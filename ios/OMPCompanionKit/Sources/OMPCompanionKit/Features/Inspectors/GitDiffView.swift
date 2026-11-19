import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct GitDiffView: View {
    @Environment(\.ompPalette) private var palette
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
                    title: "Working Tree Clean",
                    message: "No uncommitted changes \(diffBase == "start" ? "since this session began" : "relative to HEAD").",
                    actionTitle: store.canPerformMutatingActions ? "Refresh" : nil
                ) {
                    Task { await loadWorkingTree() }
                }
            } else {
                ScrollViewReader { proxy in
                    VStack(spacing: 0) {
                        // Summary + Jump-to-file index bar
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                Text("\(diffData.files.count) \(diffData.files.count == 1 ? "file" : "files")")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(palette.foreground)
                                Text("+\(totalStats.additions)")
                                    .font(.caption.monospacedDigit().weight(.bold))
                                    .foregroundStyle(palette.green)
                                Text("-\(totalStats.deletions)")
                                    .font(.caption.monospacedDigit().weight(.bold))
                                    .foregroundStyle(palette.red)
                                Spacer()
                                if let omitted = diffData.untrackedOmitted, omitted > 0 {
                                    Text("\(omitted) untracked omitted")
                                        .font(.caption2)
                                        .foregroundStyle(palette.amber)
                                }
                            }

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(diffData.files) { f in
                                        let shortName = URL(fileURLWithPath: f.path).lastPathComponent
                                        Button {
                                            withAnimation {
                                                collapsedFiles.remove(f.id)
                                                proxy.scrollTo(f.id, anchor: .top)
                                            }
                                        } label: {
                                            Text(shortName)
                                                .font(.caption2.monospaced())
                                                .padding(.horizontal, 8)
                                                .padding(.vertical, 4)
                                                .background(palette.raised, in: Capsule())
                                                .foregroundStyle(palette.accent)
                                                .overlay(Capsule().stroke(palette.border, lineWidth: 1))
                                        }
                                        .buttonStyle(.plain)
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
                                    diffFileCard(file, cwd: diffData.cwd)
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
                title: "Inspect Changes",
                message: "Load the git diff for \(session.cwd)."
            )
        }
    }

    @ViewBuilder
    private func diffFileCard(_ file: ToolFileDiff, cwd: String) -> some View {
        let isCollapsed = collapsedFiles.contains(file.id)
        let stats = DiffParser.stats(for: file.diff)
        let rows = DiffParser.parse(file.diff ?? "")
        let showAll = showAllLinesFiles.contains(file.id)
        let displayedRows = showAll ? rows : Array(rows.prefix(180))

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    if isCollapsed { collapsedFiles.remove(file.id) } else { collapsedFiles.insert(file.id) }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(palette.muted)

                        Text((file.op ?? "modify").uppercased())
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(opColor(file.op).opacity(0.16), in: Capsule())
                            .foregroundStyle(opColor(file.op))

                        Text(relativeDisplayPath(file.path, cwd: cwd))
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(palette.foreground)
                            .lineLimit(2)
                            .truncationMode(.head)
                            .multilineTextAlignment(.leading)
                    }
                }
                .buttonStyle(.plain)

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

                Menu {
                    Button {
                        Task { await store.openInEditor(path: file.path, cwd: cwd) }
                    } label: {
                        Label("Open in Host Editor", systemImage: "macwindow")
                    }
                    #if canImport(UIKit)
                    Button {
                        UIPasteboard.general.string = file.path
                        store.showToast("Copied file path")
                    } label: {
                        Label("Copy Path", systemImage: "doc.on.doc")
                    }
                    if let raw = file.diff, !raw.isEmpty {
                        Button {
                            UIPasteboard.general.string = raw
                            store.showToast("Copied patch diff")
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
                    ScrollView(.horizontal, showsIndicators: true) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(displayedRows) { row in
                                HStack(spacing: 8) {
                                    Text(row.lineNumber)
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(palette.muted)
                                        .frame(width: 34, alignment: .trailing)

                                    Text(row.text.isEmpty ? " " : row.text)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(diffRowTextColor(row.kind))
                                        .fixedSize(horizontal: true, vertical: false)
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 1.5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(diffRowBgColor(row.kind))
                            }
                        }
                    }
                    .background(palette.codeBackground)

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
                title: "No Git History",
                message: "Repository commit log will appear here."
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
                            diffFileCard(f, cwd: detail.cwd)
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
                store.showToast("Worktree deleted")
                await store.forceSync()
            } else {
                store.showToast("Worktree \(action) completed")
                await loadWorktreeStatus()
            }
        } catch {
            errorMessage = error.localizedDescription
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
