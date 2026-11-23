import SwiftUI

extension DashboardView {
    @ViewBuilder
    var hostHeaderSection: some View {
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
    func attentionSectionHeader(count: Int, collapsed: Bool) -> some View {
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
        .accessibilityHint(collapsed ? "Double tap to expand" : "Double tap to collapse")
    }

    @ViewBuilder
    func timeSectionHeader(_ bucket: SidebarTimeBucket, count: Int, collapsed: Bool) -> some View {
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
                        .accessibilityHidden(true)
                }
                Text(bucket.displayTitle)
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
        .accessibilityLabel("\(bucket.displayTitle), \(count) sessions")
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
    }

    @ViewBuilder
    func projectSectionHeader(_ group: ProjectGroup, collapsed: Bool, groups: [ProjectGroup]) -> some View {
        let workingCount = group.items.filter { $0.isWorking && !$0.needsReview }.count
        let reviewCount = group.items.filter(\.isReviewish).count
        let unseenCount = group.items.filter(\.isUnseen).count
        let branchText = (group.project?.branch?.isEmpty == false && group.project?.branch != "workspace") ? group.project?.branch : nil
        let isFocused = focusedWorkspaceNorm == group.normKey
        let isDropTarget = dropTargetGroupNormKey == group.normKey && draggingGroupNormKey != group.normKey
        let idx = groups.firstIndex(where: { $0.normKey == group.normKey })
        let canReorder = canReorderBase && groups.count > 1

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
            .accessibilityHint(collapsed ? "Double tap to expand" : "Double tap to collapse")

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

            if canReorder {
                Divider()
                if let idx, idx > 0 {
                    Button {
                        Task {
                            await store.moveGroup(
                                key: group.key,
                                beforeKey: groups.first?.key,
                                visibleKeys: groups.map(\.key)
                            )
                        }
                    } label: {
                        Label("Move to top", systemImage: "arrow.up.to.line")
                    }
                    Button {
                        let prev = groups[idx - 1]
                        Task {
                            await store.moveGroup(key: group.key, beforeKey: prev.key, visibleKeys: groups.map(\.key))
                        }
                    } label: {
                        Label("Move up", systemImage: "arrow.up")
                    }
                }
                if let idx, idx < groups.count - 1 {
                    Button {
                        let nextAfter: String? = (idx + 2 < groups.count) ? groups[idx + 2].key : nil
                        Task {
                            await store.moveGroup(key: group.key, beforeKey: nextAfter, visibleKeys: groups.map(\.key))
                        }
                    } label: {
                        Label("Move down", systemImage: "arrow.down")
                    }
                    Button {
                        Task {
                            await store.moveGroup(key: group.key, beforeKey: nil, visibleKeys: groups.map(\.key))
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
            guard canReorder else { return }
            Task { await store.moveGroup(key: group.key, beforeKey: groups.first?.key, visibleKeys: groups.map(\.key)) }
        }
        .accessibilityAction(named: "Move up") {
            guard canReorder, let idx, idx > 0 else { return }
            Task { await store.moveGroup(key: group.key, beforeKey: groups[idx - 1].key, visibleKeys: groups.map(\.key)) }
        }
        .accessibilityAction(named: "Move down") {
            guard canReorder, let idx, idx < groups.count - 1 else { return }
            let nextAfter: String? = (idx + 2 < groups.count) ? groups[idx + 2].key : nil
            Task { await store.moveGroup(key: group.key, beforeKey: nextAfter, visibleKeys: groups.map(\.key)) }
        }
        .accessibilityAction(named: "Move to bottom") {
            guard canReorder else { return }
            Task { await store.moveGroup(key: group.key, beforeKey: nil, visibleKeys: groups.map(\.key)) }
        }

        if canReorder && !group.normKey.isEmpty {
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
                        await store.moveGroup(key: draggedKey, beforeKey: group.key, visibleKeys: groups.map(\.key))
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
        var parts = [group.label, String(localized: "\(group.items.count) sessions", bundle: .main)]
        if working > 0 { parts.append(String(localized: "\(working) working", bundle: .main)) }
        if review > 0 { parts.append(String(localized: "\(review) waiting for you", bundle: .main)) }
        if unseen > 0 { parts.append(String(localized: "\(unseen) new", bundle: .main)) }
        return parts.joined(separator: ", ")
    }
}
