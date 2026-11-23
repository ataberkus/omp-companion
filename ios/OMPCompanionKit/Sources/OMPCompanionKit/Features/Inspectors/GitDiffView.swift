import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct GitDiffView: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var store: AppStore
    public let session: SessionSummary

    private enum DiffSectionTab: String, CaseIterable, Identifiable {
        case workingTree = "Working Tree"
        case commits = "Commits"
        case worktree = "Worktree"

        var id: String { rawValue }
    }

    @State private var section: DiffSectionTab = .workingTree
    @State private var diffBase: String = "start" // "start" | "head"
    @State private var workingChanges: ChangesWorktreeResponse?
    @State private var gitLog: GitLogResponse?
    @State private var selectedCommit: GitCommitSummary?
    @State private var selectedCommitDetail: GitCommitResponse?
    @State private var worktreeStatus: WorktreeStatusResponse?
    @State private var commitDirtyChanges = true
    @State private var pendingDeleteWorktree = false

    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var collapsedFiles: Set<String> = []
    @State private var showAllLinesFiles: Set<String> = []

    /// "" until the user picks a layout (split in a regular-width layout), else "unified" | "split".
    @AppStorage("omp-diff-mode") private var diffLayoutMode: String = ""
    // Working tree review, persisted per host and session by DiffReviewStore.
    @State private var viewedFiles: [String: String] = [:]
    /// Viewed files folded open again by hand; marking a file viewed folds it.
    @State private var expandedViewedFiles: Set<String> = []
    @State private var reviewNotes: [DiffReviewNote] = []
    @State private var noteDraft: DiffNoteDraft?
    @State private var isSendingReview = false

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    private var displayedChanges: ChangesWorktreeResponse? {
        workingChanges ?? store.cachedDiffsBySession[session.id]
    }

    private var totalStats: DiffStats {
        let files = displayedChanges?.files ?? []
        return files.reduce(DiffStats(additions: 0, deletions: 0)) { acc, file in
            let s = DiffParser.stats(for: file.diff)
            return DiffStats(additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions)
        }
    }

    private var reviewScope: String {
        DiffReviewStore.scope(hostID: store.activeHostID, sessionID: session.id)
    }

    /// Side by side needs room: only in a regular-width layout, where it is the default until the user picks one (the web
    /// dashboard picks split for a wide page the same way).
    private var useSplitLayout: Bool {
        horizontalSizeClass == .regular && diffLayoutMode != "unified"
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Section & Base Controls
            VStack(spacing: 8) {
                Picker("Changes View", selection: $section) {
                    ForEach(DiffSectionTab.allCases) { tab in
                        if tab == .worktree && session.isolated != true {
                            EmptyView()
                        } else {
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                }
                .pickerStyle(.segmented)

                if section == .workingTree {
                    HStack(spacing: 8) {
                        Picker("Base", selection: $diffBase) {
                            Text("Since Session Start").tag("start")
                            Text("Since HEAD").tag("head")
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: diffBase) { _, _ in
                            Task { await loadWorkingTree() }
                        }

                        Button {
                            Task { await loadWorkingTree() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .font(.subheadline)
                                .padding(8)
                                .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
                        }
                        .disabled(isLoading || !store.canPerformMutatingActions)
                        .accessibilityLabel("Refresh git diff")
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(palette.surface)
            .overlay(alignment: .bottom) { Divider().overlay(palette.border) }

            if let errorMessage {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(palette.red)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(palette.red)
                    Spacer()
                }
                .padding(10)
                .background(palette.redSoft)
            }

            switch section {
            case .workingTree:
                workingTreeContent
            case .commits:
                commitsContent
            case .worktree:
                worktreeContent
            }
        }
        .background(palette.background)
        .task(id: "\(session.id):\(section.rawValue)") {
            await loadActiveSection()
        }
        .task(id: reviewScope) {
            loadReviewState()
        }
        .sheet(item: $noteDraft) { draft in
            DiffNoteEditorSheet(
                draft: draft,
                displayPath: DiffReviewStore.relativePath(draft.path, cwd: session.cwd),
                onSave: { saveNote(draft, text: $0) },
                onDelete: { deleteNote(id: draft.id) }
            )
        }
        .confirmationDialog("Delete Worktree & Branch?", isPresented: $pendingDeleteWorktree, titleVisibility: .visible) {
            Button("Delete Worktree & Branch", role: .destructive) {
                Task { await runWorktreeAction("delete") }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes the isolated folder and its branch from disk. Your OMP session transcript stays in history.")
        }
    }

    // MARK: - Working Tree Diff

    @ViewBuilder
    private var workingTreeContent: some View {
        if isLoading && displayedChanges == nil {
            SkeletonListPlaceholder(count: 5)
                .padding()
        } else if let diffData = displayedChanges {
            if diffData.files.isEmpty {
                OMPEmptyStateView(
                    systemImage: "checkmark.seal",
                    title: String(localized: "Working Tree Clean", bundle: .main),
                    message: diffBase == "start"
                        ? String(localized: "No uncommitted changes since this session began.", bundle: .main)
                        : String(localized: "No uncommitted changes relative to HEAD.", bundle: .main),
                    actionTitle: store.canPerformMutatingActions ? String(localized: "Refresh", bundle: .main) : nil
                ) {
                    Task { await loadWorkingTree() }
                }
            } else {
                let reviews = Dictionary(diffData.files.map { ($0.id, fileReview($0)) }, uniquingKeysWith: { first, _ in first })
                let viewedCount = diffData.files.filter { reviews[$0.id]?.viewed == true }.count
                ScrollViewReader { proxy in
                    VStack(spacing: 0) {
                        // Summary + Jump-to-file index bar
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                Text(diffData.files.count == 1 ? "1 file" : "\(diffData.files.count) files")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(palette.foreground)
                                Text("+\(totalStats.additions)")
                                    .font(.caption.monospacedDigit().weight(.bold))
                                    .foregroundStyle(palette.green)
                                Text("-\(totalStats.deletions)")
                                    .font(.caption.monospacedDigit().weight(.bold))
                                    .foregroundStyle(palette.red)
                                Label("\(viewedCount)/\(diffData.files.count) viewed", systemImage: viewedCount == diffData.files.count ? "checkmark.square.fill" : "checkmark.square")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(viewedCount == diffData.files.count ? palette.green : palette.muted)
                                Spacer()
                                if let omitted = diffData.untrackedOmitted, omitted > 0 {
                                    Text("\(omitted) untracked omitted")
                                        .font(.caption2)
                                        .foregroundStyle(palette.amber)
                                }
                            }

                            if !reviewNotes.isEmpty || horizontalSizeClass == .regular {
                                HStack(spacing: 8) {
                                    if !reviewNotes.isEmpty {
                                        requestChangesButton
                                    }
                                    Spacer()
                                    if horizontalSizeClass == .regular {
                                        layoutPicker
                                    }
                                }
                            }

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(diffData.files) { f in
                                        let shortName = URL(fileURLWithPath: f.path).lastPathComponent
                                        let review = reviews[f.id]
                                        Button {
                                            withAnimation(reduceMotion ? nil : .default) {
                                                if review?.viewed != true { collapsedFiles.remove(f.id) }
                                                proxy.scrollTo(f.id, anchor: .top)
                                            }
                                        } label: {
                                            HStack(spacing: 4) {
                                                if review?.viewed == true {
                                                    Image(systemName: "checkmark")
                                                        .font(.caption2.weight(.bold))
                                                        .foregroundStyle(palette.green)
                                                }
                                                Text(shortName)
                                                if let count = review?.notes.count, count > 0 {
                                                    Label("\(count)", systemImage: "text.bubble")
                                                        .labelStyle(.titleAndIcon)
                                                        .foregroundStyle(palette.muted)
                                                }
                                            }
                                            .font(.caption2.monospaced())
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 4)
                                            .background(palette.raised, in: Capsule())
                                            .foregroundStyle(palette.accent)
                                            .overlay(Capsule().stroke(palette.border, lineWidth: 1))
                                            .opacity(review?.viewed == true ? 0.7 : 1)
                                        }
                                        .buttonStyle(.plain)
                                        .accessibilityLabel(chipAccessibilityLabel(shortName, review: review))
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(palette.surface)
                        .overlay(alignment: .bottom) { Divider().overlay(palette.border) }

                        ScrollView {
                            LazyVStack(spacing: 12) {
                                ForEach(diffData.files) { file in
                                    diffFileCard(file, cwd: diffData.cwd, review: reviews[file.id])
                                        .id(file.id)
                                }
                            }
                            .padding(12)
                        }
                        .refreshable {
                            await loadWorkingTree()
                        }
                    }
                }
            }
        } else {
            OMPEmptyStateView(
                systemImage: "doc.text.magnifyingglass",
                title: String(localized: "Inspect Changes", bundle: .main),
                message: String(localized: "Load the git diff for \(session.cwd).", bundle: .main)
            )
        }
    }

    /// Review state of one Working tree file: whether it is marked viewed at its current diff, and its comments.
    private struct FileReview {
        let signature: String
        let viewed: Bool
        let notes: [DiffReviewNote]
    }

    private func fileReview(_ file: ToolFileDiff) -> FileReview {
        let signature = DiffReviewStore.signature(of: file.diff)
        return FileReview(
            signature: signature,
            viewed: viewedFiles[file.path] == signature,
            notes: reviewNotes.filter { $0.path == file.path }
        )
    }

    /// `review` is nil where the web offers no review either (a commit's files).
    @ViewBuilder
    private func diffFileCard(_ file: ToolFileDiff, cwd: String, review: FileReview?) -> some View {
        let isViewed = review?.viewed == true
        // A viewed file stays folded until its diff changes, unless it is opened by hand.
        let isCollapsed = isViewed ? !expandedViewedFiles.contains(file.id) : collapsedFiles.contains(file.id)
        let stats = DiffParser.stats(for: file.diff)
        let raw = file.diff ?? ""
        // A new file has nothing on the left, so it stays unified.
        let split = useSplitLayout && !DiffLayout.isCreation(op: file.op, rawDiff: raw)
        let rows = isCollapsed ? [] : DiffLayout.rows(raw, split: split)
        let showAll = showAllLinesFiles.contains(file.id)
        let displayedRows = showAll ? rows : Array(rows.prefix(180))

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    if isViewed {
                        if isCollapsed { expandedViewedFiles.insert(file.id) } else { expandedViewedFiles.remove(file.id) }
                    } else if isCollapsed {
                        collapsedFiles.remove(file.id)
                    } else {
                        collapsedFiles.insert(file.id)
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(palette.muted)
                            .accessibilityHidden(true)

                        Text((file.op ?? "modify").uppercased())
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(opColor(file.op).opacity(0.16), in: Capsule())
                            .foregroundStyle(opColor(file.op))

                        Text(relativeDisplayPath(file.path, cwd: cwd))
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(isViewed ? palette.muted : palette.foreground)
                            .lineLimit(2)
                            .truncationMode(.head)
                            .multilineTextAlignment(.leading)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")

                Spacer()

                HStack(spacing: 4) {
                    if stats.additions > 0 {
                        Text("+\(stats.additions)")
                            .font(.caption2.monospacedDigit().weight(.bold))
                            .foregroundStyle(palette.green)
                    }
                    if stats.deletions > 0 {
                        Text("-\(stats.deletions)")
                            .font(.caption2.monospacedDigit().weight(.bold))
                            .foregroundStyle(palette.red)
                    }
                }

                if let review {
                    if !review.notes.isEmpty {
                        Label("\(review.notes.count)", systemImage: "text.bubble")
                            .labelStyle(.titleAndIcon)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(palette.accent)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(review.notes.count == 1 ? "1 comment" : "\(review.notes.count) comments")
                    }

                    Button {
                        setViewed(!review.viewed, file: file, signature: review.signature)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: review.viewed ? "checkmark.square.fill" : "square")
                                .accessibilityHidden(true)
                            Text("Viewed")
                        }
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(review.viewed ? palette.green : palette.muted)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Viewed")
                    .accessibilityValue(review.viewed ? "Marked viewed" : "Not viewed")
                    .accessibilityHint("Folds the file until its diff changes again")
                    .accessibilityAddTraits(review.viewed ? .isSelected : [])
                }

                Menu {
                    Button {
                        Task { await store.openInEditor(path: file.path, cwd: cwd) }
                    } label: {
                        Label("Open in Host Editor", systemImage: "macwindow")
                    }
                    #if canImport(UIKit)
                    Button {
                        UIPasteboard.general.string = file.path
                        store.showToast(String(localized: "Copied file path", bundle: .main))
                    } label: {
                        Label("Copy Path", systemImage: "doc.on.doc")
                    }
                    if let raw = file.diff, !raw.isEmpty {
                        Button {
                            UIPasteboard.general.string = raw
                            store.showToast(String(localized: "Copied patch diff", bundle: .main))
                        } label: {
                            Label("Copy Patch", systemImage: "text.alignleft")
                        }
                    }
                    #endif
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.subheadline)
                        .foregroundStyle(palette.muted)
                        .minTouchTarget()
                }
                .accessibilityLabel("File actions")
            }
            .padding(10)
            .background(palette.raised)

            if !isCollapsed {
                if rows.isEmpty {
                    Text("No textual diff available (binary or empty change)")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                        .padding(10)
                } else {
                    if split {
                        splitDiffRows(displayedRows, file: file, review: review)
                    } else {
                        unifiedDiffRows(displayedRows, file: file, review: review)
                    }

                    if rows.count > 180 && !showAll {
                        Button("Show All \(rows.count) Lines") {
                            showAllLinesFiles.insert(file.id)
                        }
                        .font(.caption.weight(.semibold))
                        .padding(10)
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
    }

    // MARK: - Diff Rows

    private func unifiedDiffRows(_ rows: [DiffDisplayRow], file: ToolFileDiff, review: FileReview?) -> some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    switch row.content {
                    case .gap(let kind, let text):
                        gapRow(kind: kind, text: text)
                    case .line(let line):
                        unifiedLineRow(line, file: file, review: review)
                        // Comments keep the visible width while the code scrolls sideways.
                        ForEach(notes(for: [line.anchor], in: review)) { note in
                            noteCard(note)
                                .containerRelativeFrame(.horizontal, alignment: .leading)
                        }
                    case .pair:
                        EmptyView()
                    }
                }
            }
        }
        .background(palette.codeBackground)
    }

    /// Old and new columns side by side; long lines wrap so both columns of a row stay aligned.
    private func splitDiffRows(_ rows: [DiffDisplayRow], file: ToolFileDiff, review: FileReview?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                switch row.content {
                case .gap(let kind, let text):
                    gapRow(kind: kind, text: text)
                case .pair(let oldLine, let newLine):
                    HStack(spacing: 0) {
                        splitCell(oldLine, side: .old, file: file, review: review)
                        Rectangle()
                            .fill(palette.border)
                            .frame(width: 1)
                        splitCell(newLine, side: .new, file: file, review: review)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    ForEach(notes(for: pairAnchors(oldLine, newLine), in: review)) { note in
                        noteCard(note)
                    }
                case .line:
                    EmptyView()
                }
            }
        }
        .background(palette.codeBackground)
    }

    private func gapRow(kind: DiffRowKind, text: String) -> some View {
        HStack(spacing: 8) {
            Color.clear
                .frame(width: 34, height: 1)
            Text(text)
                .font(.caption2.monospaced())
                .foregroundStyle(diffRowTextColor(kind))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 1.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(diffRowBgColor(kind))
    }

    private func unifiedLineRow(_ line: DiffLine, file: ToolFileDiff, review: FileReview?) -> some View {
        HStack(spacing: 8) {
            Text(line.label)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(palette.muted)
                .frame(width: 34, alignment: .trailing)

            Text(markedText(line))
                .font(.caption2.monospaced())
                .foregroundStyle(diffRowTextColor(line.kind))
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 1.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(diffRowBgColor(line.kind))
        .contentShape(Rectangle())
        .contextMenu { lineMenu(line, file: file, review: review) }
    }

    @ViewBuilder
    private func splitCell(_ line: DiffLine?, side: DiffSide, file: ToolFileDiff, review: FileReview?) -> some View {
        if let line {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text((side == .old ? line.oldLine : line.newLine).map { String($0) } ?? line.label)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(palette.muted)
                    .frame(width: 34, alignment: .trailing)

                Text(markedText(line))
                    .font(.caption2.monospaced())
                    .foregroundStyle(diffRowTextColor(line.kind))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(diffRowBgColor(line.kind))
            .contentShape(Rectangle())
            .contextMenu { lineMenu(line, file: file, review: review) }
        } else {
            palette.raised.opacity(0.6)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityHidden(true)
        }
    }

    /// Long-press menu of a diff line: comment on it (Working tree only) or copy it.
    @ViewBuilder
    private func lineMenu(_ line: DiffLine, file: ToolFileDiff, review: FileReview?) -> some View {
        if review != nil, let anchor = line.anchor {
            Button {
                noteDraft = DiffNoteDraft(path: file.path, anchor: anchor, quote: line.text)
            } label: {
                Label("Comment on Line \(anchor.line)", systemImage: "text.bubble")
            }
        }
        #if canImport(UIKit)
        Button {
            UIPasteboard.general.string = line.text
        } label: {
            Label("Copy Line", systemImage: "doc.on.doc")
        }
        #endif
    }

    /// The line's text with the changed span of a paired removed/added line marked, as the web's `<mark>`.
    private func markedText(_ line: DiffLine) -> AttributedString {
        let text = line.text.isEmpty ? " " : line.text
        guard let mark = line.mark, !mark.isEmpty,
              let start = text.index(text.startIndex, offsetBy: mark.lowerBound, limitedBy: text.endIndex),
              let end = text.index(start, offsetBy: mark.count, limitedBy: text.endIndex) else {
            return AttributedString(text)
        }
        var changed = AttributedString(String(text[start..<end]))
        changed.backgroundColor = line.kind == .add ? palette.green.opacity(0.4) : palette.red.opacity(0.4)
        return AttributedString(String(text[..<start])) + changed + AttributedString(String(text[end...]))
    }

    private func notes(for anchors: [DiffLineAnchor?], in review: FileReview?) -> [DiffReviewNote] {
        guard let review, !review.notes.isEmpty else { return [] }
        let wanted = anchors.compactMap { $0 }
        return review.notes.filter { note in wanted.contains { $0.side == note.side && $0.line == note.line } }
    }

    /// The lines a split row's comments belong to: a context line fills both columns but is commented on by its new
    /// line number, so only a removed line counts on the old side.
    private func pairAnchors(_ oldLine: DiffLine?, _ newLine: DiffLine?) -> [DiffLineAnchor?] {
        [oldLine?.kind == .delete ? oldLine?.anchor : nil, newLine?.anchor]
    }

    private func noteCard(_ note: DiffReviewNote) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "text.bubble.fill")
                    .accessibilityHidden(true)
                Text(note.side == .old ? "Comment · line \(note.line) (removed)" : "Comment · line \(note.line)")
                Spacer(minLength: 8)
                Button("Edit") {
                    noteDraft = DiffNoteDraft(editing: note)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Edit comment on line \(note.line)")
                Button("Delete", role: .destructive) {
                    deleteNote(id: note.id)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(palette.red)
                .accessibilityLabel("Delete comment on line \(note.line)")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(palette.accent)

            Text(note.text)
                .font(.caption)
                .foregroundStyle(palette.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.accentLine, lineWidth: 1))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    private var layoutPicker: some View {
        Picker("Diff Layout", selection: Binding(
            get: { useSplitLayout ? "split" : "unified" },
            set: { diffLayoutMode = $0 }
        )) {
            Text("Unified").tag("unified")
            Text("Split").tag("split")
        }
        .pickerStyle(.segmented)
        .fixedSize()
    }

    private var requestChangesButton: some View {
        Menu {
            Button(role: .destructive) {
                discardAllNotes()
            } label: {
                Label("Discard All Comments", systemImage: "trash")
            }
        } label: {
            HStack(spacing: 6) {
                if isSendingReview {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: "paperplane.fill")
                }
                Text("Request Changes")
                Text("\(reviewNotes.count)")
                    .monospacedDigit()
                    .padding(.horizontal, 5)
                    .background(palette.accent.opacity(0.2), in: Capsule())
            }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(palette.accentSoft, in: Capsule())
            .foregroundStyle(palette.accent)
            .overlay(Capsule().stroke(palette.accentLine, lineWidth: 1))
        } primaryAction: {
            Task { await requestChanges() }
        }
        .disabled(isSendingReview || !store.canPerformMutatingActions)
        .accessibilityLabel(reviewNotes.count == 1 ? "Request changes, 1 comment" : "Request changes, \(reviewNotes.count) comments")
        .accessibilityHint("Sends every comment to the session as one message")
    }

    private func chipAccessibilityLabel(_ name: String, review: FileReview?) -> String {
        var parts = [name]
        if review?.viewed == true { parts.append("viewed") }
        if let count = review?.notes.count, count > 0 { parts.append("\(count) \(count == 1 ? "comment" : "comments")") }
        return parts.joined(separator: ", ")
    }

    // MARK: - Commits & Commit Diff

    @ViewBuilder
    private var commitsContent: some View {
        if isLoading && gitLog == nil {
            SkeletonListPlaceholder(count: 6)
                .padding()
        } else if let log = gitLog {
            List {
                Section {
                    HStack {
                        Label(log.branch, systemImage: "arrow.triangle.branch")
                            .font(.subheadline.monospaced().weight(.semibold))
                            .foregroundStyle(palette.accent)
                        Spacer()
                        if log.ahead > 0 || log.behind > 0 {
                            Text("↑\(log.ahead) ↓\(log.behind)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(palette.muted)
                        }
                    }
                    .listRowBackground(palette.card)
                }

                Section("Recent Commits (\(log.commits.count))") {
                    ForEach(log.commits) { commit in
                        Button {
                            selectedCommit = commit
                            Task { await loadCommitDetail(sha: commit.sha) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(commit.short)
                                        .font(.caption2.monospaced().weight(.bold))
                                        .foregroundStyle(palette.accent)
                                    if commit.session == true {
                                        Text("SESSION")
                                            .font(.caption2.weight(.bold))
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 1)
                                            .background(palette.greenSoft, in: Capsule())
                                            .foregroundStyle(palette.green)
                                    }
                                    Spacer()
                                    Text(CompanionFormatters.relativeDate(commit.date))
                                        .font(.caption2)
                                        .foregroundStyle(palette.muted)
                                }
                                Text(commit.subject)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(palette.foreground)
                                    .lineLimit(2)
                                Text(commit.author)
                                    .font(.caption2)
                                    .foregroundStyle(palette.muted)
                            }
                            .padding(.vertical, 3)
                        }
                        .listRowBackground(palette.card)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .refreshable {
                await loadGitLog()
            }
            .sheet(item: $selectedCommit) { commit in
                commitDetailSheet(commit)
            }
        } else {
            OMPEmptyStateView(
                systemImage: "clock",
                title: String(localized: "No Git History", bundle: .main),
                message: String(localized: "Repository commit log will appear here.", bundle: .main)
            )
        }
    }

    @ViewBuilder
    private func commitDetailSheet(_ commit: GitCommitSummary) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let detail = selectedCommitDetail, detail.sha == commit.sha {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(detail.message)
                                .font(.headline)
                                .foregroundStyle(palette.foreground)
                            Text("\(detail.author) · \(commit.short)")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                        }
                        .ompCard(palette)

                        ForEach(detail.files) { f in
                            diffFileCard(f, cwd: detail.cwd, review: nil)
                        }
                    } else {
                        SkeletonListPlaceholder(count: 4)
                    }
                }
                .padding()
            }
            .background(palette.background)
            .navigationTitle("Commit \(commit.short)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { selectedCommit = nil }
                }
                ToolbarItem(placement: .primaryAction) {
                    if horizontalSizeClass == .regular {
                        layoutPicker
                    }
                }
            }
        }
    }

    // MARK: - Isolated Worktree Actions

    @ViewBuilder
    private var worktreeContent: some View {
        List {
            if let wt = worktreeStatus {
                Section("Worktree Status") {
                    LabeledContent("Branch", value: wt.branch ?? "-")
                    LabeledContent("Base Branch", value: wt.base ?? "-")
                    LabeledContent("Ahead / Behind", value: "+\(wt.ahead ?? 0) / -\(wt.behind ?? 0)")
                    LabeledContent("Dirty Files (Worktree)", value: "\(wt.dirty ?? 0)")
                    LabeledContent("Dirty Files (Base Root)", value: "\(wt.rootDirty ?? 0)")
                    if let problem = wt.problem, !problem.isEmpty {
                        Text(problem)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                }
                .listRowBackground(palette.card)

                if let commits = wt.commits, !commits.isEmpty {
                    Section("Worktree Commits (\(commits.count))") {
                        ForEach(commits, id: \.self) { line in
                            Text(line)
                                .font(.caption.monospaced())
                                .listRowBackground(palette.card)
                        }
                    }
                }

                Section("Finish Worktree") {
                    Toggle("Auto-commit dirty worktree files before merge/squash", isOn: $commitDirtyChanges)
                        .listRowBackground(palette.card)

                    Button {
                        Task { await runWorktreeAction("merge", commit: commitDirtyChanges) }
                    } label: {
                        Label("Merge into \(wt.base ?? "base")", systemImage: "arrow.triangle.merge")
                    }
                    .disabled(session.isWorking || !store.canPerformMutatingActions)
                    .listRowBackground(palette.card)

                    Button {
                        Task { await runWorktreeAction("squash", commit: commitDirtyChanges) }
                    } label: {
                        Label("Squash Merge into \(wt.base ?? "base")", systemImage: "arrow.triangle.pull")
                    }
                    .disabled(session.isWorking || !store.canPerformMutatingActions)
                    .listRowBackground(palette.card)

                    Button {
                        Task { await runWorktreeAction("rebase") }
                    } label: {
                        Label("Rebase onto \(wt.base ?? "base")", systemImage: "arrow.up.arrow.down")
                    }
                    .disabled(session.isWorking || !store.canPerformMutatingActions)
                    .listRowBackground(palette.card)

                    Button {
                        Task { await runWorktreeAction("push") }
                    } label: {
                        Label("Push Branch to Remote", systemImage: "icloud.and.arrow.up")
                    }
                    .disabled(session.isWorking || !store.canPerformMutatingActions)
                    .listRowBackground(palette.card)

                    Button(role: .destructive) {
                        pendingDeleteWorktree = true
                    } label: {
                        Label("Delete Worktree & Branch", systemImage: "trash")
                    }
                    .disabled(session.isWorking || !store.canPerformMutatingActions)
                    .listRowBackground(palette.card)
                }
            } else if isLoading {
                SkeletonListPlaceholder(count: 4)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable {
            await loadWorktreeStatus()
        }
    }

    // MARK: - Networking

    private func loadActiveSection() async {
        switch section {
        case .workingTree:
            await loadWorkingTree()
        case .commits:
            await loadGitLog()
        case .worktree:
            await loadWorktreeStatus()
        }
    }

    private func loadWorkingTree() async {
        guard let client = store.activeClient else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let res = try await client.fetchChangesWorktree(sessionId: session.id, base: diffBase)
            workingChanges = res
            store.cacheWorktreeDiff(res, for: session.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadGitLog() async {
        guard let client = store.activeClient else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            gitLog = try await client.fetchGitLog(sessionId: session.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadCommitDetail(sha: String) async {
        guard let client = store.activeClient else { return }
        do {
            selectedCommitDetail = try await client.fetchGitCommit(sessionId: session.id, sha: sha)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadWorktreeStatus() async {
        guard let client = store.activeClient else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            worktreeStatus = try await client.fetchWorktreeStatus(sessionId: session.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func runWorktreeAction(_ action: String, commit: Bool = false) async {
        guard let client = store.activeClient else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let res = try await client.finishWorktree(sessionId: session.id, action: action, commit: commit)
            store.notificationManager.triggerHaptic(.success)
            if res.deleted == true {
                store.showToast(String(localized: "Worktree deleted", bundle: .main))
                await store.forceSync()
            } else {
                store.showToast(String(localized: "Worktree \(action) completed", bundle: .main))
                await loadWorktreeStatus()
            }
        } catch {
            errorMessage = error.localizedDescription
            store.notificationManager.triggerHaptic(.error)
        }
    }

    // MARK: - Review

    private func loadReviewState() {
        let reviewStore = DiffReviewStore()
        viewedFiles = reviewStore.viewedFiles(scope: reviewScope)
        reviewNotes = reviewStore.notes(scope: reviewScope)
        expandedViewedFiles = []
    }

    private func setViewed(_ viewed: Bool, file: ToolFileDiff, signature: String) {
        viewedFiles = DiffReviewStore().setViewed(viewed, path: file.path, signature: signature, scope: reviewScope)
        expandedViewedFiles.remove(file.id)
    }

    /// Adds or edits a comment; saving an existing one empty deletes it, as on the web.
    private func saveNote(_ draft: DiffNoteDraft, text: String) {
        let trimmed = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(20_000))
        if let index = reviewNotes.firstIndex(where: { $0.id == draft.id }) {
            if trimmed.isEmpty { reviewNotes.remove(at: index) } else { reviewNotes[index].text = trimmed }
        } else if !trimmed.isEmpty {
            reviewNotes.append(DiffReviewNote(id: draft.id, path: draft.path, side: draft.side, line: draft.line, text: trimmed))
        }
        DiffReviewStore().saveNotes(reviewNotes, scope: reviewScope)
    }

    private func deleteNote(id: String) {
        reviewNotes.removeAll { $0.id == id }
        DiffReviewStore().saveNotes(reviewNotes, scope: reviewScope)
    }

    private func discardAllNotes() {
        reviewNotes = []
        DiffReviewStore().saveNotes([], scope: reviewScope)
    }

    /// The web's "Request changes": every comment as one message, a steer while the session runs, else a prompt. Sent
    /// comments are dropped; one added while sending stays.
    private func requestChanges() async {
        guard let client = store.activeClient, !reviewNotes.isEmpty, !isSendingReview else { return }
        let notes = reviewNotes
        let scope = reviewScope
        let live = session.status == .running || session.status == .queued
        isSendingReview = true
        defer { isSendingReview = false }
        do {
            let updated = try await client.sendSessionPrompt(
                sessionId: session.id,
                type: live ? "steer" : "prompt",
                message: DiffReviewStore.reviewMessage(notes, cwd: session.cwd)
            )
            store.integrateSession(updated)
            let sent = Set(notes.map(\.id))
            let reviewStore = DiffReviewStore()
            let remaining = reviewStore.notes(scope: scope).filter { !sent.contains($0.id) }
            reviewStore.saveNotes(remaining, scope: scope)
            if scope == reviewScope { reviewNotes = remaining }
            let sentLabel = notes.count == 1
                ? String(localized: "Sent 1 comment", bundle: .main)
                : String(localized: "Sent \(notes.count) comments", bundle: .main)
            store.showToast(live ? String(localized: "\(sentLabel) as a steer", bundle: .main) : sentLabel)
            store.notificationManager.triggerHaptic(.success)
            store.selectedSessionTab = .chat
        } catch {
            store.showToast(error.localizedDescription, isError: true)
            store.notificationManager.triggerHaptic(.error)
        }
    }

    private func opColor(_ op: String?) -> Color {
        switch op {
        case "create": return palette.green
        case "delete": return palette.red
        case "rename": return palette.amber
        default: return palette.accent
        }
    }

    private func diffRowTextColor(_ kind: DiffRowKind) -> Color {
        switch kind {
        case .add: return palette.diffAddText
        case .delete: return palette.diffDeleteText
        case .hunkHeader: return palette.cyan
        case .note: return palette.amber
        case .context: return palette.foreground
        }
    }

    private func diffRowBgColor(_ kind: DiffRowKind) -> Color {
        switch kind {
        case .add: return palette.diffAddBackground
        case .delete: return palette.diffDeleteBackground
        case .hunkHeader: return palette.raised
        default: return .clear
        }
    }

    private func relativeDisplayPath(_ fullPath: String, cwd: String) -> String {
        let normCwd = cwd.hasSuffix("/") || cwd.hasSuffix("\\") ? cwd : cwd + "/"
        if fullPath.hasPrefix(normCwd) {
            return String(fullPath.dropFirst(normCwd.count))
        }
        return fullPath
    }
}

/// A comment being added or edited on one diff line.
private struct DiffNoteDraft: Identifiable {
    /// The edited comment's id, or the id a new one will get.
    let id: String
    let path: String
    let side: DiffSide
    let line: Int
    /// The commented line's text, shown above the editor for a new comment.
    let quote: String?
    let text: String
    let isNew: Bool

    init(path: String, anchor: DiffLineAnchor, quote: String) {
        id = UUID().uuidString
        self.path = path
        side = anchor.side
        line = anchor.line
        self.quote = quote
        text = ""
        isNew = true
    }

    init(editing note: DiffReviewNote) {
        id = note.id
        path = note.path
        side = note.side
        line = note.line
        quote = nil
        text = note.text
        isNew = false
    }
}

private struct DiffNoteEditorSheet: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.dismiss) private var dismiss
    let draft: DiffNoteDraft
    let displayPath: String
    let onSave: (String) -> Void
    /// Offered for an existing comment only.
    let onDelete: () -> Void

    @State private var text: String
    @FocusState private var isFocused: Bool

    init(draft: DiffNoteDraft, displayPath: String, onSave: @escaping (String) -> Void, onDelete: @escaping () -> Void) {
        self.draft = draft
        self.displayPath = displayPath
        self.onSave = onSave
        self.onDelete = onDelete
        _text = State(initialValue: draft.text)
    }

    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text(draft.side == .old ? "\(displayPath):\(draft.line) (removed line)" : "\(displayPath):\(draft.line)")
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.muted)
                    .lineLimit(2)
                    .truncationMode(.head)

                if let quote = draft.quote {
                    Text(quote.isEmpty ? " " : quote)
                        .font(.caption2.monospaced())
                        .foregroundStyle(draft.side == .old ? palette.diffDeleteText : palette.foreground)
                        .lineLimit(3)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 8))
                }

                TextEditor(text: $text)
                    .focused($isFocused)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .frame(minHeight: 140)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                    .accessibilityLabel("Comment on line \(draft.line)")

                if !draft.isNew {
                    Button(role: .destructive) {
                        onDelete()
                        dismiss()
                    } label: {
                        Label("Delete Comment", systemImage: "trash")
                            .font(.subheadline.weight(.semibold))
                    }
                }
            }
            .padding()
            .frame(maxHeight: .infinity, alignment: .top)
            .background(palette.background)
            .navigationTitle(draft.isNew ? "Add Comment" : "Edit Comment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(draft.isNew ? "Add" : "Save") {
                        onSave(text)
                        dismiss()
                    }
                    .disabled(draft.isNew && isEmpty)
                }
            }
            .onAppear { isFocused = true }
        }
        .presentationDetents([.medium, .large])
    }
}
