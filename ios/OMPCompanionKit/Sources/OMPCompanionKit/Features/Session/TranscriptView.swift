import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// MARK: - Virtualized Streaming Transcript View

public struct TranscriptView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary
    public var onResendDroppedSteer: ((TranscriptMessage) -> Void)?
    public var onBranchFromEntry: ((String, String) -> Void)?
    public var onEditLast: (() -> Void)?
    public var onRegenerate: (() -> Void)?

    @State private var isPinnedToBottom = true
    @State private var unreadCount = 0
    @State private var lastObservedCount = 0
    @State private var lightboxImage: LightboxImagePayload?
    @State private var editingSteerMessage: TranscriptMessage?
    @State private var steerEditDraft: String = ""

    public init(
        store: AppStore,
        session: SessionSummary,
        onResendDroppedSteer: ((TranscriptMessage) -> Void)? = nil,
        onBranchFromEntry: ((String, String) -> Void)? = nil,
        onEditLast: (() -> Void)? = nil,
        onRegenerate: (() -> Void)? = nil
    ) {
        self.store = store
        self.session = session
        self.onResendDroppedSteer = onResendDroppedSteer
        self.onBranchFromEntry = onBranchFromEntry
        self.onEditLast = onEditLast
        self.onRegenerate = onRegenerate
    }

    private var messages: [TranscriptMessage] {
        session.messages ?? []
    }

    private var streamTailSignature: String {
        let last = messages.last
        return "\(messages.count):\(last?.id ?? ""):\(last?.text.count ?? 0):\(last?.tool?.status ?? ""):\(last?.tool?.result?.count ?? 0)"
    }

    public var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if messages.isEmpty {
                            OMPEmptyStateView(
                                systemImage: "text.bubble",
                                title: session.draft == true ? "Draft Session Ready" : "No Messages Yet",
                                message: "Type a prompt below, attach screenshots, or pick a /slash command to start."
                            )
                            .padding(.top, 36)
                        } else {
                            ForEach(messages) { msg in
                                messageRow(msg)
                                    .id(msg.id)
                            }
                        }

                        if session.isWorking {
                            liveActivityFooter
                        }

                        Color.clear
                            .frame(height: 2)
                            .id("transcript-bottom")
                            .onAppear {
                                isPinnedToBottom = true
                                unreadCount = 0
                            }
                            .onDisappear {
                                isPinnedToBottom = false
                            }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 8)
                        .onChanged { value in
                            // Downward drag pulls earlier messages into view -> yield auto-scroll immediately
                            if value.translation.height > 12 {
                                isPinnedToBottom = false
                            }
                        }
                )
                .onChange(of: session.id) { _, _ in
                    isPinnedToBottom = true
                    unreadCount = 0
                    lastObservedCount = messages.count
                    DispatchQueue.main.async {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo("transcript-bottom", anchor: .bottom)
                        }
                    }
                }
                .onChange(of: streamTailSignature) { _, _ in
                    if messages.count > lastObservedCount && !isPinnedToBottom {
                        unreadCount += (messages.count - lastObservedCount)
                    }
                    lastObservedCount = messages.count
                    if isPinnedToBottom {
                        withAnimation(.easeOut(duration: 0.18)) {
                            proxy.scrollTo("transcript-bottom", anchor: .bottom)
                        }
                    }
                }
                .onAppear {
                    lastObservedCount = messages.count
                    proxy.scrollTo("transcript-bottom", anchor: .bottom)
                }

                if !isPinnedToBottom && !messages.isEmpty {
                    Button {
                        isPinnedToBottom = true
                        unreadCount = 0
                        withAnimation(.easeOut(duration: 0.24)) {
                            proxy.scrollTo("transcript-bottom", anchor: .bottom)
                        }
                        store.notificationManager.triggerHaptic(.lightTap)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.down.circle.fill")
                            Text(unreadCount > 0 ? "Jump to latest (\(unreadCount) new)" : "Jump to latest")
                                .font(.caption.weight(.semibold))
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(palette.accent, in: Capsule())
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.28), radius: 8, y: 4)
                    }
                    .padding(.trailing, 14)
                    .padding(.bottom, 12)
                    .minTouchTarget()
                    .transition(.scale.combined(with: .opacity))
                    .accessibilityLabel("Jump to latest transcript messages")
                }
            }
        }
        .sheet(item: $lightboxImage) { payload in
            ImageLightboxSheet(payload: payload)
        }
        .alert("Edit Queued Steer", isPresented: Binding(
            get: { editingSteerMessage != nil },
            set: { if !$0 { editingSteerMessage = nil } }
        )) {
            TextField("Steer message", text: $steerEditDraft)
            Button("Save") {
                if let msg = editingSteerMessage {
                    let text = steerEditDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        Task { await editPendingSteer(id: msg.id, message: text) }
                    }
                }
                editingSteerMessage = nil
            }
            Button("Cancel", role: .cancel) { editingSteerMessage = nil }
        }
    }

    @ViewBuilder
    private var liveActivityFooter: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .tint(palette.accent)
            Text(session._task ?? session._bash ?? (session._compacting == true ? "Compacting conversation…" : "OMP is working…"))
                .font(.caption)
                .foregroundStyle(palette.muted)
            if let tps = session.tps, tps > 0 {
                Spacer()
                Text(String(format: "%.0f tok/s", tps))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(palette.accent)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
    }

    @ViewBuilder
    private func messageRow(_ msg: TranscriptMessage) -> some View {
        switch msg.role {
        case .user:
            userCard(msg)
        case .assistant:
            assistantCard(msg)
        case .thinking:
            ThinkingTraceCard(message: msg)
        case .tool:
            ToolExecutionCard(
                store: store,
                sessionCwd: session.cwd,
                message: msg,
                onTapImage: { data, title in
                    lightboxImage = LightboxImagePayload(title: title, data: data)
                }
            )
        case .advisor, .advisorUpdate:
            advisorCard(msg)
        case .system:
            systemCard(msg)
        }
    }

    // MARK: - User Card & Steer Lifecycle

    @ViewBuilder
    private func userCard(_ msg: TranscriptMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Label("You", systemImage: "person.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.accent)

                if let from = msg.from, !from.isEmpty {
                    Text(from)
                        .font(.caption2.monospaced())
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(palette.raised, in: Capsule())
                        .foregroundStyle(palette.muted)
                }

                if let steer = msg.steer {
                    steerBadge(steer)
                }

                Spacer()

                if let at = msg.at {
                    Text(CompanionFormatters.relativeDate(at))
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
            }

            if let previews = msg.imagePreview, !previews.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(previews.enumerated()), id: \.offset) { idx, src in
                            Button {
                                if let data = ImageAttachmentProcessor.decodeDataURL(src) {
                                    lightboxImage = LightboxImagePayload(title: "Attachment \(idx + 1)", data: data)
                                }
                            } label: {
                                DataURLImageView(dataURL: src)
                                    .frame(width: 96, height: 96)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.borderStrong, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            } else if msg.hasImage == true {
                Label("Image attached", systemImage: "photo")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            }

            if !msg.text.isEmpty {
                Text(msg.text)
                    .font(.body)
                    .foregroundStyle(palette.foreground)
                    .textSelection(.enabled)
            }

            // Steer actions (`pending` edit/cancel, `dropped` one-tap Resend)
            if msg.steer == .pending {
                HStack(spacing: 10) {
                    if msg.hasImage != true {
                        Button("Edit Steer") {
                            steerEditDraft = msg.text
                            editingSteerMessage = msg
                        }
                        .font(.caption.weight(.semibold))
                    }
                    Button("Cancel Steer", role: .destructive) {
                        Task { await cancelPendingSteer(id: msg.id) }
                    }
                    .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .disabled(!store.canPerformMutatingActions)
            } else if msg.steer == .dropped {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(palette.red)
                    Text("Steer dropped before delivery")
                        .font(.caption)
                        .foregroundStyle(palette.red)
                    Spacer()
                    Button {
                        onResendDroppedSteer?(msg)
                    } label: {
                        Label("Resend", systemImage: "arrow.uturn.right.circle.fill")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.amber)
                    .disabled(!store.canPerformMutatingActions)
                }
                .padding(.top, 2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.accentSoft.opacity(0.65), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(msg.steer == .dropped ? palette.red.opacity(0.6) : palette.accentLine, lineWidth: 1)
        )
        .contextMenu {
            #if canImport(UIKit)
            Button {
                UIPasteboard.general.string = msg.text
                store.showToast("Copied message")
            } label: {
                Label("Copy Text", systemImage: "doc.on.doc")
            }
            #endif
            if let entryId = msg.entryId, !entryId.isEmpty, !session.isWorking {
                Button {
                    onBranchFromEntry?(entryId, msg.text)
                } label: {
                    Label("Branch / Fork From Here", systemImage: "arrow.triangle.branch")
                }
            }
        }
    }

    @ViewBuilder
    private func steerBadge(_ state: SteerState) -> some View {
        let (label, fg, bg): (String, Color, Color) = {
            switch state {
            case .pending: return ("Steer Pending", palette.amber, palette.amberSoft)
            case .received: return ("Steer Delivered", palette.green, palette.greenSoft)
            case .dropped: return ("Steer Dropped", palette.red, palette.redSoft)
            }
        }()
        Text(label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(bg, in: Capsule())
            .foregroundStyle(fg)
    }

    // MARK: - Assistant Card

    @ViewBuilder
    private func assistantCard(_ msg: TranscriptMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Label(msg.model ?? "OMP", systemImage: "sparkles")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.green)
                    .lineLimit(1)

                if let from = msg.from, !from.isEmpty {
                    Text(from)
                        .font(.caption2.monospaced())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(palette.raised, in: Capsule())
                        .foregroundStyle(palette.muted)
                }

                Spacer()

                if let at = msg.at {
                    Text(CompanionFormatters.relativeDate(at))
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
            }

            if !msg.text.isEmpty {
                MarkdownView(msg.text)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(palette.border, lineWidth: 1))
        .contextMenu {
            #if canImport(UIKit)
            Button {
                UIPasteboard.general.string = msg.text
                store.showToast("Copied reply")
            } label: {
                Label("Copy Reply", systemImage: "doc.on.doc")
            }
            #endif
            if !session.isWorking {
                Button {
                    onEditLast?()
                } label: {
                    Label("Rewind & Edit Last Prompt", systemImage: "pencil.and.outline")
                }
                Button {
                    onRegenerate?()
                } label: {
                    Label("Regenerate Reply", systemImage: "arrow.clockwise")
                }
            }
        }
    }

    // MARK: - Advisor Card

    @ViewBuilder
    private func advisorCard(_ msg: TranscriptMessage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Label(msg.adv ?? "Advisor", systemImage: "eye.trianglebadge.exclamationmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(palette.violet)
                Spacer()
                if let at = msg.at {
                    Text(CompanionFormatters.relativeDate(at))
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
            }

            if !msg.text.isEmpty {
                MarkdownView(msg.text)
            }

            if let notes = msg.notes, !notes.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(notes) { note in
                        HStack(alignment: .top, spacing: 6) {
                            let sevColor = note.severity == "blocker" ? palette.red : (note.severity == "concern" ? palette.amber : palette.accent)
                            Text(note.severity.uppercased())
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(sevColor.opacity(0.16), in: Capsule())
                                .foregroundStyle(sevColor)
                            Text(note.note)
                                .font(.caption)
                                .foregroundStyle(palette.foreground)
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.violetSoft.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.violet.opacity(0.45), lineWidth: 1))
    }

    // MARK: - System Notice Card

    @ViewBuilder
    private func systemCard(_ msg: TranscriptMessage) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle")
                .font(.caption)
                .foregroundStyle(palette.muted)
                .padding(.top, 2)
            Text(msg.text)
                .font(.caption)
                .foregroundStyle(palette.muted)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 8))
    }

    private func cancelPendingSteer(id: String) async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.cancelSteer(sessionId: session.id, messageId: id)
            store.integrateSession(updated)
            store.notificationManager.triggerHaptic(.lightTap)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func editPendingSteer(id: String, message: String) async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.editSteer(sessionId: session.id, messageId: id, message: message)
            store.integrateSession(updated)
            store.notificationManager.triggerHaptic(.success)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}

