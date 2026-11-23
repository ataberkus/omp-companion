import SwiftUI

public struct QuickSwitcherView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var query: String = ""
    @FocusState private var searchFocused: Bool

    public init(store: AppStore) {
        self.store = store
    }

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var matchedHosts: [HostProfile] {
        let q = normalizedQuery
        guard !q.isEmpty else { return store.hosts }
        return store.hosts.filter {
            $0.name.lowercased().contains(q) || $0.baseURL.lowercased().contains(q)
        }
    }

    private var matchedSessions: [SessionSummary] {
        let q = normalizedQuery
        let pool = store.visibleSessions + store.archivedSessions
        guard !q.isEmpty else { return Array(store.visibleSessions.prefix(10)) }
        return pool.filter { s in
            s.title.lowercased().contains(q)
                || s.cwd.lowercased().contains(q)
                || (s.branch?.lowercased().contains(q) ?? false)
                || (s.model?.lowercased().contains(q) ?? false)
        }
    }

    private var matchedProjects: [WorkspaceProject] {
        let q = normalizedQuery
        guard !q.isEmpty else { return Array(store.visibleProjects.prefix(6)) }
        return store.snapshot.projects.filter { p in
            p.name.lowercased().contains(q) || p.path.lowercased().contains(q) || (p.branch?.lowercased().contains(q) ?? false)
        }
    }

    private var matchedNativeHistory: [NativeSessionSummary] {
        let q = normalizedQuery
        guard !q.isEmpty else { return [] }
        return Array(
            store.nativeSessions.filter { s in
                (s.title?.lowercased().contains(q) ?? false)
                    || (s.cwd?.lowercased().contains(q) ?? false)
                    || (s.preview?.lowercased().contains(q) ?? false)
            }.prefix(10)
        )
    }

    private var matchedCommands: [SlashCommandInfo] {
        guard let sid = store.selectedSessionID,
              let commands = store.commandsBySession[sid] else { return [] }
        let q = normalizedQuery.hasPrefix("/") ? String(normalizedQuery.dropFirst()) : normalizedQuery
        if q.isEmpty { return [] }
        return Array(commands.filter {
            $0.name.lowercased().contains(q) || ($0.description?.lowercased().contains(q) ?? false)
        }.prefix(8))
    }
    private struct QuickDiffMatch: Identifiable {
        let id: String
        let session: SessionSummary
        let file: ToolFileDiff
    }

    private var matchedDiffs: [QuickDiffMatch] {
        let q = normalizedQuery
        var out: [QuickDiffMatch] = []
        for session in store.visibleSessions {
            guard let diff = store.cachedDiffsBySession[session.id] else { continue }
            for file in diff.files {
                if q.isEmpty
                    || file.path.lowercased().contains(q)
                    || session.title.lowercased().contains(q) {
                    out.append(QuickDiffMatch(
                        id: "\(session.id):\(file.path)",
                        session: session,
                        file: file
                    ))
                }
            }
        }
        return Array(out.prefix(q.isEmpty ? 6 : 14))
    }

    private struct QuickActionItem: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let icon: String
        let run: () -> Void
    }

    private var quickActions: [QuickActionItem] {
        let all: [QuickActionItem] = [
            QuickActionItem(id: "new", title: "New Session", subtitle: "Quick-start in any folder or worktree", icon: "plus.bubble") {
                dismiss()
                store.presentQuickStart()
            },
            QuickActionItem(id: "add-host", title: "Add Companion Host", subtitle: "Connect another Tailscale machine or scan QR", icon: "network.badge.shield.half.filled") {
                dismiss()
                store.isAddHostPresented = true
            },
            QuickActionItem(id: "activity", title: "Global Activity Log", subtitle: "Inspect completions, alerts, and errors", icon: "bell.badge") {
                dismiss()
                store.isActivityPresented = true
            },
            QuickActionItem(id: "history", title: "OMP Session History", subtitle: "Search and resume CLI transcripts", icon: "clock.arrow.circlepath") {
                dismiss()
                store.isHistoryPresented = true
            },
            QuickActionItem(id: "workspaces", title: "Workspaces & Files", subtitle: "Manage folders, branches, and editor links", icon: "folder.badge.gearshape") {
                dismiss()
                store.isWorkspacesPresented = true
            },
            QuickActionItem(id: "settings", title: "Host Admin & Settings", subtitle: "Spend charts, MCP, plugins, CLI tools, updates", icon: "gearshape.2") {
                dismiss()
                store.isSettingsPresented = true
            },
            QuickActionItem(id: "changes", title: "Active Session Diffs", subtitle: "Inspect git changes for current session", icon: "doc.text.magnifyingglass") {
                dismiss()
                if let sid = store.selectedSessionID {
                    Task { await store.selectSession(sid, tab: .changes) }
                }
            },
            QuickActionItem(id: "screen", title: "Screen & Terminal", subtitle: "Live remote screen & custom terminal panels", icon: "terminal") {
                dismiss()
                if let sid = store.selectedSessionID {
                    Task { await store.selectSession(sid, tab: .screen) }
                }
            },
        ]
        let q = normalizedQuery
        guard !q.isEmpty else { return all }
        return all.filter { $0.title.lowercased().contains(q) || $0.subtitle.lowercased().contains(q) }
    }

    public var body: some View {
        NavigationStack {
            List {
                if !matchedSessions.isEmpty {
                    Section("Sessions") {
                        ForEach(matchedSessions) { session in
                            Button {
                                dismiss()
                                Task { await store.selectSession(session.id, tab: .chat) }
                            } label: {
                                HStack(spacing: 10) {
                                    StatusPill(status: session.status, compact: true)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(session.title)
                                            .font(.subheadline.weight(.medium))
                                            .foregroundStyle(palette.foreground)
                                            .lineLimit(1)
                                        HStack(spacing: 6) {
                                            if let branch = session.branch, !branch.isEmpty {
                                                Text(branch)
                                                    .font(.caption2.monospaced())
                                                    .foregroundStyle(palette.accent)
                                            }
                                            Text(URL(fileURLWithPath: session.cwd).lastPathComponent)
                                                .font(.caption2)
                                                .foregroundStyle(palette.muted)
                                        }
                                    }
                                    Spacer()
                                    if session.needsAttention {
                                        Image(systemName: "exclamationmark.circle.fill")
                                            .foregroundStyle(palette.amber)
                                    }
                                }
                            }
                            .listRowBackground(palette.card)
                        }
                    }
                }

                if !matchedCommands.isEmpty {
                    Section("Slash Commands (Active Session)") {
                        ForEach(matchedCommands) { cmd in
                            Button {
                                dismiss()
                                if let sid = store.selectedSessionID {
                                    Task {
                                        guard let client = store.activeClient else { return }
                                        do {
                                            let updated = try await client.sendSessionPrompt(sessionId: sid, type: "prompt", message: "/\(cmd.name)")
                                            store.integrateSession(updated)
                                            store.showToast(String(localized: "Ran /\(cmd.name)", bundle: .main))
                                        } catch {
                                            store.showToast(error.localizedDescription, isError: true)
                                        }
                                    }
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("/\(cmd.name)")
                                        .font(.subheadline.monospaced().weight(.semibold))
                                        .foregroundStyle(palette.accent)
                                    if let desc = cmd.description, !desc.isEmpty {
                                        Text(desc)
                                            .font(.caption)
                                            .foregroundStyle(palette.muted)
                                            .lineLimit(2)
                                    }
                                }
                            }
                            .disabled(!store.canPerformMutatingActions)
                            .listRowBackground(palette.card)
                        }
                    }
                }
                if !matchedDiffs.isEmpty {
                    Section("Changed Files & Diffs") {
                        ForEach(matchedDiffs) { match in
                            Button {
                                dismiss()
                                Task { await store.selectSession(match.session.id, tab: .changes) }
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "doc.text.magnifyingglass")
                                        .font(.caption)
                                        .foregroundStyle(palette.amber)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(match.file.path)
                                            .font(.caption.monospaced().weight(.semibold))
                                            .foregroundStyle(palette.foreground)
                                            .lineLimit(1)
                                            .truncationMode(.head)
                                        Text(match.session.title)
                                            .font(.caption2)
                                            .foregroundStyle(palette.muted)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    Text((match.file.op ?? "modify").prefix(1).uppercased())
                                        .font(.caption2.monospaced().weight(.bold))
                                        .foregroundStyle(palette.accent)
                                }
                            }
                            .listRowBackground(palette.card)
                        }
                    }
                }

                if !matchedProjects.isEmpty {
                    Section("Workspaces") {
                        ForEach(matchedProjects) { project in
                            Button {
                                dismiss()
                                store.presentQuickStart(projectPath: project.path)
                            } label: {
                                HStack(spacing: 10) {
                                    Circle()
                                        .fill(Color.fromCSS(project.color))
                                        .frame(width: 10, height: 10)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(project.name)
                                            .font(.subheadline.weight(.medium))
                                            .foregroundStyle(palette.foreground)
                                        Text(project.path)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(palette.muted)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    Text("New Session")
                                        .font(.caption2.weight(.medium))
                                        .foregroundStyle(palette.accent)
                                }
                            }
                            .listRowBackground(palette.card)
                        }
                    }
                }

                if !matchedHosts.isEmpty {
                    Section("Companion Hosts") {
                        ForEach(matchedHosts) { host in
                            Button {
                                dismiss()
                                Task { await store.selectHost(host.id) }
                            } label: {
                                HStack {
                                    Label(host.name, systemImage: "desktopcomputer")
                                        .foregroundStyle(palette.foreground)
                                    Spacer()
                                    if store.activeHost?.id == host.id {
                                        Text("Active")
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(palette.accent)
                                    } else {
                                        Text(host.hostDisplay)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(palette.muted)
                                    }
                                }
                            }
                            .listRowBackground(palette.card)
                        }
                    }
                }

                if !matchedNativeHistory.isEmpty {
                    Section("OMP History") {
                        ForEach(matchedNativeHistory) { item in
                            Button {
                                dismiss()
                                store.selectedNativeSessionFile = item.file
                                store.isHistoryPresented = true
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.title ?? URL(fileURLWithPath: item.file).lastPathComponent)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(palette.foreground)
                                        .lineLimit(1)
                                    if let cwd = item.cwd {
                                        Text(cwd)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(palette.muted)
                                            .lineLimit(1)
                                    }
                                }
                            }
                            .listRowBackground(palette.card)
                        }
                    }
                }

                if !quickActions.isEmpty {
                    Section("Actions & Panels") {
                        ForEach(quickActions) { act in
                            Button(action: act.run) {
                                Label {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(act.title)
                                            .font(.subheadline.weight(.medium))
                                            .foregroundStyle(palette.foreground)
                                        Text(act.subtitle)
                                            .font(.caption2)
                                            .foregroundStyle(palette.muted)
                                    }
                                } icon: {
                                    Image(systemName: act.icon)
                                        .foregroundStyle(palette.accent)
                                }
                            }
                            .listRowBackground(palette.card)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Jump to session, host, workspace, /command…")
            .navigationTitle("Quick Switcher")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task {
                if let sid = store.selectedSessionID,
                   store.cachedDiffsBySession[sid] == nil,
                   let client = store.activeClient,
                   let diff = try? await client.fetchChangesWorktree(sessionId: sid) {
                    store.cacheWorktreeDiff(diff, for: sid)
                }
            }
        }
    }
}
