import SwiftUI

public enum DashboardSessionFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case active
    case idle
    case pinned
    case archived

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .all: return "All"
        case .active: return "Active"
        case .idle: return "Idle"
        case .pinned: return "Pinned"
        case .archived: return "Archived"
        }
    }
}

public struct DashboardView: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var store: AppStore

    @State private var filter: DashboardSessionFilter = .all
    @State private var searchText: String = ""
    @State private var renamingSession: SessionSummary?
    @State private var renameDraft: String = ""
    @State private var editingActiveHost: HostProfile?
    @State private var expandedSubagentSessions: Set<String> = []
    @State private var treeViewingSession: SessionSummary?

    public init(store: AppStore) {
        self.store = store
    }

    private var searchQuery: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func matchesSearch(_ session: SessionSummary) -> Bool {
        let q = searchQuery
        guard !q.isEmpty else { return true }
        let projName = store.project(for: session)?.name.lowercased() ?? ""
        return session.title.lowercased().contains(q)
            || session.cwd.lowercased().contains(q)
            || (session.branch?.lowercased().contains(q) ?? false)
            || (session.model?.lowercased().contains(q) ?? false)
            || projName.contains(q)
    }

    private var filteredSessions: [SessionSummary] {
        let base: [SessionSummary]
        switch filter {
        case .all:
            base = store.visibleSessions
        case .active:
            base = store.visibleSessions.filter { $0.isWorking || $0.needsAttention }
        case .idle:
            base = store.visibleSessions.filter { !$0.isWorking && !$0.needsAttention }
        case .pinned:
            base = store.pinnedSessions
        case .archived:
            base = store.archivedSessions
        }
        return base.filter(matchesSearch)
    }

    private var needsAttentionList: [SessionSummary] {
        guard filter == .all else { return [] }
        return store.attentionSessions.filter(matchesSearch)
    }

    private var pinnedList: [SessionSummary] {
        guard filter == .all else { return [] }
        let attnIDs = Set(needsAttentionList.map(\.id))
        return store.pinnedSessions.filter { !attnIDs.contains($0.id) && matchesSearch($0) }
    }

    private var orderedProjects: [WorkspaceProject] {
        let projects = store.visibleProjects
        guard let order = store.snapshot.ui?.groupOrder, !order.isEmpty else {
            return projects
        }
        let byID = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
        var sorted: [WorkspaceProject] = []
        var seen = Set<String>()
        for id in order {
            if let p = byID[id] {
                sorted.append(p)
                seen.insert(id)
            }
        }
        for p in projects where !seen.contains(p.id) {
            sorted.append(p)
        }
        return sorted
    }

    private var ungroupedSessions: [SessionSummary] {
        let projIDs = Set(orderedProjects.map(\.id))
        let excludedIDs = Set((needsAttentionList + pinnedList).map(\.id))
        return filteredSessions.filter { s in
            !excludedIDs.contains(s.id) && (s.projectId == nil || !projIDs.contains(s.projectId ?? ""))
        }
    }

    private func sessions(for project: WorkspaceProject) -> [SessionSummary] {
        let excludedIDs = Set((needsAttentionList + pinnedList).map(\.id))
        return filteredSessions.filter { s in
            !excludedIDs.contains(s.id) && s.projectId == project.id
        }
    }

    private var collapsedProjectIDs: Set<String> {
        Set(store.snapshot.ui?.collapsed ?? [])
    }

    public var body: some View {
        List {
            hostHeaderSection

            if case .offline(let cachedAt, let msg, let kind) = store.connectionStatus {
                Section {
                    DiagnosticErrorBanner(
                        title: kind.title,
                        message: cachedAt.map { "Cached \(CompanionFormatters.relativeDate($0.ISO8601Format())). \(msg)" } ?? msg,
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
                        message: msg,
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
                filterChipStrip
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
            }

            if store.isInitialLoading && store.snapshot.sessions.isEmpty {
                Section {
                    SkeletonListPlaceholder(count: 5)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
            } else if filteredSessions.isEmpty {
                Section {
                    OMPEmptyStateView(
                        systemImage: filter == .archived ? "archivebox" : "bubble.left.and.bubble.right",
                        title: emptyStateTitle,
                        message: emptyStateMessage,
                        actionTitle: filter == .all ? "Start New Session" : nil
                    ) {
                        store.presentQuickStart()
                    }
                    .listRowBackground(Color.clear)
                }
            } else if filter != .all {
                Section("\(filter.label) (\(filteredSessions.count))") {
                    ForEach(filteredSessions) { session in
                        sessionRow(session)
                    }
                }
            } else {
                if !needsAttentionList.isEmpty {
                    Section {
                        ForEach(needsAttentionList) { session in
                            sessionRow(session, emphasizeAttention: true)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Image(systemName: "bell.badge.fill")
                                .foregroundStyle(palette.amber)
                            Text("Needs Attention (\(needsAttentionList.count))")
                                .foregroundStyle(palette.amber)
                        }
                    }
                }

                if !pinnedList.isEmpty {
                    Section {
                        ForEach(pinnedList) { session in
                            sessionRow(session)
                        }
                    } header: {
                        Label("Pinned (\(pinnedList.count))", systemImage: "pin.fill")
                    }
                }

                ForEach(orderedProjects) { project in
                    let groupSessions = sessions(for: project)
                    if !groupSessions.isEmpty || searchQuery.isEmpty {
                        let isCollapsed = collapsedProjectIDs.contains(project.id)
                        Section {
                            if !isCollapsed {
                                if groupSessions.isEmpty {
                                    HStack {
                                        Text("No active sessions in \(project.name)")
                                            .font(.caption)
                                            .foregroundStyle(palette.muted)
                                        Spacer()
                                        Button("Start") {
                                            store.presentQuickStart(projectPath: project.path)
                                        }
                                        .font(.caption.weight(.semibold))
                                        .buttonStyle(.borderless)
                                        .disabled(!store.canPerformMutatingActions)
                                    }
                                    .listRowBackground(palette.card)
                                } else {
                                    ForEach(groupSessions) { session in
                                        sessionRow(session)
                                    }
                                }
                            }
                        } header: {
                            projectSectionHeader(project, count: groupSessions.count, collapsed: isCollapsed)
                        }
                    }
                }

                if !ungroupedSessions.isEmpty {
                    Section("Other Sessions (\(ungroupedSessions.count))") {
                        ForEach(ungroupedSessions) { session in
                            sessionRow(session)
                        }
                    }
                }
            }

            navigationShortcutsSection
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .searchable(text: $searchText, prompt: "Search sessions, branches, models…")
        .refreshable {
            await store.forceSync()
            await store.probeAllHosts()
        }
        .navigationTitle("OMP Control")
        .navigationBarTitleDisplayMode(.large)
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

                Button {
                    store.presentQuickStart()
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

    @ViewBuilder
    private var hostHeaderSection: some View {
        if let host = store.activeHost {
            Section {
                HStack(spacing: 10) {
                    Button {
                        store.isHostSwitcherPresented = true
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: host.endpointKind.isTailscale ? "network.badge.shield.half.filled" : "desktopcomputer")
                                .font(.title3)
                                .foregroundStyle(palette.accent)
                                .frame(width: 34, height: 34)
                                .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: 8))

                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(host.name)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(palette.foreground)
                                    Text(host.endpointKind.badge)
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 1)
                                        .background(palette.raised, in: Capsule())
                                        .foregroundStyle(host.endpointKind.isTailscale ? palette.green : palette.amber)
                                }
                                Text(hostStatusSubtitle(host))
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(palette.muted)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                        }
                    }
                    .buttonStyle(.plain)
                    .minTouchTarget()
                }
                .listRowBackground(palette.card)
            }
        }
    }

    @ViewBuilder
    private func projectSectionHeader(_ project: WorkspaceProject, count: Int, collapsed: Bool) -> some View {
        HStack(spacing: 8) {
            Button {
                Task { await toggleCollapse(project.id) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(palette.muted)
                    Circle()
                        .fill(Color.fromCSS(project.color))
                        .frame(width: 9, height: 9)
                    Text(project.name)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(palette.foreground)
                    if let branch = project.branch, !branch.isEmpty {
                        Text(branch)
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.accent)
                    }
                    Text("(\(count))")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
            }
            .buttonStyle(.plain)

            Spacer()

            Button {
                store.presentQuickStart(projectPath: project.path)
            } label: {
                Image(systemName: "plus.circle")
                    .font(.caption)
                    .foregroundStyle(palette.accent)
            }
            .buttonStyle(.plain)
            .disabled(!store.canPerformMutatingActions)
            .accessibilityLabel("New session in \(project.name)")
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: SessionSummary, emphasizeAttention: Bool = false) -> some View {
        let isSelected = horizontalSizeClass == .regular && store.selectedSessionID == session.id
        let isPinned = store.isPinned(session)
        let isArchived = store.isArchived(session)

        VStack(alignment: .leading, spacing: 6) {
            Button {
                Task { await store.selectSession(session.id, tab: .chat, openDetail: true) }
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .top, spacing: 8) {
                        StatusPill(status: session.status, compact: false)

                        Text(session.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)

                        Spacer(minLength: 4)

                        if isPinned {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(palette.accent)
                        }
                        Text(CompanionFormatters.relativeDate(session.updatedAt))
                            .font(.caption2)
                            .foregroundStyle(palette.muted)
                    }

                    if let reason = attentionReason(for: session) {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.bubble.fill")
                                .font(.caption2)
                            Text(reason)
                                .font(.caption2.weight(.medium))
                                .lineLimit(1)
                        }
                        .foregroundStyle(session.status == .error ? palette.red : palette.amber)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)

            HStack(spacing: 8) {
                if let branch = session.branch, !branch.isEmpty {
                    Label(branch, systemImage: session.isolated == true ? "arrow.triangle.branch" : "point.topleft.down.curvedto.point.bottomright.up")
                        .font(.caption2.monospaced())
                        .foregroundStyle(session.isolated == true ? palette.green : palette.muted)
                        .lineLimit(1)
                }
                if let model = session.effectiveModelSelector {
                    Text(model.split(separator: "/").last.map(String.init) ?? model)
                        .font(.caption2.monospaced())
                        .foregroundStyle(palette.muted)
                        .lineLimit(1)
                }
                if session.resolvedSubagentCount > 0 {
                    let hasChildren = !(session.subagentList ?? []).isEmpty
                    let isExpanded = expandedSubagentSessions.contains(session.id)
                    if hasChildren {
                        Button {
                            withAnimation(.easeInOut(duration: 0.16)) {
                                if isExpanded {
                                    expandedSubagentSessions.remove(session.id)
                                } else {
                                    expandedSubagentSessions.insert(session.id)
                                }
                            }
                        } label: {
                            Label("\(session.resolvedSubagentCount)", systemImage: isExpanded ? "chevron.down.circle.fill" : "cpu")
                                .font(.caption2.monospaced())
                                .foregroundStyle(palette.cyan)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(palette.raised, in: Capsule())
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(isExpanded ? "Collapse subagents" : "Expand subagents")
                    } else {
                        Label("\(session.resolvedSubagentCount)", systemImage: "cpu")
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.cyan)
                    }
                }
                Spacer(minLength: 0)
                if let cost = session.cost, cost > 0 {
                    Text(CompanionFormatters.formatCost(cost))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.muted)
                }
            }

            if expandedSubagentSessions.contains(session.id), let subs = session.subagentList, !subs.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(subs.prefix(8)) { sub in
                        Button {
                            Task { await store.selectSession(session.id, tab: .subagents, openDetail: true) }
                        } label: {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(sub.isActive ? palette.amber : palette.green)
                                    .frame(width: 6, height: 6)
                                Text(sub.agent ?? "subagent")
                                    .font(.caption2.monospaced().weight(.semibold))
                                    .foregroundStyle(palette.cyan)
                                Text(sub.description ?? sub.id)
                                    .font(.caption2)
                                    .foregroundStyle(palette.muted)
                                    .lineLimit(1)
                                Spacer()
                                Text(sub.status)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(palette.muted)
                            }
                            .padding(.vertical, 2)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                    }
                }
                .padding(.leading, 10)
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(
            isSelected
                ? palette.accentSoft
                : (emphasizeAttention ? palette.amberSoft.opacity(0.45) : palette.card)
        )
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                Task { await store.togglePin(for: session) }
            } label: {
                Label(isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash" : "pin")
            }
            .tint(palette.accent)
            .disabled(!store.canPerformMutatingActions)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if session.isWorking {
                Button(role: .destructive) {
                    Task {
                        guard let client = store.activeClient else { return }
                        if let updated = try? await client.abortSession(sessionId: session.id, abortRetry: session._retry != nil) {
                            store.integrateSession(updated)
                        }
                    }
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .disabled(!store.canPerformMutatingActions)
            } else {
                Button {
                    Task { await store.toggleArchive(for: session) }
                } label: {
                    Label(isArchived ? "Restore" : "Archive", systemImage: isArchived ? "tray.and.arrow.up" : "archivebox")
                }
                .tint(palette.amber)
                .disabled(!store.canPerformMutatingActions)
            }

            Button {
                renameDraft = session.title
                renamingSession = session
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            .tint(palette.violet)
            .disabled(!store.canPerformMutatingActions)
        }
        .contextMenu {
            Button {
                Task { await store.selectSession(session.id, tab: .chat) }
            } label: {
                Label("Open Chat", systemImage: "bubble.left.and.bubble.right")
            }
            Button {
                Task { await store.selectSession(session.id, tab: .changes) }
            } label: {
                Label("Inspect Diffs", systemImage: "doc.text.magnifyingglass")
            }
            Button {
                Task { await store.selectSession(session.id, tab: .todos) }
            } label: {
                Label("Todos & Plan", systemImage: "checklist")
            }
            Button {
                Task { await store.selectSession(session.id, tab: .subagents) }
            } label: {
                Label("Subagents", systemImage: "cpu")
            }
            Button {
                treeViewingSession = session
            } label: {
                Label("Conversation Tree", systemImage: "point.3.connected.trianglepath.dotted")
            }
            Divider()
            Button {
                Task { await store.togglePin(for: session) }
            } label: {
                Label(isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash" : "pin")
            }
            Button {
                renameDraft = session.title
                renamingSession = session
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            if !session.isWorking {
                Button {
                    Task { await store.toggleArchive(for: session) }
                } label: {
                    Label(isArchived ? "Restore" : "Archive", systemImage: isArchived ? "tray.and.arrow.up" : "archivebox")
                }
            }
            Button(role: .destructive) {
                Task { await store.hideSession(session) }
            } label: {
                Label("Hide from Sidebar", systemImage: "eye.slash")
            }
        }
    }

    private var filterChipStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(DashboardSessionFilter.allCases) { item in
                    let isSelected = filter == item
                    let count = count(for: item)
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            filter = item
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Text(item.label)
                                .font(.caption.weight(.semibold))
                            if count > 0 || item == .all {
                                Text("\(count)")
                                    .font(.caption2.monospacedDigit().weight(.bold))
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(isSelected ? Color.white.opacity(0.22) : palette.raised, in: Capsule())
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(isSelected ? palette.accent : palette.card, in: Capsule())
                        .foregroundStyle(isSelected ? .white : palette.foreground)
                        .overlay(
                            Capsule().stroke(isSelected ? palette.accent : palette.border, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.borderless)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 2)
        }
    }

    private func count(for item: DashboardSessionFilter) -> Int {
        switch item {
        case .all:
            return store.visibleSessions.count
        case .active:
            return store.visibleSessions.filter { $0.isWorking || $0.needsAttention }.count
        case .idle:
            return store.visibleSessions.filter { !$0.isWorking && !$0.needsAttention }.count
        case .pinned:
            return store.pinnedSessions.count
        case .archived:
            return store.archivedSessions.count
        }
    }

    private var navigationShortcutsSection: some View {
        Section("Host & Control Room") {
            Button {
                store.isActivityPresented = true
                Task { await store.refreshActivityOnly() }
            } label: {
                HStack {
                    Label("Activity Feed", systemImage: "bell.badge")
                        .foregroundStyle(palette.foreground)
                    Spacer()
                    let errors = store.activityItems.filter { $0.type == "error" }.count
                    if errors > 0 {
                        Text("\(errors) errors")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(palette.redSoft, in: Capsule())
                            .foregroundStyle(palette.red)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                }
            }
            .listRowBackground(palette.card)

            Button {
                store.isHistoryPresented = true
            } label: {
                HStack {
                    Label("OMP CLI History", systemImage: "clock.arrow.circlepath")
                        .foregroundStyle(palette.foreground)
                    Spacer()
                    if !store.nativeSessions.isEmpty {
                        Text("\(store.nativeSessions.count)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(palette.muted)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                }
            }
            .listRowBackground(palette.card)

            Button {
                store.isWorkspacesPresented = true
            } label: {
                HStack {
                    Label("Workspaces & Files", systemImage: "folder.badge.gearshape")
                        .foregroundStyle(palette.foreground)
                    Spacer()
                    Text("\(store.visibleProjects.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.muted)
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                }
            }
            .listRowBackground(palette.card)

            Button {
                store.isSettingsPresented = true
            } label: {
                HStack {
                    Label("Settings & Host Admin", systemImage: "gearshape.2")
                        .foregroundStyle(palette.foreground)
                    Spacer()
                    if store.snapshot.autoShutdown?.on == true {
                        Text("Auto-Shutdown")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(palette.amber)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                }
            }
            .listRowBackground(palette.card)
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

    private func hostStatusSubtitle(_ host: HostProfile) -> String {
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

    private func attentionReason(for session: SessionSummary) -> String? {
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
        return nil
    }

    private var emptyStateTitle: String {
        if !searchQuery.isEmpty { return "No Matching Sessions" }
        switch filter {
        case .all: return "No Sessions Yet"
        case .active: return "Nothing Running Right Now"
        case .idle: return "No Idle Sessions"
        case .pinned: return "No Pinned Sessions"
        case .archived: return "No Archived Sessions"
        }
    }

    private var emptyStateMessage: String {
        if !searchQuery.isEmpty { return "Try another keyword or clear your search filter." }
        switch filter {
        case .all: return "Start a session in any workspace folder or resume an existing OMP transcript."
        case .active: return "Running turns and sessions needing attention appear here."
        case .idle: return "Completed or paused sessions waiting for a follow-up appear here."
        case .pinned: return "Swipe right on any session to pin it for fast access."
        case .archived: return "Archived sessions stay out of the main sidebar until restored."
        }
    }

    private func toggleCollapse(_ projectID: String) async {
        var current = Set(store.snapshot.ui?.collapsed ?? [])
        if current.contains(projectID) {
            current.remove(projectID)
        } else {
            current.insert(projectID)
        }
        guard let client = store.activeClient else { return }
        if (try? await client.saveUI(collapsed: Array(current))) != nil {
            await store.forceSync()
        }
    }
}
