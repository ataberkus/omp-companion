import SwiftUI

public struct DashboardView: View {
    @Environment(\.ompPalette) var palette
    @Environment(\.horizontalSizeClass) var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @Bindable var store: AppStore

    @AppStorage("omp-group-by") var groupByRaw: String = SidebarGroupBy.project.rawValue
    @AppStorage("omp-focus") var focusedWorkspaceNorm: String = ""

    @State var filter: DashboardSessionFilter = .all
    @State var searchText: String = ""
    @State var renamingSession: SessionSummary?
    @State var renameDraft: String = ""
    @State private var editingActiveHost: HostProfile?
    @State var expandedSubagentSessions: Set<String> = []
    @State var treeViewingSession: SessionSummary?
    @State var draggingGroupNormKey: String?
    @State var dropTargetGroupNormKey: String?
    @State var isDropTargetBottom = false
    @State var derivedCache = DashboardDerivedCache()
    @State var rowLimits: [String: Int] = [:]

    public init(store: AppStore) {
        self.store = store
    }

    public var body: some View {
        List {
            hostHeaderSection

            if case .offline(let cachedAt, let msg, let kind) = store.connectionStatus {
                Section {
                    DiagnosticErrorBanner(
                        title: kind.title,
                        message: (cachedAt.map { String(localized: "Cached \(CompanionFormatters.relativeDate($0.ISO8601Format())). \(msg)", bundle: .main) } ?? msg) + outboxNote,
                        kind: kind,
                        isOfflineCache: true,
                        onRetry: { Task { await store.forceSync() } },
                        onEditHost: { editingActiveHost = store.activeHost }
                    )
                    .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                    .listRowBackground(Color.clear)
                }
            } else if case .error(let msg, let kind) = store.connectionStatus {
                Section {
                    DiagnosticErrorBanner(
                        title: kind.title,
                        message: msg + outboxNote,
                        kind: kind,
                        isOfflineCache: false,
                        onRetry: { Task { await store.forceSync() } },
                        onEditHost: { editingActiveHost = store.activeHost }
                    )
                    .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                    .listRowBackground(Color.clear)
                }
            }

            Section {
                controlsHeaderBlock
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
            }

            if store.isInitialLoading && store.snapshot.sessions.isEmpty {
                Section {
                    SkeletonListPlaceholder(count: 5)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
            } else if isFailedWithoutData {
                // The error banner above explains why the list is empty.
                EmptyView()
            } else if groupBy == .time {
                timeGroupedSections(timeGroups)
            } else {
                projectGroupedSections(groups: orderedProjectGroups, attention: attentionItems)
            }

            navigationShortcutsSection
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search sessions… (in:workspace)")
        .refreshable {
            await store.forceSync()
            await store.refreshNativeSessions(force: true)
            await store.probeAllHosts()
        }
        .navigationTitle("OMP Control")
        .navigationBarTitleDisplayMode(.large)
        .task(id: reconcileTriggerKey) {
            guard draggingGroupNormKey == nil,
                  groupBy == .project,
                  filter == .all,
                  parsedSearch.isEmpty,
                  focusedWorkspaceNorm.isEmpty else { return }
            await store.reconcileGroupOrderIfNeeded(
                visibleKeys: visibleProjectOrderKeys,
                presentNormalizedKeys: presentNormalizedWorkspaceKeys
            )
        }
        .task(id: "\(draggingGroupNormKey ?? "")|\(dropTargetGroupNormKey ?? "")|\(isDropTargetBottom)") {
            guard draggingGroupNormKey != nil,
                  dropTargetGroupNormKey == nil,
                  !isDropTargetBottom else { return }
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard !Task.isCancelled else { return }
            draggingGroupNormKey = nil
            dropTargetGroupNormKey = nil
            isDropTargetBottom = false
        }
        .onChange(of: canReorderProjectsOnDashboard) { _, canReorder in
            if !canReorder {
                draggingGroupNormKey = nil
                dropTargetGroupNormKey = nil
                isDropTargetBottom = false
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    store.isHostSwitcherPresented = true
                } label: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(connectionDotColor)
                            .frame(width: 8, height: 8)
                        Text(store.activeHost?.name ?? "Hosts")
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                    }
                }
                .accessibilityLabel("Switch companion host")
            }

            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    store.isQuickSwitcherPresented = true
                } label: {
                    Image(systemName: "magnifyingglass.circle")
                }
                .accessibilityLabel("Quick Switcher")

