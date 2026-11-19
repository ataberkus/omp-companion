import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// MARK: - Tool Execution Card

/// One tool call, shared by the live transcript and the history preview: tool name, run state and duration up top,
/// then what the call acted on (a shell command in monospace, a shortened file path, a search pattern) instead of
/// its raw JSON arguments. Long values stay folded to three lines until tapped.
struct ToolExecutionCard: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    let sessionCwd: String
    let message: TranscriptMessage
    let onTapImage: (Data, String) -> Void

    @State private var isExpanded: Bool
    @State private var showFullResult = false
    @State private var loadedImages: [String: Data] = [:]

    private let tool: ToolRecord
    private let summary: ToolCallSummary

    init(store: AppStore, sessionCwd: String, message: TranscriptMessage, onTapImage: @escaping (Data, String) -> Void) {
        self.store = store
        self.sessionCwd = sessionCwd
        self.message = message
        self.onTapImage = onTapImage
        let tool = message.tool ?? ToolRecord(name: "tool", status: "done")
        self.tool = tool
        self.summary = ToolCallSummary(tool: tool, fallbackText: message.text)
        let hasVisuals = !(tool.images?.isEmpty ?? true) || !(tool.files?.isEmpty ?? true)
        self._isExpanded = State(initialValue: hasVisuals || tool.status == "error")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(summary.accessibilityLabel)
            .accessibilityHint(isExpanded ? "Collapses the tool details" : "Expands the tool details")
            .accessibilityAddTraits(.isButton)

            if isExpanded {
                expandedBody
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(summary.status == .error ? palette.red.opacity(0.5) : palette.border, lineWidth: 1)
        )
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            statusIcon
                .frame(minWidth: 16)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                titleRow
                primaryView
                if let intent = summary.intent {
                    Text(intent)
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                        .lineLimit(isExpanded ? nil : 2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                .font(.caption2)
                .foregroundStyle(palette.muted)
                .padding(.top, 2)
        }
        .contentShape(Rectangle())
    }

    private var titleRow: some View {
        // Wraps instead of overflowing at large Dynamic Type sizes.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { titleParts }
            VStack(alignment: .leading, spacing: 2) { titleParts }
        }
    }

    @ViewBuilder
    private var titleParts: some View {
        Text(summary.name)
            .font(.caption.monospaced().weight(.bold))
            .foregroundStyle(palette.foreground)
            .lineLimit(1)
        Text(summary.status.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(statusColor)
        if let duration = summary.durationLabel {
            Text(duration)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(palette.muted)
        }
        if let code = summary.exitCode {
            Text("exit \(code)")
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(code == 0 ? palette.green : palette.red)
        }
    }

    @ViewBuilder
    private var primaryView: some View {
        if let primary = summary.primary {
            switch summary.kind {
            case .command:
                Text(primary)
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.cyan)
                    .lineLimit(isExpanded ? nil : 3)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 6))
            case .path:
                Text(isExpanded ? primary : (summary.primaryShort ?? primary))
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.accent)
                    .lineLimit(isExpanded ? nil : 1)
                    .truncationMode(.middle)
                    .multilineTextAlignment(.leading)
            case .search, .other:
                Text(primary)
                    .font(summary.kind == .search ? Font.caption.monospaced() : Font.caption)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(isExpanded ? nil : 3)
                    .multilineTextAlignment(.leading)
            }
        }
    }

    // MARK: Expanded body

    @ViewBuilder
    private var expandedBody: some View {
        if !summary.arguments.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(summary.arguments) { argument in
                    ToolArgumentRow(argument: argument)
                }
            }
        }

        if let tasks = tool.tasks, !tasks.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(tasks.enumerated()), id: \.offset) { _, t in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "cpu")
                            .font(.caption2)
                            .foregroundStyle(palette.accent)
                        Text(t.name ?? t.id ?? "Subagent task")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                        if let desc = t.description, !desc.isEmpty {
                            Text(desc)
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                                .lineLimit(2)
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
                        imageThumb(ref)
                    }
                }
            }
        }

        if let result = tool.result, !result.isEmpty {
            resultView(result)
        }
    }

    @ViewBuilder
    private func imageThumb(_ ref: ToolImageRef) -> some View {
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
            .accessibilityLabel("\(tool.name) output image")
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

    private func resultView(_ result: String) -> some View {
        let clean = SGRParser.stripANSI(result)
        let display = (!showFullResult && clean.count > 2500) ? String(clean.prefix(2500)) + "\n… [truncated]" : clean
        return VStack(alignment: .leading, spacing: 6) {
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

    // MARK: Status

    private var statusColor: Color {
        switch summary.status {
        case .running: return palette.amber
        case .error: return palette.red
        case .done: return palette.green
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch summary.status {
        case .running:
            ProgressView().controlSize(.mini)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.caption)
                .foregroundStyle(palette.red)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(palette.green)
        }
    }
}

// MARK: - Tool Argument Row

/// One remaining argument of a tool call: folded to three lines, the whole value on tap.
private struct ToolArgumentRow: View {
    @Environment(\.ompPalette) private var palette
    let argument: ToolCallSummary.Argument
    @State private var isExpanded = false

    private var isLong: Bool {
        argument.value.count > 160 || argument.value.split(separator: "\n", omittingEmptySubsequences: false).count > 3
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(argument.key)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(palette.muted)
            Text(argument.value)
                .font(.caption2.monospaced())
                .foregroundStyle(palette.foreground)
                .lineLimit(isExpanded ? nil : 3)
                .multilineTextAlignment(.leading)
                .textSelection(.enabled)
            if isLong {
                Button(isExpanded ? "Show Less" : "Show More") {
                    withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(palette.accent)
                .buttonStyle(.borderless)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Inline Diff

struct ToolInlineDiffBox: View {
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
                .accessibilityLabel("Open \(fileDiff.path) in the host editor")
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
