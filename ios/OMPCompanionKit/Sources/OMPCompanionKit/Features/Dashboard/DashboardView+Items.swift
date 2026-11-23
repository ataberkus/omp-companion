import SwiftUI

extension DashboardView {
    var groupBy: SidebarGroupBy {
        SidebarGroupBy(rawValue: groupByRaw) ?? .project
    }

    var parsedSearch: ParsedSidebarSearch {
        ParsedSidebarSearch(query: searchText)
    }

    private var allUnifiedItems: [DashboardItem] {
        let key = DashboardDerivedCache.ItemsKey(
            snapshot: store.snapshot,
            native: store.nativeSessions,
            models: store.availableModels,
            unseen: store.unseenSessionIDs,
            selected: store.selectedSessionID,
            tick: Int(Date().timeIntervalSince1970 / 30)
        )
        if derivedCache.itemsKey != key {
            derivedCache.items = buildUnifiedItems()
            derivedCache.itemsKey = key
            derivedCache.itemsGeneration &+= 1
        }
        return derivedCache.items
    }

    private func buildUnifiedItems() -> [DashboardItem] {
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
        let nativeKey = DashboardDerivedCache.NativeKey(
            native: store.nativeSessions,
            projects: store.snapshot.projects,
            archived: store.snapshot.archived,
            pinned: store.snapshot.pinned,
            models: store.availableModels,
            matchedFiles: matchedNativeFiles
        )
        if derivedCache.nativeKey != nativeKey {
            derivedCache.nativeItems = buildNativeItems(
                excluding: matchedNativeFiles,
                projectsByNormPath: projectsByNormPath,
                modelLabel: formattedModelLabel,
                forkTip: forkTip
            )
            derivedCache.nativeKey = nativeKey
        }

        // History rows rarely change while panel sessions stream, so they stay built and sorted; merge the two sorted lists.
        let byRecency: (DashboardItem, DashboardItem) -> Bool = { lhs, rhs in
            if lhs.sortTime != rhs.sortTime { return lhs.sortTime > rhs.sortTime }
            return lhs.key < rhs.key
        }
        let panelSorted = items.sorted(by: byRecency)
        let native = derivedCache.nativeItems
        var merged: [DashboardItem] = []
        merged.reserveCapacity(panelSorted.count + native.count)
        var i = 0, j = 0
        while i < panelSorted.count && j < native.count {
            if byRecency(native[j], panelSorted[i]) {
                merged.append(native[j]); j += 1
            } else {
                merged.append(panelSorted[i]); i += 1
            }
        }
        merged.append(contentsOf: panelSorted[i...])
        merged.append(contentsOf: native[j...])
        return merged
    }

