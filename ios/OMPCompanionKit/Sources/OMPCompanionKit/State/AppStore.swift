import Foundation
import Observation
import SwiftUI

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

@Observable
@MainActor
public final class AppStore {
    // MARK: - Persistence & Dependencies
    private let credentialStore: CredentialStore
    private let offlineCache: OfflineCache
    private let urlSession: URLSession
    private let syncReducer = SyncDeltaReducer()

    public let biometricLock = BiometricLock()
    public let notificationManager = NotificationManager()

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
    public private(set) var advisorConfig: AdvisorConfigResponse?

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
            UserDefaults.standard.set(themePreference.rawValue, forKey: Self.themeDefaultsKey)
        }
    }

    // MARK: - Private Polling Runtime
    private var scenePhase: ScenePhase = .active
    private var wasBackgrounded = false
    private var pollTask: Task<Void, Never>?
    private var lastEtag: String?
    private var nativeSessionsEtag: String?
    private var lastCacheSaveAt: Date = .distantPast
    private var hasReceivedLiveSnapshotForHost = false
    private var lastActivityFetchAt: Date = .distantPast
    private var lastNativeSessionsFetchAt: Date = .distantPast
    private var priorDroppedSteerIds: Set<String> = []
    private var toastDismissTask: Task<Void, Never>?

    private static let hostsDefaultsKey = "omp.hosts.v1"
    private static let activeHostDefaultsKey = "omp.activeHostID.v1"
    private static let themeDefaultsKey = "omp.themePreference.v1"

    public init(
        credentialStore: CredentialStore = KeychainStore(),
        offlineCache: OfflineCache = OfflineCache(),
        urlSession: URLSession = CompanionClient.defaultURLSession()
    ) {
        self.credentialStore = credentialStore
        self.offlineCache = offlineCache
        self.urlSession = urlSession
        if let rawTheme = UserDefaults.standard.string(forKey: Self.themeDefaultsKey),
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
        let archivedSet = Set(snapshot.archived.compactMap { $0.hasPrefix("s:") ? String($0.dropFirst(2)) : nil })
        return snapshot.sessions.filter { s in
            s.hidden != true && !archivedSet.contains(s.id) && s.needsAttention
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

    // MARK: - Lifecycle & Scene Handling

    public func bootstrap() async {
        if biometricLock.isEnabled && biometricLock.isLocked {
            _ = await biometricLock.unlock()
        }
        if let host = activeHost {
            await hydrateOfflineCache(for: host.id)
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
            if resumed && biometricLock.isEnabled && biometricLock.isLocked {
                _ = await biometricLock.unlock()
            }
            if activeHost != nil {
                startPolling()
                await forceSync()
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
            showToast("Unsupported link format.", isError: true)
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
        if let data = UserDefaults.standard.data(forKey: Self.hostsDefaultsKey),
           let decoded = try? JSONDecoder().decode([HostProfile].self, from: data) {
            hosts = decoded.sorted { $0.sortOrder < $1.sortOrder }
        }
        if let rawID = UserDefaults.standard.string(forKey: Self.activeHostDefaultsKey),
           let id = UUID(uuidString: rawID),
           hosts.contains(where: { $0.id == id }) {
            activeHostID = id
        } else {
            activeHostID = hosts.first?.id
        }
    }

    private func persistHostMetadata() {
        if let data = try? JSONEncoder().encode(hosts) {
            UserDefaults.standard.set(data, forKey: Self.hostsDefaultsKey)
        }
        if let activeHostID {
            UserDefaults.standard.set(activeHostID.uuidString, forKey: Self.activeHostDefaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.activeHostDefaultsKey)
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
            throw CompanionAPIError(kind: authKind == .remotePassword ? .wrongPassword : .invalidToken, serverMessage: "Enter a token or password.")
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

        if selectAsActive {
            await selectHost(profile.id)
        } else {
            Task { await probeHost(profile.id) }
        }
        return profile
    }

    public func deleteHost(_ id: UUID) async {
        try? credentialStore.deleteSecret(for: id)
        await offlineCache.clear(hostID: id)
        hosts.removeAll { $0.id == id }
        reachabilityByHost.removeValue(forKey: id)
        notificationManager.resetTracking(for: id)

        if activeHostID == id {
            activeHostID = hosts.first?.id
            syncReducer.reset()
            lastEtag = nil
            snapshot = StoreSnapshot()
            activityItems = []
            selectedSessionID = nil
            isDetailActiveOnCompact = false
            persistHostMetadata()
            if let nextID = activeHostID {
                await hydrateOfflineCache(for: nextID)
                startPolling()
                await forceSync()
            } else {
                stopPolling()
                connectionStatus = .disconnected
            }
        } else {
            persistHostMetadata()
        }
    }

    public func selectHost(_ hostID: UUID) async {
        guard hosts.contains(where: { $0.id == hostID }) else { return }
        if activeHostID == hostID, pollTask != nil {
            await forceSync()
            return
        }
        await persistOfflineCacheNow()
        stopPolling()
        activeHostID = hostID
        persistHostMetadata()

        syncReducer.reset()
        lastEtag = nil
        nativeSessionsEtag = nil
        lastNativeSessionsFetchAt = .distantPast
        hasReceivedLiveSnapshotForHost = false
        selectedSessionID = nil
        isDetailActiveOnCompact = false
        selectedSessionTab = .chat
        snapshot = StoreSnapshot()
        activityItems = []
        nativeSessions = []
        nativeSessionsDir = nil
        advisorConfig = nil
        cachedDiffsBySession = [:]
        availableModels = []
        commandsBySession = [:]
        commandsByPath = [:]
        priorDroppedSteerIds = []

        await hydrateOfflineCache(for: hostID)
        startPolling()
        await forceSync()
        Task { await refreshModelsAndActivity() }
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
        if let cached = await offlineCache.load(hostID: hostID) {
            snapshot = await offlineCache.hydratedSnapshot(from: cached)
            activityItems = cached.activity
            cachedDiffsBySession = cached.diffs
            connectionStatus = .offline(
                cachedAt: cached.savedAt,
                errorMessage: "Showing cached snapshot until connected",
                errorKind: .tailscaleInactiveOrUnreachable
            )
        } else {
            connectionStatus = .connecting
        }
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
        guard activeHost != nil, scenePhase == .active else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.pollOnce()
                let anyWorking = self.snapshot.sessions.contains { $0.isWorking || !(self.selectedSession?.uiRequests?.isEmpty ?? true) }
                let delayNs: UInt64 = anyWorking ? 1_200_000_000 : 4_500_000_000
                try? await Task.sleep(nanoseconds: delayNs)
            }
        }
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

    public func pollOnce() async {
        guard let host = activeHost, let client = activeClient else {
            connectionStatus = .disconnected
            return
        }
        if !hasReceivedLiveSnapshotForHost && snapshot.sessions.isEmpty {
            isInitialLoading = true
        }
        defer { isInitialLoading = false }

        do {
            let sid = selectedSessionID
            let result = try await client.fetchState(
                sessionId: sid,
                since: syncReducer.sinceToken(for: sid),
                storeToken: syncReducer.storeToken,
                orderDelta: true,
                etag: lastEtag
            )

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
                snapshot = nextSnapshot
                connectionStatus = .connected
                reachabilityByHost[host.id] = .reachable(latencyMs: host.lastLatencyMs ?? 15)

                if let idx = hosts.firstIndex(where: { $0.id == host.id }) {
                    hosts[idx].lastConnectedAt = Date()
                    persistHostMetadata()
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

            if Date().timeIntervalSince(lastNativeSessionsFetchAt) > 20 {
                Task { await refreshNativeSessions() }
            }
        } catch let apiError as CompanionAPIError {
            if apiError.kind == .cancelled { return }
            reachabilityByHost[host.id] = .unreachable(apiError.localizedDescription)
            if hasReceivedLiveSnapshotForHost || !snapshot.sessions.isEmpty {
                let cachedAt = await offlineCache.load(hostID: host.id)?.savedAt
                connectionStatus = .offline(
                    cachedAt: cachedAt,
                    errorMessage: apiError.localizedDescription,
                    errorKind: apiError.kind
                )
            } else {
                connectionStatus = .error(errorMessage: apiError.localizedDescription, errorKind: apiError.kind)
            }
        } catch {
            let apiError = TailscaleDiagnostic.classifyTransport(error, host: host)
            reachabilityByHost[host.id] = .unreachable(apiError.localizedDescription)
            connectionStatus = .error(errorMessage: apiError.localizedDescription, errorKind: apiError.kind)
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
        guard let client = activeClient else { return }
        async let modelsTask: Void = refreshModels()
        async let nativeTask: Void = refreshNativeSessions(force: true)
        async let advisorTask: Void = refreshAdvisorConfig()
        async let tsTask: Void = refreshTailscaleInfo()
        _ = await (modelsTask, nativeTask, advisorTask, tsTask)
    }

    private func refreshTailscaleInfo() async {
        guard let client = activeClient else { return }
        if let ts = try? await client.fetchTailscaleInfo() {
            lastTailscaleInfo = ts
            if let activeID = activeHostID, let idx = hosts.firstIndex(where: { $0.id == activeID }) {
                hosts[idx].magicDNS = ts.tailscale?.name
                hosts[idx].tailscaleIPv4 = ts.tailscale?.ips?.first(where: { !$0.contains(":") })
                hosts[idx].tailscaleIPv6 = ts.tailscale?.ips?.first(where: { $0.contains(":") })
                persistHostMetadata()
            }
        }
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

    public func refreshNativeSessions(force: Bool = false) async {
        guard let client = activeClient else { return }
        if force { nativeSessionsEtag = nil }
        lastNativeSessionsFetchAt = Date()
        if nativeSessions.isEmpty { isLoadingNativeSessions = true }
        defer { isLoadingNativeSessions = false }
        if let res = try? await client.fetchOmpSessions(etag: nativeSessionsEtag) {
            switch res {
            case .notModified:
                break
            case .updated(let data, let tag):
                nativeSessionsEtag = tag
                nativeSessionsDir = data.dir
                nativeSessions = data.sessions
            }
        }
    }

    public func refreshActivityOnly() async {
        guard let client = activeClient else { return }
        lastActivityFetchAt = Date()
        if let full = try? await client.fetchFullState() {
            activityItems = full.activity ?? []
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
        guard let client = activeClient else { return }
        let target = !isPinned(session)
        do {
            let res = try await client.setPinned(key: session.panelKey, pinned: target)
            snapshot.pinned = res.pinned
            snapshot.archived = res.archived
            notificationManager.triggerHaptic(.selection)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func toggleArchive(for session: SessionSummary) async {
        guard let client = activeClient else { return }
        let target = !isArchived(session)
        do {
            let res = try await client.setArchived(key: session.panelKey, archived: target)
            snapshot.pinned = res.pinned
            snapshot.archived = res.archived
            notificationManager.triggerHaptic(.selection)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
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
        guard let client = activeClient else { return }
        do {
            let ui = try await client.saveUI(groupOrder: order, collapsed: collapsed)
            snapshot.ui = ui
        } catch {
            showToast(error.localizedDescription, isError: true)
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
            showToast("Opened \(URL(fileURLWithPath: res.path).lastPathComponent) in \(res.editor)")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func openTerminalOnHost(path: String) async {
        guard let client = activeClient else { return }
        do {
            let res = try await client.openTerminal(path: path)
            showToast("Opened terminal in \(res.path)")
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func setHostEditor(_ editor: String) async {
        guard let client = activeClient else { return }
        do {
            let saved = try await client.setEditor(editor)
            snapshot.editor = saved
            showToast("Saved editor")
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
        do {
            _ = try await client.restartHost()
            showToast("Companion host restarting…")
            notificationManager.triggerHaptic(.warning)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    public func shutdownCompanionHost() async {
        guard let client = activeClient else { return }
        do {
            _ = try await client.shutdownHost()
            showToast("Shutdown command sent to host")
            notificationManager.triggerHaptic(.warning)
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }
}
