import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct SessionDetailView: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.openURL) private var openURL
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var composerText: String = ""
    @State private var composerAttachments: [PendingImageAttachment] = []

    @State private var showModesSheet = false
    @State private var showBtwSheet = false
    @State private var showPlanReviewSheet = false
    @State private var showRewindSheet = false
    @State private var showTreeSheet = false
    @State private var showStatsSheet = false
    @State private var showUsageSheet = false
    @State private var showFormulaSizeSheet = false
    @State private var showRenameAlert = false
    @State private var renameDraft = ""
    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    private var liveSession: SessionSummary {
        store.snapshot.sessions.first(where: { $0.id == session.id }) ?? session
    }

    private var isPinned: Bool {
        store.isPinned(liveSession)
    }

    private var isArchived: Bool {
        store.isArchived(liveSession)
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Inspector Tab Bar
            inspectorTabStrip

            if store.isOfflineReadOnly {
                HStack(spacing: 8) {
                    Image(systemName: "wifi.slash")
                        .font(.caption)
                    Text("Offline cache mode — transcript & diffs readable; actions disabled until reconnected.")
                        .font(.caption2)
                    Spacer()
                    Button("Retry") {
                        Task { await store.forceSync() }
                    }
                    .font(.caption2.weight(.bold))
                }
                .foregroundStyle(palette.amber)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(palette.amberSoft)
            }

            // Tab Content
            switch store.selectedSessionTab {
            case .chat:
                chatTabContent
            case .changes:
                GitDiffView(store: store, session: liveSession)
            case .todos:
                TodoPlanView(store: store, session: liveSession)
            case .subagents:
                SubagentsView(store: store, session: liveSession)
            case .screen:
                TerminalScreenView(store: store, session: liveSession)
            }
        }
        .background(palette.background)
        .navigationTitle(liveSession.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if liveSession.isWorking {
                    Button {
                        Task { await store.abortActiveSession() }
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .foregroundStyle(palette.red)
                    }
                    .disabled(!store.canPerformMutatingActions)
                    .accessibilityLabel("Stop active turn")
                }

                Menu {
                    Button {
                        showModesSheet = true
                    } label: {
                        Label("Modes, Model & Context Controls", systemImage: "slider.horizontal.3")
                    }

                    Button {
                        showBtwSheet = true
                    } label: {
                        Label("Side Questions (/btw)", systemImage: "bubble.left.and.text.bubble.right")
                    }

                    Divider()

                    Button {
                        Task { await store.togglePin(for: liveSession) }
                    } label: {
                        Label(isPinned ? "Unpin Session" : "Pin Session", systemImage: isPinned ? "pin.slash" : "pin")
                    }
                    .disabled(!store.canPerformMutatingActions)

                    Button {
                        renameDraft = liveSession.title
                        showRenameAlert = true
                    } label: {
                        Label("Rename Session", systemImage: "pencil")
                    }
                    .disabled(!store.canPerformMutatingActions)

                    if !liveSession.isWorking {
                        Button {
                            showRewindSheet = true
                        } label: {
                            Label("Rewind / Branch Turn…", systemImage: "arrow.uturn.backward.circle")
                        }
                        .disabled(!store.canPerformMutatingActions)
                    }

                    Button {
                        showTreeSheet = true
                    } label: {
                        Label("Conversation Tree", systemImage: "point.3.connected.trianglepath.dotted")
                    }

                    Button {
                        showStatsSheet = true
                    } label: {
                        Label("Stats & HTML Export", systemImage: "chart.bar.doc.horizontal")
                    }

                    Button {
                        showUsageSheet = true
                    } label: {
                        Label("Provider Quotas", systemImage: "gauge.with.needle")
                    }

                    Button {
                        showFormulaSizeSheet = true
                    } label: {
                        Label("Formula Size…", systemImage: "x.squareroot")
                    }
                    Divider()

                    Button {
                        Task { await store.openTerminalOnHost(path: liveSession.cwd) }
                    } label: {
                        Label("Open Terminal on Host", systemImage: "terminal")
                    }
                    .disabled(!store.canPerformMutatingActions)

                    if !liveSession.isWorking && liveSession.status != .done {
                        Button {
                            Task { await store.completeSession(liveSession) }
                        } label: {
                            Label("Mark Done", systemImage: "checkmark.circle")
                        }
                        .disabled(!store.canPerformMutatingActions)
                    }

                    if !liveSession.isWorking {
                        Button {
                            Task { await store.toggleArchive(for: liveSession) }
                        } label: {
                            Label(isArchived ? "Restore from Archive" : "Archive Session", systemImage: isArchived ? "tray.and.arrow.up" : "archivebox")
                        }
                        .disabled(!store.canPerformMutatingActions)
                    }

                    Button(role: .destructive) {
                        Task { await store.hideSession(liveSession) }
                    } label: {
                        Label("Hide from Sidebar", systemImage: "eye.slash")
                    }
                    .disabled(!store.canPerformMutatingActions || liveSession.status == .running)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Session actions")
            }
        }
        // Hidden keyboard shortcuts for iPadOS / external keyboards (Cmd+1..5)
        .background {
            VStack {
                ForEach(Array(SessionInspectorTab.allCases.enumerated()), id: \.offset) { idx, tab in
                    if let keyChar = Character("\(idx + 1)") as Character? {
                        Button("") {
                            store.selectInspectorTab(tab)
                        }
                        .keyboardShortcut(KeyEquivalent(keyChar), modifiers: .command)
                    }
                }
                if liveSession.isWorking && store.canPerformMutatingActions {
                    Button("") {
                        Task { await store.abortActiveSession() }
                    }
                    .keyboardShortcut(.escape, modifiers: [])
                }
            }
            .frame(width: 0, height: 0)
            .opacity(0)
            .accessibilityHidden(true)
        }
        .sheet(isPresented: $showModesSheet) {
            ModeControlsSheet(store: store, session: liveSession)
        }
        .sheet(isPresented: $showBtwSheet) {
            BtwSideSheet(store: store, session: liveSession)
        }
        .sheet(isPresented: $showPlanReviewSheet) {
            PlanReviewSheet(store: store, session: liveSession)
        }
        .sheet(isPresented: $showRewindSheet) {
            BranchRewindSheet(store: store, session: liveSession) { prefill in
                composerText = prefill
                store.selectInspectorTab(.chat)
            }
        }
        .sheet(isPresented: $showTreeSheet) {
            TreeViewerSheet(store: store, session: liveSession)
        }
        .sheet(isPresented: $showStatsSheet) {
            SessionStatsSheet(store: store, session: liveSession)
        }
        .sheet(isPresented: $showUsageSheet) {
            UsagePopoverSheet(store: store, session: liveSession)
        }
        .sheet(isPresented: $showFormulaSizeSheet) {
            FormulaSizeSheet()
        }
        .alert("Rename Session", isPresented: $showRenameAlert) {
            TextField("Title", text: $renameDraft)
            Button("Save") {
                let clean = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                if !clean.isEmpty {
                    Task { await store.renameSession(liveSession, to: clean) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    // MARK: - Inspector Tabs

    private var inspectorTabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(SessionInspectorTab.allCases) { tab in
                    let isSelected = store.selectedSessionTab == tab
                    let badge = badgeCount(for: tab)
                    Button {
                        store.selectInspectorTab(tab)
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: tab.systemImage)
                                .font(.caption2)
                            Text(tab.title)
                                .font(.caption.weight(.semibold))
                            if badge > 0 {
                                Text("\(badge)")
                                    .font(.caption2.monospacedDigit().weight(.bold))
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(isSelected ? Color.white.opacity(0.22) : palette.accentSoft, in: Capsule())
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(isSelected ? palette.accent : palette.raised, in: Capsule())
                        .foregroundStyle(isSelected ? .white : palette.foreground)
                        .overlay(
                            Capsule().stroke(isSelected ? palette.accent : palette.border, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
        }
        .background(palette.surface)
        .overlay(alignment: .bottom) { Divider().overlay(palette.border) }
    }

    private func badgeCount(for tab: SessionInspectorTab) -> Int {
        switch tab {
        case .chat:
            return liveSession.uiRequests?.count ?? 0
        case .changes:
            return store.cachedDiffsBySession[liveSession.id]?.files.count ?? 0
        case .todos:
            return (liveSession.todos ?? []).reduce(0) { $0 + $1.tasks.filter { $0.status != .completed }.count }
        case .subagents:
            return liveSession.resolvedSubagentCount
        case .screen:
            return (liveSession.uiRequests ?? []).filter { $0.method == "custom" }.count
        }
    }

    // MARK: - Chat Tab

    private var chatTabContent: some View {
        VStack(spacing: 0) {
            sessionStatusBanners

            TranscriptView(
                store: store,
                session: liveSession,
                onResendDroppedSteer: { msg in
                    Task { await resendDroppedSteer(msg) }
                },
                onBranchFromEntry: { entryId, _ in
                    Task { await branchFromTranscriptEntry(entryId) }
                },
                onEditLast: {
                    Task { await editLastTranscriptMessage() }
                },
                onRegenerate: {
                    Task { await regenerateLastTranscriptMessage() }
                }
            )

            if !(liveSession.uiRequests?.isEmpty ?? true) {
                ScrollView {
                    InteractivePromptStack(store: store, session: liveSession)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }
                .frame(maxHeight: 360)
                .background(palette.surface.opacity(0.95))
                .overlay(alignment: .top) { Divider().overlay(palette.amber.opacity(0.5)) }
            }

            ComposerView(
                store: store,
                session: liveSession,
                text: $composerText,
                attachments: $composerAttachments,
                onOpenModes: { showModesSheet = true },
                onOpenBtw: { showBtwSheet = true }
            )
        }
    }

    // MARK: - Session Alerts & Contextual Banners

    @ViewBuilder
    private var sessionStatusBanners: some View {
        let hasBanners = liveSession.hasPlanReviewPending
            || liveSession._retry != nil
            || liveSession._openUrl != nil
            || !(liveSession._overlaps?.isEmpty ?? true)
            || liveSession._rateLimit != nil
            || liveSession.connectionResume != nil
            || !(liveSession._notices?.isEmpty ?? true)

        if hasBanners {
            VStack(spacing: 6) {
                if liveSession.hasPlanReviewPending {
                    Button {
                        showPlanReviewSheet = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "doc.text.magnifyingglass")
                                .foregroundStyle(palette.amber)
                            Text(liveSession._planReview?.title ?? "Native Plan Ready for Review")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                            Spacer()
                            Text("Review")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(palette.amber)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(palette.amberSoft, in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }

                if let retry = liveSession._retry {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Retrying (attempt \(retry.attempt ?? 1)\(retry.maxAttempts.map { "/\($0)" } ?? ""))")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.amber)
                            if let err = retry.error, !err.isEmpty {
                                Text(err)
                                    .font(.caption2)
                                    .foregroundStyle(palette.muted)
                                    .lineLimit(2)
                            }
                        }
                        Spacer()
                        Button("Abort Retry") {
                            Task { await store.abortActiveSession() }
                        }
                        .font(.caption.weight(.bold))
                        .foregroundStyle(palette.red)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(palette.amberSoft, in: RoundedRectangle(cornerRadius: 10))
                }

                if let openUrlPrompt = liveSession._openUrl {
                    HStack(spacing: 8) {
                        Image(systemName: "person.badge.key.fill")
                            .foregroundStyle(palette.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(openUrlPrompt.title ?? "Sign In Required")
                                .font(.caption.weight(.semibold))
                            if let inst = openUrlPrompt.instructions, !inst.isEmpty {
                                Text(inst).font(.caption2).foregroundStyle(palette.muted).lineLimit(2)
                            }
                        }
                        Spacer()
                        if let u = URL(string: openUrlPrompt.url) {
                            Button("Open") {
                                openURL(u)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(palette.accent)
                            .controlSize(.small)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: 10))
                }

                if let overlaps = liveSession._overlaps, !overlaps.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.2")
                            .foregroundStyle(palette.amber)
                        Text("File overlap with: \(overlaps.compactMap(\.title).joined(separator: ", "))")
                            .font(.caption2)
                            .foregroundStyle(palette.foreground)
                            .lineLimit(2)
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(palette.amberSoft.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
                }

                if let notices = liveSession._notices, !notices.isEmpty {
                    ForEach(notices.suffix(2)) { n in
                        HStack(spacing: 8) {
                            Image(systemName: n.level == "error" ? "xmark.octagon.fill" : "info.circle.fill")
                                .font(.caption)
                                .foregroundStyle(n.level == "error" ? palette.red : (n.level == "warning" ? palette.amber : palette.accent))
                            Text(n.text)
                                .font(.caption2)
                                .foregroundStyle(palette.foreground)
                                .lineLimit(2)
                            Spacer()
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(n.level == "error" ? palette.redSoft : palette.raised, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(palette.surface)
        }
    }

    // MARK: - Transcript Action Callbacks

    private func resendDroppedSteer(_ msg: TranscriptMessage) async {
        guard let client = store.activeClient else { return }
        let type = liveSession.isWorking ? "steer" : "prompt"
        do {
            let updated = try await client.sendSessionPrompt(sessionId: liveSession.id, type: type, message: msg.text)
            store.integrateSession(updated)
            store.showToast("Resent dropped steer")
            store.notificationManager.triggerHaptic(.success)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func branchFromTranscriptEntry(_ entryId: String) async {
        guard let client = store.activeClient else { return }
        do {
            let res = try await client.branchSession(sessionId: liveSession.id, entryId: entryId)
            store.integrateSession(res.session)
            if !res.text.isEmpty { composerText = res.text }
            store.showToast("Branched from turn")
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func editLastTranscriptMessage() async {
        guard let client = store.activeClient else { return }
        do {
            let res = try await client.editLastMessage(sessionId: liveSession.id)
            store.integrateSession(res.session)
            if !res.text.isEmpty { composerText = res.text }
            store.showToast("Rewound prompt into composer")
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func regenerateLastTranscriptMessage() async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.regenerateLastMessage(sessionId: liveSession.id)
            store.integrateSession(updated)
            store.showToast("Regenerating last turn")
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}