                Menu {
                    Button {
                        Task { await store.setAllGroupsCollapsed(true, keys: allCollapsibleGroupKeys) }
                    } label: {
                        Label("Collapse All", systemImage: "rectangle.compress.vertical")
                    }
                    .disabled(!store.canPerformMutatingActions)

                    Button {
                        Task { await store.setAllGroupsCollapsed(false, keys: allCollapsibleGroupKeys) }
                    } label: {
                        Label("Expand All", systemImage: "rectangle.expand.vertical")
                    }
                    .disabled(!store.canPerformMutatingActions)

                    Divider()

                    Picker("Group by", selection: $groupByRaw) {
                        ForEach(SidebarGroupBy.allCases) { mode in
                            Text(mode.label).tag(mode.rawValue)
                        }
                    }

                    if !focusedWorkspaceNorm.isEmpty {
                        Button {
                            focusedWorkspaceNorm = ""
                        } label: {
                            Label("Show All Workspaces", systemImage: "line.3.horizontal.decrease.circle")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Sidebar Layout Options")

                Button {
                    store.presentQuickStart(projectPath: focusedWorkspaceOriginalPath)
                } label: {
                    Image(systemName: "plus.circle.fill")
                }
                .disabled(!store.canPerformMutatingActions)
                .accessibilityLabel("New Session")
            }
        }
        .sheet(item: $editingActiveHost) { host in
            HostSetupView(store: store, editingHost: host)
        }
        .sheet(item: $treeViewingSession) { session in
            TreeViewerSheet(store: store, session: session)
        }
        .alert("Rename Session", isPresented: Binding(
            get: { renamingSession != nil },
            set: { if !$0 { renamingSession = nil } }
        )) {
            TextField("Session Title", text: $renameDraft)
            Button("Save") {
                if let target = renamingSession {
                    let clean = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !clean.isEmpty {
                        Task { await store.renameSession(target, to: clean) }
                    }
                }
                renamingSession = nil
            }
            Button("Cancel", role: .cancel) { renamingSession = nil }
        }
    }

    private var connectionDotColor: Color {
        switch store.connectionStatus {
        case .connected: return palette.green
        case .connecting: return palette.amber
        case .offline: return palette.amber
        case .error, .disconnected: return palette.red
        }
    }

    func hostStatusSubtitle(_ host: HostProfile) -> String {
        switch store.connectionStatus {
        case .connected:
            if case .reachable(let ms) = store.reachabilityByHost[host.id] {
                return "\(host.hostDisplay) · \(ms) ms"
            }
            return "\(host.hostDisplay) · Connected"
        case .connecting:
            return "\(host.hostDisplay) · Connecting…"
        case .offline:
            return "\(host.hostDisplay) · Offline Cache"
        case .error:
            return "\(host.hostDisplay) · Error"
        case .disconnected:
            return host.hostDisplay
        }
    }

    func attentionReason(for session: SessionSummary) -> String? {
        if let req = session.uiRequests?.first {
            return "Needs input: \(req.title ?? req.method)"
        }
        if session.hasPlanReviewPending {
            return "Plan ready for approval"
        }
        if session.status == .error {
            return session.error ?? "Session failed"
        }
        if session.status == .review {
            return "Finished turn — ready for review"
        }
        if store.isSessionUnseen(session) {
            return "Updated since you last looked"
        }
        return nil
    }

    private var isFailedWithoutData: Bool {
        guard store.snapshot.sessions.isEmpty else { return false }
        if case .error = store.connectionStatus { return true }
        return false
    }

    var emptyStateTitle: String {
        if !parsedSearch.isEmpty { return String(localized: "No Matching Sessions", bundle: .main) }
        if !focusedWorkspaceNorm.isEmpty { return String(localized: "No Sessions in Workspace", bundle: .main) }
        switch filter {
        case .all: return String(localized: "No Sessions Yet", bundle: .main)
        case .active: return String(localized: "Nothing Running Right Now", bundle: .main)
        case .inPanel: return String(localized: "No Panel Sessions", bundle: .main)
        case .archived: return String(localized: "No Archived Sessions", bundle: .main)
        }
    }

    var emptyStateMessage: String {
        if !parsedSearch.isEmpty { return String(localized: "Try another keyword or in:<folder> scope, or clear your search.", bundle: .main) }
        if !focusedWorkspaceNorm.isEmpty { return String(localized: "Start a session in this workspace or clear the workspace focus filter.", bundle: .main) }
        switch filter {
        case .all: return String(localized: "Start a session in any workspace folder or resume an existing OMP transcript.", bundle: .main)
        case .active: return String(localized: "Running turns and sessions needing attention appear here.", bundle: .main)
        case .inPanel: return String(localized: "Sessions opened or started in OMP Control Room appear here.", bundle: .main)
        case .archived: return String(localized: "Archived sessions and hidden workspaces stay out of the main sidebar until restored.", bundle: .main)
        }
    }
}
