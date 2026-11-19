import SwiftUI

public enum DashboardSessionFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case active
    case inPanel
    case archived

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .all: return "All"
        case .active: return "Active"
        case .inPanel: return "In panel"
        case .archived: return "Archived"
        }
    }
}

private struct DashboardItem: Identifiable {
    let rowID: String
    let key: String
    let title: String
    let cwd: String
    let normCwd: String
    let folder: String
    let color: String
    let hiddenWs: Bool
    let isPanel: Bool
    let isWorking: Bool
    let needsReview: Bool
    let isReviewish: Bool
    let isUnseen: Bool
    let needsYou: Bool
    let isPinned: Bool
    let isArchived: Bool
    let updatedAt: String
    let sortTime: Double
    let status: SessionStatus?
    let taskText: String?
    let modelLabel: String?
    let branch: String?
    let isolated: Bool
    let forkTip: String?
    let overlaps: [String]
    let workDuration: String?
    let preview: String?
    let session: SessionSummary?
    let nativeSummary: NativeSessionSummary?

    var id: String { rowID }

    func withRowPrefix(_ prefix: String) -> DashboardItem {
        DashboardItem(
            rowID: "\(prefix):\(key)",
            key: key,
            title: title,
            cwd: cwd,
            normCwd: normCwd,
            folder: folder,
            color: color,
            hiddenWs: hiddenWs,
            isPanel: isPanel,
            isWorking: isWorking,
            needsReview: needsReview,
            isReviewish: isReviewish,
            isUnseen: isUnseen,
            needsYou: needsYou,
            isPinned: isPinned,
            isArchived: isArchived,
            updatedAt: updatedAt,
            sortTime: sortTime,
            status: status,
            taskText: taskText,
            modelLabel: modelLabel,
            branch: branch,
            isolated: isolated,
            forkTip: forkTip,
            overlaps: overlaps,
            workDuration: workDuration,
            preview: preview,
            session: session,
            nativeSummary: nativeSummary
        )
    }
}

private struct ProjectGroup: Identifiable {
    let key: String
    let normKey: String
    let label: String
    let color: String
    let project: WorkspaceProject?
    let items: [DashboardItem]

    var id: String { normKey }
}

private struct TimeGroup: Identifiable {
    let bucket: SidebarTimeBucket
    let items: [DashboardItem]

    var id: String { bucket.id }
}