    /// History-only rows (OMP sessions not in the panel), sorted newest first.
    private func buildNativeItems(
        excluding matchedNativeFiles: Set<String>,
        projectsByNormPath: [String: WorkspaceProject],
        modelLabel formattedModelLabel: (String?, String?) -> String?,
        forkTip: (NativeSessionSummary?) -> String?
    ) -> [DashboardItem] {
        let archivedSet = Set(store.snapshot.archived)
        let pinnedSet = Set(store.snapshot.pinned)
        var items: [DashboardItem] = []
        items.reserveCapacity(store.nativeSessions.count)

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
                    modelLabel: formattedModelLabel(n.model, n.thinking),
                    branch: nil,
                    isolated: false,
                    forkTip: forkTip(n),
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

    func applyFilter(_ filter: DashboardSessionFilter, to items: [DashboardItem]) -> [DashboardItem] {
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

    var scopedItems: [DashboardItem] {
        applyFocusAndSearch(allUnifiedItems)
    }

    private var filteredItems: [DashboardItem] {
        let key = viewCacheKey()
        if derivedCache.filteredKey != key {
            derivedCache.filtered = applyFilter(filter, to: scopedItems)
            derivedCache.filteredKey = key
        }
        return derivedCache.filtered
    }

    /// Refreshes the item cache first, so its generation in the key is current.
    private func viewCacheKey() -> DashboardDerivedCache.ViewKey {
        _ = allUnifiedItems
        return DashboardDerivedCache.ViewKey(
            itemsGeneration: derivedCache.itemsGeneration,
            filter: filter,
            search: searchText,
            focus: focusedWorkspaceNorm,
            groupOrder: store.effectiveGroupOrder
        )
    }

    var attentionItems: [DashboardItem] {
        guard groupBy == .project, filter != .archived else { return [] }
        return filteredItems
            .filter(\.needsYou)
            .map { $0.withRowPrefix("attn") }
    }

    var orderedProjectGroups: [ProjectGroup] {
        let key = viewCacheKey()
        if derivedCache.groupsKey != key {
            derivedCache.groups = buildOrderedProjectGroups()
            derivedCache.groupsKey = key
        }
        return derivedCache.groups
    }

    private func buildOrderedProjectGroups() -> [ProjectGroup] {
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

    var visibleProjectOrderKeys: [String] {
        orderedProjectGroups.map(\.key)
    }

    var presentNormalizedWorkspaceKeys: Set<String> {
        var set = Set(allUnifiedItems.map(\.normCwd))
        for proj in store.visibleProjects {
            set.insert(SidebarLayoutHelper.normalizePathKey(proj.path))
        }
        return set
    }

    var reconcileTriggerKey: String {
        let keys = visibleProjectOrderKeys.joined(separator: "|")
        let present = presentNormalizedWorkspaceKeys.sorted().joined(separator: "|")
        return "\(store.hasReceivedLiveSnapshotForHost):\(store.hasLoadedNativeSessions):\(keys)::\(present)"
    }

    var timeGroups: [TimeGroup] {
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

    var focusedWorkspaceDisplay: (name: String, color: String)? {
        guard !focusedWorkspaceNorm.isEmpty else { return nil }
        if let proj = store.snapshot.projects.first(where: { SidebarLayoutHelper.normalizePathKey($0.path) == focusedWorkspaceNorm }) {
            return (proj.name, proj.color ?? SidebarLayoutHelper.pathColor(proj.path))
        }
        if let item = allUnifiedItems.first(where: { $0.normCwd == focusedWorkspaceNorm }) {
            return (item.folder, item.color)
        }
        return (SidebarLayoutHelper.baseName(focusedWorkspaceNorm), SidebarLayoutHelper.pathColor(focusedWorkspaceNorm))
    }

    var focusedWorkspaceOriginalPath: String? {
        guard !focusedWorkspaceNorm.isEmpty else { return nil }
        if let proj = store.snapshot.projects.first(where: { SidebarLayoutHelper.normalizePathKey($0.path) == focusedWorkspaceNorm }) {
            return proj.path
        }
        if let item = allUnifiedItems.first(where: { $0.normCwd == focusedWorkspaceNorm }) {
            return item.cwd
        }
        return focusedWorkspaceNorm
    }

    /// Everything but the group count, which callers that already hold `orderedProjectGroups` check themselves: rebuilding
    /// the groups walks every session, and section headers ask once each.
    var canReorderBase: Bool {
        store.canPerformMutatingActions
            && groupBy == .project
            && focusedWorkspaceNorm.isEmpty
            && parsedSearch.isEmpty
    }

    var canReorderProjectsOnDashboard: Bool {
        canReorderBase && orderedProjectGroups.count > 1
    }

    /// The connection banner's count of messages held on this phone until the PC answers.
    var outboxNote: String {
        switch store.outboxCount {
        case 0: return ""
        case 1: return " " + String(localized: "1 message waits on this phone to be sent.", bundle: .main)
        case let n: return " " + String(localized: "\(n) messages wait on this phone to be sent.", bundle: .main)
        }
    }
}
