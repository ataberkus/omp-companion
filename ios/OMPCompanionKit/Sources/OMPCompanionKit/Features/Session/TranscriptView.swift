import SwiftUI
import QuickLook

#if canImport(UIKit)
import UIKit
#endif

// MARK: - Virtualized Streaming Transcript View

public struct TranscriptView: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    /// A downloaded PDF shown in QuickLook; `openingPdfID` is the one being fetched.
    @State private var pdfPreviewURL: URL?
    @State private var openingPdfID: String?
    @State private var editingSteerMessage: TranscriptMessage?
    /// How many of the newest messages are rendered; "Show earlier messages" raises it by `tailPageSize`.
    @State private var tailLimit = TranscriptView.tailPageSize
    private static let tailPageSize = 40
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

    /// The thread's last user message when it is OMP's last prompt (not a steer or companion-only command): only that one
    /// can be edited in place (`edit_last`), as on the web; earlier prompts are edited by branching from them.
    private var editableLastPromptID: String? {
        guard let last = messages.last(where: { $0.role == .user }),
              last.steer == nil,
              (last.entryId?.isEmpty == false) || last.ompAt != nil else { return nil }
        return last.id
    }

    public var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    // Eager VStack over the newest messages, not a LazyVStack over all of them: the lazy stack guessed the
                    // heights of unrendered rows, so the bottom anchor opened the chat over blank space until a later layout.
                    VStack(alignment: .leading, spacing: 10) {
                        if messages.isEmpty {
                            OMPEmptyStateView(
                                systemImage: "text.bubble",
                                title: session.draft == true ? String(localized: "Draft Session Ready", bundle: .main) : String(localized: "No Messages Yet", bundle: .main),
                                message: String(localized: "Type a prompt below, attach screenshots, or pick a /slash command to start.", bundle: .main)
                            )
                            .padding(.top, 36)
                        } else {
                            let hidden = max(0, messages.count - tailLimit)
                            if hidden > 0 {
                                Button {
                                    isPinnedToBottom = false
                                    tailLimit += Self.tailPageSize
                                } label: {
                                    Label("Show \(min(hidden, Self.tailPageSize)) earlier messages · \(hidden) hidden", systemImage: "arrow.up.circle")
                                        .font(.footnote.weight(.semibold))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 8)
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(palette.accent)
                            }
                            ForEach(messages.suffix(tailLimit)) { msg in
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
                // A fresh scroll view per session, opened at the bottom by the anchor. Reusing one across sessions and
                // jumping with scrollTo before the lazy rows were measured left it mid-transcript, past its real end, so it
                // would not scroll down until scrolled up first.
                .id(session.id)
                .defaultScrollAnchor(.bottom)
                // Scrolling or tapping the transcript puts the keyboard away.
                .scrollDismissesKeyboard(.interactively)
                .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
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
                    tailLimit = Self.tailPageSize
                }
                .onChange(of: streamTailSignature) { _, _ in
                    if messages.count > lastObservedCount && !isPinnedToBottom {
                        unreadCount += (messages.count - lastObservedCount)
                    }
                    lastObservedCount = messages.count
                    if isPinnedToBottom {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                            proxy.scrollTo("transcript-bottom", anchor: .bottom)
                        }
                    }
                }
                .onAppear {
                    lastObservedCount = messages.count
                }

                if !isPinnedToBottom && !messages.isEmpty {
                    Button {
                        isPinnedToBottom = true
                        unreadCount = 0
                        tailLimit = Self.tailPageSize
                        // No animation and repeated once rows settle: an animated scrollTo over a long distance stopped short
                        // (rows above it re-measured mid-flight), so the button only worked near the bottom.
                        proxy.scrollTo("transcript-bottom", anchor: .bottom)
                        for delay in [0.05, 0.25] {
                            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                                guard isPinnedToBottom else { return }
                                proxy.scrollTo("transcript-bottom", anchor: .bottom)
                            }
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
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.scale.combined(with: .opacity))
                    .accessibilityLabel("Jump to latest transcript messages")
                }
            }
        }
        .sheet(item: $lightboxImage) { payload in
            ImageLightboxSheet(payload: payload)
        }
        .quickLookPreview($pdfPreviewURL)
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

    private func dismissKeyboard() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
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
        // The companion's "PDF attached" stands in for a message of PDFs alone: the chips (or the label) show it instead.
        let own = msg.textAndPdfs
        let pdfOnly = own.text == "PDF attached"
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
                            .accessibilityLabel("View attachment \(idx + 1)")
                        }
                    }
                }
            } else if msg.hasImage == true {
                Label("Image attached", systemImage: "photo")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            }

            if !own.pdfs.isEmpty {
                pdfChips(own.pdfs)
            } else if pdfOnly {
                Label("PDF attached", systemImage: "doc.richtext")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            }

            if !own.text.isEmpty && !pdfOnly {
                Text(own.text)
                    .font(.body)
                    .foregroundStyle(palette.foreground)
                    .textSelection(.enabled)
            }

            // Steer actions (`pending` edit/cancel, `dropped` one-tap Resend)
            if msg.steer == .pending {
                HStack(spacing: 10) {
                    // Steers with images are not edited here, and the host refuses edit_steer for ones with PDFs.
                    if msg.hasImage != true && own.pdfs.isEmpty {
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
                UIPasteboard.general.string = own.text
                store.showToast(String(localized: "Copied message", bundle: .main))
            } label: {
                Label("Copy Text", systemImage: "doc.on.doc")
            }
            #endif
            if !session.isWorking && msg.id == editableLastPromptID {
                Button {
                    onEditLast?()
                } label: {
                    Label("Edit & Resend", systemImage: "pencil")
                }
            }
            if let entryId = msg.entryId, !entryId.isEmpty, !session.isWorking {
                Button {
                    onBranchFromEntry?(entryId, msg.text)
                } label: {
                    Label(msg.id == editableLastPromptID ? "Branch / Fork From Here" : "Edit & Resend (Branch From Here)", systemImage: "arrow.triangle.branch")
                }
            }
        }
    }

    // MARK: - PDF Chips

    private func pdfChips(_ pdfs: [MessagePdf]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(pdfs.enumerated()), id: \.offset) { _, pdf in
                    pdfChip(pdf)
                }
            }
        }
    }

    /// One PDF the message carries; one with a stored ID opens in QuickLook, one without (an older message) only shows.
    private func pdfChip(_ pdf: MessagePdf) -> some View {
        let detail = PdfAttachmentProcessor.detail(pages: pdf.pages, bytes: pdf.bytes)
        let isOpening = pdf.storedID != nil && openingPdfID == pdf.storedID
        return Button {
            Task { await openPdf(pdf) }
        } label: {
            HStack(spacing: 8) {
                if isOpening {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "doc.richtext.fill")
                        .font(.title3)
                        .foregroundStyle(palette.red)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(pdf.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if isOpening || !detail.isEmpty {
                        Text(isOpening ? "Downloading…" : detail)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(palette.muted)
                            .lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: 240, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(pdf.storedID == nil || openingPdfID != nil)
        .accessibilityLabel("Open \(pdf.name)\(detail.isEmpty ? "" : ", \(detail)")")
    }

    /// Downloads a stored PDF (`GET /api/attachment`) to a temporary file named after it and shows it in QuickLook.
    private func openPdf(_ pdf: MessagePdf) async {
        guard let id = pdf.storedID, openingPdfID == nil, let client = store.activeClient else { return }
        let base = PdfAttachmentProcessor.sanitizeName(pdf.name)
        let fileName = base.lowercased().hasSuffix(".pdf") ? base : base + ".pdf"
        // One folder per content ID: the same ID is the same bytes, so a file already downloaded is shown again as is.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("attachments/\(id)", isDirectory: true)
        let file = dir.appendingPathComponent(fileName)
        if FileManager.default.fileExists(atPath: file.path) {
            pdfPreviewURL = file
            return
        }
        openingPdfID = id
        defer { openingPdfID = nil }
        do {
            let data = try await client.fetchAttachment(id: id, name: pdf.name)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
            pdfPreviewURL = file
        } catch let error as CompanionAPIError where error.statusCode == 404 {
            store.showToast(String(localized: "\(pdf.name) is no longer stored on the host: it was cleared from Tools › Disk space.", bundle: .main), isError: true)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
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
                MarkdownView(text: msg.text)
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
                store.showToast(String(localized: "Copied reply", bundle: .main))
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
                MarkdownView(text: msg.text)
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

struct ThinkingTraceCard: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let message: TranscriptMessage
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(palette.muted)
                        .accessibilityHidden(true)
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
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")

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

// MARK: - Fullscreen Image Lightbox Sheet

public struct LightboxImagePayload: Identifiable, Sendable {
    public let id = UUID()
    public let title: String
    public let data: Data
}

public struct ImageLightboxSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                                    withAnimation(reduceMotion ? nil : .default) { scale = 1.0 }
                                }
                            }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(reduceMotion ? nil : .default) { scale = scale > 1.2 ? 1.0 : 2.2 }
                    }
                    .accessibilityElement()
                    .accessibilityLabel(payload.title)
                    .accessibilityAddTraits(.isImage)
                    .accessibilityAction(named: scale > 1.2 ? "Zoom out" : "Zoom in") {
                        withAnimation(reduceMotion ? nil : .default) { scale = scale > 1.2 ? 1.0 : 2.2 }
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
                                title: String(localized: "Side Questions (/btw)", bundle: .main),
                                message: String(localized: "Ask out-of-band questions about the current session without interrupting or polluting the main agent transcript.", bundle: .main)
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
                    if activeRecordId != nil {
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
                        .accessibilityLabel("Send side question")
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
                MarkdownView(text: answer)
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
