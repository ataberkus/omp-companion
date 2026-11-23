import Foundation
import Network
import Observation
import os
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public enum HostReachability: Equatable, Sendable {
    case unknown
    case checking
    case reachable(latencyMs: Int)
    case unreachable(String)
}

public enum ConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case offline(cachedAt: Date?, errorMessage: String, errorKind: TailscaleErrorKind)
    case error(errorMessage: String, errorKind: TailscaleErrorKind)

    public var isOnline: Bool {
        if case .connected = self { return true }
        return false
    }

    public var isOfflineReadOnly: Bool {
        if case .offline = self { return true }
        return false
    }
}

public struct AppToast: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let message: String
    public let isError: Bool

    public init(message: String, isError: Bool = false) {
        self.message = message
        self.isError = isError
    }
}

private struct NativePreviewCacheEntry {
    let updatedAt: String
    let preview: NativeSessionPreview
    let storedAt: Date
}

private struct UILocalOverride: Equatable {
    var value: [String]
    var updatedAt: Date
    var seq: UInt64
}

private struct PriorSessionAttention {
    var status: SessionStatus
    var uiRequestCount: Int
    var workFinishedAt: String?
}
@Observable
@MainActor
public final class AppStore {
    // MARK: - Persistence & Dependencies
    private let credentialStore: CredentialStore
    private let offlineCache: OfflineCache
    private let urlSession: URLSession
    /// Where hosts, the active host and the theme persist; tests pass an isolated suite.
    private let defaults: UserDefaults
    private let syncReducer = SyncDeltaReducer()

    public let biometricLock = BiometricLock()
    public let notificationManager = NotificationManager()
    /// Messages written while the PC was unreachable, sent by `flushOutbox` once it answers.
    public let promptOutbox: PromptOutbox

    // MARK: - Host & Connection State
    public private(set) var hosts: [HostProfile] = []
    public private(set) var activeHostID: UUID?
    public private(set) var reachabilityByHost: [UUID: HostReachability] = [:]
    public private(set) var connectionStatus: ConnectionStatus = .disconnected
    public private(set) var lastTailscaleInfo: TailscaleInfoResponse?
    public private(set) var isInitialLoading: Bool = false

    // MARK: - Companion State
    public private(set) var snapshot: StoreSnapshot = StoreSnapshot()
    public private(set) var activityItems: [ActivityItem] = []
    public private(set) var cachedDiffsBySession: [String: ChangesWorktreeResponse] = [:]
    public private(set) var availableModels: [ModelEntry] = []
    public private(set) var modelRoles: [String: String] = [:]
    public private(set) var defaultThinking: String?
    public private(set) var thinkingLevels: [String] = ["off", "minimal", "low", "medium", "high", "xhigh"]
    public private(set) var commandsBySession: [String: [SlashCommandInfo]] = [:]
    public private(set) var commandsByPath: [String: [SlashCommandInfo]] = [:]
    public private(set) var cachedToolImages: [String: Data] = [:]
    public private(set) var nativeSessions: [NativeSessionSummary] = []
    public private(set) var nativeSessionsDir: String?
    public private(set) var isLoadingNativeSessions: Bool = false
    /// Why the last history refresh failed; nil once one succeeds.
    public private(set) var nativeSessionsError: String?
    public private(set) var advisorConfig: AdvisorConfigResponse?
    public private(set) var unseenSessionIDs: Set<String> = []

    // MARK: - Navigation & Sheet State
    public var selectedSessionID: String?
    public var selectedProjectID: String?
    public var selectedSessionTab: SessionInspectorTab = .chat
    public var isDetailActiveOnCompact: Bool = false
    public var isQuickStartPresented: Bool = false
    public var quickStartInitialPath: String?
    public var isQuickSwitcherPresented: Bool = false
    public var isHostSwitcherPresented: Bool = false
    public var isAddHostPresented: Bool = false
    public var isActivityPresented: Bool = false
    public var isHistoryPresented: Bool = false
    public var isWorkspacesPresented: Bool = false
    public var isSettingsPresented: Bool = false
    public var settingsInitialSection: String?
    public var selectedNativeSessionFile: String?
    public var pendingPairingPayload: PairingPayload?
    public var toast: AppToast?

    public var themePreference: ThemePreference {
        didSet {
            defaults.set(themePreference.rawValue, forKey: Self.themeDefaultsKey)
        }
    }

    // MARK: - Private Polling Runtime
    private var scenePhase: ScenePhase = .active
    private var wasBackgrounded = false
    private var pollTask: Task<Void, Never>?
    /// Waits for a restarted or updated companion on GET /api/instance (waitForNewInstance).
    private var instanceWaitTask: Task<Void, Never>?
    private var lastEtag: String?
    private var nativeSessionsEtag: String?
    /// Incremented by every poll and every local change to the store; a poll reply is applied only if it is still the newest.
    private var pollGeneration: UInt64 = 0
    private var nativeSessionsGeneration: UInt64 = 0
    public private(set) var hasLoadedNativeSessions = false
    private var nativePreviewCache: [String: NativePreviewCacheEntry] = [:]
    private var lastCacheSaveAt: Date = .distantPast
    public private(set) var hasReceivedLiveSnapshotForHost = false
    private var localGroupOrderOverride: UILocalOverride?
    private var localCollapsedOverride: UILocalOverride?
    private var uiMutationSeq: UInt64 = 0
    private var priorSessionAttention: [String: PriorSessionAttention] = [:]
    private var lastActivityFetchAt: Date = .distantPast
    private var lastNativeSessionsFetchAt: Date = .distantPast
    private var priorDroppedSteerIds: Set<String> = []
    private var toastDismissTask: Task<Void, Never>?
    /// When failOver last tried a host's other addresses.
    private var lastFailoverAt: [UUID: Date] = [:]
    /// bootstrap() is running, or found the app Face ID–locked and waits for the unlock to run again.
    private var bootstrapInProgress = false
    private var bootstrapAwaitingUnlock = false
    /// Polls in a row that failed (reset by any reply, a 304 included): the poll loop backs off on them like the web
    /// dashboard, min(30 s, 2^failures s), instead of hitting an unreachable PC every 1.2–4.5 s.
    private var consecutivePollFailures = 0
    /// `flushOutbox` is sending; another trigger meanwhile is a no-op.
    private var isFlushingOutbox = false
    /// Reports network changes (NWPathMonitor); the last path seen, nil before the first report.
    private let pathMonitor = NWPathMonitor()
    private var lastNetworkPath: (satisfied: Bool, interfaces: [String])?

    static let hostsDefaultsKey = "omp.hosts.v1"
    static let activeHostDefaultsKey = "omp.activeHostID.v1"
    static let themeDefaultsKey = "omp.themePreference.v1"
    /// Prefix of a local composer draft's key, followed by `<hostID>.<sessionID>` (`LocalComposerDraft`).
    static let localDraftDefaultsPrefix = "omp.localDraft.v1."

