import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct WorkspacesView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.editMode) private var editMode
    @Bindable var store: AppStore

    @State private var showAddFolderPicker = false
    @State private var showHiddenProjects = false
    @State private var editingProject: WorkspaceProject?
    @State private var browsingProject: WorkspaceProject?
    @State private var draggingProjectNormKey: String?
    @State private var dropTargetProjectNormKey: String?

    public init(store: AppStore) {
        self.store = store
    }

    private var displayedProjects: [WorkspaceProject] {
        store.orderedProjects(includeHidden: showHiddenProjects)
    }

    private var displayedProjectPaths: [String] {
        displayedProjects.map(\.path)
    }

    private var allowsDirectPadDrag: Bool {
        horizontalSizeClass == .regular
            && editMode?.wrappedValue.isEditing != true
            && store.canPerformMutatingActions
            && displayedProjects.count > 1
    }

    public var body: some View {
        NavigationStack {
            List {
                if displayedProjects.isEmpty {
                    Section {
                        OMPEmptyStateView(
                            systemImage: "folder.badge.plus",
                            title: "No Workspaces Registered",
                            message: "Add any folder on your companion computer to track git branches, browse files, and launch sessions.",
                            actionTitle: "Add Workspace Folder"
                        ) {
                            showAddFolderPicker = true
                        }
                        .listRowBackground(Color.clear)
                    }
                } else {
                    Section {
                        ForEach(displayedProjects) { project in
                            projectRow(project)
                        }
                        .onMove(perform: moveProjects)
                        .moveDisabled(!store.canPerformMutatingActions || displayedProjects.count < 2)
                    } header: {
                        HStack {
                            Text("Workspaces (\(displayedProjects.count))")
                            Spacer()
                            if !store.hiddenProjects.isEmpty {
                                Button(showHiddenProjects ? "Hide Hidden" : "Show Hidden (\(store.hiddenProjects.count))") {
                                    showHiddenProjects.toggle()
                                }
                                .font(.caption)
                            }
                        }
                    } footer: {
                        if horizontalSizeClass == .regular {
                            Text("Drag a workspace to reorder, or tap Edit. Tap a workspace to browse files or start a new session.")
                        } else {
                            Text("Tap Edit to drag workspaces into order. Tap a workspace to browse files or start a new session.")
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .navigationTitle("Workspaces")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    EditButton()
                        .disabled(!store.canPerformMutatingActions || displayedProjects.count < 2)
                    Button {
                        showAddFolderPicker = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .disabled(!store.canPerformMutatingActions)
                    .accessibilityLabel("Add workspace folder")
                }
            }
            .sheet(isPresented: $showAddFolderPicker) {
                HostDirectoryPickerSheet(store: store) { path in
                    Task { await addWorkspace(path: path) }
                }
            }
            .sheet(item: $editingProject) { project in
                ProjectEditSheet(store: store, project: project)
            }
            .sheet(item: $browsingProject) { project in
                WorkspaceFileBrowserSheet(store: store, project: project) {
                    dismiss()
                }
            }
            .task(id: "\(draggingProjectNormKey ?? "")|\(dropTargetProjectNormKey ?? "")") {
                guard draggingProjectNormKey != nil, dropTargetProjectNormKey == nil else { return }
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                guard !Task.isCancelled else { return }
                draggingProjectNormKey = nil
                dropTargetProjectNormKey = nil
            }
            .onChange(of: allowsDirectPadDrag) { _, allowed in
                if !allowed {
                    draggingProjectNormKey = nil
                    dropTargetProjectNormKey = nil
                }
            }
        }
    }

    @ViewBuilder
    private func projectRow(_ project: WorkspaceProject) -> some View {
        let count = store.visibleSessions.filter { $0.projectId == project.id }.count
        let normPath = SidebarLayoutHelper.normalizePathKey(project.path)
        let isDropTarget = dropTargetProjectNormKey == normPath && draggingProjectNormKey != normPath
        let idx = displayedProjects.firstIndex(where: { $0.id == project.id })

        let rowContent = HStack(spacing: 12) {
            Circle()
                .fill(Color.fromCSS(project.color))
                .frame(width: 12, height: 12)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(project.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if project.hidden == true {
                        Text("HIDDEN")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(palette.raised, in: Capsule())
                            .foregroundStyle(palette.muted)
                    }
                }
                Text(project.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(palette.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 8) {
                    if let branch = project.branch, !branch.isEmpty, branch != "workspace" {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.accent)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Text("\(count) session\(count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
            }

            Spacer()

            Menu {
                Button {
                    browsingProject = project
                } label: {
                    Label("Browse Files", systemImage: "doc.text.magnifyingglass")
                }
                Button {
                    dismiss()
                    store.presentQuickStart(projectPath: project.path)
                } label: {
                    Label("New Session Here", systemImage: "plus.bubble")
                }
                Button {
                    Task { await store.openInEditor(path: project.path) }
                } label: {
                    Label("Open in Host Editor", systemImage: "macwindow")
                }
                Button {
                    Task { await store.openTerminalOnHost(path: project.path) }
                } label: {
                    Label("Open Host Terminal", systemImage: "terminal")
                }
                Divider()
                Button {
                    editingProject = project
                } label: {
                    Label("Rename & Color", systemImage: "pencil")
                }
                Button {
                    Task { await refreshBranch(project) }
                } label: {
                    Label("Refresh Git Branch", systemImage: "arrow.clockwise")
                }
                Button {
                    Task { await store.updateProject(project, hidden: !(project.hidden == true)) }
                } label: {
                    Label(project.hidden == true ? "Show Workspace" : "Hide Workspace", systemImage: project.hidden == true ? "eye" : "eye.slash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(palette.muted)
                    .minTouchTarget()
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard editMode?.wrappedValue.isEditing != true else { return }
            browsingProject = project
        }
        .overlay(alignment: .top) {
            if isDropTarget {
                Capsule()
                    .fill(palette.accent)
                    .frame(height: 3)
            }
        }
        .listRowBackground(isDropTarget ? palette.accentSoft : palette.card)
        .accessibilityAction(named: "Move up") {
            guard store.canPerformMutatingActions, let idx, idx > 0 else { return }
            Task {
                await store.moveGroup(key: project.path, beforeKey: displayedProjects[idx - 1].path, visibleKeys: displayedProjectPaths)
            }
        }
        .accessibilityAction(named: "Move down") {
            guard store.canPerformMutatingActions, let idx, idx < displayedProjects.count - 1 else { return }
            let nextAfter: String? = (idx + 2 < displayedProjects.count) ? displayedProjects[idx + 2].path : nil
            Task {
                await store.moveGroup(key: project.path, beforeKey: nextAfter, visibleKeys: displayedProjectPaths)
            }
        }
        .accessibilityAction(named: "Move to top") {
            guard store.canPerformMutatingActions else { return }
            Task {
                await store.moveGroup(key: project.path, beforeKey: displayedProjects.first?.path, visibleKeys: displayedProjectPaths)
            }
        }
        .accessibilityAction(named: "Move to bottom") {
            guard store.canPerformMutatingActions else { return }
            Task {
                await store.moveGroup(key: project.path, beforeKey: nil, visibleKeys: displayedProjectPaths)
            }
        }

        if allowsDirectPadDrag {
            rowContent
                .draggable(project.path) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(Color.fromCSS(project.color))
                            .frame(width: 10, height: 10)
                        Text(project.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(palette.raised, in: Capsule())
                    .overlay(Capsule().stroke(palette.accent, lineWidth: 1))
                    .onAppear {
                        draggingProjectNormKey = normPath
                        store.notificationManager.triggerHaptic(.lightTap)
                    }
                }
                .dropDestination(for: String.self) { items, _ in
                    let draggedPath = items.first ?? draggingProjectNormKey
                    draggingProjectNormKey = nil
                    dropTargetProjectNormKey = nil
                    guard let draggedPath,
                          SidebarLayoutHelper.normalizePathKey(draggedPath) != normPath else {
                        return false
                    }
                    store.notificationManager.triggerHaptic(.lightTap)
                    Task {
                        await store.moveGroup(key: draggedPath, beforeKey: project.path, visibleKeys: displayedProjectPaths)
                    }
                    return true
                } isTargeted: { targeted in
                    if targeted {
                        dropTargetProjectNormKey = normPath
                    } else if dropTargetProjectNormKey == normPath {
                        dropTargetProjectNormKey = nil
                    }
                }
        } else {
            rowContent
        }
    }

    private func addWorkspace(path: String) async {
        guard let client = store.activeClient else { return }
        do {
            let proj = try await client.addProject(path: path)
            store.showToast("Added workspace \(proj.name)")
            await store.forceSync()
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func refreshBranch(_ project: WorkspaceProject) async {
        guard let client = store.activeClient else { return }
        do {
            _ = try await client.updateProject(id: project.id, refreshBranch: true)
            await store.forceSync()
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func moveProjects(from offsets: IndexSet, to destination: Int) {
        var reordered = displayedProjects.map(\.path)
        reordered.move(fromOffsets: offsets, toOffset: destination)
        let displayedNorms = Set(reordered.map(SidebarLayoutHelper.normalizePathKey))
        let existingExtras = store.effectiveGroupOrder.filter {
            !displayedNorms.contains(SidebarLayoutHelper.normalizePathKey($0))
        }
        let merged = reordered + existingExtras
        store.notificationManager.triggerHaptic(.lightTap)
        Task { await store.updateProjectsOrder(merged) }
    }
}

private struct ProjectEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    let project: WorkspaceProject

    @State private var name: String
    @State private var color: String
    @State private var isHidden: Bool
    @State private var isSaving = false

    private let colorPresets: [String] = [
        "#6366f1", "#ec4899", "#10b981", "#f59e0b", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"
    ]

    init(store: AppStore, project: WorkspaceProject) {
        self.store = store
        self.project = project
        self._name = State(initialValue: project.name)
        self._color = State(initialValue: project.color ?? "#6366f1")
        self._isHidden = State(initialValue: project.hidden == true)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Workspace Name") {
                    TextField("Name", text: $name)
                }

                Section("Color") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
                        ForEach(colorPresets, id: \.self) { preset in
                            Button {
                                color = preset
                            } label: {
                                Circle()
                                    .fill(Color.fromCSS(preset))
                                    .frame(width: 34, height: 34)
                                    .overlay {
                                        if color.lowercased() == preset.lowercased() {
                                            Image(systemName: "checkmark")
                                                .font(.caption.bold())
                                                .foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)

                    TextField("CSS color (#hex or oklch)", text: $color)
                        .font(.caption.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section {
                    Toggle("Hide Workspace from Sidebar", isOn: $isHidden)
                }
            }
            .navigationTitle("Edit Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task {
                            isSaving = true
                            await store.updateProject(project, name: name, color: color, hidden: isHidden)
                            isSaving = false
                            dismiss()
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                }
            }
        }
    }
}

private struct WorkspaceFileBrowserSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    let project: WorkspaceProject
    let onStartSession: () -> Void

    @State private var currentPath: String
    @State private var listing: BrowseListing?
    @State private var searchQuery: String = ""
    @State private var searchMatches: [FileMatch] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    init(store: AppStore, project: WorkspaceProject, onStartSession: @escaping () -> Void) {
        self.store = store
        self.project = project
        self.onStartSession = onStartSession
        self._currentPath = State(initialValue: project.path)
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                }

                if !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Section("Matching Files (\(searchMatches.count))") {
                        if searchMatches.isEmpty && !isLoading {
                            Text("No files match \"\(searchQuery)\"")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                        } else {
                            ForEach(searchMatches) { file in
                                fileActionRow(name: file.rel, fullPath: file.path)
                            }
                        }
                    }
                } else if let listing {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(listing.path)
                                .font(.caption.monospaced())
                                .foregroundStyle(palette.foreground)
                            HStack(spacing: 12) {
                                Button("Open in Editor") {
                                    Task { await store.openInEditor(path: listing.path) }
                                }
                                Button("Open Terminal") {
                                    Task { await store.openTerminalOnHost(path: listing.path) }
                                }
                                Button("New Session") {
                                    dismiss()
                                    onStartSession()
                                    store.presentQuickStart(projectPath: listing.path)
                                }
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.borderless)
                            .padding(.top, 4)
                        }

                        if let parent = listing.parent, listing.path != project.path {
                            Button {
                                Task { await loadDir(parent) }
                            } label: {
                                Label("Up to Parent Folder", systemImage: "arrow.up.left.square")
                                    .foregroundStyle(palette.accent)
                            }
                        }
                    } header: {
                        Text("Current Folder")
                    }

                    if !listing.dirs.isEmpty {
                        Section("Folders (\(listing.dirs.count))") {
                            ForEach(listing.dirs) { dir in
                                Button {
                                    Task { await loadDir(dir.path) }
                                } label: {
                                    HStack {
                                        Label(dir.name, systemImage: "folder.fill")
                                            .foregroundStyle(palette.foreground)
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption)
                                            .foregroundStyle(palette.muted)
                                    }
                                }
                            }
                        }
                    }

                    if let files = listing.files, !files.isEmpty {
                        Section("Files (\(files.count))") {
                            ForEach(files) { file in
                                fileActionRow(name: file.name, fullPath: file.path)
                            }
                        }
                    }
                } else if isLoading {
                    Section {
                        SkeletonListPlaceholder(count: 5)
                    }
                }
            }
            .searchable(text: $searchQuery, prompt: "Search files inside \(project.name)…")
            .onChange(of: searchQuery) { _, next in
                Task { await runSearch(next) }
            }
            .navigationTitle(project.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                await loadDir(currentPath)
            }
        }
    }

    @ViewBuilder
    private func fileActionRow(name: String, fullPath: String) -> some View {
        HStack {
            Label(name, systemImage: "doc.text")
                .font(.caption.monospaced())
                .foregroundStyle(palette.foreground)
                .lineLimit(2)
            Spacer()
            Menu {
                Button {
                    Task { await store.openInEditor(path: fullPath, cwd: project.path) }
                } label: {
                    Label("Open in Host Editor", systemImage: "macwindow")
                }
                Button {
                    #if canImport(UIKit)
                    UIPasteboard.general.string = fullPath
                    store.showToast("Copied path")
                    #endif
                } label: {
                    Label("Copy Path", systemImage: "doc.on.doc")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundStyle(palette.muted)
                    .minTouchTarget()
            }
        }
    }

    private func loadDir(_ path: String) async {
        guard let client = store.activeClient else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let res = try await client.browse(path: path, includeFiles: true)
            listing = res
            currentPath = res.path
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func runSearch(_ q: String) async {
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let client = store.activeClient else {
            searchMatches = []
            return
        }
        try? await Task.sleep(nanoseconds: 220_000_000)
        guard !Task.isCancelled else { return }
        do {
            let res = try await client.searchFiles(path: project.path, query: trimmed, limit: 150)
            searchMatches = res.files
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
