import SwiftUI

extension DashboardView {
    /// Rows shown up front per section, and across all sections together. With 1,000 sessions in "All" every row was built
    /// on each update; sections past the shared budget show a few rows each and a "Show more" button.
    private static let rowPageSize = 15
    private static let minRowsPerSection = 5
    private static let totalRowBudget = 120

    /// Per-section row limits for this render, in display order. A section the user expanded keeps its own limit; the
    /// others share `totalRowBudget`. Collapsed sections pass a count of 0 and use none of it.
    private func sectionRowLimits(_ sections: [(key: String, count: Int)]) -> [String: Int] {
        var remaining = Self.totalRowBudget
        var out: [String: Int] = [:]
        for section in sections {
            let limit = rowLimits[section.key] ?? max(Self.minRowsPerSection, min(Self.rowPageSize, remaining))
            out[section.key] = limit
            remaining = max(0, remaining - min(limit, section.count))
        }
        return out
    }

    @ViewBuilder
    private func cappedRows(_ items: [DashboardItem], key: String, limit: Int?, showFolder: Bool, emphasizeAttention: Bool = false) -> some View {
        let limit = limit ?? Self.rowPageSize
        let step = 100
        ForEach(items.count > limit ? Array(items.prefix(limit)) : items) { item in
            sessionRow(item, showFolder: showFolder, emphasizeAttention: emphasizeAttention)
        }
        if items.count > limit {
            Button {
                rowLimits[key] = limit + step
            } label: {
                HStack {
                    Image(systemName: "chevron.down")
                    Text("Show \(min(step, items.count - limit)) more · \(items.count - limit) hidden")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.accent)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderless)
            .listRowBackground(palette.card)
        }
    }

    /// Status-grouped sections; `groups` is computed once per render by the caller.
    @ViewBuilder
    func timeGroupedSections(_ groups: [TimeGroup]) -> some View {
        if groups.isEmpty {
            emptyStateSection
        } else {
            let timeCounts: [(key: String, count: Int)] = groups.map { g in
                let collapsed = parsedSearch.isEmpty && store.isGroupCollapsed(g.bucket.title)
                return (key: "time:\(g.bucket.id)", count: collapsed ? 0 : g.items.count)
            }
            let limits = sectionRowLimits(timeCounts)
            ForEach(groups) { group in
                let isCollapsed = parsedSearch.isEmpty && store.isGroupCollapsed(group.bucket.title)
                Section {
                    if !isCollapsed {
                        cappedRows(group.items, key: "time:\(group.bucket.id)", limit: limits["time:\(group.bucket.id)"], showFolder: true)
                    }
                } header: {
                    timeSectionHeader(group.bucket, count: group.items.count, collapsed: isCollapsed)
                }
            }
        }
    }

    /// Needs-attention and workspace sections. The caller builds `groups` and `attention` once per render and every header
    /// reuses them: rebuilding walks every panel and history session, and doing that per header froze launch.
    @ViewBuilder
    func projectGroupedSections(groups: [ProjectGroup], attention: [DashboardItem]) -> some View {
        if groups.isEmpty && attention.isEmpty {
            emptyStateSection
        } else {
            let attnKey = SidebarLayoutHelper.attentionGroupKey
            let attnCount: Int = (parsedSearch.isEmpty && store.isGroupCollapsed(attnKey)) ? 0 : attention.count
            let groupCounts: [(key: String, count: Int)] = groups.map { g in
                let collapsed = parsedSearch.isEmpty && store.isGroupCollapsed(g.key, legacyProjectID: g.project?.id)
                return (key: "proj:\(g.normKey)", count: collapsed ? 0 : g.items.count)
            }
            let limits = sectionRowLimits([(key: attnKey, count: attnCount)] + groupCounts)
            if !attention.isEmpty {
                let attnCollapsed = parsedSearch.isEmpty && store.isGroupCollapsed(SidebarLayoutHelper.attentionGroupKey)
                Section {
                    if !attnCollapsed {
                        cappedRows(attention, key: SidebarLayoutHelper.attentionGroupKey, limit: limits[SidebarLayoutHelper.attentionGroupKey], showFolder: true, emphasizeAttention: true)
                    }
                } header: {
                    attentionSectionHeader(count: attention.count, collapsed: attnCollapsed)
                }
            }

            ForEach(groups) { group in
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
                            cappedRows(group.items, key: "proj:\(group.normKey)", limit: limits["proj:\(group.normKey)"], showFolder: false)
                        }
                    }
                } header: {
                    projectSectionHeader(group, collapsed: isCollapsed, groups: groups)
                }
            }

            if draggingGroupNormKey != nil && canReorderBase && groups.count > 1 {
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
                            await store.moveGroup(key: sourceKey, beforeKey: nil, visibleKeys: groups.map(\.key))
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
    }

    var allCollapsibleGroupKeys: [String] {
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
                actionTitle: (filter == .all && parsedSearch.isEmpty)
                    ? String(localized: "Start New Session", bundle: .main)
                    : (!focusedWorkspaceNorm.isEmpty ? String(localized: "Show All Workspaces", bundle: .main) : nil)
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

    var controlsHeaderBlock: some View {
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
                            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.16)) {
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

    private var filterChipStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                let scoped = scopedItems
                ForEach(DashboardSessionFilter.allCases) { item in
                    let isSelected = filter == item
                    let count = applyFilter(item, to: scoped).count
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

    var navigationShortcutsSection: some View {
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
}
