import SwiftUI

extension DashboardView {
    @ViewBuilder
    func sessionRow(_ item: DashboardItem, showFolder: Bool, emphasizeAttention: Bool = false) -> some View {
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
                                .accessibilityLabel("Pinned")
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
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.16)) {
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
}