// MARK: - Collapsible Thinking Trace Card

private struct ThinkingTraceCard: View {
    @Environment(\.ompPalette) private var palette
    let message: TranscriptMessage
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(palette.muted)
                    Label("Reasoning Trace", systemImage: "brain.head.profile")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.muted)
                    Spacer()
                    Text("\(message.text.count) chars")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.muted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(message.text)
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.muted)
                    .textSelection(.enabled)
                    .padding(.top, 4)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
    }
}

// MARK: - Tool Execution Card

private struct ToolExecutionCard: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    let sessionCwd: String
    let message: TranscriptMessage
    let onTapImage: (Data, String) -> Void

    @State private var isExpanded: Bool
    @State private var showFullResult = false
    @State private var loadedImages: [String: Data] = [:]

    init(store: AppStore, sessionCwd: String, message: TranscriptMessage, onTapImage: @escaping (Data, String) -> Void) {
        self.store = store
        self.sessionCwd = sessionCwd
        self.message = message
        self.onTapImage = onTapImage
        let hasVisuals = !(message.tool?.images?.isEmpty ?? true) || !(message.tool?.files?.isEmpty ?? true)
        self._isExpanded = State(initialValue: hasVisuals || message.tool?.status == "error")
    }

    private var tool: ToolRecord {
        message.tool ?? ToolRecord(name: "tool", status: "done")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    statusIcon
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(tool.name)
                                .font(.caption.monospaced().weight(.bold))
                                .foregroundStyle(palette.foreground)
                            if let ms = tool.ms {
                                Text("\(ms) ms")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.muted)
                            }
                            if let code = tool.exitCode {
                                Text("exit \(code)")
                                    .font(.caption2.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(code == 0 ? palette.green : palette.red)
                            }
                        }
                        if let subtitle = (tool.intent?.isEmpty == false ? tool.intent : tool.args) ?? (message.text.isEmpty ? nil : message.text) {
                            Text(subtitle)
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                                .lineLimit(isExpanded ? 4 : 1)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                if let cmd = tool.command, !cmd.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text("$ \(cmd)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.cyan)
                            .textSelection(.enabled)
                    }
                    .padding(8)
                    .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 8))
                }

                if let tasks = tool.tasks, !tasks.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(tasks.enumerated()), id: \.offset) { _, t in
                            HStack(spacing: 6) {
                                Image(systemName: "cpu")
                                    .font(.caption2)
                                    .foregroundStyle(palette.accent)
                                Text(t.name ?? t.id ?? "Subagent task")
                                    .font(.caption2.weight(.semibold))
                                if let desc = t.description, !desc.isEmpty {
                                    Text(desc)
                                        .font(.caption2)
                                        .foregroundStyle(palette.muted)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }

                if let files = tool.files, !files.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(files) { f in
                            ToolInlineDiffBox(store: store, sessionCwd: sessionCwd, fileDiff: f)
                        }
                    }
                }

                if let images = tool.images, !images.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(images) { ref in
                                Group {
                                    if let data = loadedImages[ref.id] {
                                        Button {
                                            onTapImage(data, "\(tool.name) Output")
                                        } label: {
                                            PlatformRawImageView(data: data)
                                                .frame(maxWidth: 220, maxHeight: 160)
                                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.borderStrong, lineWidth: 1))
                                        }
                                        .buttonStyle(.plain)
                                    } else {
                                        ProgressView()
                                            .frame(width: 96, height: 72)
                                            .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
                                            .task(id: ref.id) {
                                                if let data = await store.loadToolImageData(id: ref.id) {
                                                    loadedImages[ref.id] = data
                                                }
                                            }
                                    }
                                }
                            }
                        }
                    }
                }

                if let result = tool.result, !result.isEmpty {
                    let clean = SGRParser.stripANSI(result)
                    let display = (!showFullResult && clean.count > 2500) ? String(clean.prefix(2500)) + "\n… [truncated]" : clean
                    VStack(alignment: .leading, spacing: 6) {
                        ScrollView(.horizontal, showsIndicators: true) {
                            Text(display)
                                .font(.caption2.monospaced())
                                .foregroundStyle(palette.foreground)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        .padding(8)
                        .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 8))

                        HStack(spacing: 12) {
                            if clean.count > 2500 {
                                Button(showFullResult ? "Show Less" : "Show Full Output (\(clean.count) chars)") {
                                    showFullResult.toggle()
                                }
                                .font(.caption2.weight(.semibold))
                            }
                            #if canImport(UIKit)
                            Button("Copy Output") {
                                UIPasteboard.general.string = clean
                                store.showToast("Copied tool output")
                            }
                            .font(.caption2.weight(.semibold))
                            #endif
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(tool.status == "error" ? palette.red.opacity(0.5) : palette.border, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch tool.status {
        case "running":
            ProgressView().controlSize(.mini)
        case "error":
            Image(systemName: "xmark.circle.fill")
                .font(.caption)
                .foregroundStyle(palette.red)
        default:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(palette.green)
        }
    }
}

private struct ToolInlineDiffBox: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    let sessionCwd: String
    let fileDiff: ToolFileDiff

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text((fileDiff.op ?? "modify").uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(fileDiff.op == "delete" ? palette.red : (fileDiff.op == "create" ? palette.green : palette.accent))
                Text(fileDiff.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button {
                    Task { await store.openInEditor(path: fileDiff.path, cwd: sessionCwd) }
                } label: {
                    Image(systemName: "macwindow")
                        .font(.caption2)
                        .foregroundStyle(palette.accent)
                }
                .buttonStyle(.plain)
            }

            if let diff = fileDiff.diff, !diff.isEmpty {
                let rows = Array(DiffParser.parse(diff).prefix(60))
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(rows) { row in
                            HStack(spacing: 6) {
                                Text(row.lineNumber)
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.muted)
                                    .frame(width: 28, alignment: .trailing)
                                Text(row.text.isEmpty ? " " : row.text)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(rowColor(row.kind))
                                    .fixedSize(horizontal: true, vertical: false)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(rowBackground(row.kind))
                        }
                    }
                }
                .padding(6)
                .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(8)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
    }

    private func rowColor(_ kind: DiffRowKind) -> Color {
        switch kind {
        case .add: return palette.diffAddText
        case .delete: return palette.diffDeleteText
        case .hunkHeader: return palette.cyan
        default: return palette.foreground
        }
    }

    private func rowBackground(_ kind: DiffRowKind) -> Color {
        switch kind {
        case .add: return palette.diffAddBackground
        case .delete: return palette.diffDeleteBackground
        default: return .clear
        }
    }
}