    public init(
        credentialStore: CredentialStore = KeychainStore(),
        offlineCache: OfflineCache = OfflineCache(),
        urlSession: URLSession = CompanionClient.defaultURLSession(),
        defaults: UserDefaults = .standard,
        outboxDirectory: URL? = nil
    ) {
        self.credentialStore = credentialStore
        self.offlineCache = offlineCache
        self.urlSession = urlSession
        self.defaults = defaults
        self.promptOutbox = PromptOutbox(directory: outboxDirectory)
        if let rawTheme = defaults.string(forKey: Self.themeDefaultsKey),
           let pref = ThemePreference(rawValue: rawTheme) {
            self.themePreference = pref
        } else {
            self.themePreference = .dark
        }
        loadSavedHosts()

        notificationManager.onRouteToSession = { [weak self] hostID, sessionID in
            guard let self else { return }
            Task { @MainActor in
                if self.activeHostID != hostID {
                    await self.selectHost(hostID)
                }
                self.selectedSessionTab = .chat
                await self.selectSession(sessionID)
            }
        }

        // Face ID lock: nothing is fetched while locked. Unlocking runs a bootstrap that waited on it, or resumes polling.
        biometricLock.onLockChanged = { [weak self] locked in
            guard let self else { return }
            if locked {
                self.stopPolling()
            } else if self.bootstrapInProgress {
                // bootstrap() unlocked it and carries on itself (hydrating the cache before the first poll).
            } else if self.bootstrapAwaitingUnlock {
                self.bootstrapAwaitingUnlock = false
                Task { await self.bootstrap() }
            } else if self.activeHost != nil, self.scenePhase == .active {
                self.startPolling()
            }
        }
        // Local notifications show no session title or detail while the Face ID lock is on.
        notificationManager.redactsContent = { [weak self] in self?.biometricLock.isEnabled ?? false }
        // Apple push: registrations follow the in-app notifications switch and the Face ID lock (generic alerts while on).
        notificationManager.onEnabledChanged = { [weak self] in self?.syncPushRegistration() }
        biometricLock.onEnabledChanged = { [weak self] _ in self?.syncPushRegistration() }
        // In the foreground the active host is polled, and evaluateTransitions already reported its sessions.
        notificationManager.coversRemoteNotifications = { [weak self] hostID in
            guard let self else { return false }
            return self.scenePhase == .active && self.activeHost?.id == hostID && self.pollTask != nil
        }

        // The network came back or changed (Wi-Fi ↔ cellular, a VPN such as Tailscale up): sync at once rather than at
        // the end of a backoff, and let failOver try the other addresses right away.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let interfaces = path.availableInterfaces.map(\.name)
            Task { @MainActor in self?.networkPathChanged(satisfied: satisfied, interfaces: interfaces) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "dev.omp.companion.network"))
    }

    deinit {
        pathMonitor.cancel()
    }

    // MARK: - Derived Accessors

    public var activeHost: HostProfile? {
        guard let activeHostID else { return hosts.first }
        return hosts.first(where: { $0.id == activeHostID }) ?? hosts.first
    }

    public var selectedSession: SessionSummary? {
        guard let id = selectedSessionID else { return nil }
        return snapshot.sessions.first(where: { $0.id == id })
    }
    public var isOfflineReadOnly: Bool {
        connectionStatus.isOfflineReadOnly
    }

    public var canPerformMutatingActions: Bool {
        connectionStatus.isOnline
    }

    /// The composer takes a message: sent at once while connected, otherwise held in `promptOutbox` until the PC answers.
    /// Not while the PC refuses this phone (wrong token or password) or answers with errors: nothing queued would go through.
    public var canComposePrompts: Bool {
        guard activeHost != nil else { return false }
        switch connectionStatus {
        case .connected, .connecting:
            return true
        case .offline(_, _, let kind):
            return !kind.isAuthFailure
        case .error(_, let kind):
            return kind.isConnectivityFailure
        case .disconnected:
            return false
        }
    }

    public var activeClient: CompanionClient? {
        guard let host = activeHost else { return nil }
        let token = (try? credentialStore.loadSecret(for: host.id)) ?? ""
        return CompanionClient(host: host, token: token, session: urlSession)
    }

    public func client(for hostID: UUID) -> CompanionClient? {
        guard let host = hosts.first(where: { $0.id == hostID }) else { return nil }
        let token = (try? credentialStore.loadSecret(for: host.id)) ?? ""
        return CompanionClient(host: host, token: token, session: urlSession)
    }

    public func secret(for hostID: UUID) -> String? {
        try? credentialStore.loadSecret(for: hostID)
    }

    public var visibleSessions: [SessionSummary] {
        let archivedSet = Set(snapshot.archived.compactMap { $0.hasPrefix("s:") ? String($0.dropFirst(2)) : nil })
        return snapshot.sessions.filter { $0.hidden != true && !archivedSet.contains($0.id) }
    }

    public var attentionSessions: [SessionSummary] {
        let projectsByID = Dictionary(snapshot.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return snapshot.sessions.filter { s in
            guard s.hidden != true else { return false }
            let proj = s.projectId.flatMap { projectsByID[$0] }
            return needsYou(s, project: proj)
        }
    }

    public var pinnedSessions: [SessionSummary] {
        let pinnedIds = Set(snapshot.pinned.compactMap { $0.hasPrefix("s:") ? String($0.dropFirst(2)) : nil })
        let archivedSet = Set(snapshot.archived.compactMap { $0.hasPrefix("s:") ? String($0.dropFirst(2)) : nil })
        return snapshot.sessions.filter { $0.hidden != true && !archivedSet.contains($0.id) && pinnedIds.contains($0.id) }
    }

    public var archivedSessions: [SessionSummary] {
        let archivedSet = Set(snapshot.archived.compactMap { $0.hasPrefix("s:") ? String($0.dropFirst(2)) : nil })
        return snapshot.sessions.filter { archivedSet.contains($0.id) }
    }

    public func isPinned(_ session: SessionSummary) -> Bool {
        snapshot.pinned.contains(session.panelKey)
    }

    public func isArchived(_ session: SessionSummary) -> Bool {
        snapshot.archived.contains(session.panelKey)
    }

    public func project(for session: SessionSummary) -> WorkspaceProject? {
        guard let pid = session.projectId else { return nil }
        return snapshot.projects.first(where: { $0.id == pid })
    }

    public var visibleProjects: [WorkspaceProject] {
        snapshot.projects.filter { $0.hidden != true }
    }

    public var hiddenProjects: [WorkspaceProject] {
        snapshot.projects.filter { $0.hidden == true }
    }

    public var effectiveGroupOrder: [String] {
        localGroupOrderOverride?.value ?? snapshot.ui?.groupOrder ?? []
    }

    public var effectiveCollapsed: [String] {
        localCollapsedOverride?.value ?? snapshot.ui?.collapsed ?? []
    }

    public func isGroupCollapsed(_ key: String, legacyProjectID: String? = nil) -> Bool {
        effectiveCollapsed.contains {
            SidebarLayoutHelper.isCollapsedMatch($0, groupKey: key, legacyProjectID: legacyProjectID)
        }
    }

    public func orderedProjects(includeHidden: Bool = false) -> [WorkspaceProject] {
        let base = includeHidden ? snapshot.projects : visibleProjects
        return SidebarLayoutHelper.orderedProjects(projects: base, groupOrder: effectiveGroupOrder)
    }

    public func isSessionUnseen(_ session: SessionSummary) -> Bool {
        session.id != selectedSessionID && unseenSessionIDs.contains(session.id)
    }

    public func needsYou(_ session: SessionSummary, project: WorkspaceProject? = nil) -> Bool {
        let resolvedProject = project ?? self.project(for: session)
        let isArchivedOrHidden = isArchived(session) || (resolvedProject?.hidden == true)
        let hasQuestions = !(session.uiRequests?.isEmpty ?? true)
        let reviewish = hasQuestions || session.hasPlanReviewPending || session.status == .review || session.status == .error
        return (reviewish || isSessionUnseen(session)) && (!isArchivedOrHidden || hasQuestions)
    }
    // MARK: - Lifecycle & Scene Handling

    /// True while Face ID locks the app: no polling, no cache hydration, until `biometricLock` unlocks.
    private var isLockedOut: Bool {
        biometricLock.isEnabled && biometricLock.isLocked
    }

    public func bootstrap() async {
        bootstrapInProgress = true
        defer { bootstrapInProgress = false }
        if isLockedOut {
            _ = await biometricLock.unlock()
        }
        // Still locked (cancelled, or no passcode): the lock screen's unlock runs this again through onLockChanged.
        guard !isLockedOut else {
            bootstrapAwaitingUnlock = true
            return
        }
        if let host = activeHost {
            await hydrateOfflineCache(for: host.id)
            await promptOutbox.load(hostID: host.id)
            startPolling()
            Task { await refreshModelsAndActivity() }
            Task { await probeAllHosts() }
        }
    }

    public func handleScenePhaseChange(_ phase: ScenePhase) async {
        scenePhase = phase
        biometricLock.noteScenePhase(phase)
        if phase == .active {
            // The Face ID sheet itself moves the scene inactive → active, so prompting on every activation would
            // re-prompt forever after a cancel; prompt once per return from background (the lock screen has a button).
            let resumed = wasBackgrounded
            wasBackgrounded = false
            if resumed && isLockedOut {
                _ = await biometricLock.unlock()
            }
            if activeHost != nil, !isLockedOut {
                startPolling()
                await forceSync()
                // Messages written while away go out now if that poll reached the PC (it schedules this too).
                scheduleOutboxFlush()
                Task { await probeAllHosts() }
            }
        } else if phase == .background {
            wasBackgrounded = true
            stopPolling()
            await persistOfflineCacheNow()
        }
    }

    public func handleIncomingURL(_ url: URL) {
        guard let parsed = PairingPayload.parse(url.absoluteString) else {
            showToast(String(localized: "Unsupported link format.", bundle: .main), isError: true)
            return
        }
        pendingPairingPayload = parsed
        isAddHostPresented = true
    }

    public func presentQuickStart(projectPath: String? = nil) {
        quickStartInitialPath = projectPath
        isQuickStartPresented = true
    }

    public func showToast(_ message: String, isError: Bool = false) {
        toastDismissTask?.cancel()
        toast = AppToast(message: message, isError: isError)
        toastDismissTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    // MARK: - Host Management (Keychain + UserDefaults)

    private func loadSavedHosts() {
        if let data = defaults.data(forKey: Self.hostsDefaultsKey),
           let decoded = try? JSONDecoder().decode([HostProfile].self, from: data) {
            hosts = decoded.sorted { $0.sortOrder < $1.sortOrder }
        }
        if let rawID = defaults.string(forKey: Self.activeHostDefaultsKey),
           let id = UUID(uuidString: rawID),
           hosts.contains(where: { $0.id == id }) {
            activeHostID = id
        } else {
            activeHostID = hosts.first?.id
        }
    }

    private func persistHostMetadata() {
        if let data = try? JSONEncoder().encode(hosts) {
            defaults.set(data, forKey: Self.hostsDefaultsKey)
        }
        if let activeHostID {
            defaults.set(activeHostID.uuidString, forKey: Self.activeHostDefaultsKey)
        } else {
            defaults.removeObject(forKey: Self.activeHostDefaultsKey)
        }
    }

    @discardableResult
    public func saveHost(
        existingID: UUID? = nil,
        name: String,
        baseURL: String,
        authKind: HostAuthKind,
        secret: String,
        selectAsActive: Bool = true
    ) async throws -> HostProfile {
        let normalizedURL = HostProfile.normalizeBaseURL(baseURL)
        guard !normalizedURL.isEmpty, URL(string: normalizedURL) != nil else {
            throw CompanionAPIError(kind: .invalidURL)
        }
        let trimmedSecret = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSecret.isEmpty else {
            throw CompanionAPIError(kind: authKind == .remotePassword ? .wrongPassword : .invalidToken, serverMessage: String(localized: "Enter a token or password.", bundle: .main))
        }

        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = cleanName.isEmpty ? (URL(string: normalizedURL)?.host ?? normalizedURL) : cleanName

        var profile: HostProfile
        if let existingID, let idx = hosts.firstIndex(where: { $0.id == existingID }) {
            profile = hosts[idx]
            profile.name = resolvedName
            profile.baseURL = normalizedURL
            profile.authKind = authKind
            hosts[idx] = profile
        } else {
            profile = HostProfile(
                name: resolvedName,
                baseURL: normalizedURL,
                authKind: authKind,
                sortOrder: hosts.count
            )
            hosts.append(profile)
        }

        try credentialStore.saveSecret(trimmedSecret, for: profile.id)
        persistHostMetadata()
        syncPushRegistration(only: [profile.id])

        if selectAsActive {
            await selectHost(profile.id)
        } else {
            Task { await probeHost(profile.id) }
        }
        return profile
    }

    public func deleteHost(_ id: UUID) async {
        // Withdraw this phone's push registration while the host's token is still in the Keychain.
        if let token = pushToken, let client = client(for: id) {
            Task {
                do { try await client.unregisterPush(token: token) } catch {
                    Self.pushLog.error("Push unregistration failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        try? credentialStore.deleteSecret(for: id)
        await offlineCache.clear(hostID: id)
        await promptOutbox.clear(hostID: id)
        let draftPrefix = Self.localDraftDefaultsPrefix + id.uuidString + "."
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(draftPrefix) {
            defaults.removeObject(forKey: key)
        }
        hosts.removeAll { $0.id == id }
        reachabilityByHost.removeValue(forKey: id)
        notificationManager.resetTracking(for: id)

        if activeHostID == id {
            stopPolling()
            activeHostID = hosts.first?.id
            resetHostScopedState()
            persistHostMetadata()
            if let nextID = activeHostID {
                await hydrateOfflineCache(for: nextID)
                startPolling()
                await forceSync()
                Task { await refreshModelsAndActivity() }
            } else {
                connectionStatus = .disconnected
            }
        } else {
            persistHostMetadata()
        }
    }

    public func selectHost(_ hostID: UUID) async {
        guard hosts.contains(where: { $0.id == hostID }) else { return }
        // Also retries a registration the host missed while it was offline.
        syncPushRegistration(only: [hostID])
        if activeHostID == hostID, pollTask != nil {
            await forceSync()
            scheduleOutboxFlush()
            return
        }
        await persistOfflineCacheNow()
        stopPolling()
        activeHostID = hostID
        persistHostMetadata()
        resetHostScopedState()

        await hydrateOfflineCache(for: hostID)
        guard activeHostID == hostID else { return }
        await promptOutbox.load(hostID: hostID)
        guard activeHostID == hostID else { return }
        startPolling()
        await forceSync()
        // This host's waiting messages go out if that poll reached it (pollOnce schedules this too).
        scheduleOutboxFlush()
        Task { await refreshModelsAndActivity() }
    }

    // MARK: - Apple Push

    private static let pushLog = Logger(subsystem: "dev.omp.companion", category: "push")
    /// The APNs device token (hex) iOS handed over this launch; nil until then (and on a simulator without push).
    public private(set) var pushToken: String?

    /// From the app delegate. A new token replaces the old one at every host (the old one would only fail at Apple).
    public func didRegisterForRemoteNotifications(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard hex != pushToken else { return }
        if let old = pushToken {
            for host in hosts {
                guard let client = client(for: host.id) else { continue }
                Task { _ = try? await client.unregisterPush(token: old) }
            }
        }
        pushToken = hex
        syncPushRegistration()
    }

    /// From the app delegate: no push this launch (simulator, no network, missing entitlement); local notifications still work.
    public func didFailToRegisterForRemoteNotifications(_ error: Error) {
        Self.pushLog.notice("Push registration unavailable: \(error.localizedDescription, privacy: .public)")
    }

    /// Registers the push token with every saved host (or those in `only`), so each companion can push "needs input" and
    /// "plan ready" while the app is not running; withdraws it while the in-app notifications switch is off. `hostRef`
    /// is the host's id here, which the push carries back as `hostID` for tap routing. Failures are logged only: a host
    /// that was offline gets it the next time it is selected.
    func syncPushRegistration(only hostIDs: [UUID]? = nil) {
        guard let token = pushToken else { return }
        let enabled = notificationManager.notificationsEnabled
        let redact = biometricLock.isEnabled
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        #if canImport(UIKit)
        let name: String? = UIDevice.current.name
        #else
        let name: String? = nil
        #endif
        for host in hosts where hostIDs?.contains(host.id) ?? true {
            guard let client = client(for: host.id) else { continue }
            let hostRef = host.id.uuidString
            Task {
                do {
                    if enabled {
                        try await client.registerPush(token: token, environment: environment, hostRef: hostRef, redact: redact, name: name)
                    } else {
                        try await client.unregisterPush(token: token)
                    }
                } catch {
                    Self.pushLog.error("Push registration with \(hostRef, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    public func testHostConnection(baseURL: String, secret: String) async -> Result<(latencyMs: Int, tailscale: TailscaleInfoResponse), CompanionAPIError> {
        let normalized = HostProfile.normalizeBaseURL(baseURL)
        guard !normalized.isEmpty else {
            return .failure(CompanionAPIError(kind: .invalidURL))
        }
        let tempHost = HostProfile(name: "Test", baseURL: normalized)
        let tempClient = CompanionClient(host: tempHost, token: secret.trimmingCharacters(in: .whitespacesAndNewlines), session: urlSession)
        let start = CFAbsoluteTimeGetCurrent()
        do {
            let ts = try await tempClient.fetchTailscaleInfo()
            let ms = max(1, Int((CFAbsoluteTimeGetCurrent() - start) * 1000))
            return .success((ms, ts))
        } catch let err as CompanionAPIError {
            return .failure(err)
        } catch {
            return .failure(TailscaleDiagnostic.classifyTransport(error, host: tempHost))
        }
    }

    public func probeHost(_ hostID: UUID) async {
        guard let client = client(for: hostID) else { return }
        reachabilityByHost[hostID] = .checking
        do {
            let ms = try await client.probeReachability()
            reachabilityByHost[hostID] = .reachable(latencyMs: ms)
            if let idx = hosts.firstIndex(where: { $0.id == hostID }) {
                hosts[idx].lastConnectedAt = Date()
                hosts[idx].lastLatencyMs = ms
                persistHostMetadata()
            }
        } catch {
            reachabilityByHost[hostID] = .unreachable(error.localizedDescription)
        }
    }

    public func probeAllHosts() async {
        let ids = hosts.map(\.id)
        await withTaskGroup(of: Void.self) { group in
            for id in ids {
                group.addTask {
                    await self.probeHost(id)
                }
            }
        }
    }

    // MARK: - Sync Engine & Offline Cache

    private func hydrateOfflineCache(for hostID: UUID) async {
        let cached = await offlineCache.load(hostID: hostID)
        // The host may have changed while the cache file was read.
        guard hostID == activeHostID else { return }
        if let cached {
            snapshot = await offlineCache.hydratedSnapshot(from: cached)
            guard hostID == activeHostID else { return }
            activityItems = cached.activity
            cachedDiffsBySession = cached.diffs
            connectionStatus = .offline(
                cachedAt: cached.savedAt,
                errorMessage: String(localized: "Showing cached snapshot until connected", bundle: .main),
                errorKind: .tailscaleInactiveOrUnreachable
            )
        } else {
            connectionStatus = .connecting
        }
    }

    /// Forgets everything read from the previous host: sync cursors and ETags (a 304 against them would keep the old
    /// host's data), the store, history, previews and catalogs. Bumping the generations drops replies still in flight.
    private func resetHostScopedState() {
        syncReducer.reset()
        pollGeneration &+= 1
        nativeSessionsGeneration &+= 1
        lastEtag = nil
        nativeSessionsEtag = nil
        lastNativeSessionsFetchAt = .distantPast
        lastActivityFetchAt = .distantPast
        hasReceivedLiveSnapshotForHost = false
        hasLoadedNativeSessions = false
        selectedSessionID = nil
        selectedNativeSessionFile = nil
        isDetailActiveOnCompact = false
        selectedSessionTab = .chat
        snapshot = StoreSnapshot()
        activityItems = []
        nativeSessions = []
        nativeSessionsDir = nil
        nativeSessionsError = nil
        isLoadingNativeSessions = false
        nativePreviewCache = [:]
        advisorConfig = nil
        cachedDiffsBySession = [:]
        cachedToolImages = [:]
        availableModels = []
        commandsBySession = [:]
        commandsByPath = [:]
        priorDroppedSteerIds = []
        localGroupOrderOverride = nil
        localCollapsedOverride = nil
        uiMutationSeq = 0
        unseenSessionIDs = []
        priorSessionAttention = [:]
        lastTailscaleInfo = nil
        consecutivePollFailures = 0
        instanceWaitTask?.cancel()
        instanceWaitTask = nil
    }

    private func persistOfflineCacheNow() async {
        guard let hostID = activeHostID, hasReceivedLiveSnapshotForHost else { return }
        lastCacheSaveAt = Date()
        await offlineCache.save(
            hostID: hostID,
            snapshot: snapshot,
            diffs: cachedDiffsBySession,
            activity: activityItems
        )
    }

    public func startPolling() {
        pollTask?.cancel()
        guard activeHost != nil, scenePhase == .active, !isLockedOut else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.pollOnce()
                let anyWorking = self.snapshot.sessions.contains { $0.isWorking || !(self.selectedSession?.uiRequests?.isEmpty ?? true) }
                try? await Task.sleep(nanoseconds: Self.pollDelay(failures: self.consecutivePollFailures, anyWorking: anyWorking))
            }
        }
    }

    /// The poll loop's pause: 1.2 s while something works or asks, 4.5 s idle; after failed polls
    /// min(30 s, 2^failures s), as the web dashboard backs off.
    nonisolated static func pollDelay(failures: Int, anyWorking: Bool) -> UInt64 {
        if failures > 0 {
            return UInt64(min(30, 1 << min(failures, 5))) * 1_000_000_000
        }
        return anyWorking ? 1_200_000_000 : 4_500_000_000
    }

    /// A path that became usable, or moved to other interfaces, restarts the poll loop (it polls at once) with the
    /// backoff cleared. The first report is the state at launch, not a change. The outbox is flushed by that poll once it
    /// reaches the PC, not here: a send over a path that does not reach it yet could time out and leave its fate unknown.
    private func networkPathChanged(satisfied: Bool, interfaces: [String]) {
        let previous = lastNetworkPath
        lastNetworkPath = (satisfied, interfaces)
        guard let previous, satisfied, !previous.satisfied || previous.interfaces != interfaces else { return }
        consecutivePollFailures = 0
        lastFailoverAt.removeAll()
        startPolling()
    }

    public func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    public func forceSync() async {
        lastEtag = nil
        await pollOnce()
    }

    public func selectSession(_ sessionID: String?, tab: SessionInspectorTab? = nil, openDetail: Bool = true) async {
        selectedSessionID = sessionID
        if let sessionID {
            unseenSessionIDs.remove(sessionID)
        }
        if let tab {
            selectedSessionTab = tab
        }
        if openDetail && sessionID != nil {
            isDetailActiveOnCompact = true
        } else if sessionID == nil {
            isDetailActiveOnCompact = false
        }
        lastEtag = nil
        if sessionID != nil {
            await pollOnce()
            if let sid = sessionID {
                Task { await refreshCommandsIfNeeded(for: sid) }
            }
        }
    }

    public func selectInspectorTab(_ tab: SessionInspectorTab) {
        selectedSessionTab = tab
        notificationManager.triggerHaptic(.selection)
    }

    /// One poll of `/api/state`. Polls can overlap (the poll loop, `forceSync` after an action or a return to the
    /// foreground, `selectSession`): each takes a generation number, and a reply is applied only if no newer poll or
    /// local change started since and the host is unchanged, so a slow older reply never overwrites newer state.
    public func pollOnce() async {
        guard let host = activeHost, let client = activeClient else {
            connectionStatus = .disconnected
            return
        }
        pollGeneration &+= 1
        let generation = pollGeneration
        let isCurrent = { [weak self] in
            guard let self else { return false }
            return self.pollGeneration == generation && self.activeHost?.id == host.id
        }
        if !hasReceivedLiveSnapshotForHost && snapshot.sessions.isEmpty {
            isInitialLoading = true
        }
        defer { if isCurrent() { isInitialLoading = false } }

        do {
            let sid = selectedSessionID
            // An ETag only stands for a reply this store applied: without one for this host, ask for the whole reply.
            let etag = hasReceivedLiveSnapshotForHost ? lastEtag : nil
            let result = try await client.fetchState(
                sessionId: sid,
                since: syncReducer.sinceToken(for: sid),
                storeToken: syncReducer.storeToken,
                orderDelta: true,
                etag: etag
            )
            guard isCurrent(), sid == selectedSessionID else { return }
            consecutivePollFailures = 0

            switch result {
            case .notModified:
                connectionStatus = .connected
                reachabilityByHost[host.id] = .reachable(latencyMs: host.lastLatencyMs ?? 15)
            case .updated(let poll, let etag):
                lastEtag = etag
                let (nextSnapshot, retryTx) = syncReducer.apply(
                    poll: poll,
                    viewedSessionId: sid,
                    currentSnapshot: snapshot
                )
                let wasInitial = !hasReceivedLiveSnapshotForHost
                hasReceivedLiveSnapshotForHost = true
                // A new instance id: the companion restarted (or the desktop app updated) since the last poll. The
                // delta cursors and ETag belong to the old process, so drop them and take a whole state.
                let restarted = !wasInitial && snapshot.instance != nil && nextSnapshot.instance != nil
                    && snapshot.instance != nextSnapshot.instance
                snapshot = nextSnapshot
                if restarted {
                    companionInstanceChanged()
                    await pollOnce()
                    return
                }
                reconcileLocalUIOverrides()
                connectionStatus = .connected
                reachabilityByHost[host.id] = .reachable(latencyMs: host.lastLatencyMs ?? 15)

                if let idx = hosts.firstIndex(where: { $0.id == host.id }) {
                    hosts[idx].lastConnectedAt = Date()
                    persistHostMetadata()
                }

                // The addresses to fall back on are recorded from a live companion: bootstrap may have run while it was off.
                if wasInitial {
                    Task { await refreshTailscaleInfo() }
                }

                if let sid = selectedSessionID, !snapshot.sessions.contains(where: { $0.id == sid }) {
                    selectedSessionID = nil
                    isDetailActiveOnCompact = false
                }

                notificationManager.evaluateTransitions(
                    host: host,
                    sessions: snapshot.sessions,
                    selectedSessionID: selectedSessionID,
                    isAppActive: scenePhase == .active,
                    isInitialSnapshot: wasInitial
                )
                updateUnseenSessions(sessions: snapshot.sessions, isInitialSnapshot: wasInitial)

                detectDroppedSteers(in: selectedSession)

                if retryTx {
                    lastEtag = nil
                    await pollOnce()
                    return
                }

                if Date().timeIntervalSince(lastCacheSaveAt) > 10 {
                    await persistOfflineCacheNow()
                }
            }

            // The PC answered: messages written while it could not be reached go out now, in order.
            scheduleOutboxFlush()

            if Date().timeIntervalSince(lastNativeSessionsFetchAt) > 20 {
                Task { await refreshNativeSessions() }
            }
        } catch {
            guard isCurrent() else { return }
            let apiError = (error as? CompanionAPIError) ?? TailscaleDiagnostic.classifyTransport(error, host: host)
            if apiError.kind == .cancelled { return }
            // The paired address does not answer: the PC may have come back on another one it reported (its tailnet
            // after a reboot that left the LAN closed or changed its LAN address). Same credential, no new pairing.
            if apiError.kind.isConnectivityFailure, apiError.kind != .companionRestarting, await failOver(from: host) {
                guard activeHost?.id == host.id else { return }
                await pollOnce()
                return
            }
            guard isCurrent() else { return }
            reachabilityByHost[host.id] = .unreachable(apiError.localizedDescription)
            consecutivePollFailures += 1
            if hasReceivedLiveSnapshotForHost || !snapshot.sessions.isEmpty {
                let cachedAt = await offlineCache.load(hostID: host.id)?.savedAt
                guard isCurrent() else { return }
                connectionStatus = .offline(
                    cachedAt: cachedAt,
                    errorMessage: apiError.localizedDescription,
                    errorKind: apiError.kind
                )
            } else {
                connectionStatus = .error(errorMessage: apiError.localizedDescription, errorKind: apiError.kind)
            }
        }
    }

    private func detectDroppedSteers(in session: SessionSummary?) {
        guard let messages = session?.messages else { return }
        for msg in messages where msg.steer == .dropped {
            if !priorDroppedSteerIds.contains(msg.id) {
                priorDroppedSteerIds.insert(msg.id)
                notificationManager.triggerHaptic(.warning)
            }
        }
    }

    public func performBackgroundAttentionCheck() async -> Bool {
        var anySuccess = false
        for host in hosts {
            guard let client = client(for: host.id) else { continue }
            do {
                let result = try await client.fetchState(sessionId: "", since: nil, storeToken: nil, orderDelta: false, etag: nil)
                if case .updated(let poll, _) = result {
                    anySuccess = true
                    let sessions = poll.sx?.changed ?? poll.sessions ?? []
                    notificationManager.evaluateTransitions(
                        host: host,
                        sessions: sessions,
                        selectedSessionID: nil,
                        isAppActive: false,
                        isInitialSnapshot: false
                    )
                }
            } catch {
                // Keep checking remaining hosts
            }
        }
        return anySuccess
    }

    // MARK: - Shared Catalog & Metadata Refreshers

    public func refreshModelsAndActivity() async {
        guard activeClient != nil else { return }
        async let modelsTask: Void = refreshModels()
        async let nativeTask: Void = refreshNativeSessions(force: true)
        async let advisorTask: Void = refreshAdvisorConfig()
        async let tsTask: Void = refreshTailscaleInfo()
        _ = await (modelsTask, nativeTask, advisorTask, tsTask)
    }

    private func refreshTailscaleInfo() async {
        guard let client = activeClient, let hostID = activeHostID else { return }
        guard let ts = try? await client.fetchTailscaleInfo(), hostID == activeHostID else { return }
        lastTailscaleInfo = ts
        guard let idx = hosts.firstIndex(where: { $0.id == hostID }) else { return }
        // A companion whose Tailscale is down for the moment reports no tailnet: keep what an earlier answer recorded,
        // since those are the addresses a reboot that changed the LAN side still answers on.
        if let tailscale = ts.tailscale {
            hosts[idx].magicDNS = tailscale.name
            hosts[idx].tailscaleIPv4 = tailscale.ips?.first(where: { !$0.contains(":") })
            hosts[idx].tailscaleIPv6 = tailscale.ips?.first(where: { $0.contains(":") })
        }
        let reported = (ts.tailnetUrls + ts.lanUrls).map { HostProfile.normalizeBaseURL($0) }.filter { !$0.isEmpty }
        if !reported.isEmpty {
            var merged: [String] = []
            for url in reported + (hosts[idx].alternateURLs ?? []) where !merged.contains(url) {
                merged.append(url)
            }
            hosts[idx].alternateURLs = Array(merged.prefix(12))
        }
        persistHostMetadata()
    }

    /// When the paired address stops answering, tries the other addresses this companion reported (`alternateURLs`) with
    /// the same credential, all at once with a short timeout, and moves the host to the first one, in the companion's
    /// order, that accepts it. A PC that rebooted answers on its tailnet even when its LAN listener or LAN address
    /// changed, so the phone stays paired. Plain-HTTP LAN or public addresses are never tried: this runs unattended, and
    /// the credential would cross that network unencrypted (`HostProfile.sendsCredentialInClear`). At most once every
    /// 20 s per host, so an offline PC is not probed every poll.
    private func failOver(from host: HostProfile) async -> Bool {
        let now = Date()
        if let last = lastFailoverAt[host.id], now.timeIntervalSince(last) < 20 { return false }
        lastFailoverAt[host.id] = now
        let current = HostProfile.normalizeBaseURL(host.baseURL)
        let candidates = (host.alternateURLs ?? []).filter { $0 != current && !HostProfile.sendsCredentialInClear($0) }
        guard !candidates.isEmpty, let token = try? credentialStore.loadSecret(for: host.id), !token.isEmpty else { return false }
        let session = urlSession
        let answered = await withTaskGroup(of: (Int, Int?).self) { group -> [Int: Int] in
            for (order, url) in candidates.enumerated() {
                var moved = host
                moved.baseURL = url
                let probe = moved
                group.addTask {
                    let ms = try? await CompanionClient(host: probe, token: token, session: session).probeReachability()
                    return (order, ms)
                }
            }
            var latency: [Int: Int] = [:]
            for await (order, ms) in group {
                if let ms { latency[order] = ms }
            }
            return latency
        }
        guard let best = answered.keys.min(),
              let idx = hosts.firstIndex(where: { $0.id == host.id }),
              HostProfile.normalizeBaseURL(hosts[idx].baseURL) == current else { return false }
        hosts[idx].baseURL = candidates[best]
        hosts[idx].lastLatencyMs = answered[best]
        persistHostMetadata()
        return true
    }

    public func refreshModels() async {
        guard let client = activeClient else { return }
        if let resp = try? await client.fetchModels() {
            availableModels = resp.models
            modelRoles = resp.roles ?? [:]
            defaultThinking = resp.defaultThinking
            if let levels = resp.thinkingLevels, !levels.isEmpty {
                thinkingLevels = levels
            }
        }
    }

    public func refreshAdvisorConfig() async {
        guard let client = activeClient else { return }
        if let cfg = try? await client.fetchAdvisorConfig() {
            advisorConfig = cfg
        }
    }

    /// Refreshes the OMP history list. Overlapping calls (the list's `.task`, pull-to-refresh, the poll loop's periodic
    /// refresh) all send, but only the newest reply for the current host is applied; a 304 keeps the list only when
    /// this host's list was actually loaded under that ETag.
    public func refreshNativeSessions(force: Bool = false) async {
        guard let client = activeClient, let hostID = activeHostID else { return }
        if force || !hasLoadedNativeSessions { nativeSessionsEtag = nil }
        nativeSessionsGeneration &+= 1
        let generation = nativeSessionsGeneration
        lastNativeSessionsFetchAt = Date()
        if nativeSessions.isEmpty { isLoadingNativeSessions = true }
        do {
            let res = try await client.fetchOmpSessions(etag: nativeSessionsEtag)
            guard generation == nativeSessionsGeneration, hostID == activeHostID else { return }
            switch res {
            case .notModified:
                break
            case .updated(let data, let tag):
                nativeSessionsEtag = tag
                nativeSessionsDir = data.dir
                nativeSessions = data.sessions
                hasLoadedNativeSessions = true
            }
            nativeSessionsError = nil
        } catch {
            guard generation == nativeSessionsGeneration, hostID == activeHostID else { return }
            if let apiError = error as? CompanionAPIError, apiError.kind == .cancelled {
                // Leave the spinner to the request that superseded this one.
            } else {
                nativeSessionsError = error.localizedDescription
            }
        }
        isLoadingNativeSessions = false
    }

    /// The activity log from `GET /api/activity`, which carries nothing else (the whole store reply also carries every
    /// transcript, hundreds of MB on a busy host).
    public func refreshActivityOnly() async {
        guard let client = activeClient, let hostID = activeHostID else { return }
        lastActivityFetchAt = Date()
        do {
            let res = try await client.fetchActivity()
            guard hostID == activeHostID else { return }
            activityItems = res.activity
        } catch {
            guard hostID == activeHostID else { return }
            if let apiError = error as? CompanionAPIError, apiError.kind == .cancelled { return }
            showToast(String(localized: "Activity: \(error.localizedDescription)", bundle: .main), isError: true)
        }
    }
    public func refreshCommandsIfNeeded(for sessionId: String, force: Bool = false) async {
        if !force, commandsBySession[sessionId] != nil { return }
        guard let client = activeClient else { return }
        if let resp = try? await client.fetchCommands(sessionId: sessionId) {
            commandsBySession[sessionId] = resp.commands
        }
    }

    public func fetchCommands(forPath path: String) async -> [SlashCommandInfo] {
        if let cached = commandsByPath[path] { return cached }
        guard let client = activeClient else { return [] }
        if let resp = try? await client.fetchCommands(path: path) {
            commandsByPath[path] = resp.commands
            return resp.commands
        }
        return []
    }

    // MARK: - Tool Image Fetching with Cache

    public func loadToolImageData(id: String) async -> Data? {
        if let cached = cachedToolImages[id] { return cached }
        guard let client = activeClient else { return nil }
        guard let data = try? await client.fetchToolImage(id: id) else { return nil }
        if cachedToolImages.count > 64 {
            cachedToolImages.removeAll()
        }
        cachedToolImages[id] = data
        return data
    }

    // MARK: - High-Level Session & Workspace Actions

    public func integrateSession(_ session: SessionSummary) {
        var mutable = snapshot
        syncReducer.integrateSessionReply(session, into: &mutable)
        snapshot = mutable
        lastEtag = nil
        // A poll sent before this reply could carry the session's older state: drop it.
        pollGeneration &+= 1
    }

    // MARK: - Offline Outbox & Local Drafts

    /// What became of one outbox message's send.
    private enum OutboxDelivery {
        case sent
        /// The PC could not be reached: the message stays pending, or is failed when it may have arrived.
        case unreachable(String)
        /// The PC answered with an error: the message is failed.
        case refused(String)
        /// Gone, or already on the wire.
        case skipped
    }

    /// The active host's waiting messages for a session, oldest first.
    public func outboxItems(sessionID: String) -> [OutboxItem] {
        guard let hostID = activeHost?.id else { return [] }
        return promptOutbox.items(hostID: hostID, sessionID: sessionID)
    }

    /// The active host's waiting messages, every session.
    public var outboxCount: Int {
        guard let hostID = activeHost?.id else { return 0 }
        return promptOutbox.items(hostID: hostID).count
    }

    /// Messages of this session still to go out on their own: a new one must wait behind them.
    public func hasUnsentOutboxItems(sessionID: String) -> Bool {
        guard let hostID = activeHost?.id else { return false }
        return promptOutbox.hasUnsent(hostID: hostID, sessionID: sessionID)
    }

    /// Reads the active host's outbox for display; not while Face ID locks the app.
    public func loadOutbox() async {
        guard !isLockedOut, let hostID = activeHost?.id else { return }
        await promptOutbox.load(hostID: hostID)
    }

    /// Holds a message for the active host behind the session's earlier ones: a `pending` one goes out on its own once the
    /// PC answers, a `failed` one (sent without an answer, so it may have arrived) waits for the user. Throws, holding
    /// nothing, when the outbox is full or cannot be saved.
    public func queuePrompt(
        session: SessionSummary,
        text: String,
        images: [PendingImageAttachment],
        pdfs: [PendingPdfAttachment],
        state: OutboxItem.State = .pending,
        lastError: String? = nil
    ) async throws {
        guard let hostID = activeHost?.id else { throw PromptOutboxError.notSaved("No PC is selected.") }
        try await promptOutbox.enqueue(OutboxItem(
            hostID: hostID,
            sessionID: session.id,
            draftKey: session.draftKey,
            text: text,
            images: images,
            pdfs: pdfs,
            lastError: lastError,
            state: state
        ))
    }

    /// Starts `flushOutbox` when the last poll reached the active host and it has messages waiting (or its outbox is not
    /// read yet).
    func scheduleOutboxFlush() {
        guard !isFlushingOutbox, !isLockedOut, connectionStatus.isOnline, let hostID = activeHost?.id,
              !promptOutbox.isLoaded(hostID: hostID) || promptOutbox.hasPending(hostID: hostID) else { return }
        Task { await flushOutbox() }
    }

    /// Sends the active host's `pending` messages one at a time, oldest first, so each session gets them in order. Only
    /// right after a poll reached the PC, and never while Face ID locks the app. Stops at the first that cannot reach the
    /// PC; one the PC refuses is marked failed and the rest go on.
    public func flushOutbox() async {
        guard !isFlushingOutbox, !isLockedOut, connectionStatus.isOnline,
              let hostID = activeHost?.id, let client = activeClient else { return }
        isFlushingOutbox = true
        defer { isFlushingOutbox = false }
        guard await promptOutbox.load(hostID: hostID) else { return }
        var sent = 0, refused = 0
        sending: while !isLockedOut, activeHost?.id == hostID,
                       let next = promptOutbox.items(hostID: hostID).first(where: { $0.state == .pending }) {
            switch await deliverOutboxItem(next.id, hostID: hostID, client: client) {
            case .sent: sent += 1
            case .refused: refused += 1
            case .unreachable, .skipped: break sending
            }
        }
        if refused > 0 {
            showToast(refused == 1
                ? String(localized: "A message written offline was refused by the PC. It is kept above the composer.", bundle: .main)
                : String(localized: "\(refused) messages written offline were refused by the PC. They are kept above the composer.", bundle: .main), isError: true)
        } else if sent > 0 {
            showToast(sent == 1
                ? String(localized: "Sent the message written while the PC was unreachable.", bundle: .main)
                : String(localized: "Sent \(sent) messages written while the PC was unreachable.", bundle: .main))
        }
    }

    /// Send now on one waiting message, whatever its state: the user's own resend, so a failed one (which may have
    /// arrived) goes again too.
    public func sendOutboxItemNow(_ id: UUID) async {
        guard !isLockedOut, let hostID = activeHost?.id, let client = activeClient else { return }
        switch await deliverOutboxItem(id, hostID: hostID, client: client) {
        case .sent:
            notificationManager.triggerHaptic(.lightTap)
            scheduleOutboxFlush()
        case .unreachable(let message), .refused(let message):
            showToast(message, isError: true)
            notificationManager.triggerHaptic(.error)
        case .skipped:
            break
        }
    }

    public func deleteOutboxItem(_ id: UUID) async {
        guard let hostID = activeHost?.id, let item = promptOutbox.item(id, hostID: hostID), item.state != .sending else { return }
        await promptOutbox.remove(id, hostID: hostID)
    }

    /// Takes a waiting message out of the outbox to edit it in the composer; nil while it is being sent.
    public func takeOutboxItem(_ id: UUID) async -> OutboxItem? {
        guard let hostID = activeHost?.id, let item = promptOutbox.item(id, hostID: hostID), item.state != .sending else { return nil }
        await promptOutbox.remove(id, hostID: hostID)
        return item
    }

    private func deliverOutboxItem(_ id: UUID, hostID: UUID, client: CompanionClient) async -> OutboxDelivery {
        guard let item = promptOutbox.item(id, hostID: hostID), item.state != .sending else { return .skipped }
        do {
            // On disk as sending before it is on the wire: if the app ends mid-send, it is never resent on its own.
            try await promptOutbox.update(id, hostID: hostID, state: .sending, lastError: item.lastError)
        } catch {
            let message = String(localized: "The outbox could not be saved on this phone: \(error.localizedDescription)", bundle: .main)
            try? await promptOutbox.update(id, hostID: hostID, state: item.state, lastError: message)
            return .unreachable(message)
        }
        // As the composer decides: a working session queues it as a follow-up, an idle one takes it as a prompt. A
        // session this phone does not know goes as a follow-up, which the PC runs as a prompt when the session is idle.
        let working = snapshot.sessions.first(where: { $0.id == item.sessionID })?.isWorking ?? true
        let previews = item.images.compactMap(\.previewDataURL)
        do {
            let updated = try await client.sendSessionPrompt(
                sessionId: item.sessionID,
                type: working ? "follow_up" : "prompt",
                message: item.text,
                images: item.images.map(\.wireImagePart),
                preview: previews.isEmpty ? nil : previews,
                pdfs: item.pdfs.map(\.wirePromptEntry)
            )
            await promptOutbox.remove(id, hostID: hostID)
            if activeHost?.id == hostID { integrateSession(updated) }
            await clearDeliveredDraft(item, client: client)
            return .sent
        } catch {
            let apiError = (error as? CompanionAPIError) ?? TailscaleDiagnostic.classifyTransport(error, host: activeHost)
            if apiError.kind == .decodingFailed {
                // The PC took it (a 2xx reply) but the reply did not decode: delivered, so it is not kept to send again.
                await promptOutbox.remove(id, hostID: hostID)
                await clearDeliveredDraft(item, client: client)
                if activeHost?.id == hostID { await forceSync() }
                return .sent
            }
            if apiError.definitelyNotDelivered {
                try? await promptOutbox.update(id, hostID: hostID, state: .pending, lastError: apiError.localizedDescription)
                return .unreachable(apiError.localizedDescription)
            }
            if apiError.kind.isConnectivityFailure || apiError.kind == .cancelled {
                let message = PromptOutbox.uncertainDeliveryMessage(apiError)
                try? await promptOutbox.update(id, hostID: hostID, state: .failed, lastError: message)
                return .unreachable(message)
            }
            try? await promptOutbox.update(id, hostID: hostID, state: .failed, lastError: apiError.localizedDescription)
            return .refused(apiError.localizedDescription)
        }
    }

    /// After a delivery, clears the session's host draft while it still holds that message: the same text, or saved
    /// before the message was queued (the phone could not clear it then). A draft written later, elsewhere, stays.
    private func clearDeliveredDraft(_ item: OutboxItem, client: CompanionClient) async {
        let names = item.images.map(\.name) + item.pdfs.map(\.name)
        guard let draft = try? await client.fetchDraft(key: item.draftKey, haveNames: names) else { return }
        guard !draft.text.isEmpty || !draft.images.isEmpty || !(draft.pdfs ?? []).isEmpty else { return }
        let savedBefore = (draft.at ?? 0) <= item.createdAt.timeIntervalSince1970 * 1000
        guard draft.text == item.text || savedBefore else { return }
        _ = try? await client.saveDraft(key: item.draftKey, text: "", images: [], pdfs: [])
    }

    private func localDraftKey(sessionID: String) -> String? {
        guard let hostID = activeHost?.id else { return nil }
        return Self.localDraftDefaultsPrefix + hostID.uuidString + "." + sessionID
    }

    /// The draft text the composer kept on the phone for this session when the PC could not store it.
    public func localDraft(sessionID: String) -> LocalComposerDraft? {
        guard let key = localDraftKey(sessionID: sessionID), let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(LocalComposerDraft.self, from: data)
    }

    /// Keeps a draft's text on the phone; empty text removes it.
    public func setLocalDraft(_ text: String, sessionID: String) {
        guard let key = localDraftKey(sessionID: sessionID) else { return }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            defaults.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(LocalComposerDraft(text: text)) {
            defaults.set(data, forKey: key)
        }
    }

    // MARK: - OMP History Preview Cache

    /// The last preview read for a history file, reused while the file is unchanged so reopening a preview shows it at
    /// once (the sheet still refreshes it). Keyed by file and its `updatedAt`, so a changed file is never shown stale.
    public func cachedNativePreview(file: String, updatedAt: String) -> NativeSessionPreview? {
        guard let entry = nativePreviewCache[file], entry.updatedAt == updatedAt else { return nil }
        return entry.preview
    }

    public func rememberNativePreview(_ preview: NativeSessionPreview, file: String, updatedAt: String) {
        if nativePreviewCache[file] == nil, nativePreviewCache.count >= 12,
           let oldest = nativePreviewCache.min(by: { $0.value.storedAt < $1.value.storedAt })?.key {
            nativePreviewCache.removeValue(forKey: oldest)
        }
        nativePreviewCache[file] = NativePreviewCacheEntry(updatedAt: updatedAt, preview: preview, storedAt: Date())
    }

    public func abortActiveSession() async {
        guard let session = selectedSession, let client = activeClient else { return }
        do {
            let updated = try await client.abortSession(sessionId: session.id, abortRetry: session._retry != nil)
            integrateSession(updated)
            notificationManager.triggerHaptic(.lightTap)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func togglePin(for session: SessionSummary) async {
        if await setPinned(key: session.panelKey, pinned: !isPinned(session)) {
            notificationManager.triggerHaptic(.selection)
        }
    }

    public func toggleArchive(for session: SessionSummary) async {
        if await setArchived(key: session.panelKey, archived: !isArchived(session)) {
            notificationManager.triggerHaptic(.selection)
        }
    }

    /// Pins or unpins any panel key (`s:<id>` for a session, `f:<file>` for an OMP history transcript). The reply's
    /// lists are applied at once, and polls already in flight are dropped so a reply read before the change cannot put
    /// the old lists back; a fresh poll then confirms them.
    @discardableResult
    public func setPinned(key: String, pinned: Bool) async -> Bool {
        guard let client = activeClient else { return false }
        let hostID = activeHostID
        do {
            let res = try await client.setPinned(key: key, pinned: pinned)
            guard hostID == activeHostID else { return false }
            applyListMutation(pinned: res.pinned, archived: res.archived)
            await forceSync()
            return true
        } catch {
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    @discardableResult
    public func setArchived(key: String, archived: Bool) async -> Bool {
        guard let client = activeClient else { return false }
        let hostID = activeHostID
        do {
            let res = try await client.setArchived(key: key, archived: archived)
            guard hostID == activeHostID else { return false }
            applyListMutation(pinned: res.pinned, archived: res.archived)
            await forceSync()
            return true
        } catch {
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    private func applyListMutation(pinned: [String], archived: [String]) {
        pollGeneration &+= 1
        snapshot.pinned = pinned
        snapshot.archived = archived
    }

    public func completeSession(_ session: SessionSummary) async {
        guard let client = activeClient else { return }
        do {
            let updated = try await client.completeSession(sessionId: session.id)
            integrateSession(updated)
            notificationManager.triggerHaptic(.success)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func hideSession(_ session: SessionSummary) async {
        guard let client = activeClient else { return }
        do {
            let updated = try await client.hideSession(sessionId: session.id)
            integrateSession(updated)
            if selectedSessionID == session.id {
                selectedSessionID = nil
                isDetailActiveOnCompact = false
            }
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func renameSession(_ session: SessionSummary, to name: String) async {
        guard let client = activeClient else { return }
        do {
            let updated = try await client.renameSession(sessionId: session.id, name: name)
            integrateSession(updated)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func cacheWorktreeDiff(_ diff: ChangesWorktreeResponse, for sessionID: String) {
        cachedDiffsBySession[sessionID] = diff
    }

    public func updateProjectsOrder(_ order: [String], collapsed: [String]? = nil) async {
        let projectsByID = Dictionary(snapshot.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let normalizedOrder = order.map { projectsByID[$0]?.path ?? $0 }
        await saveUILayout(groupOrder: normalizedOrder, collapsed: collapsed, revertOnFailure: true)
    }

    public func toggleGroupCollapsed(_ key: String, legacyProjectID: String? = nil) async {
        var next = effectiveCollapsed
        let wasCollapsed = isGroupCollapsed(key, legacyProjectID: legacyProjectID)
        next.removeAll {
            SidebarLayoutHelper.isCollapsedMatch($0, groupKey: key, legacyProjectID: legacyProjectID)
        }
        if !wasCollapsed {
            next.append(key)
        }
        notificationManager.triggerHaptic(.selection)
        await saveUILayout(collapsed: next, revertOnFailure: true)
    }

    public func setAllGroupsCollapsed(_ collapsed: Bool, keys: [String]) async {
        guard !keys.isEmpty else { return }
        let projectsByPathNorm = Dictionary(
            snapshot.projects.map { (SidebarLayoutHelper.normalizePathKey($0.path), $0.id) },
            uniquingKeysWith: { first, _ in first }
        )
        var next = effectiveCollapsed
        for key in keys {
            let legacyID = projectsByPathNorm[SidebarLayoutHelper.normalizePathKey(key)]
            next.removeAll {
                SidebarLayoutHelper.isCollapsedMatch($0, groupKey: key, legacyProjectID: legacyID)
            }
            if collapsed {
                next.append(key)
            }
        }
        notificationManager.triggerHaptic(.selection)
        await saveUILayout(collapsed: next, revertOnFailure: true)
    }

    public func moveGroup(key: String, beforeKey: String?, visibleKeys: [String]) async {
        let nextOrder = SidebarLayoutHelper.moveGroup(
            key: key,
            beforeKey: beforeKey,
            currentOrder: effectiveGroupOrder,
            visibleKeys: visibleKeys
        )
        await saveUILayout(groupOrder: nextOrder, revertOnFailure: true)
    }

    public func reconcileGroupOrderIfNeeded(visibleKeys: [String], presentNormalizedKeys: Set<String>) async {
        guard hasReceivedLiveSnapshotForHost, canPerformMutatingActions else { return }
        let result = SidebarLayoutHelper.reconcileGroupOrder(
            saved: effectiveGroupOrder,
            visibleKeys: visibleKeys,
            presentNormalizedKeys: presentNormalizedKeys,
            projects: snapshot.projects,
            allowPrune: hasLoadedNativeSessions
        )
        guard result.didChange, result.order != effectiveGroupOrder else { return }
        await saveUILayout(groupOrder: result.order, revertOnFailure: false)
    }

    public func saveUILayout(groupOrder: [String]? = nil, collapsed: [String]? = nil, revertOnFailure: Bool = true) async {
        guard let client = activeClient else {
            if revertOnFailure {
                showToast(String(localized: "Not connected to companion host.", bundle: .main), isError: true)
            }
            return
        }
        let hostID = activeHostID
        let prevUI = snapshot.ui
        let prevOrderOverride = localGroupOrderOverride
        let prevCollapsedOverride = localCollapsedOverride

        uiMutationSeq &+= 1
        let mySeq = uiMutationSeq
        let now = Date()

        var nextUI = snapshot.ui ?? SidebarUI()
        if let groupOrder {
            localGroupOrderOverride = UILocalOverride(value: groupOrder, updatedAt: now, seq: mySeq)
            nextUI.groupOrder = groupOrder
        }
        if let collapsed {
            localCollapsedOverride = UILocalOverride(value: collapsed, updatedAt: now, seq: mySeq)
            nextUI.collapsed = collapsed
        }
        snapshot.ui = nextUI

        do {
            let saved = try await client.saveUI(groupOrder: groupOrder, collapsed: collapsed)
            guard hostID == activeHostID else { return }
            var merged = snapshot.ui ?? saved
            if groupOrder != nil {
                if localGroupOrderOverride?.seq == mySeq {
                    merged.groupOrder = saved.groupOrder
                    localGroupOrderOverride = UILocalOverride(value: saved.groupOrder ?? groupOrder ?? [], updatedAt: Date(), seq: mySeq)
                }
            } else {
                merged.groupOrder = saved.groupOrder ?? merged.groupOrder
            }
            if collapsed != nil {
                if localCollapsedOverride?.seq == mySeq {
                    merged.collapsed = saved.collapsed
                    localCollapsedOverride = UILocalOverride(value: saved.collapsed ?? collapsed ?? [], updatedAt: Date(), seq: mySeq)
                }
            } else {
                merged.collapsed = saved.collapsed ?? merged.collapsed
            }
            snapshot.ui = merged
            reconcileLocalUIOverrides()
        } catch {
            guard hostID == activeHostID else { return }
            if revertOnFailure {
                var revertedUI = snapshot.ui ?? prevUI ?? SidebarUI()
                if groupOrder != nil && localGroupOrderOverride?.seq == mySeq {
                    localGroupOrderOverride = prevOrderOverride
                    revertedUI.groupOrder = prevOrderOverride?.value ?? prevUI?.groupOrder
                }
                if collapsed != nil && localCollapsedOverride?.seq == mySeq {
                    localCollapsedOverride = prevCollapsedOverride
                    revertedUI.collapsed = prevCollapsedOverride?.value ?? prevUI?.collapsed
                }
                snapshot.ui = revertedUI
            }
            showToast(error.localizedDescription, isError: true)
        }
    }

    private func reconcileLocalUIOverrides() {
        let now = Date()
        if let orderOverride = localGroupOrderOverride {
            let serverOrder = snapshot.ui?.groupOrder ?? []
            let matches = serverOrder.map(SidebarLayoutHelper.normalizePathKey) == orderOverride.value.map(SidebarLayoutHelper.normalizePathKey)
            if matches || now.timeIntervalSince(orderOverride.updatedAt) > 15 {
                localGroupOrderOverride = nil
            }
        }
        if let collapsedOverride = localCollapsedOverride {
            let serverCollapsed = snapshot.ui?.collapsed ?? []
            let matches = Set(serverCollapsed.map(SidebarLayoutHelper.normalizePathKey)) == Set(collapsedOverride.value.map(SidebarLayoutHelper.normalizePathKey))
            if matches || now.timeIntervalSince(collapsedOverride.updatedAt) > 15 {
                localCollapsedOverride = nil
            }
        }
        if let orderOverride = localGroupOrderOverride {
            var ui = snapshot.ui ?? SidebarUI()
            ui.groupOrder = orderOverride.value
            snapshot.ui = ui
        }
        if let collapsedOverride = localCollapsedOverride {
            var ui = snapshot.ui ?? SidebarUI()
            ui.collapsed = collapsedOverride.value
            snapshot.ui = ui
        }
    }

    private func updateUnseenSessions(sessions: [SessionSummary], isInitialSnapshot: Bool) {
        let visible = sessions.filter { $0.hidden != true }
        let viewingID = (scenePhase == .active) ? selectedSessionID : nil

        if !isInitialSnapshot && !priorSessionAttention.isEmpty {
            for s in visible {
                guard let prev = priorSessionAttention[s.id] else { continue }
                let reqCount = s.uiRequests?.count ?? 0
                let ended = prev.status == .running || prev.status == .queued || (s.workFinishedAt != nil && s.workFinishedAt != prev.workFinishedAt)
                let triggered: Bool
                if reqCount > prev.uiRequestCount {
                    triggered = true
                } else if s.status == .error && (prev.status != .error || ended) {
                    triggered = true
                } else if s.status == .review && ended {
                    triggered = true
                } else {
                    triggered = false
                }
                if triggered && s.id != viewingID {
                    unseenSessionIDs.insert(s.id)
                }
            }
        }

        priorSessionAttention = Dictionary(
            visible.map { ($0.id, PriorSessionAttention(status: $0.status, uiRequestCount: $0.uiRequests?.count ?? 0, workFinishedAt: $0.workFinishedAt)) },
            uniquingKeysWith: { _, later in later }
        )

        let byID = Dictionary(visible.map { ($0.id, $0) }, uniquingKeysWith: { _, later in later })
        for id in Array(unseenSessionIDs) {
            guard let s = byID[id] else {
                unseenSessionIDs.remove(id)
                continue
            }
            if id == viewingID || s.status == .done || (s.status == .running && (s.uiRequests?.isEmpty ?? true)) {
                unseenSessionIDs.remove(id)
            }
        }
    }

    public func updateProject(_ project: WorkspaceProject, name: String? = nil, color: String? = nil, hidden: Bool? = nil) async {
        guard let client = activeClient else { return }
        do {
            let updated = try await client.updateProject(id: project.id, name: name, color: color, hidden: hidden)
            if let idx = snapshot.projects.firstIndex(where: { $0.id == updated.id }) {
                snapshot.projects[idx] = updated
            }
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func openInEditor(path: String, cwd: String? = nil, line: Int? = nil) async {
        guard let client = activeClient else { return }
        do {
            let res = try await client.openFile(path: path, cwd: cwd, line: line)
            showToast(String(localized: "Opened \(URL(fileURLWithPath: res.path).lastPathComponent) in \(res.editor)", bundle: .main))
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func openTerminalOnHost(path: String) async {
        guard let client = activeClient else { return }
        do {
            let res = try await client.openTerminal(path: path)
            showToast(String(localized: "Opened terminal in \(res.path)", bundle: .main))
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func setHostEditor(_ editor: String) async {
        guard let client = activeClient else { return }
        do {
            let saved = try await client.setEditor(editor)
            snapshot.editor = saved
            showToast(String(localized: "Saved editor", bundle: .main))
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func setHostEnhanceMode(_ mode: String) async {
        guard let client = activeClient else { return }
        let prev = snapshot.enhanceMode
        snapshot.enhanceMode = mode
        do {
            let saved = try await client.setEnhanceMode(mode)
            snapshot.enhanceMode = saved
        } catch {
            snapshot.enhanceMode = prev
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func setAutoShutdown(on: Bool) async {
        guard let client = activeClient else { return }
        do {
            let state = try await client.setAutoShutdown(on: on)
            snapshot.autoShutdown = state
            notificationManager.triggerHaptic(.selection)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func restartCompanionHost() async {
        guard let client = activeClient else { return }
        let previous = snapshot.instance
        do {
            _ = try await client.restartHost()
            showToast(String(localized: "Companion host restarting…", bundle: .main))
            notificationManager.triggerHaptic(.warning)
            waitForNewInstance(after: previous, upTo: 5 * 60) { [weak self] _ in
                self?.showToast(String(localized: "Companion restarted", bundle: .main))
            }
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    /// The desktop app checks for its own update (Updates & Host Power ▸ Update Desktop App, the web's ⋯ ▸ Update app):
    /// when it finds one it downloads, installs and restarts without asking, and this waits for the new companion.
    public func updateDesktopApp() async {
        guard let client = activeClient else { return }
        let previous = snapshot.instance, previousVersion = snapshot.appVersion ?? ""
        showToast(String(localized: "Checking for updates…", bundle: .main))
        let reply: AppUpdateResponse
        do {
            reply = try await client.startAppUpdate()
        } catch {
            showToast(error.localizedDescription, isError: true)
            return
        }
        switch reply.state {
        case "up-to-date":
            showToast(reply.current.map { String(localized: "OMP Control Room \($0) is up to date.", bundle: .main) }
                ?? String(localized: "OMP Control Room is up to date.", bundle: .main))
        case "error":
            let detail = [reply.error?.title.map { "\($0)." }, reply.error?.advice].compactMap { $0 }.joined(separator: " ")
            showToast(detail.isEmpty ? String(localized: "The update check failed.", bundle: .main) : detail, isError: true)
        case "downloading", "installing":
            showToast(reply.version.map { String(localized: "Updating to \($0). The app restarts when it is ready.", bundle: .main) }
                ?? String(localized: "Updating to the new version. The app restarts when it is ready.", bundle: .main))
            notificationManager.triggerHaptic(.success)
            // The runtime download can be large: up to an hour, as on the web.
            waitForNewInstance(after: previous, upTo: 60 * 60) { [weak self] next in
                let version = next.appVersion ?? ""
                self?.showToast(!version.isEmpty && version != previousVersion
                    ? String(localized: "OMP Control Room updated to \(version)", bundle: .main)
                    : String(localized: "OMP Control Room restarted", bundle: .main))
            }
        default:
            showToast(String(localized: "The update check gave no answer. Try again.", bundle: .main), isError: true)
        }
    }

    /// Polls the tiny GET /api/instance every 3 s (not the whole state) until a companion with another instance id
    /// answers on the active host, then resyncs from scratch at once instead of at the end of the poll backoff.
    private func waitForNewInstance(after previous: String?, upTo seconds: TimeInterval, then done: @escaping (InstanceResponse) -> Void) {
        guard let hostID = activeHostID else { return }
        instanceWaitTask?.cancel()
        instanceWaitTask = Task { [weak self] in
            let end = Date().addingTimeInterval(seconds)
            while Date() < end, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard let self, !Task.isCancelled, self.activeHostID == hostID, let client = self.activeClient else { return }
                guard let reply = try? await client.fetchInstance() else { continue }
                guard reply.instance != previous, self.activeHostID == hostID else { continue }
                self.companionInstanceChanged()
                self.snapshot.instance = reply.instance
                self.snapshot.appVersion = reply.appVersion
                done(reply)
                self.startPolling()
                return
            }
            if !Task.isCancelled, let self, self.activeHostID == hostID {
                self.showToast(String(localized: "The companion did not come back. Check it on that computer.", bundle: .main), isError: true)
            }
        }
    }

    /// A new companion process: forget the old one's delta cursors, ETag and backoff.
    private func companionInstanceChanged() {
        syncReducer.reset()
        lastEtag = nil
        consecutivePollFailures = 0
        lastActivityFetchAt = .distantPast
        lastNativeSessionsFetchAt = .distantPast
    }

    public func shutdownCompanionHost() async {
        guard let client = activeClient else { return }
        do {
            _ = try await client.shutdownHost()
            showToast(String(localized: "Shutdown command sent to host", bundle: .main))
            notificationManager.triggerHaptic(.warning)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }
}
