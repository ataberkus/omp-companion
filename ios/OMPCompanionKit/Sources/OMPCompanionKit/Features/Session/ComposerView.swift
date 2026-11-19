import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

#if canImport(UIKit)
import UIKit
#endif

public struct ComposerView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @Binding public var text: String
    @Binding public var attachments: [PendingImageAttachment]

    public var onOpenModes: () -> Void
    public var onOpenBtw: () -> Void

    @FocusState private var isInputFocused: Bool
    @State private var isSending = false
    @State private var showModelPicker = false
    @State private var showEnhanceSheet = false
    @State private var showCamera = false
    @State private var showFileImporter = false
    @State private var photoItems: [PhotosPickerItem] = []

    // Draft sync tracking
    @State private var lastAppliedDraftAt: Double = 0
    @State private var hasLocalUnpushedEdits: Bool = false
    @State private var draftSaveTask: Task<Void, Never>?

    // Autocomplete states
    @State private var fileMatches: [FileMatch] = []
    @State private var isSearchingFiles = false
    @State private var fileSearchTask: Task<Void, Never>?
    @State private var predictedSuffix: String?
    @State private var predictTask: Task<Void, Never>?

    // Queue editor
    @State private var isQueueExpanded = false
    @State private var editingQueuedItem: QueuedMessage?
    @State private var queuedEditText: String = ""

    public init(
        store: AppStore,
        session: SessionSummary,
        text: Binding<String>,
        attachments: Binding<[PendingImageAttachment]>,
        onOpenModes: @escaping () -> Void,
        onOpenBtw: @escaping () -> Void
    ) {
        self.store = store
        self.session = session
        self._text = text
        self._attachments = attachments
        self.onOpenModes = onOpenModes
        self.onOpenBtw = onOpenBtw
    }

    private var commands: [SlashCommandInfo] {
        store.commandsBySession[session.id] ?? []
    }

    private var slashQuery: String? {
        guard text.hasPrefix("/") else { return nil }
        let body = String(text.dropFirst())
        // Stop matching once user passes command + args unless typing a subcommand
        let parts = body.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
        if parts.count > 2 { return nil }
        if text.contains("\n") { return nil }
        return body.lowercased()
    }

    private var filteredCommands: [(command: SlashCommandInfo, subcommand: SlashSubcommandInfo?)] {
        guard let q = slashQuery else { return [] }
        let parts = q.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
        let cmdPart = String(parts.first ?? "")
        let subPart = parts.count > 1 ? String(parts[1]) : nil

        var results: [(SlashCommandInfo, SlashSubcommandInfo?)] = []
        for cmd in commands {
            let matchesName = cmdPart.isEmpty
                || cmd.name.lowercased().contains(cmdPart)
                || (cmd.aliases?.contains(where: { $0.lowercased().contains(cmdPart) }) ?? false)

            if let subPart {
                if cmd.name.lowercased() == cmdPart, let subs = cmd.subcommands {
                    for sub in subs where subPart.isEmpty || sub.name.lowercased().contains(subPart) {
                        results.append((cmd, sub))
                    }
                }
            } else if matchesName {
                results.append((cmd, nil))
            }
        }
        return Array(results.prefix(20))
    }

    private var activeMentionRangeAndQuery: (range: Range<String.Index>, query: String)? {
        guard !text.isEmpty else { return nil }
        // Find trailing `@token` at end of string
        guard let atIdx = text.lastIndex(of: "@") else { return nil }
        if atIdx > text.startIndex {
            let prev = text[text.index(before: atIdx)]
            if !prev.isWhitespace && !prev.isNewline { return nil }
        }
        let after = text.index(after: atIdx)
        let token = String(text[after...])
        if token.contains(where: { $0.isWhitespace || $0.isNewline }) { return nil }
        return (atIdx..<text.endIndex, token)
    }

    private var canSend: Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return (hasText || !attachments.isEmpty) && !isSending && store.canPerformMutatingActions
    }

    private var totalAttachmentsBytes: Int {
        attachments.reduce(0) { $0 + $1.base64Data.utf8.count }
    }

    private var estimatedPromptTokens: Int {
        let imgTokens = attachments.reduce(0) { $0 + $1.estimatedTokens }
        let txtTokens = max(0, (text.utf8.count + 3) / 4)
        return imgTokens + txtTokens
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Queued follow-up bar
            if let queued = session.queuedMessages, !queued.isEmpty {
                queuedMessagesBar(queued)
            }

            // Above-keyboard autocomplete sheets
            if !filteredCommands.isEmpty {
                slashAutocompleteBar
            } else if activeMentionRangeAndQuery != nil {
                fileMentionBar
            }

            if let suffix = predictedSuffix, !suffix.isEmpty {
                HStack(spacing: 8) {
                    Text("Suggestion:")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                    Button {
                        acceptPrediction(suffix)
                    } label: {
                        Text(suffix)
                            .font(.caption.monospaced())
                            .foregroundStyle(palette.accent)
                            .lineLimit(1)
                    }
                    .buttonStyle(.bordered)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(palette.surface)
            }

            // Attachments strip
            if !attachments.isEmpty {
                attachmentsStrip
            }

            // Main composer card
            VStack(spacing: 8) {
                // Top chip row: Model, Modes, Context
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Button {
                            showModelPicker = true
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "cpu")
                                Text(shortModelLabel)
                                    .lineLimit(1)
                                if let th = session.thinkingChoice ?? session.thinking, !th.isEmpty {
                                    Text("· \(th)")
                                        .foregroundStyle(palette.muted)
                                }
                            }
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(palette.raised, in: Capsule())
                            .foregroundStyle(palette.foreground)
                            .overlay(Capsule().stroke(palette.border, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(!store.canPerformMutatingActions)

                        Button(action: onOpenModes) {
                            HStack(spacing: 4) {
                                Image(systemName: "slider.horizontal.3")
                                Text("Modes")
                                if session.autoApprove == true {
                                    Text("AUTO")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(palette.green)
                                }
                                if session.planMode?.enabled == true {
                                    Text("PLAN")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(palette.violet)
                                }
                                if session.isVibeActive {
                                    Text("VIBE")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(palette.cyan)
                                }
                            }
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(palette.raised, in: Capsule())
                            .foregroundStyle(palette.foreground)
                            .overlay(Capsule().stroke(palette.border, lineWidth: 1))
                        }
                        .buttonStyle(.plain)

                        Button(action: onOpenBtw) {
                            HStack(spacing: 4) {
                                Image(systemName: "bubble.left.and.text.bubble.right")
                                Text("/btw")
                                if let cnt = session._btw?.count, cnt > 0 {
                                    Text("\(cnt)")
                                        .foregroundStyle(palette.accent)
                                }
                            }
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(palette.raised, in: Capsule())
                            .foregroundStyle(palette.foreground)
                            .overlay(Capsule().stroke(palette.border, lineWidth: 1))
                        }
                        .buttonStyle(.plain)

                        if let pct = session.contextPercent {
                            HStack(spacing: 4) {
                                Image(systemName: "chart.pie")
                                Text("\(Int(pct.rounded()))% ctx")
                            }
                            .font(.caption2.monospacedDigit())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(pct >= 85 ? palette.redSoft : palette.raised, in: Capsule())
                            .foregroundStyle(pct >= 85 ? palette.red : palette.muted)
                        }
                    }
                    .padding(.horizontal, 12)
                }

                // Text editor + action strip
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(
                        session.isWorking ? "Steer mid-turn or queue follow-up…" : "Message OMP (/ commands, @ files)…",
                        text: $text,
                        axis: .vertical
                    )
                    .focused($isInputFocused)
                    .lineLimit(1...6)
                    .font(.body)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(isInputFocused ? palette.accentLine : palette.border, lineWidth: 1))
                    .disabled(!store.canPerformMutatingActions)
                    .onChange(of: text) { _, next in
                        hasLocalUnpushedEdits = true
                        scheduleDraftSave()
                        handleMentionSearch(next)
                        scheduleWordPrediction(next)
                    }

                    // Primary send/steer/stop controls
                    if session.isWorking {
                        HStack(spacing: 6) {
                            Button {
                                Task { await store.abortActiveSession() }
                            } label: {
                                Image(systemName: "stop.fill")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 36, height: 36)
                                    .background(palette.red, in: Circle())
                            }
                            .disabled(!store.canPerformMutatingActions)
                            .accessibilityLabel("Stop active turn")

                            Menu {
                                Button {
                                    Task { await dispatch(type: "steer") }
                                } label: {
                                    Label("Steer Current Turn", systemImage: "arrow.triangle.turn.up.right.diamond")
                                }
                                Button {
                                    Task { await dispatch(type: "follow_up") }
                                } label: {
                                    Label("Queue Follow-Up", systemImage: "text.append")
                                }
                                Button {
                                    Task { await dispatch(type: "interrupt") }
                                } label: {
                                    Label("Stop & Send Immediately", systemImage: "bolt.circle")
                                }
                            } label: {
                                Image(systemName: "arrow.up.circle.fill")
                                    .font(.system(size: 32))
                                    .foregroundStyle(canSend ? palette.amber : palette.muted.opacity(0.4))
                            } primaryAction: {
                                Task { await dispatch(type: "steer") }
                            }
                            .disabled(!canSend)
                            .accessibilityLabel("Steer turn or queue follow-up")
                        }
                    } else {
                        Button {
                            Task { await dispatch(type: "prompt") }
                        } label: {
                            if isSending {
                                ProgressView()
                                    .frame(width: 36, height: 36)
                            } else {
                                Image(systemName: "arrow.up.circle.fill")
                                    .font(.system(size: 34))
                                    .foregroundStyle(canSend ? palette.accent : palette.muted.opacity(0.4))
                            }
                        }
                        .disabled(!canSend)
                        .keyboardShortcut(.return, modifiers: .command)
                        .accessibilityLabel("Send prompt")
                    }
                }
                .padding(.horizontal, 12)

                // Attachment & utility toolbar
                HStack(spacing: 14) {
                    PhotosPicker(selection: $photoItems, maxSelectionCount: 6, matching: .images) {
                        Image(systemName: "photo.on.rectangle")
                            .font(.subheadline)
                            .foregroundStyle(palette.muted)
                    }
                    .disabled(!store.canPerformMutatingActions)
                    .onChange(of: photoItems) { _, items in
                        Task { await loadPickedPhotos(items) }
                    }
                    .accessibilityLabel("Attach from Photos")

                    Button {
                        showCamera = true
                    } label: {
                        Image(systemName: "camera")
                            .font(.subheadline)
                            .foregroundStyle(palette.muted)
                    }
                    .disabled(!store.canPerformMutatingActions)
                    .accessibilityLabel("Take photo")

                    Button {
                        showFileImporter = true
                    } label: {
                        Image(systemName: "paperclip")
                            .font(.subheadline)
                            .foregroundStyle(palette.muted)
                    }
                    .disabled(!store.canPerformMutatingActions)
                    .accessibilityLabel("Attach image file")

                    #if canImport(UIKit)
                    Button {
                        pasteClipboardImage()
                    } label: {
                        Image(systemName: "doc.on.clipboard")
                            .font(.subheadline)
                            .foregroundStyle(palette.muted)
                    }
                    .disabled(!store.canPerformMutatingActions)
                    .accessibilityLabel("Paste image from clipboard")
                    #endif

                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button {
                            showEnhanceSheet = true
                        } label: {
                            Label("Enhance", systemImage: "sparkles")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.accent)
                        }
                        .disabled(!store.canPerformMutatingActions)
                    }

                    Spacer()

                    if estimatedPromptTokens > 0 {
                        Text("~\(CompanionFormatters.formatTokens(estimatedPromptTokens)) tok")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(palette.muted)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 8)
            }
            .padding(.top, 8)
            .background(palette.surface)
            .overlay(alignment: .top) {
                Divider().overlay(palette.border)
            }
            .background {
                Button("") {
                    Task { await dispatch(type: session.isWorking ? "steer" : "prompt") }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
                .frame(width: 0, height: 0)
                .opacity(0)
                .accessibilityHidden(true)
            }
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(
                store: store,
                selectedModel: session.effectiveModelSelector ?? "",
                selectedThinking: session.thinkingChoice ?? session.thinking ?? ""
            ) { model, thinking in
                Task {
                    guard let client = store.activeClient else { return }
                    if let updated = try? await client.setModel(
                        sessionId: session.id,
                        model: model.isEmpty ? nil : model,
                        thinking: thinking.isEmpty ? nil : thinking
                    ) {
                        store.integrateSession(updated)
                    }
                }
            }
        }
        .sheet(isPresented: $showEnhanceSheet) {
            PromptEnhanceSheet(
                store: store,
                originalText: text,
                sessionId: session.id,
                path: session.cwd,
                model: session.effectiveModelSelector,
                thinking: session.thinkingChoice ?? session.thinking,
                images: attachments
            ) { enhanced in
                text = enhanced
                hasLocalUnpushedEdits = true
                scheduleDraftSave()
            }
        }
        #if canImport(UIKit)
        .sheet(isPresented: $showCamera) {
            CameraImagePicker { img in
                do {
                    let att = try ImageAttachmentProcessor.processUIImage(img, existingBase64Bytes: totalAttachmentsBytes)
                    attachments.append(att)
                    hasLocalUnpushedEdits = true
                    scheduleDraftSave()
                } catch {
                    store.showToast(error.localizedDescription, isError: true)
                }
            }
        }
        #endif
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task { await loadImageFiles(urls) }
            }
        }
        .alert("Edit Queued Follow-Up", isPresented: Binding(
            get: { editingQueuedItem != nil },
            set: { if !$0 { editingQueuedItem = nil } }
        )) {
            TextField("Follow-up message", text: $queuedEditText)
            Button("Save") {
                if let item = editingQueuedItem {
                    Task { await saveEditedFollowUp(item: item, message: queuedEditText) }
                }
                editingQueuedItem = nil
            }
            Button("Cancel", role: .cancel) { editingQueuedItem = nil }
        }
        .task(id: session.id) {
            hasLocalUnpushedEdits = false
            lastAppliedDraftAt = 0
            predictedSuffix = nil
            await pullDraftFromHost(force: true)
            await store.refreshCommandsIfNeeded(for: session.id)
            await applyEditorTextIfNeeded()
        }
        .onChange(of: sessionDraftTimestamp) { _, newAt in
            if newAt > lastAppliedDraftAt && !hasLocalUnpushedEdits {
                Task { await pullDraftFromHost(force: false) }
            }
        }
        .onChange(of: session._editorText?.id) { _, _ in
            Task { await applyEditorTextIfNeeded() }
        }
    }

    private var shortModelLabel: String {
        if let m = session.model, !m.isEmpty {
            return m.split(separator: "/").last.map(String.init) ?? m
        }
        return "Model"
    }

    private var sessionDraftTimestamp: Double {
        store.snapshot.drafts?[session.draftKey] ?? 0
    }

    // MARK: - Queued Follow-ups Bar

    @ViewBuilder
    private func queuedMessagesBar(_ items: [QueuedMessage]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) {
                        isQueueExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "text.line.first.and.arrowtriangle.forward")
                            .font(.caption)
                            .foregroundStyle(palette.amber)
                        Text("\(items.count) \(items.count == 1 ? "message" : "messages") queued")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                        if !isQueueExpanded, let first = items.first {
                            Text("· \(first.text.isEmpty ? "[Image]" : first.text)")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                                .lineLimit(1)
                        }
                    }
                }
                .buttonStyle(.plain)

                Spacer()

                if items.count > 1 {
                    Button {
                        withAnimation { isQueueExpanded.toggle() }
                    } label: {
                        Image(systemName: isQueueExpanded ? "chevron.down" : "chevron.up")
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                    }
                    .buttonStyle(.plain)
                }
            }

            let visibleItems = isQueueExpanded ? items : Array(items.prefix(1))
            ForEach(visibleItems) { q in
                HStack(spacing: 8) {
                    Text(q.text.isEmpty ? "Image attached" : q.text)
                        .font(.caption)
                        .foregroundStyle(palette.foreground)
                        .lineLimit(isQueueExpanded ? 4 : 1)
                    Spacer()

                    Button {
                        Task { await sendQueuedNow(q) }
                    } label: {
                        Image(systemName: "arrow.up.circle")
                            .font(.subheadline)
                            .foregroundStyle(palette.accent)
                    }
                    .accessibilityLabel("Send queued message now")

                    Button {
                        queuedEditText = q.text
                        editingQueuedItem = q
                    } label: {
                        Image(systemName: "pencil")
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                    }
                    .accessibilityLabel("Edit queued message")

                    Button {
                        Task { await cancelQueued(q) }
                    } label: {
                        Image(systemName: "trash")
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                    .accessibilityLabel("Remove queued message")
                }
                .buttonStyle(.borderless)
                .disabled(!store.canPerformMutatingActions)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(palette.amberSoft.opacity(0.45))
        .overlay(alignment: .top) { Divider().overlay(palette.border) }
    }

    // MARK: - Autocomplete Popovers

    private var slashAutocompleteBar: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                ForEach(Array(filteredCommands.enumerated()), id: \.offset) { _, entry in
                    let cmd = entry.command
                    let sub = entry.subcommand
                    let fullName = sub != nil ? "/\(cmd.name) \(sub!.name)" : "/\(cmd.name)"
                    Button {
                        text = fullName + " "
                        hasLocalUnpushedEdits = true
                        store.notificationManager.triggerHaptic(.selection)
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Text(fullName)
                                .font(.caption.monospaced().weight(.bold))
                                .foregroundStyle(palette.accent)
                            if let desc = sub?.description ?? cmd.description, !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(palette.muted)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                            }
                            Spacer()
                            if let hint = cmd.hint, !hint.isEmpty, sub == nil {
                                Text(hint)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(palette.muted)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
        }
        .frame(maxHeight: 190)
        .background(palette.card)
        .overlay(alignment: .top) { Divider().overlay(palette.borderStrong) }
    }

    private var fileMentionBar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Workspace Files (@)", systemImage: "doc.text.magnifyingglass")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.accent)
                Spacer()
                if isSearchingFiles {
                    ProgressView().controlSize(.mini)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if fileMatches.isEmpty && !isSearchingFiles {
                        Text("No matching files found")
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                    } else {
                        ForEach(fileMatches) { file in
                            Button {
                                insertFileMention(file.rel)
                            } label: {
                                HStack {
                                    Image(systemName: "doc")
                                        .font(.caption2)
                                        .foregroundStyle(palette.muted)
                                    Text(file.rel)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(palette.foreground)
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                    Spacer()
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .frame(maxHeight: 170)
        }
        .background(palette.card)
        .overlay(alignment: .top) { Divider().overlay(palette.borderStrong) }
    }

    // MARK: - Attachments Strip

    private var attachmentsStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(attachments) { att in
                    ZStack(alignment: .topTrailing) {
                        VStack(alignment: .leading, spacing: 3) {
                            if let preview = att.previewDataURL {
                                DataURLImageView(dataURL: preview)
                                    .frame(width: 70, height: 54)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            } else if let raw = Data(base64Encoded: att.base64Data) {
                                PlatformRawImageView(data: raw)
                                    .frame(width: 70, height: 54)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            Text("~\(att.estimatedTokens) tok")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(palette.muted)
                        }
                        .padding(4)
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))

                        Button {
                            attachments.removeAll { $0.id == att.id }
                            hasLocalUnpushedEdits = true
                            scheduleDraftSave()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.white, palette.red)
                        }
                        .offset(x: 5, y: -5)
                        .accessibilityLabel("Remove image \(att.name)")
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(palette.surface)
        .overlay(alignment: .top) { Divider().overlay(palette.border) }
    }

    // MARK: - Draft Sync, Mentions, Predictions & Dispatch

    private func pullDraftFromHost(force: Bool) async {
        guard let client = store.activeClient else { return }
        let haveNames = attachments.map(\.name)
        guard let resp = try? await client.fetchDraft(key: session.draftKey, haveNames: force ? [] : haveNames) else {
            return
        }
        let remoteAt = resp.at ?? 0
        guard force || (remoteAt > lastAppliedDraftAt && !hasLocalUnpushedEdits) else { return }
        lastAppliedDraftAt = remoteAt
        text = resp.text
        var rebuilt: [PendingImageAttachment] = []
        for entry in resp.images {
            if let existing = attachments.first(where: { $0.name == entry.name }), entry.image == nil {
                rebuilt.append(existing)
            } else if let mapped = PendingImageAttachment.fromDraftEntry(entry) {
                rebuilt.append(mapped)
            }
        }
        attachments = rebuilt
        hasLocalUnpushedEdits = false
    }

    private func scheduleDraftSave() {
        draftSaveTask?.cancel()
        draftSaveTask = Task {
            try? await Task.sleep(nanoseconds: 650_000_000)
            guard !Task.isCancelled, let client = store.activeClient else { return }
            let currentText = text
            let wireImages = attachments.map { $0.wireDraftImageEntry() }
            if let saved = try? await client.saveDraft(key: session.draftKey, text: currentText, images: wireImages) {
                lastAppliedDraftAt = saved.at ?? lastAppliedDraftAt
                hasLocalUnpushedEdits = false
            }
        }
    }

    private func applyEditorTextIfNeeded() async {
        guard let prompt = session._editorText, !prompt.text.isEmpty, let client = store.activeClient else { return }
        if text.isEmpty {
            text = prompt.text
        } else if !text.contains(prompt.text) {
            text += "\n" + prompt.text
        }
        hasLocalUnpushedEdits = true
        scheduleDraftSave()
        try? await client.acknowledgeEditorText(sessionId: session.id, id: prompt.id)
    }

    private func handleMentionSearch(_ value: String) {
        fileSearchTask?.cancel()
        guard let info = activeMentionRangeAndQuery else {
            fileMatches = []
            isSearchingFiles = false
            return
        }
        isSearchingFiles = true
        let q = info.query
        fileSearchTask = Task {
            try? await Task.sleep(nanoseconds: 160_000_000)
            guard !Task.isCancelled, let client = store.activeClient else { return }
            do {
                let res = try await client.searchFiles(path: session.cwd, query: q, limit: 35)
                if !Task.isCancelled {
                    fileMatches = res.files
                    isSearchingFiles = false
                }
            } catch {
                if !Task.isCancelled {
                    isSearchingFiles = false
                }
            }
        }
    }

    private func insertFileMention(_ relPath: String) {
        guard let info = activeMentionRangeAndQuery else { return }
        text.replaceSubrange(info.range, with: "@\(relPath) ")
        fileMatches = []
        hasLocalUnpushedEdits = true
        scheduleDraftSave()
        store.notificationManager.triggerHaptic(.selection)
    }

    private func scheduleWordPrediction(_ value: String) {
        predictTask?.cancel()
        predictedSuffix = nil
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 8, !value.hasPrefix("/"), let client = store.activeClient else { return }
        predictTask = Task {
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard !Task.isCancelled else { return }
            if let res = try? await client.predictWord(sessionId: session.id, text: value, cursor: value.count),
               let suffix = res.suffix, !suffix.isEmpty, text == value {
                predictedSuffix = suffix
            }
        }
    }

    private func acceptPrediction(_ suffix: String) {
        let baseText = text
        let cursor = baseText.count
        text += suffix
        predictedSuffix = nil
        hasLocalUnpushedEdits = true
        scheduleDraftSave()
        Task {
            guard let client = store.activeClient else { return }
            try? await client.predictWordFeedback(sessionId: session.id, text: baseText, cursor: cursor, suggestion: suffix, accepted: true)
        }
    }

    private func dispatch(type: String) async {
        guard let client = store.activeClient else { return }
        let bodyText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !bodyText.isEmpty || !attachments.isEmpty else { return }

        let totalWireBytes = totalAttachmentsBytes + bodyText.utf8.count
        guard totalWireBytes < CompanionClient.largeBodyLimit - 65_536 else {
            store.showToast("Payload exceeds 48 MB companion upload limit. Remove an image.", isError: true)
            return
        }

        let currentText = text
        let currentAttachments = attachments
        let previews = currentAttachments.compactMap(\.previewDataURL)
        let wireImages = currentAttachments.map(\.wireImagePart)

        isSending = true
        draftSaveTask?.cancel()
        predictedSuffix = nil
        text = ""
        attachments = []
        hasLocalUnpushedEdits = false
        defer { isSending = false }

        do {
            let updated = try await client.sendSessionPrompt(
                sessionId: session.id,
                type: type,
                message: currentText,
                images: wireImages,
                preview: previews.isEmpty ? nil : previews
            )
            store.integrateSession(updated)
            _ = try? await client.saveDraft(key: session.draftKey, text: "", images: [])
            store.notificationManager.triggerHaptic(.lightTap)
        } catch {
            text = currentText
            attachments = currentAttachments
            hasLocalUnpushedEdits = true
            store.showToast(error.localizedDescription, isError: true)
            store.notificationManager.triggerHaptic(.error)
        }
    }

    private func sendQueuedNow(_ item: QueuedMessage) async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.sendFollowUpNow(sessionId: session.id, itemId: item.id)
            store.integrateSession(updated)
            store.notificationManager.triggerHaptic(.lightTap)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func saveEditedFollowUp(item: QueuedMessage, message: String) async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.editFollowUp(sessionId: session.id, itemId: item.id, message: message)
            store.integrateSession(updated)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func cancelQueued(_ item: QueuedMessage) async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.cancelFollowUp(sessionId: session.id, itemId: item.id)
            store.integrateSession(updated)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    // MARK: - Media Pickers

    private func loadPickedPhotos(_ items: [PhotosPickerItem]) async {
        defer { photoItems = [] }
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self) {
                do {
                    let att = try ImageAttachmentProcessor.processRawImageData(data, suggestedName: "photo.jpg", existingBase64Bytes: totalAttachmentsBytes)
                    attachments.append(att)
                    hasLocalUnpushedEdits = true
                } catch {
                    store.showToast(error.localizedDescription, isError: true)
                }
            }
        }
        scheduleDraftSave()
    }

    private func loadImageFiles(_ urls: [URL]) async {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url) {
                do {
                    let att = try ImageAttachmentProcessor.processRawImageData(data, suggestedName: url.lastPathComponent, existingBase64Bytes: totalAttachmentsBytes)
                    attachments.append(att)
                    hasLocalUnpushedEdits = true
                } catch {
                    store.showToast(error.localizedDescription, isError: true)
                }
            }
        }
        scheduleDraftSave()
    }

    #if canImport(UIKit)
    private func pasteClipboardImage() {
        if let image = UIPasteboard.general.image {
            do {
                let att = try ImageAttachmentProcessor.processUIImage(image, suggestedName: "clipboard.jpg", existingBase64Bytes: totalAttachmentsBytes)
                attachments.append(att)
                hasLocalUnpushedEdits = true
                scheduleDraftSave()
                store.notificationManager.triggerHaptic(.lightTap)
            } catch {
                store.showToast(error.localizedDescription, isError: true)
            }
        } else {
            store.showToast("No image found in clipboard", isError: true)
        }
    }
    #endif
}
