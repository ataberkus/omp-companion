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
    @State private var composerPdfs: [PendingPdfAttachment] = []

    @State private var showModesSheet = false
    @State private var showBtwSheet = false
    @State private var showPlanReviewSheet = false
    @State private var showRewindSheet = false
    @State private var showTreeSheet = false
    @State private var showStatsSheet = false
    @State private var showUsageSheet = false
    @State private var showFormulaSizeSheet = false
    @State private var showRenameAlert = false
    @State private var showShutdownConfirm = false
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

    private func performMenuAction(_ action: SessionActionsMenu.Action) {
        let session = liveSession
        switch action {
        case .modes: showModesSheet = true
        case .btw: showBtwSheet = true
        case .togglePin: Task { await store.togglePin(for: session) }
        case .rename:
            renameDraft = session.title
            showRenameAlert = true
        case .rewind: showRewindSheet = true
        case .tree: showTreeSheet = true
        case .stats: showStatsSheet = true
        case .usage: showUsageSheet = true
        case .formulaSize: showFormulaSizeSheet = true
        case .terminal: Task { await store.openTerminalOnHost(path: session.cwd) }
        case .markDone: Task { await store.completeSession(session) }
        case .toggleArchive: Task { await store.toggleArchive(for: session) }
        case .shutdownPC: showShutdownConfirm = true
        case .toggleAutoShutdown:
            Task { await store.setAutoShutdown(on: !(store.snapshot.autoShutdown?.on == true)) }
        case .hide: Task { await store.hideSession(session) }
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Inspector Tab Bar
            inspectorTabStrip

            if store.isOfflineReadOnly {
                HStack(spacing: 8) {
                    Image(systemName: "wifi.slash")
                        .font(.caption)
                    Text("Offline cache mode — transcript & diffs readable; messages you send wait on this phone until the PC answers.")
                        .font(.caption2)
                    if store.outboxCount > 0 {
                        Text("\(store.outboxCount)")
                            .font(.caption2.monospacedDigit().weight(.bold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(palette.amber.opacity(0.25), in: Capsule())
                            .accessibilityLabel("\(store.outboxCount) waiting to send")
                    }
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
        // Pinned to the top and filling the screen: a tab whose content is shorter than the screen (Changes' empty state)
        // otherwise centered the whole stack, tab strip included, leaving a gap under the navigation bar.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
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

            }
            // Own item and an equatable view: polls replace `liveSession` every few seconds, and rebuilding the open
            // menu's content made a scrolled ⋯ menu jump back to its top (the web had the same bug, 2697a39).
            ToolbarItem(placement: .topBarTrailing) {
                SessionActionsMenu(
                    state: SessionActionsMenu.MenuState(
                        isPinned: isPinned,
                        isArchived: isArchived,
                        isWorking: liveSession.isWorking,
                        isDone: liveSession.status == .done,
                        isRunning: liveSession.status == .running,
                        isAutoShutdownOn: store.snapshot.autoShutdown?.on == true,
                        canMutate: store.canPerformMutatingActions
                    ),
                    perform: performMenuAction
                )
                .equatable()
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
        .alert("Shut Down Host Computer?", isPresented: $showShutdownConfirm) {
            Button("Shut Down Now", role: .destructive) {
                Task { await store.shutdownCompanionHost() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will power off the remote companion computer over Tailscale after pausing active sessions.")
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
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
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

            OutboxQueueBar(store: store, sessionID: liveSession.id) { item in
                Task { await editOutboxItem(item) }
            }

            ComposerView(
                store: store,
                session: liveSession,
                text: $composerText,
                attachments: $composerAttachments,
                pdfAttachments: $composerPdfs,
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

    /// Edit on a waiting message: it leaves the outbox and goes back into the composer, which must be empty so nothing
    /// written there is replaced.
    private func editOutboxItem(_ item: OutboxItem) async {
        let composerBusy = !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !composerAttachments.isEmpty || !composerPdfs.isEmpty
        guard !composerBusy else {
            store.showToast(String(localized: "Send or clear the message in the composer first, then edit this one.", bundle: .main), isError: true)
            return
        }
        guard let taken = await store.takeOutboxItem(item.id) else { return }
        composerText = taken.text
        composerAttachments = taken.images
        composerPdfs = taken.pdfs
    }

    private func resendDroppedSteer(_ msg: TranscriptMessage) async {
        guard let client = store.activeClient else { return }
        let type = liveSession.isWorking ? "steer" : "prompt"
        // A steer's PDFs go again as their reference lines, so OMP reads the stored files; without stored paths they
        // must be attached again.
        let own = msg.textAndPdfs
        var message = own.text
        if !own.pdfs.isEmpty {
            guard own.pdfs.allSatisfy({ $0.path?.isEmpty == false }) else {
                store.showToast(String(localized: "Reattach the PDF before resending.", bundle: .main), isError: true)
                return
            }
            message = PdfAttachmentProcessor.withPdfRefs(own.text == "PDF attached" ? "" : own.text, pdfs: own.pdfs)
        }
        do {
            let updated = try await client.sendSessionPrompt(sessionId: liveSession.id, type: type, message: message)
            store.integrateSession(updated)
            store.showToast(String(localized: "Resent dropped steer", bundle: .main))
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
            store.showToast(String(localized: "Branched from turn", bundle: .main))
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
            store.showToast(String(localized: "Rewound prompt into composer", bundle: .main))
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func regenerateLastTranscriptMessage() async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.regenerateLastMessage(sessionId: liveSession.id)
            store.integrateSession(updated)
            store.showToast(String(localized: "Regenerating last turn", bundle: .main))
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}

/// The session's ⋯ menu. Equatable on `state` only, so SwiftUI skips rebuilding it (and the open menu keeps its scroll
/// position) when a poll changes the session without changing anything the menu shows.
struct SessionActionsMenu: View, Equatable {
    struct MenuState: Equatable {
        let isPinned: Bool
        let isArchived: Bool
        let isWorking: Bool
        let isDone: Bool
        let isRunning: Bool
        let isAutoShutdownOn: Bool
        let canMutate: Bool
    }

    enum Action {
        case modes, btw, togglePin, rename, rewind, tree, stats, usage, formulaSize, terminal, markDone, toggleArchive,
             shutdownPC, toggleAutoShutdown, hide
    }

    let state: MenuState
    let perform: (Action) -> Void

    static func == (lhs: SessionActionsMenu, rhs: SessionActionsMenu) -> Bool {
        lhs.state == rhs.state
    }

    var body: some View {
        Menu {
            Button { perform(.modes) } label: {
                Label("Modes, Model & Context Controls", systemImage: "slider.horizontal.3")
            }
            Button { perform(.btw) } label: {
                Label("Side Questions (/btw)", systemImage: "bubble.left.and.text.bubble.right")
            }

            Divider()

            Button { perform(.togglePin) } label: {
                Label(state.isPinned ? "Unpin Session" : "Pin Session", systemImage: state.isPinned ? "pin.slash" : "pin")
            }
            .disabled(!state.canMutate)

            Button { perform(.rename) } label: {
                Label("Rename Session", systemImage: "pencil")
            }
            .disabled(!state.canMutate)

            if !state.isWorking {
                Button { perform(.rewind) } label: {
                    Label("Rewind / Branch Turn…", systemImage: "arrow.uturn.backward.circle")
                }
                .disabled(!state.canMutate)
            }

            Button { perform(.tree) } label: {
                Label("Conversation Tree", systemImage: "point.3.connected.trianglepath.dotted")
            }
            Button { perform(.stats) } label: {
                Label("Stats & HTML Export", systemImage: "chart.bar.doc.horizontal")
            }
            Button { perform(.usage) } label: {
                Label("Provider Quotas", systemImage: "gauge.with.needle")
            }
            Button { perform(.formulaSize) } label: {
                Label("Formula Size…", systemImage: "x.squareroot")
            }

            Divider()

            Button { perform(.terminal) } label: {
                Label("Open Terminal on Host", systemImage: "terminal")
            }
            .disabled(!state.canMutate)

            if !state.isWorking && !state.isDone {
                Button { perform(.markDone) } label: {
                    Label("Mark Done", systemImage: "checkmark.circle")
                }
                .disabled(!state.canMutate)
            }

            if !state.isWorking {
                Button { perform(.toggleArchive) } label: {
                    Label(state.isArchived ? "Restore from Archive" : "Archive Session", systemImage: state.isArchived ? "tray.and.arrow.up" : "archivebox")
                }
                .disabled(!state.canMutate)
            }

            Button(role: .destructive) { perform(.shutdownPC) } label: {
                Label("Shut down PC…", systemImage: "power")
            }
            .disabled(!state.canMutate)

            Button { perform(.toggleAutoShutdown) } label: {
                if state.isAutoShutdownOn {
                    Label("Shut down PC when finished", systemImage: "checkmark")
                } else {
                    Text("Shut down PC when finished")
                }
            }
            .disabled(!state.canMutate)

            Button(role: .destructive) { perform(.hide) } label: {
                Label("Hide from Sidebar", systemImage: "eye.slash")
            }
            .disabled(!state.canMutate || state.isRunning)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Session actions")
    }
}