public struct DashboardView: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var store: AppStore

    @AppStorage("omp-group-by") private var groupByRaw: String = SidebarGroupBy.project.rawValue
    @AppStorage("omp-focus") private var focusedWorkspaceNorm: String = ""

    @State private var filter: DashboardSessionFilter = .all
    @State private var searchText: String = ""
    @State private var renamingSession: SessionSummary?
    @State private var renameDraft: String = ""
    @State private var editingActiveHost: HostProfile?
    @State private var expandedSubagentSessions: Set<String> = []
    @State private var treeViewingSession: SessionSummary?
    @State private var draggingGroupNormKey: String?
    @State private var dropTargetGroupNormKey: String?
    @State private var isDropTargetBottom = false

    public init(store: AppStore) {
        self.store = store
    }

    private var groupBy: SidebarGroupBy {
        SidebarGroupBy(rawValue: groupByRaw) ?? .project
    }

    private var parsedSearch: ParsedSidebarSearch {
        ParsedSidebarSearch(query: searchText)
    }

    private var allUnifiedItems: [DashboardItem] {
        let projectsByID = Dictionary(store.snapshot.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let projectsByNormPath = Dictionary(
            store.snapshot.projects.map { (SidebarLayoutHelper.normalizePathKey($0.path), $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let modelsBySelector = Dictionary(store.availableModels.map { ($0.selector, $0) }, uniquingKeysWith: { first, _ in first })
        let visiblePanel = store.snapshot.sessions.filter { $0.hidden != true }
        let panelIDs = Set(visiblePanel.map(\.id))

        var nativeByManagedID: [String: NativeSessionSummary] = [:]
        for n in store.nativeSessions {
            if let mid = n.managedId, panelIDs.contains(mid), nativeByManagedID[mid] == nil {
                nativeByManagedID[mid] = n
            }
        }

        func formattedModelLabel(_ selector: String?, thinking: String?) -> String? {
            guard let selector, !selector.isEmpty else { return nil }
            let name = modelsBySelector[selector]?.name
                ?? (selector.split(separator: "/").dropFirst().first.map(String.init) ?? selector)
            if let thinking, !thinking.isEmpty, thinking != "off" {
                return "\(name) · \(thinking)"
            }
            return name
        }

        func forkTip(for native: NativeSessionSummary?) -> String? {
            guard let parent = native?.parent, !parent.isEmpty else { return nil }
            let label = native?.parentTitle ?? SidebarLayoutHelper.baseName(parent)
            return "Forked from \(label)"
        }

        var items: [DashboardItem] = []
        items.reserveCapacity(visiblePanel.count + store.nativeSessions.count)

        for s in visiblePanel {
            let proj = s.projectId.flatMap { projectsByID[$0] }
                ?? projectsByNormPath[SidebarLayoutHelper.normalizePathKey(s.cwd)]
            let native = nativeByManagedID[s.id]
            let cwd = proj?.path ?? s.cwd
            let normCwd = SidebarLayoutHelper.normalizePathKey(cwd)
            let folder = proj?.name ?? SidebarLayoutHelper.baseName(cwd)
            let color = proj?.color ?? SidebarLayoutHelper.pathColor(cwd)
            let working = s.isWorking
            let title = (native?.named == true && s.renamed != true) ? (native?.title ?? s.title) : s.title
            let fresher = native != nil && !working && (native!.updatedAt > s.updatedAt)
            let updatedAt = fresher ? native!.updatedAt : s.updatedAt
            let selector = (fresher ? native?.model : nil) ?? s.effectiveModelSelector
            let thinking = (fresher && native?.model != nil) ? native?.thinking : s.thinking
            let needsReview = !(s.uiRequests?.isEmpty ?? true) || s.hasPlanReviewPending
            let isReviewish = needsReview || s.status == .review || s.status == .error
            let isArchived = store.isArchived(s)
            let hiddenWs = proj?.hidden == true
            let isUnseen = store.isSessionUnseen(s)
            let needsYou = (isReviewish || isUnseen) && (!(isArchived || hiddenWs) || needsReview)
            let taskText: String? = {
                if let t = s._task, !t.isEmpty { return t }
                if let b = s._bash, !b.isEmpty { return "Running a shell command" }
                return nil
            }()
            let sortDate = SidebarLayoutHelper.parseISODate(updatedAt) ?? .distantPast
            let livePriority: Double = (needsReview || working || s.status == .review || s.status == .error) ? 1_000_000_000_000.0 : 0.0

            items.append(
                DashboardItem(
                    rowID: s.panelKey,
                    key: s.panelKey,
                    title: title,
                    cwd: cwd,
                    normCwd: normCwd,
                    folder: folder,
                    color: color,
                    hiddenWs: hiddenWs,
                    isPanel: true,
                    isWorking: working,
                    needsReview: needsReview,
                    isReviewish: isReviewish,
                    isUnseen: isUnseen,
                    needsYou: needsYou,
                    isPinned: store.isPinned(s),
                    isArchived: isArchived,
                    updatedAt: updatedAt,
                    sortTime: livePriority + sortDate.timeIntervalSince1970,
                    status: s.status,
                    taskText: taskText,
                    modelLabel: formattedModelLabel(selector, thinking: thinking),
                    branch: s.branch,
                    isolated: s.isolated == true,
                    forkTip: forkTip(for: native),
                    overlaps: (s._overlaps ?? []).compactMap(\.title),
                    workDuration: SidebarLayoutHelper.formatWorkDuration(startedAt: s.workStartedAt, finishedAt: s.workFinishedAt),
                    preview: native?.preview,
                    session: s,
                    nativeSummary: nil
                )
            )
        }

        let matchedNativeFiles = Set(nativeByManagedID.values.map(\.file))
        let archivedSet = Set(store.snapshot.archived)
        let pinnedSet = Set(store.snapshot.pinned)

        for n in store.nativeSessions where !matchedNativeFiles.contains(n.file) {
            let cwd = n.cwd ?? ""
            let normCwd = SidebarLayoutHelper.normalizePathKey(cwd)
            let proj = projectsByNormPath[normCwd]
            let folder = proj?.name ?? SidebarLayoutHelper.baseName(cwd)
            let color = proj?.color ?? SidebarLayoutHelper.pathColor(cwd)
            let title = n.title ?? SidebarLayoutHelper.baseName(n.file)
            let sortDate = SidebarLayoutHelper.parseISODate(n.updatedAt) ?? .distantPast

            items.append(
                DashboardItem(
                    rowID: n.panelKey,
                    key: n.panelKey,
                    title: title,
                    cwd: cwd,
                    normCwd: normCwd,
                    folder: folder,
                    color: color,
                    hiddenWs: proj?.hidden == true,
                    isPanel: false,
                    isWorking: false,
                    needsReview: false,
                    isReviewish: false,
                    isUnseen: false,
                    needsYou: false,
                    isPinned: pinnedSet.contains(n.panelKey),
                    isArchived: archivedSet.contains(n.panelKey),
                    updatedAt: n.updatedAt,
                    sortTime: sortDate.timeIntervalSince1970,
                    status: nil,
                    taskText: nil,
                    modelLabel: formattedModelLabel(n.model, thinking: n.thinking),
                    branch: nil,
                    isolated: false,
                    forkTip: forkTip(for: n),
                    overlaps: [],
                    workDuration: nil,
                    preview: n.preview,
                    session: nil,
                    nativeSummary: n
                )
            )
        }

        return items.sorted { lhs, rhs in
            if lhs.sortTime != rhs.sortTime { return lhs.sortTime > rhs.sortTime }
            return lhs.key < rhs.key
        }
    }

    private func applyFocusAndSearch(_ items: [DashboardItem]) -> [DashboardItem] {
        let search = parsedSearch
        return items.filter { item in
            if !focusedWorkspaceNorm.isEmpty && item.normCwd != focusedWorkspaceNorm {
                return false
            }
            if !search.isEmpty {
                return search.matches(
                    title: item.title,
                    cwd: item.cwd,
                    folderName: item.folder,
                    branch: item.branch,
                    model: item.modelLabel,
                    preview: item.preview
                )
            }
            return true
        }
    }

    private func applyFilter(_ filter: DashboardSessionFilter, to items: [DashboardItem]) -> [DashboardItem] {
        var result = items
        switch filter {
        case .all:
            break
        case .active:
            result = result.filter { $0.needsReview || $0.isWorking || $0.status == .review || $0.status == .error }
        case .inPanel:
            result = result.filter(\.isPanel)
        case .archived:
            return result.filter { $0.isArchived || $0.hiddenWs }
        }
        return result.filter { !($0.isArchived || $0.hiddenWs) || $0.needsReview || $0.isWorking }
    }

    private var scopedItems: [DashboardItem] {
        applyFocusAndSearch(allUnifiedItems)
    }

    private var filteredItems: [DashboardItem] {
        applyFilter(filter, to: scopedItems)
    }

    private var attentionItems: [DashboardItem] {
        guard groupBy == .project, filter != .archived else { return [] }
        return filteredItems
            .filter(\.needsYou)
            .map { $0.withRowPrefix("attn") }
    }

    private var orderedProjectGroups: [ProjectGroup] {
        let items = filteredItems
        var groupedByNorm: [String: [DashboardItem]] = [:]
        var metaByNorm: [String: (key: String, label: String, color: String, project: WorkspaceProject?)] = [:]

        for item in items {
            let norm = item.normCwd
            groupedByNorm[norm, default: []].append(item)
            if metaByNorm[norm] == nil {
                let proj = store.snapshot.projects.first {
                    SidebarLayoutHelper.normalizePathKey($0.path) == norm
                }
                metaByNorm[norm] = (
                    key: proj?.path ?? item.cwd,
                    label: proj?.name ?? item.folder,
                    color: proj?.color ?? item.color,
                    project: proj
                )
            }
        }

        // Also include visible registered projects with 0 sessions when in All + unfiltered + unfocused (or focused on that workspace)
        if filter == .all && parsedSearch.isEmpty {
            for proj in store.visibleProjects {
                let norm = SidebarLayoutHelper.normalizePathKey(proj.path)
                if !focusedWorkspaceNorm.isEmpty && norm != focusedWorkspaceNorm {
                    continue
                }
                if metaByNorm[norm] == nil {
                    metaByNorm[norm] = (key: proj.path, label: proj.name, color: proj.color ?? SidebarLayoutHelper.pathColor(proj.path), project: proj)
                    groupedByNorm[norm] = []
                }
            }
        }

        let allGroups: [ProjectGroup] = metaByNorm.map { norm, meta in
            let sortedItems = (groupedByNorm[norm] ?? [])
                .sorted { lhs, rhs in
                    if lhs.isPinned != rhs.isPinned { return lhs.isPinned && !rhs.isPinned }
                    if lhs.sortTime != rhs.sortTime { return lhs.sortTime > rhs.sortTime }
                    return lhs.key < rhs.key
                }
                .map { $0.withRowPrefix("proj:\(norm)") }
            return ProjectGroup(
                key: meta.key,
                normKey: norm,
                label: meta.label,
                color: meta.color,
                project: meta.project,
                items: sortedItems
            )
        }

        let order = store.effectiveGroupOrder
        var rankByNorm: [String: Int] = [:]
        for raw in order {
            let norm = SidebarLayoutHelper.normalizePathKey(raw)
            if rankByNorm[norm] == nil {
                rankByNorm[norm] = rankByNorm.count
            }
        }
        // Fallback for legacy project.id entries in groupOrder
        let projectIDToNorm = Dictionary(
            store.snapshot.projects.map { ($0.id, SidebarLayoutHelper.normalizePathKey($0.path)) },
            uniquingKeysWith: { first, _ in first }
        )
        for (idx, raw) in order.enumerated() {
            if let norm = projectIDToNorm[raw], rankByNorm[norm] == nil {
                rankByNorm[norm] = idx
            }
        }

        var fresh: [ProjectGroup] = []
        var ranked: [(rank: Int, group: ProjectGroup)] = []
        for group in allGroups {
            if let r = rankByNorm[group.normKey] {
                ranked.append((r, group))
            } else {
                fresh.append(group)
            }
        }
        ranked.sort { $0.rank < $1.rank }
        return fresh + ranked.map(\.group)
    }

    private var visibleProjectOrderKeys: [String] {
        orderedProjectGroups.map(\.key)
    }

    private var presentNormalizedWorkspaceKeys: Set<String> {
        var set = Set(allUnifiedItems.map(\.normCwd))
        for proj in store.visibleProjects {
            set.insert(SidebarLayoutHelper.normalizePathKey(proj.path))
        }
        return set
    }

    private var reconcileTriggerKey: String {
        let keys = visibleProjectOrderKeys.joined(separator: "|")
        let present = presentNormalizedWorkspaceKeys.sorted().joined(separator: "|")
        return "\(store.hasReceivedLiveSnapshotForHost):\(store.hasLoadedNativeSessions):\(keys)::\(present)"
    }

    private var timeGroups: [TimeGroup] {
        guard groupBy == .time else { return [] }
        let items = filteredItems
        let pinned = items.filter(\.isPinned)
        let unpinned = items.filter { !$0.isPinned }
        let working = unpinned.filter { !$0.needsReview && $0.isWorking }
        let workingIDs = Set(working.map(\.key))
        let review = unpinned.filter { !workingIDs.contains($0.key) && $0.isReviewish }
        let reviewIDs = Set(review.map(\.key))
        let rest = unpinned.filter { !workingIDs.contains($0.key) && !reviewIDs.contains($0.key) }

        let now = Date()
        let startToday = Calendar.current.startOfDay(for: now)
        let startYesterday = startToday.addingTimeInterval(-86_400)
        let start7Days = startToday.addingTimeInterval(-7 * 86_400)

        var today: [DashboardItem] = []
        var yesterday: [DashboardItem] = []
        var prev7: [DashboardItem] = []
        var older: [DashboardItem] = []

        for item in rest {
            let date = SidebarLayoutHelper.parseISODate(item.updatedAt) ?? .distantPast
            if date >= startToday {
                today.append(item)
            } else if date >= startYesterday {
                yesterday.append(item)
            } else if date >= start7Days {
                prev7.append(item)
            } else {
                older.append(item)
            }
        }

        let pairs: [(SidebarTimeBucket, [DashboardItem])] = [
            (.pinned, pinned),
            (.working, working),
            (.review, review),
            (.today, today),
            (.yesterday, yesterday),
            (.previous7Days, prev7),
            (.older, older)
        ]

        return pairs.compactMap { bucket, arr in
            guard !arr.isEmpty else { return nil }
            let prefixed = arr.map { $0.withRowPrefix("time:\(bucket.rawValue)") }
            return TimeGroup(bucket: bucket, items: prefixed)
        }
    }

    private var focusedWorkspaceDisplay: (name: String, color: String)? {
        guard !focusedWorkspaceNorm.isEmpty else { return nil }
        if let proj = store.snapshot.projects.first(where: { SidebarLayoutHelper.normalizePathKey($0.path) == focusedWorkspaceNorm }) {
            return (proj.name, proj.color ?? SidebarLayoutHelper.pathColor(proj.path))
        }
        if let item = allUnifiedItems.first(where: { $0.normCwd == focusedWorkspaceNorm }) {
            return (item.folder, item.color)
        }
        return (SidebarLayoutHelper.baseName(focusedWorkspaceNorm), SidebarLayoutHelper.pathColor(focusedWorkspaceNorm))
    }

    private var focusedWorkspaceOriginalPath: String? {
        guard !focusedWorkspaceNorm.isEmpty else { return nil }
        if let proj = store.snapshot.projects.first(where: { SidebarLayoutHelper.normalizePathKey($0.path) == focusedWorkspaceNorm }) {
            return proj.path
        }
        if let item = allUnifiedItems.first(where: { $0.normCwd == focusedWorkspaceNorm }) {
            return item.cwd
        }
        return focusedWorkspaceNorm
    }

    private var canReorderProjectsOnDashboard: Bool {
        store.canPerformMutatingActions
            && groupBy == .project
            && focusedWorkspaceNorm.isEmpty
            && parsedSearch.isEmpty
            && orderedProjectGroups.count > 1
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
                if timeGroups.isEmpty {
                    emptyStateSection
                } else {
                    ForEach(timeGroups) { group in
                        let isCollapsed = parsedSearch.isEmpty && store.isGroupCollapsed(group.bucket.title)
                        Section {
                            if !isCollapsed {
                                ForEach(group.items) { item in
                                    sessionRow(item, showFolder: true)
                                }
                            }
                        } header: {
                            timeSectionHeader(group.bucket, count: group.items.count, collapsed: isCollapsed)
                        }
                    }
                }
            } else if orderedProjectGroups.isEmpty && attentionItems.isEmpty {
                emptyStateSection
            } else {
                if !attentionItems.isEmpty {
                    let attnCollapsed = parsedSearch.isEmpty && store.isGroupCollapsed(SidebarLayoutHelper.attentionGroupKey)
                    Section {
                        if !attnCollapsed {
                            ForEach(attentionItems) { item in
                                sessionRow(item, showFolder: true, emphasizeAttention: true)
                            }
                        }
                    } header: {
                        attentionSectionHeader(count: attentionItems.count, collapsed: attnCollapsed)
                    }
                }

                ForEach(orderedProjectGroups) { group in
                    let isCollapsed = parsedSearch.isEmpty && store.isGroupCollapsed(group.key, legacyProjectID: group.project?.id)
                    Section {
                        if !isCollapsed {
                            if group.items.isEmpty {
                                HStack {
                                    Text("No active sessions in \(group.label)")
                                        .font(.caption)
                                        .foregroundStyle(palette.muted)
                                    Spacer()
                                    Button("Start") {
                                        store.presentQuickStart(projectPath: group.key)
                                    }
                                    .font(.caption.weight(.semibold))
                                    .buttonStyle(.borderless)
                                    .disabled(!store.canPerformMutatingActions)
                                }
                                .listRowBackground(palette.card)
                            } else {
                                ForEach(group.items) { item in
                                    sessionRow(item, showFolder: false)
                                }
                            }
                        }
                    } header: {
                        projectSectionHeader(group, collapsed: isCollapsed)
                    }
                }

                if draggingGroupNormKey != nil && canReorderProjectsOnDashboard {
                    Section {
                        HStack(spacing: 8) {
                            Image(systemName: "arrow.down.to.line")
                                .font(.caption)
                            Text("Drop here to move to bottom")
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(isDropTargetBottom ? palette.accent : palette.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(
                                    isDropTargetBottom ? palette.accent : palette.border,
                                    style: StrokeStyle(lineWidth: isDropTargetBottom ? 2 : 1, dash: [5, 4])
                                )
                        )
                        .listRowBackground(Color.clear)
                        .dropDestination(for: String.self) { items, _ in
                            isDropTargetBottom = false
                            let sourceKey = items.first ?? draggingGroupNormKey
                            draggingGroupNormKey = nil
                            dropTargetGroupNormKey = nil
                            guard let sourceKey else { return false }
                            store.notificationManager.triggerHaptic(.lightTap)
                            Task {
                                await store.moveGroup(key: sourceKey, beforeKey: nil, visibleKeys: visibleProjectOrderKeys)
                            }
                            return true
                        } isTargeted: { targeted in
                            isDropTargetBottom = targeted
                        }
                        .onTapGesture {
                            draggingGroupNormKey = nil
                            dropTargetGroupNormKey = nil
                            isDropTargetBottom = false
                        }
                    }
                }
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
                    .disabled(!store.canPerformMutatingActions || allCollapsibleGroupKeys.isEmpty)

                    Button {
                        Task { await store.setAllGroupsCollapsed(false, keys: allCollapsibleGroupKeys) }
                    } label: {
                        Label("Expand All", systemImage: "rectangle.expand.vertical")
                    }
                    .disabled(!store.canPerformMutatingActions || allCollapsibleGroupKeys.isEmpty)

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

    private var allCollapsibleGroupKeys: [String] {
        switch groupBy {
        case .project:
            var keys = orderedProjectGroups.map(\.key)
            if !attentionItems.isEmpty {
                keys.insert(SidebarLayoutHelper.attentionGroupKey, at: 0)
            }
            return keys
        case .time:
            return timeGroups.map(\.bucket.title)
        }
    }

    private var emptyStateSection: some View {
        Section {
            OMPEmptyStateView(
                systemImage: filter == .archived ? "archivebox" : "bubble.left.and.bubble.right",
                title: emptyStateTitle,
                message: emptyStateMessage,
                actionTitle: (filter == .all && parsedSearch.isEmpty) ? "Start New Session" : (!focusedWorkspaceNorm.isEmpty ? "Show All Workspaces" : nil)
            ) {
                if !focusedWorkspaceNorm.isEmpty && filter == .all && parsedSearch.isEmpty {
                    focusedWorkspaceNorm = ""
                } else {
                    store.presentQuickStart(projectPath: focusedWorkspaceOriginalPath)
                }
            }
            .listRowBackground(Color.clear)
        }
    }

    private var controlsHeaderBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                store.presentQuickStart(projectPath: focusedWorkspaceOriginalPath)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                        .font(.subheadline.weight(.bold))
                    Text("New session")
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(palette.accent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .disabled(!store.canPerformMutatingActions)
            .opacity(store.canPerformMutatingActions ? 1 : 0.5)
            .accessibilityLabel("New session")

            filterChipStrip

            HStack(spacing: 8) {
                Text("Group by")
                    .font(.caption)
                    .foregroundStyle(palette.muted)

                HStack(spacing: 0) {
                    ForEach(SidebarGroupBy.allCases) { mode in
                        let selected = groupBy == mode
                        Button {
                            withAnimation(.easeInOut(duration: 0.16)) {
                                groupByRaw = mode.rawValue
                            }
                            store.notificationManager.triggerHaptic(.selection)
                        } label: {
                            Text(mode.label)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(selected ? palette.accent : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                                .foregroundStyle(selected ? .white : palette.foreground)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(2)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(palette.border, lineWidth: 1)
                )

                Spacer(minLength: 4)
            }

            if let focused = focusedWorkspaceDisplay {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.fromCSS(focused.color))
                        .frame(width: 8, height: 8)
                    Text("Focused: \(focused.name)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Button {
                        focusedWorkspaceNorm = ""
                        store.notificationManager.triggerHaptic(.selection)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.subheadline)
                            .foregroundStyle(palette.muted)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Show all workspaces")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(palette.card, in: Capsule())
                .overlay(Capsule().stroke(palette.borderStrong, lineWidth: 1))
            }
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
    private func attentionSectionHeader(count: Int, collapsed: Bool) -> some View {
        Button {
            Task { await store.toggleGroupCollapsed(SidebarLayoutHelper.attentionGroupKey) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.cyan)
                Image(systemName: "bell.badge.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.cyan)
                Text("Needs you")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(palette.cyan)
                Spacer(minLength: 4)
                Text("\(count)")
                    .font(.caption2.monospacedDigit().weight(.semibold))
                    .foregroundStyle(palette.cyan)
            }
            .contentShape(Rectangle())
            .minTouchTarget(36)
        }
        .buttonStyle(.plain)
        .disabled(!store.canPerformMutatingActions)
        .accessibilityLabel("Needs you, \(count) sessions")
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
        .accessibilityHint("Double tap to \(collapsed ? "expand" : "collapse")")
    }

    @ViewBuilder
    private func timeSectionHeader(_ bucket: SidebarTimeBucket, count: Int, collapsed: Bool) -> some View {
        Button {
            Task { await store.toggleGroupCollapsed(bucket.title) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.muted)
                if bucket == .pinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(palette.accent)
                }
                Text(bucket.title)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(palette.foreground)
                Spacer(minLength: 4)
                Text("\(count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(palette.muted)
            }
            .contentShape(Rectangle())
            .minTouchTarget(36)
        }
        .buttonStyle(.plain)
        .disabled(!store.canPerformMutatingActions)
        .accessibilityLabel("\(bucket.title), \(count) sessions")
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
    }

    @ViewBuilder
    private func projectSectionHeader(_ group: ProjectGroup, collapsed: Bool) -> some View {
        let workingCount = group.items.filter { $0.isWorking && !$0.needsReview }.count
        let reviewCount = group.items.filter(\.isReviewish).count
        let unseenCount = group.items.filter(\.isUnseen).count
        let branchText = (group.project?.branch?.isEmpty == false && group.project?.branch != "workspace") ? group.project?.branch : nil
        let isFocused = focusedWorkspaceNorm == group.normKey
        let isDropTarget = dropTargetGroupNormKey == group.normKey && draggingGroupNormKey != group.normKey
        let idx = orderedProjectGroups.firstIndex(where: { $0.normKey == group.normKey })

        let headerRow = HStack(spacing: 8) {
            Button {
                Task { await store.toggleGroupCollapsed(group.key, legacyProjectID: group.project?.id) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(palette.muted)
                    Circle()
                        .fill(Color.fromCSS(group.color))
                        .frame(width: 9, height: 9)
                    Text(group.label)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let branch = branchText {
                        Text(branch)
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.accent)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if workingCount > 0 {
                        groupStatBadge("\(workingCount)", fg: palette.accent, bg: palette.accentSoft)
                            .layoutPriority(1)
                    }
                    if reviewCount > 0 {
                        groupStatBadge("\(reviewCount)", fg: palette.cyan, bg: palette.cyan.opacity(0.15))
                            .layoutPriority(1)
                    }
                    if unseenCount > 0 {
                        groupStatBadge("\(unseenCount)", fg: palette.foreground, bg: palette.raised)
                            .layoutPriority(1)
                    }
                    Text("\(group.items.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.muted)
                        .layoutPriority(1)
                }
                .frame(minHeight: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!store.canPerformMutatingActions)
            .accessibilityLabel(projectHeaderAccessibilityLabel(group: group, working: workingCount, review: reviewCount, unseen: unseenCount))
            .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
            .accessibilityHint("Double tap to \(collapsed ? "expand" : "collapse")")

            Spacer(minLength: 4)

            if isFocused {
                Button {
                    focusedWorkspaceNorm = ""
                    store.notificationManager.triggerHaptic(.selection)
                } label: {
                    Image(systemName: "scope")
                        .font(.caption)
                        .foregroundStyle(palette.accent)
                        .frame(minWidth: 32, minHeight: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .layoutPriority(1)
                .accessibilityLabel("Show all workspaces")
            }

            Button {
                store.presentQuickStart(projectPath: group.key)
            } label: {
                Image(systemName: "plus.circle")
                    .font(.caption)
                    .foregroundStyle(palette.accent)
                    .frame(minWidth: 32, minHeight: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
            .disabled(!store.canPerformMutatingActions)
            .accessibilityLabel("New session in \(group.label)")
        }
        .padding(.vertical, 2)
        .overlay(alignment: .top) {
            if isDropTarget {
                Capsule()
                    .fill(palette.accent)
                    .frame(height: 3)
                    .padding(.top, -2)
            }
        }
        .background(isDropTarget ? palette.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contextMenu {
            Button {
                store.presentQuickStart(projectPath: group.key)
            } label: {
                Label("New session here", systemImage: "plus.bubble")
            }
            .disabled(!store.canPerformMutatingActions)

            Button {
                focusedWorkspaceNorm = isFocused ? "" : group.normKey
                store.notificationManager.triggerHaptic(.selection)
            } label: {
                Label(isFocused ? "Show all workspaces" : "Focus this workspace", systemImage: "scope")
            }

            Button {
                Task { await store.toggleGroupCollapsed(group.key, legacyProjectID: group.project?.id) }
            } label: {
                Label(collapsed ? "Expand" : "Collapse", systemImage: collapsed ? "chevron.down" : "chevron.right")
            }
            .disabled(!store.canPerformMutatingActions)

            if canReorderProjectsOnDashboard {
                Divider()
                if let idx, idx > 0 {
                    Button {
                        Task {
                            await store.moveGroup(
                                key: group.key,
                                beforeKey: orderedProjectGroups.first?.key,
                                visibleKeys: visibleProjectOrderKeys
                            )
                        }
                    } label: {
                        Label("Move to top", systemImage: "arrow.up.to.line")
                    }
                    Button {
                        let prev = orderedProjectGroups[idx - 1]
                        Task {
                            await store.moveGroup(key: group.key, beforeKey: prev.key, visibleKeys: visibleProjectOrderKeys)
                        }
                    } label: {
                        Label("Move up", systemImage: "arrow.up")
                    }
                }
                if let idx, idx < orderedProjectGroups.count - 1 {
                    Button {
                        let nextAfter: String? = (idx + 2 < orderedProjectGroups.count) ? orderedProjectGroups[idx + 2].key : nil
                        Task {
                            await store.moveGroup(key: group.key, beforeKey: nextAfter, visibleKeys: visibleProjectOrderKeys)
                        }
                    } label: {
                        Label("Move down", systemImage: "arrow.down")
                    }
                    Button {
                        Task {
                            await store.moveGroup(key: group.key, beforeKey: nil, visibleKeys: visibleProjectOrderKeys)
                        }
                    } label: {
                        Label("Move to bottom", systemImage: "arrow.down.to.line")
                    }
                }
            }

            Divider()
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
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Move to top") {
            guard canReorderProjectsOnDashboard else { return }
            Task { await store.moveGroup(key: group.key, beforeKey: orderedProjectGroups.first?.key, visibleKeys: visibleProjectOrderKeys) }
        }
        .accessibilityAction(named: "Move up") {
            guard canReorderProjectsOnDashboard, let idx, idx > 0 else { return }
            Task { await store.moveGroup(key: group.key, beforeKey: orderedProjectGroups[idx - 1].key, visibleKeys: visibleProjectOrderKeys) }
        }
        .accessibilityAction(named: "Move down") {
            guard canReorderProjectsOnDashboard, let idx, idx < orderedProjectGroups.count - 1 else { return }
            let nextAfter: String? = (idx + 2 < orderedProjectGroups.count) ? orderedProjectGroups[idx + 2].key : nil
            Task { await store.moveGroup(key: group.key, beforeKey: nextAfter, visibleKeys: visibleProjectOrderKeys) }
        }
        .accessibilityAction(named: "Move to bottom") {
            guard canReorderProjectsOnDashboard else { return }
            Task { await store.moveGroup(key: group.key, beforeKey: nil, visibleKeys: visibleProjectOrderKeys) }
        }

        if canReorderProjectsOnDashboard && !group.normKey.isEmpty {
            headerRow
                .draggable(group.key) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(Color.fromCSS(group.color))
                            .frame(width: 9, height: 9)
                        Text(group.label)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(palette.foreground)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(palette.raised, in: Capsule())
                    .overlay(Capsule().stroke(palette.accent, lineWidth: 1))
                    .onAppear {
                        draggingGroupNormKey = group.normKey
                        store.notificationManager.triggerHaptic(.lightTap)
                    }
                }
                .dropDestination(for: String.self) { items, _ in
                    let draggedKey = items.first ?? draggingGroupNormKey
                    draggingGroupNormKey = nil
                    dropTargetGroupNormKey = nil
                    isDropTargetBottom = false
                    guard let draggedKey,
                          SidebarLayoutHelper.normalizePathKey(draggedKey) != group.normKey else {
                        return false
                    }
                    store.notificationManager.triggerHaptic(.lightTap)
                    Task {
                        await store.moveGroup(key: draggedKey, beforeKey: group.key, visibleKeys: visibleProjectOrderKeys)
                    }
                    return true
                } isTargeted: { targeted in
                    if targeted {
                        dropTargetGroupNormKey = group.normKey
                    } else if dropTargetGroupNormKey == group.normKey {
                        dropTargetGroupNormKey = nil
                    }
                }
        } else {
            headerRow
        }
    }

    private func groupStatBadge(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text)
            .font(.caption2.monospacedDigit().weight(.bold))
            .foregroundStyle(fg)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(bg, in: Capsule())
    }

    private func projectHeaderAccessibilityLabel(group: ProjectGroup, working: Int, review: Int, unseen: Int) -> String {
        var parts = [group.label, "\(group.items.count) sessions"]
        if working > 0 { parts.append("\(working) working") }
        if review > 0 { parts.append("\(review) waiting for you") }
        if unseen > 0 { parts.append("\(unseen) new") }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private func sessionRow(_ item: DashboardItem, showFolder: Bool, emphasizeAttention: Bool = false) -> some View {
        let isSelected = horizontalSizeClass == .regular && item.session != nil && store.selectedSessionID == item.session?.id

        VStack(alignment: .leading, spacing: 5) {
            Button {
                if let session = item.session {
                    Task { await store.selectSession(session.id, tab: .chat, openDetail: true) }
                } else if let native = item.nativeSummary {
                    store.selectedNativeSessionFile = native.file
                    store.isHistoryPresented = true
                }
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .top, spacing: 8) {
                        statusDot(for: item)
                            .padding(.top, 5)

                        Text(item.title)
                            .font(.subheadline.weight(item.isUnseen ? .bold : .semibold))
                            .foregroundStyle(palette.foreground)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)

                        Spacer(minLength: 4)

                        if item.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(palette.accent)
                        }

                        let compactAgo = SidebarLayoutHelper.formatCompactAgo(item.updatedAt)
                        Text(compactAgo.isEmpty ? CompanionFormatters.relativeDate(item.updatedAt) : compactAgo)
                            .font(.caption2.monospacedDigit().weight(item.isUnseen ? .semibold : .regular))
                            .foregroundStyle(item.isUnseen ? palette.accent : palette.muted)
                    }

                    if let session = item.session, let reason = attentionReason(for: session), emphasizeAttention {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.bubble.fill")
                                .font(.caption2)
                            Text(reason)
                                .font(.caption2.weight(.medium))
                                .lineLimit(1)
                        }
                        .foregroundStyle(session.status == .error ? palette.red : palette.amber)
                    }

                    HStack(spacing: 6) {
                        if showFolder {
                            HStack(spacing: 4) {
                                RoundedRectangle(cornerRadius: 2, style: .continuous)
                                    .fill(Color.fromCSS(item.color))
                                    .frame(width: 6, height: 6)
                                Text(item.folder)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(palette.foreground.opacity(0.85))
                                    .lineLimit(1)
                            }
                        }

                        if let statusLabel = rowStatusLabel(for: item) {
                            Text(statusLabel)
                                .font(.caption2.weight(item.needsReview || item.status == .review ? .medium : .regular))
                                .foregroundStyle(rowStatusColor(for: item))
                                .lineLimit(1)
                        }

                        if item.isolated {
                            Label("worktree", systemImage: "arrow.triangle.branch")
                                .font(.caption2.monospaced())
                                .foregroundStyle(palette.green)
                                .lineLimit(1)
                        }

                        if item.forkTip != nil {
                            Text("fork")
                                .font(.caption2.weight(.medium))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(palette.raised, in: Capsule())
                                .foregroundStyle(palette.muted)
                        }

                        if !item.overlaps.isEmpty {
                            Label("overlap", systemImage: "exclamationmark.triangle.fill")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(palette.amber)
                                .lineLimit(1)
                        }

                        if let model = item.modelLabel {
                            Text(model)
                                .font(.caption2.monospaced())
                                .foregroundStyle(palette.muted)
                                .lineLimit(1)
                        }

                        Spacer(minLength: 4)

                        if let workDuration = item.workDuration {
                            Text(workDuration)
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(palette.muted)
                                .lineLimit(1)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)

            if let session = item.session, session.resolvedSubagentCount > 0 {
                subagentInlineBar(for: session)
            }
        }
        .padding(.vertical, 4)
        .overlay(alignment: .leading) {
            if isSelected {
                Rectangle()
                    .fill(palette.accent)
                    .frame(width: 3)
                    .padding(.vertical, -4)
                    .padding(.leading, -12)
            }
        }
        .listRowBackground(
            isSelected
                ? palette.raised
                : (emphasizeAttention ? palette.amberSoft.opacity(0.28) : palette.card)
        )
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                Task {
                    if let session = item.session {
                        await store.togglePin(for: session)
                    } else if let native = item.nativeSummary {
                        await store.setPinned(key: native.panelKey, pinned: !item.isPinned)
                    }
                }
            } label: {
                Label(item.isPinned ? "Unpin" : "Pin", systemImage: item.isPinned ? "pin.slash" : "pin")
            }
            .tint(palette.accent)
            .disabled(!store.canPerformMutatingActions)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let session = item.session {
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
                        Label(item.isArchived ? "Restore" : "Archive", systemImage: item.isArchived ? "tray.and.arrow.up" : "archivebox")
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
            } else if let native = item.nativeSummary {
                Button {
                    Task { await store.setArchived(key: native.panelKey, archived: !item.isArchived) }
                } label: {
                    Label(item.isArchived ? "Restore" : "Archive", systemImage: item.isArchived ? "tray.and.arrow.up" : "archivebox")
                }
                .tint(palette.amber)
                .disabled(!store.canPerformMutatingActions)
            }
        }
        .contextMenu {
            if let session = item.session {
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
                    Label(item.isPinned ? "Unpin" : "Pin", systemImage: item.isPinned ? "pin.slash" : "pin")
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
                        Label(item.isArchived ? "Restore" : "Archive", systemImage: item.isArchived ? "tray.and.arrow.up" : "archivebox")
                    }
                }
                Button(role: .destructive) {
                    Task { await store.hideSession(session) }
                } label: {
                    Label("Hide from Sidebar", systemImage: "eye.slash")
                }
            } else if let native = item.nativeSummary {
                Button {
                    store.selectedNativeSessionFile = native.file
                    store.isHistoryPresented = true
                } label: {
                    Label("Preview & Resume", systemImage: "doc.text.magnifyingglass")
                }
                Button {
                    Task { await store.setPinned(key: native.panelKey, pinned: !item.isPinned) }
                } label: {
                    Label(item.isPinned ? "Unpin" : "Pin", systemImage: item.isPinned ? "pin.slash" : "pin")
                }
                Button {
                    Task { await store.setArchived(key: native.panelKey, archived: !item.isArchived) }
                } label: {
                    Label(item.isArchived ? "Restore" : "Archive", systemImage: item.isArchived ? "tray.and.arrow.up" : "archivebox")
                }
            }
        }
    }

    @ViewBuilder
    private func statusDot(for item: DashboardItem) -> some View {
        if let status = item.status {
            if item.needsReview || status == .review {
                Circle()
                    .fill(palette.cyan)
                    .frame(width: 8, height: 8)
            } else if status == .running {
                Circle()
                    .fill(palette.violet)
                    .frame(width: 8, height: 8)
            } else if status == .queued || item.isWorking {
                Circle()
                    .stroke(palette.accent, lineWidth: 1.5)
                    .frame(width: 8, height: 8)
            } else if status == .error {
                Circle()
                    .fill(palette.red)
                    .frame(width: 8, height: 8)
            } else if status == .done {
                Circle()
                    .fill(palette.green)
                    .frame(width: 8, height: 8)
            } else {
                Circle()
                    .fill(palette.muted)
                    .frame(width: 8, height: 8)
            }
        } else {
            Circle()
                .stroke(palette.muted.opacity(0.65), lineWidth: 1.4)
                .frame(width: 8, height: 8)
        }
    }

    private func rowStatusLabel(for item: DashboardItem) -> String? {
        guard let status = item.status else { return nil }
        if !(item.session?.uiRequests?.isEmpty ?? true) {
            return "Waiting for answer"
        }
        if item.session?.hasPlanReviewPending == true {
            return "Plan ready for review"
        }
        if let taskText = item.taskText, !taskText.isEmpty {
            return taskText
        }
        switch status {
        case .queued: return "Starting"
        case .running: return "Working"
        case .review: return "Ready for review"
        case .paused: return "Idle"
        case .error: return "Error"
        case .done: return "Done"
        }
    }

    private func rowStatusColor(for item: DashboardItem) -> Color {
        guard let status = item.status else { return palette.muted }
        if item.needsReview || status == .review { return palette.cyan }
        if status == .error { return palette.red }
        if item.isWorking { return palette.accent }
        return palette.muted
    }

    @ViewBuilder
    private func subagentInlineBar(for session: SessionSummary) -> some View {
        let hasChildren = !(session.subagentList ?? []).isEmpty
        let isExpanded = expandedSubagentSessions.contains(session.id)
        HStack(spacing: 8) {
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
            Spacer(minLength: 0)
            if let cost = session.cost, cost > 0 {
                Text(CompanionFormatters.formatCost(cost))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(palette.muted)
            }
        }

        if isExpanded, let subs = session.subagentList, !subs.isEmpty {
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
                            Text(sub.description ?? sub.status)
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                                .lineLimit(1)
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(.leading, 10)
            .padding(.top, 2)
        }
    }

    private var filterChipStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(DashboardSessionFilter.allCases) { item in
                    let isSelected = filter == item
                    let count = count(for: item)
                    Button {
                        filter = item
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
                        .padding(.horizontal, 11)
                        .padding(.vertical, 6)
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
        applyFilter(item, to: scopedItems).count
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

    private var emptyStateTitle: String {
        if !parsedSearch.isEmpty { return "No Matching Sessions" }
        if !focusedWorkspaceNorm.isEmpty { return "No Sessions in Workspace" }
        switch filter {
        case .all: return "No Sessions Yet"
        case .active: return "Nothing Running Right Now"
        case .inPanel: return "No Panel Sessions"
        case .archived: return "No Archived Sessions"
        }
    }

    private var emptyStateMessage: String {
        if !parsedSearch.isEmpty { return "Try another keyword or in:<folder> scope, or clear your search." }
        if !focusedWorkspaceNorm.isEmpty { return "Start a session in this workspace or clear the workspace focus filter." }
        switch filter {
        case .all: return "Start a session in any workspace folder or resume an existing OMP transcript."
        case .active: return "Running turns and sessions needing attention appear here."
        case .inPanel: return "Sessions opened or started in OMP Control Room appear here."
        case .archived: return "Archived sessions and hidden workspaces stay out of the main sidebar until restored."
        }
    }
}
