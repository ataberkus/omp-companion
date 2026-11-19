import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// MARK: - Interactive UI Request Host (ask, select, confirm, input, editor, custom)

public struct InteractivePromptStack: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    public var body: some View {
        let requests = session.uiRequests ?? []
        if !requests.isEmpty {
            VStack(spacing: 10) {
                ForEach(requests) { request in
                    InteractivePromptCard(store: store, session: session, request: request)
                }
            }
        }
    }
}

public struct InteractivePromptCard: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary
    public let request: UIRequest

    @State private var isSubmitting = false
    @State private var errorMessage: String?

    // Single input/editor draft
    @State private var textAnswer: String = ""

    // Ask multi-question state keyed by AskQuestion.id
    @State private var selectedByQuestion: [String: Set<String>] = [:]
    @State private var customByQuestion: [String: String] = [:]

    public init(store: AppStore, session: SessionSummary, request: UIRequest) {
        self.store = store
        self.session = session
        self.request = request
        self._textAnswer = State(initialValue: request.prefill ?? "")
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: headerIcon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.amber)

                Text(headerTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(2)

                Spacer()

                Button {
                    Task { await cancelRequest() }
                } label: {
                    Text(request.method == "custom" ? "Close" : "Cancel")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(palette.raised, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting || !store.canPerformMutatingActions)
                .accessibilityLabel(request.method == "custom" ? "Close interactive panel" : "Cancel question")
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(palette.red)
            }

            switch request.method {
            case "ask":
                askFormBody
            case "select":
                selectBody
            case "confirm":
                confirmBody
            case "input":
                inputBody
            case "editor":
                editorBody
            case "custom":
                CustomTerminalPanelView(
                    store: store,
                    sessionId: session.id,
                    request: request,
                    compactEmbedded: true
                )
            default:
                Text("Unsupported prompt method: \(request.method)")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            }
        }
        .padding(12)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(palette.amber.opacity(0.45), lineWidth: 1.2)
        )
        .onChange(of: request.id) { _, _ in
            textAnswer = request.prefill ?? ""
            selectedByQuestion = [:]
            customByQuestion = [:]
            errorMessage = nil
        }
    }

    private var headerIcon: String {
        switch request.method {
        case "custom": return "terminal.fill"
        case "confirm": return "checkmark.shield.fill"
        case "select": return "list.bullet.circle.fill"
        default: return "questionmark.circle.fill"
        }
    }

    private var headerTitle: String {
        if let title = request.title, !title.isEmpty { return title }
        switch request.method {
        case "ask": return "Agent Questions"
        case "custom": return "Interactive Panel"
        case "confirm": return "Confirmation Required"
        case "select": return "Choose an Option"
        default: return "Input Required"
        }
    }

    // MARK: - Ask

    @ViewBuilder
    private var askFormBody: some View {
        let questions = request.questions ?? []
        VStack(alignment: .leading, spacing: 14) {
            ForEach(questions) { q in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        if let header = q.header, !header.isEmpty {
                            Text(header)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(palette.accentSoft, in: Capsule())
                                .foregroundStyle(palette.accent)
                        }
                        if q.multi == true {
                            Text("Choose any")
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                        }
                    }

                    Text(q.question)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(palette.foreground)

                    VStack(spacing: 6) {
                        ForEach(Array(q.options.enumerated()), id: \.offset) { idx, opt in
                            let selected = selectedByQuestion[q.id]?.contains(opt.label) ?? false
                            Button {
                                toggleAskOption(question: q, label: opt.label)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 8) {
                                        Image(systemName: q.multi == true
                                              ? (selected ? "checkmark.square.fill" : "square")
                                              : (selected ? "largecircle.fill.circle" : "circle"))
                                        .foregroundStyle(selected ? palette.accent : palette.muted)

                                        Text(opt.label)
                                            .font(.subheadline.weight(.medium))
                                            .foregroundStyle(palette.foreground)
                                            .multilineTextAlignment(.leading)

                                        if q.recommended == idx {
                                            Text("Recommended")
                                                .font(.caption2.weight(.semibold))
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(palette.greenSoft, in: Capsule())
                                                .foregroundStyle(palette.green)
                                        }
                                        Spacer()
                                    }

                                    if let desc = opt.description, !desc.isEmpty {
                                        Text(desc)
                                            .font(.caption)
                                            .foregroundStyle(palette.muted)
                                            .padding(.leading, 26)
                                    }
                                    if let preview = opt.preview, !preview.isEmpty {
                                        ScrollView(.horizontal, showsIndicators: false) {
                                            Text(preview)
                                                .font(.caption2.monospaced())
                                                .foregroundStyle(palette.foreground)
                                                .padding(8)
                                        }
                                        .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 6))
                                        .padding(.leading, 26)
                                    }
                                }
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(selected ? palette.accentSoft : palette.raised, in: RoundedRectangle(cornerRadius: 10))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10)
                                        .stroke(selected ? palette.accentLine : palette.border, lineWidth: 1)
                                )
                            }
                            .buttonStyle(.plain)
                            .minTouchTarget()
                        }
                    }

                    TextField(
                        "Other (type your own)",
                        text: Binding(
                            get: { customByQuestion[q.id] ?? "" },
                            set: { val in
                                customByQuestion[q.id] = val
                                if q.multi != true && !val.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                    selectedByQuestion[q.id] = []
                                }
                            }
                        )
                    )
                    .textFieldStyle(.roundedBorder)
                    .font(.subheadline)
                    .accessibilityLabel("Other answer for \(q.question)")
                }
                .padding(10)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
            }

            Button {
                Task { await submitAsk() }
            } label: {
                HStack {
                    if isSubmitting { ProgressView().controlSize(.small) }
                    Text(questions.count > 1 ? "Submit Answers" : "Submit Answer")
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(palette.accent)
            .disabled(isSubmitting || !store.canPerformMutatingActions || questions.isEmpty)
            .minTouchTarget()
        }
    }

    private func toggleAskOption(question: AskQuestion, label: String) {
        var current = selectedByQuestion[question.id] ?? []
        if question.multi == true {
            if current.contains(label) {
                current.remove(label)
            } else {
                current.insert(label)
            }
        } else {
            current = [label]
            customByQuestion[question.id] = ""
        }
        selectedByQuestion[question.id] = current
    }

    private func submitAsk() async {
        let questions = request.questions ?? []
        var payloadAnswers: [[String: Any]] = []
        for q in questions {
            let picked = Array(selectedByQuestion[q.id] ?? [])
            let custom = (customByQuestion[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if picked.isEmpty && custom.isEmpty {
                errorMessage = "Please answer \"\(q.question)\"."
                return
            }
            if q.multi != true && (picked.count > 1 || (!picked.isEmpty && !custom.isEmpty)) {
                errorMessage = "\"\(q.question)\" accepts a single choice or custom text."
                return
            }
            var item: [String: Any] = [
                "id": q.id,
                "selectedOptions": picked,
            ]
            if !custom.isEmpty {
                item["customInput"] = custom
            }
            payloadAnswers.append(item)
        }
        await sendAnswer(["answers": payloadAnswers])
    }

    // MARK: - Select

    @ViewBuilder
    private var selectBody: some View {
        let options = request.options ?? []
        let checkedSet = Set(request.checked ?? [])
        VStack(spacing: 8) {
            ForEach(Array(options.enumerated()), id: \.offset) { idx, option in
                let isChecked = checkedSet.contains(idx)
                let desc = request.optionDetails?.indices.contains(idx) == true ? request.optionDetails?[idx].description : nil
                Button {
                    Task { await sendAnswer(["value": option]) }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            if isChecked {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(palette.green)
                            }
                            Text(option)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(palette.foreground)
                                .multilineTextAlignment(.leading)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                        }
                        if let desc, !desc.isEmpty {
                            Text(desc)
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(isChecked ? palette.greenSoft : palette.raised, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting || !store.canPerformMutatingActions)
                .minTouchTarget()
            }
        }
    }

    // MARK: - Confirm

    @ViewBuilder
    private var confirmBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let message = request.message, !message.isEmpty {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(palette.foreground)
            }
            HStack(spacing: 10) {
                Button {
                    Task { await sendAnswer(["confirmed": true]) }
                } label: {
                    Label("Yes", systemImage: "checkmark")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(palette.accent)
                .disabled(isSubmitting || !store.canPerformMutatingActions)
                .minTouchTarget()

                Button {
                    Task { await sendAnswer(["confirmed": false]) }
                } label: {
                    Label("No", systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                .disabled(isSubmitting || !store.canPerformMutatingActions)
                .minTouchTarget()
            }
        }
    }

    // MARK: - Input

    @ViewBuilder
    private var inputBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let message = request.message, !message.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            }
            Group {
                if request.secret == true {
                    SecureField(request.placeholder ?? "Enter secret value…", text: $textAnswer)
                } else {
                    TextField(request.placeholder ?? "Your answer…", text: $textAnswer)
                }
            }
            .textFieldStyle(.roundedBorder)
            .submitLabel(.send)
            .onSubmit {
                Task { await sendAnswer(["value": textAnswer]) }
            }

            Button {
                Task { await sendAnswer(["value": textAnswer]) }
            } label: {
                Text("Submit Answer")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(palette.accent)
            .disabled(isSubmitting || !store.canPerformMutatingActions)
            .minTouchTarget()
        }
    }

    // MARK: - Editor

    @ViewBuilder
    private var editorBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let message = request.message, !message.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            }
            TextEditor(text: $textAnswer)
                .font(.callout.monospaced())
                .frame(minHeight: 110, maxHeight: 200)
                .padding(6)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))

            Button {
                Task { await sendAnswer(["value": textAnswer]) }
            } label: {
                Text("Submit Text")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(palette.accent)
            .disabled(isSubmitting || !store.canPerformMutatingActions)
            .minTouchTarget()
        }
    }

    // MARK: - Transport

    private func sendAnswer(_ fields: [String: Any]) async {
        guard let client = store.activeClient else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let updated = try await client.answerUIRequest(sessionId: session.id, requestId: request.id, payloadFields: fields)
            store.integrateSession(updated)
            store.notificationManager.triggerHaptic(.success)
        } catch {
            errorMessage = error.localizedDescription
            store.notificationManager.triggerHaptic(.error)
        }
    }

    private func cancelRequest() async {
        guard let client = store.activeClient else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let updated = try await client.answerUIRequest(sessionId: session.id, requestId: request.id, payloadFields: ["cancelled": true])
            store.integrateSession(updated)
            store.notificationManager.triggerHaptic(.lightTap)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Custom Terminal Panel (`companion/custom-ui.mjs`)

public struct CustomTerminalPanelView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let sessionId: String
    public let request: UIRequest
    public var compactEmbedded: Bool = true

    @State private var fontSize: CGFloat = 12
    @State private var baseFontSize: CGFloat = 12
    @State private var ctrlArmed: Bool = false
    @State private var altArmed: Bool = false
    @State private var bufferedInput: String = ""
    @State private var lastSentDimensions: String = ""
    @State private var isSending: Bool = false
    @State private var panelError: String?

    public init(store: AppStore, sessionId: String, request: UIRequest, compactEmbedded: Bool = true) {
        self.store = store
        self.sessionId = sessionId
        self.request = request
        self.compactEmbedded = compactEmbedded
    }

    private var lines: [String] {
        request.lines ?? []
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let panelError {
                Text(panelError)
                    .font(.caption2)
                    .foregroundStyle(palette.red)
            }

            GeometryReader { geo in
                let cols = max(20, min(300, Int(floor((geo.size.width - 16) / max(5.5, fontSize * 0.62)))))
                let rows = max(5, min(100, Int(floor((geo.size.height - 16) / max(12, fontSize * 1.35)))))

                ScrollView([.vertical, .horizontal], showsIndicators: true) {
                    VStack(alignment: .leading, spacing: 0) {
                        if lines.isEmpty {
                            Text("Waiting for panel render…")
                                .font(.system(size: fontSize, design: .monospaced))
                                .foregroundStyle(palette.muted)
                        } else {
                            ForEach(Array(lines.enumerated()), id: \.offset) { _, row in
                                Text(
                                    SGRParser.attributedLine(
                                        row.isEmpty ? " " : row,
                                        defaultForeground: palette.foreground,
                                        defaultBackground: palette.codeBackground,
                                        font: .system(size: fontSize, design: .monospaced)
                                    )
                                )
                                .fixedSize(horizontal: true, vertical: false)
                            }
                        }
                    }
                    .padding(8)
                    .frame(minWidth: geo.size.width, alignment: .leading)
                }
                .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.borderStrong, lineWidth: 1))
                .gesture(
                    MagnifyGesture()
                        .onChanged { val in
                            fontSize = min(24, max(8, baseFontSize * val.magnification))
                        }
                        .onEnded { _ in
                            baseFontSize = fontSize
                            let nextCols = max(20, min(300, Int(floor((geo.size.width - 16) / max(5.5, fontSize * 0.62)))))
                            let nextRows = max(5, min(100, Int(floor((geo.size.height - 16) / max(12, fontSize * 1.35)))))
                            Task { await sendResizeIfNeeded(columns: nextCols, rows: nextRows) }
                        }
                )
                .task(id: "\(request.id):\(cols)x\(rows)") {
                    try? await Task.sleep(nanoseconds: 180_000_000)
                    guard !Task.isCancelled else { return }
                    await sendResizeIfNeeded(columns: cols, rows: rows)
                }
            }
            .frame(height: compactEmbedded ? 260 : 420)
            .accessibilityLabel("Interactive terminal panel")

            // Mobile Terminal Accessory Strip
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    terminalKeyChip("Esc") { Task { await sendRawKeys(["\u{1B}"]) } }
                    terminalKeyChip("Tab") { Task { await sendRawKeys(["\t"]) } }
                    terminalToggleChip("Ctrl", active: $ctrlArmed)
                    terminalToggleChip("Alt", active: $altArmed)
                    terminalKeyChip("↑", a11y: "Up arrow") { Task { await sendRawKeys(["\u{1B}[A"]) } }
                    terminalKeyChip("↓", a11y: "Down arrow") { Task { await sendRawKeys(["\u{1B}[B"]) } }
                    terminalKeyChip("←", a11y: "Left arrow") { Task { await sendRawKeys(["\u{1B}[D"]) } }
                    terminalKeyChip("→", a11y: "Right arrow") { Task { await sendRawKeys(["\u{1B}[C"]) } }
                    terminalKeyChip("Enter") { Task { await sendRawKeys(["\r"]) } }
                    terminalKeyChip("Ctrl+C", tint: palette.red) { Task { await sendRawKeys(["\u{03}"]) } }
                    terminalKeyChip("Ctrl+D") { Task { await sendRawKeys(["\u{04}"]) } }
                    terminalKeyChip("Ctrl+Z") { Task { await sendRawKeys(["\u{1A}"]) } }
                    #if canImport(UIKit)
                    terminalKeyChip("Paste") {
                        if let text = UIPasteboard.general.string, !text.isEmpty {
                            let clipped = String(text.prefix(19_000))
                            Task { await sendRawKeys(["\u{1B}[200~\(clipped)\u{1B}[201~"]) }
                        }
                    }
                    #endif
                }
            }

            HStack(spacing: 8) {
                TextField("Type text or command…", text: $bufferedInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .onSubmit {
                        Task { await sendBufferedText(appendEnter: true) }
                    }

                Button("Type") {
                    Task { await sendBufferedText(appendEnter: false) }
                }
                .buttonStyle(.bordered)
                .disabled(bufferedInput.isEmpty || isSending || !store.canPerformMutatingActions)
                .minTouchTarget()

                Button("Send ↵") {
                    Task { await sendBufferedText(appendEnter: true) }
                }
                .buttonStyle(.borderedProminent)
                .tint(palette.accent)
                .disabled(isSending || !store.canPerformMutatingActions)
                .minTouchTarget()
            }
        }
    }

    @ViewBuilder
    private func terminalKeyChip(_ title: String, a11y: String? = nil, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption.monospaced().weight(.semibold))
                .foregroundStyle(tint ?? palette.foreground)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!store.canPerformMutatingActions)
        .accessibilityLabel(a11y ?? title)
    }

    @ViewBuilder
    private func terminalToggleChip(_ title: String, active: Binding<Bool>) -> some View {
        Button {
            active.wrappedValue.toggle()
            store.notificationManager.triggerHaptic(.selection)
        } label: {
            Text(title)
                .font(.caption.monospaced().weight(.semibold))
                .foregroundStyle(active.wrappedValue ? palette.accent : palette.foreground)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(active.wrappedValue ? palette.accentSoft : palette.raised, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(active.wrappedValue ? palette.accentLine : palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func sendBufferedText(appendEnter: Bool) async {
        var keys: [String] = []
        let text = bufferedInput
        bufferedInput = ""

        if !text.isEmpty {
            if ctrlArmed, let first = text.lowercased().first, let ascii = first.asciiValue, ascii >= 97, ascii <= 122 {
                let ctrlChar = String(UnicodeScalar(ascii & 31))
                keys.append(altArmed ? "\u{1B}\(ctrlChar)" : ctrlChar)
                let rem = String(text.dropFirst())
                if !rem.isEmpty { keys.append(rem) }
                ctrlArmed = false
                altArmed = false
            } else if altArmed {
                keys.append("\u{1B}\(text)")
                altArmed = false
            } else {
                keys.append(text)
            }
        }
        if appendEnter {
            keys.append("\r")
        }
        guard !keys.isEmpty else { return }
        await sendRawKeys(keys)
    }

    private func sendRawKeys(_ keys: [String]) async {
        guard let client = store.activeClient else { return }
        isSending = true
        panelError = nil
        defer { isSending = false }
        var effective = keys
        if ctrlArmed && effective.count == 1 && effective[0].count == 1,
           let scalar = effective[0].lowercased().unicodeScalars.first,
           scalar.value >= 97 && scalar.value <= 122 {
            effective = [String(UnicodeScalar(scalar.value & 31)!)]
            ctrlArmed = false
        }
        if altArmed && effective.count == 1 {
            effective = ["\u{1B}" + effective[0]]
            altArmed = false
        }
        do {
            let updated = try await client.sendCustomPanelInput(sessionId: sessionId, requestId: request.id, input: effective)
            store.integrateSession(updated)
            store.notificationManager.triggerHaptic(.lightTap)
        } catch {
            panelError = error.localizedDescription
        }
    }

    private func sendResizeIfNeeded(columns: Int, rows: Int) async {
        let key = "\(columns)x\(rows)"
        guard key != lastSentDimensions, let client = store.activeClient else { return }
        lastSentDimensions = key
        do {
            let updated = try await client.resizeCustomPanel(sessionId: sessionId, requestId: request.id, columns: columns, rows: rows)
            store.integrateSession(updated)
        } catch {
            lastSentDimensions = ""
        }
    }
}

// MARK: - Plan Review & Approval Sheet (`companion/plan-host.mjs`)

public struct PlanReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var proposal: PlanProposal?
    @State private var isLoading = false
    @State private var selectedAction: PlanApprovalAction = .preserve
    @State private var feedback: String = ""
    @State private var savePath: String = ""
    @State private var executionModel: String = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    public enum PlanApprovalAction: String, CaseIterable, Identifiable {
        case preserve
        case fresh
        case compact
        case refine
        case save

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .preserve: return "Keep Context"
            case .fresh: return "Fresh Context"
            case .compact: return "Compact & Execute"
            case .refine: return "Request Refinement"
            case .save: return "Save & Quit"
            }
        }

        public var subtitle: String {
            switch self {
            case .preserve: return "Implement with the current conversation intact."
            case .fresh: return "Start a clean execution context with this plan."
            case .compact: return "Compact prior history before executing the plan."
            case .refine: return "Stay in plan mode and revise based on feedback."
            case .save: return "Write the plan to disk and reset into a fresh session."
            }
        }
    }

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
        self._proposal = State(initialValue: session._planReview)
    }

    private var activeProposal: PlanProposal? {
        session._planReview ?? proposal
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                            .ompCard(palette)
                    }

                    if isLoading && activeProposal == nil {
                        SkeletonListPlaceholder(count: 3)
                    } else if let plan = activeProposal {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(plan.title ?? "Native Plan Proposal")
                                .font(.headline)
                                .foregroundStyle(palette.foreground)
                            if let path = plan.resolvedFilePath, !path.isEmpty {
                                Text(path)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(palette.muted)
                            }
                        }

                        MarkdownView(text: plan.markdownContent)
                            .ompCard(palette)

                        VStack(alignment: .leading, spacing: 10) {
                            Text("Decision")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.muted)

                            ForEach(PlanApprovalAction.allCases) { act in
                                Button {
                                    selectedAction = act
                                    store.notificationManager.triggerHaptic(.selection)
                                } label: {
                                    HStack(alignment: .top, spacing: 10) {
                                        Image(systemName: selectedAction == act ? "largecircle.fill.circle" : "circle")
                                            .foregroundStyle(selectedAction == act ? palette.accent : palette.muted)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(act.title)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(palette.foreground)
                                            Text(act.subtitle)
                                                .font(.caption)
                                                .foregroundStyle(palette.muted)
                                        }
                                        Spacer()
                                    }
                                    .padding(10)
                                    .background(selectedAction == act ? palette.accentSoft : palette.raised, in: RoundedRectangle(cornerRadius: 10))
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(selectedAction == act ? palette.accentLine : palette.border, lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                            }

                            if selectedAction == .refine {
                                TextField("Describe what to change in this plan…", text: $feedback, axis: .vertical)
                                    .lineLimit(3...6)
                                    .textFieldStyle(.roundedBorder)
                            } else if selectedAction == .save {
                                TextField("Optional save path on host…", text: $savePath)
                                    .font(.callout.monospaced())
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .textFieldStyle(.roundedBorder)
                            } else if !store.availableModels.isEmpty {
                                Picker("Execution Model", selection: $executionModel) {
                                    Text("Keep OMP Default").tag("")
                                    ForEach(store.availableModels) { m in
                                        Text(m.name).tag(m.selector)
                                    }
                                }
                                .pickerStyle(.menu)
                            }
                        }
                        .ompCard(palette)
                    } else {
                        OMPEmptyStateView(
                            systemImage: "doc.plaintext",
                            title: "No Plan Proposal Pending",
                            message: "When OMP finishes drafting a plan in Plan Mode, it appears here for review and approval."
                        )
                    }
                }
                .padding()
            }
            .background(palette.background)
            .navigationTitle("Review Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                if activeProposal != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isSubmitting ? "Sending…" : "Confirm") {
                            Task { await submitDecision() }
                        }
                        .disabled(isSubmitting || !store.canPerformMutatingActions || (selectedAction == .refine && feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    }
                }
            }
            .task {
                await fetchProposalIfNeeded()
            }
        }
    }

    private func fetchProposalIfNeeded() async {
        guard activeProposal == nil, let client = store.activeClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            proposal = try await client.reviewPlan(sessionId: session.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func submitDecision() async {
        guard let plan = activeProposal, let client = store.activeClient else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let cleanFeedback = selectedAction == .refine ? feedback.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            let cleanSavePath = selectedAction == .save ? savePath.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            let execModel = (selectedAction != .refine && selectedAction != .save && !executionModel.isEmpty) ? executionModel : nil
            let updated = try await client.approvePlan(
                sessionId: session.id,
                proposalId: plan.id,
                action: selectedAction.rawValue,
                feedback: cleanFeedback,
                executionModel: execModel,
                savePath: cleanSavePath?.isEmpty == true ? nil : cleanSavePath
            )
            store.integrateSession(updated)
            store.notificationManager.triggerHaptic(.success)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            store.notificationManager.triggerHaptic(.error)
        }
    }
}