// MARK: - Fullscreen Image Lightbox Sheet

public struct LightboxImagePayload: Identifiable, Sendable {
    public let id = UUID()
    public let title: String
    public let data: Data
}

public struct ImageLightboxSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    public let payload: LightboxImagePayload

    @State private var scale: CGFloat = 1.0

    public init(payload: LightboxImagePayload) {
        self.payload = payload
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                PlatformRawImageView(data: payload.data)
                    .scaleEffect(scale)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { val in
                                scale = min(5.0, max(1.0, val.magnification))
                            }
                            .onEnded { val in
                                if val.magnification < 1.05 {
                                    withAnimation { scale = 1.0 }
                                }
                            }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation { scale = scale > 1.2 ? 1.0 : 2.2 }
                    }
            }
            .navigationTitle(payload.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                #if canImport(UIKit)
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if let img = UIImage(data: payload.data) {
                            UIPasteboard.general.image = img
                        }
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .accessibilityLabel("Copy image")
                }
                #endif
            }
        }
    }
}

// MARK: - /btw Side Question Sheet

public struct BtwSideSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var questionInput = ""
    @State private var activeRecordId: String?
    @State private var isSending = false
    @State private var errorMessage: String?

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    private var liveSession: SessionSummary {
        store.snapshot.sessions.first(where: { $0.id == session.id }) ?? session
    }

    private var records: [BtwRecord] {
        liveSession._btw ?? []
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(palette.red)
                        .padding(8)
                }

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if records.isEmpty {
                            OMPEmptyStateView(
                                systemImage: "bubble.left.and.text.bubble.right",
                                title: "Side Questions (/btw)",
                                message: "Ask out-of-band questions about the current session without interrupting or polluting the main agent transcript."
                            )
                            .padding(.top, 32)
                        } else {
                            ForEach(records) { rec in
                                VStack(alignment: .leading, spacing: 10) {
                                    turnView(question: rec.question, answer: rec.answer, status: rec.status, error: rec.error)
                                    ForEach(rec.followUps ?? []) { turn in
                                        Divider().overlay(palette.border)
                                        turnView(question: turn.question, answer: turn.answer, status: turn.status, error: turn.error)
                                    }
                                    HStack {
                                        Button("Continue Topic") {
                                            activeRecordId = rec.id
                                        }
                                        .font(.caption.weight(.semibold))

                                        if rec.status == "running" || (rec.followUps?.last?.status == "running") {
                                            Spacer()
                                            Button("Cancel", role: .destructive) {
                                                Task {
                                                    if let client = store.activeClient {
                                                        _ = try? await client.cancelBtw(sessionId: liveSession.id, recordId: rec.id)
                                                        await store.forceSync()
                                                    }
                                                }
                                            }
                                            .font(.caption.weight(.semibold))
                                        }
                                    }
                                    .buttonStyle(.borderless)
                                }
                                .ompCard(palette)
                            }
                        }
                    }
                    .padding()
                }

                Divider().overlay(palette.border)

                VStack(alignment: .leading, spacing: 6) {
                    if let activeRecordId {
                        HStack {
                            Text("Replying to side thread")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(palette.accent)
                            Spacer()
                            Button("New Topic") {
                                self.activeRecordId = nil
                            }
                            .font(.caption2)
                        }
                    }

                    HStack(spacing: 8) {
                        TextField("Ask a side question (/btw)…", text: $questionInput, axis: .vertical)
                            .lineLimit(1...4)
                            .textFieldStyle(.roundedBorder)

                        Button {
                            Task { await sendSideQuestion() }
                        } label: {
                            if isSending {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "arrow.up.circle.fill")
                                    .font(.title2)
                            }
                        }
                        .disabled(isSending || questionInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.canPerformMutatingActions)
                    }
                }
                .padding()
                .background(palette.surface)
            }
            .background(palette.background)
            .navigationTitle("Side Questions (/btw)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await loadHistory() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh side question history")
                }
            }
            .task {
                if records.isEmpty {
                    await loadHistory()
                }
            }
        }
    }

    @ViewBuilder
    private func turnView(question: String, answer: String, status: String, error: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(question)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.accent)

            if !answer.isEmpty {
                MarkdownView(answer)
            } else if status == "running" {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Thinking…")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                }
            }

            if let error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(palette.red)
            }
        }
    }

    private func loadHistory() async {
        guard let client = store.activeClient else { return }
        _ = try? await client.fetchBtwHistory(sessionId: liveSession.id)
        await store.forceSync()
    }

    private func sendSideQuestion() async {
        let q = questionInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let client = store.activeClient else { return }
        isSending = true
        errorMessage = nil
        questionInput = ""
        defer { isSending = false }
        do {
            _ = try await client.sendBtw(sessionId: liveSession.id, question: q, recordId: activeRecordId)
            await store.forceSync()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
