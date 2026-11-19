import SwiftUI

public struct NativeHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var searchText: String = ""
    @State private var showArchivedOnly = false
    @State private var previewingItem: NativeSessionSummary?

    public init(store: AppStore) {
        self.store = store
    }

    private var filteredSessions: [NativeSessionSummary] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let archivedSet = Set(store.snapshot.archived)
        return store.nativeSessions.filter { item in
            let isArch = archivedSet.contains(item.panelKey)
            if showArchivedOnly != isArch { return false }
            guard !q.isEmpty else { return true }
            return (item.title?.lowercased().contains(q) ?? false)
                || (item.cwd?.lowercased().contains(q) ?? false)
                || (item.preview?.lowercased().contains(q) ?? false)
                || (item.model?.lowercased().contains(q) ?? false)
        }
    }

    private var pinnedHistory: [NativeSessionSummary] {
        let pinnedSet = Set(store.snapshot.pinned)
        return filteredSessions.filter { pinnedSet.contains($0.panelKey) }
    }

    private var regularHistory: [NativeSessionSummary] {
        let pinnedSet = Set(store.snapshot.pinned)
        return filteredSessions.filter { !pinnedSet.contains($0.panelKey) }
    }

    public var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Filter", selection: $showArchivedOnly) {
                        Text("History").tag(false)
                        Text("Archived").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }

                if store.isLoadingNativeSessions && store.nativeSessions.isEmpty {
                    Section {
                        SkeletonListPlaceholder(count: 5)
                            .listRowBackground(Color.clear)
                    }
                } else if let error = store.nativeSessionsError, store.nativeSessions.isEmpty {
                    Section {
                        OMPEmptyStateView(
                            systemImage: "exclamationmark.triangle",
                            title: "Could Not Load History",
                            message: error,
                            actionTitle: "Retry"
                        ) {
                            Task { await store.refreshNativeSessions(force: true) }
                        }
                        .listRowBackground(Color.clear)
                    }
                } else if filteredSessions.isEmpty {
                    Section {
                        OMPEmptyStateView(
                            systemImage: "clock.arrow.circlepath",
                            title: showArchivedOnly ? "No Archived History" : "No OMP Sessions Found",
                            message: store.nativeSessionsDir.map { "Checked \($0)" } ?? "OMP CLI session transcripts on this host will appear here."
                        )
                        .listRowBackground(Color.clear)
                    }
                } else {
                    if !pinnedHistory.isEmpty {
                        Section("Pinned History") {
                            ForEach(pinnedHistory) { item in
                                historyRow(item, pinned: true)
                            }
                        }
                    }

                    Section(pinnedHistory.isEmpty ? "Recent OMP Transcripts (\(regularHistory.count))" : "All Transcripts (\(regularHistory.count))") {
                        ForEach(regularHistory) { item in
                            historyRow(item, pinned: false)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .searchable(text: $searchText, prompt: "Filter by title, workspace, model, or prompt…")
            .refreshable {
                await store.refreshNativeSessions(force: true)
            }
            .navigationTitle("OMP Session History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await store.refreshNativeSessions(force: true) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh OMP session history")
                }
            }
            .task {
                await store.refreshNativeSessions()
                openRequestedPreview()
            }
            .onChange(of: store.selectedNativeSessionFile) { _, _ in
                openRequestedPreview()
            }
            .sheet(item: $previewingItem, onDismiss: {
                // Picks up a title, size or pin change made while the preview was open.
                Task { await store.refreshNativeSessions() }
            }) { item in
                NativeSessionPreviewSheet(store: store, summary: item) { resumed in
                    dismiss()
                    Task { await store.selectSession(resumed.id, tab: .chat) }
                }
            }
        }
    }

    /// Opens the preview another screen asked for (`selectedNativeSessionFile`), once the list holds that file.
    private func openRequestedPreview() {
        guard let file = store.selectedNativeSessionFile,
              let match = store.nativeSessions.first(where: { $0.file == file }) else { return }
        store.selectedNativeSessionFile = nil
        previewingItem = match
    }

    @ViewBuilder
    private func historyRow(_ item: NativeSessionSummary, pinned: Bool) -> some View {
        Button {
            previewingItem = item
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 6) {
                    if pinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(palette.accent)
                            .padding(.top, 3)
                    }
                    Text(item.title?.isEmpty == false ? (item.title ?? "") : (item.preview ?? URL(fileURLWithPath: item.file).lastPathComponent))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Spacer()
                    Text(CompanionFormatters.relativeDate(item.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }

                if let preview = item.preview, !preview.isEmpty, preview != item.title {
                    Text(preview)
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                        .lineLimit(2)
                }

                HStack(spacing: 8) {
                    if let cwd = item.cwd, !cwd.isEmpty {
                        Label(URL(fileURLWithPath: cwd).lastPathComponent, systemImage: "folder")
                            .font(.caption2)
                            .foregroundStyle(palette.muted)
                            .lineLimit(1)
                    }
                    if let model = item.model, !model.isEmpty {
                        Text(model)
                            .font(.caption2.monospaced())
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(palette.raised, in: Capsule())
                            .foregroundStyle(palette.accent)
                            .lineLimit(1)
                    }
                    if item.parent != nil {
                        Label("Fork", systemImage: "tuningfork")
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(palette.violetSoft, in: Capsule())
                            .foregroundStyle(palette.violet)
                    }
                    if item.managedId != nil {
                        Text("Open")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(palette.greenSoft, in: Capsule())
                            .foregroundStyle(palette.green)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .listRowBackground(palette.card)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                Task { await togglePin(item) }
            } label: {
                Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
            }
            .tint(palette.accent)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                Task { await toggleArchive(item) }
            } label: {
                Label(showArchivedOnly ? "Restore" : "Archive", systemImage: showArchivedOnly ? "tray.and.arrow.up" : "archivebox")
            }
            .tint(palette.amber)
        }
    }

    private func togglePin(_ item: NativeSessionSummary) async {
        await store.setPinned(key: item.panelKey, pinned: !store.snapshot.pinned.contains(item.panelKey))
    }

    private func toggleArchive(_ item: NativeSessionSummary) async {
        await store.setArchived(key: item.panelKey, archived: !store.snapshot.archived.contains(item.panelKey))
    }
}

private struct NativeSessionPreviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    let summary: NativeSessionSummary
    let onResumed: (SessionSummary) -> Void

    @State private var preview: NativeSessionPreview?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var followUpMessage: String = ""
    @State private var selectedModel: String = ""
    @State private var selectedThinking: String = ""
    @State private var advisorEnabled = false
    @State private var launchOptions: SessionLaunchOptions?
    @State private var showLaunchOptions = false
    @State private var isResuming = false
    @State private var lightboxImage: LightboxImagePayload?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        headerCard

                        if let errorMessage {
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundStyle(palette.red)
                                .ompCard(palette)
                        }

                        if isLoading && preview == nil {
                            SkeletonListPlaceholder(count: 4)
                        } else if let preview {
                            if preview.messages.isEmpty {
                                OMPEmptyStateView(
                                    systemImage: "text.bubble",
                                    title: "Empty Transcript",
                                    message: "Resume this session below to send a prompt."
                                )
                            } else {
                                LazyVStack(alignment: .leading, spacing: 12) {
                                    ForEach(preview.messages) { msg in
                                        previewMessageCard(msg)
                                    }
                                }
                            }
                        }
                    }
                    .padding()
                }

                Divider().overlay(palette.border)

                resumeBar
            }
            .background(palette.background)
            .navigationTitle("Session Preview")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task(id: summary.file) {
                await loadPreview()
            }
            .sheet(item: $lightboxImage) { payload in
                ImageLightboxSheet(payload: payload)
            }
            .sheet(isPresented: $showLaunchOptions) {
                LaunchOptionsSheet(
                    title: "Resume Launch Options",
                    applyButtonTitle: "Apply",
                    initial: launchOptions,
                    availableModels: store.availableModels
                ) { next in
                    launchOptions = next
                    return true
                }
            }
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(preview?.title ?? summary.title ?? "OMP Session")
                .font(.headline)
                .foregroundStyle(palette.foreground)
            if let cwd = preview?.cwd ?? summary.cwd {
                Text(cwd)
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.muted)
            }
            HStack(spacing: 10) {
                if let model = preview?.model ?? summary.model {
                    Text(model)
                        .font(.caption2.monospaced())
                        .foregroundStyle(palette.accent)
                }
                if let tokens = preview?.contextTokens {
                    Text("\(CompanionFormatters.formatTokens(tokens)) ctx")
                        .font(.caption2.monospaced())
                        .foregroundStyle(palette.muted)
                }
                if let size = summary.size {
                    Text(CompanionFormatters.formatBytes(Int64(size)))
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .ompCard(palette)
    }

    @ViewBuilder
    private func previewMessageCard(_ msg: TranscriptMessage) -> some View {
        switch msg.role {
        case .tool:
            ToolExecutionCard(
                store: store,
                sessionCwd: preview?.cwd ?? summary.cwd ?? "",
                message: msg,
                onTapImage: { data, title in lightboxImage = LightboxImagePayload(title: title, data: data) }
            )
        case .thinking:
            ThinkingTraceCard(message: msg)
        default:
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(msg.role.rawValue.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(msg.role == .user ? palette.accent : palette.muted)
                    Spacer()
                    if let at = msg.at {
                        Text(CompanionFormatters.relativeDate(at))
                            .font(.caption2)
                            .foregroundStyle(palette.muted)
                    }
                }
                if msg.role == .assistant {
                    MarkdownView(text: msg.text)
                } else {
                    Text(msg.text)
                        .font(.callout)
                        .foregroundStyle(palette.foreground)
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .ompCard(palette)
        }
    }

    private var resumeBar: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Menu {
                    Picker("Model Override", selection: $selectedModel) {
                        Text("Keep Session Model").tag("")
                        ForEach(store.availableModels) { m in
                            Text(m.selector).tag(m.selector)
                        }
                    }
                } label: {
                    Label(selectedModel.isEmpty ? "Model" : selectedModel, systemImage: "cpu")
                        .font(.caption)
                        .lineLimit(1)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Menu {
                    Picker("Thinking", selection: $selectedThinking) {
                        Text("Default").tag("")
                        ForEach(store.thinkingLevels, id: \.self) { level in
                            Text(level).tag(level)
                        }
                    }
                } label: {
                    Label(selectedThinking.isEmpty ? "Effort" : selectedThinking, systemImage: "brain")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Button {
                    showLaunchOptions = true
                } label: {
                    Label("Flags", systemImage: "slider.horizontal.3")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Spacer()

                Toggle("Advisor", isOn: $advisorEnabled)
                    .labelsHidden()
                    .tint(palette.accent)
                Text("Advisor")
                    .font(.caption2)
                    .foregroundStyle(palette.muted)
            }

            HStack(spacing: 8) {
                TextField("Optional follow-up prompt on resume…", text: $followUpMessage, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)

                Button {
                    Task { await resumeNow() }
                } label: {
                    if isResuming {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Resume", systemImage: "play.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(palette.accent)
                .disabled(isResuming || !store.canPerformMutatingActions)
            }
        }
        .padding()
        .background(palette.surface)
    }

    /// Loads this sheet's preview. The sheet's `.task(id:)` cancels it when the sheet closes or shows another file,
    /// and a reply for a file this sheet no longer shows is dropped, so a slow earlier request never lands on the
    /// next session's preview.
    private func loadPreview() async {
        let file = summary.file
        if let cached = store.cachedNativePreview(file: file, updatedAt: summary.updatedAt) {
            preview = cached
            errorMessage = nil
            isLoading = false
        }
        guard let client = store.activeClient else {
            isLoading = false
            if preview == nil { errorMessage = "No companion host is selected." }
            return
        }
        if preview == nil { isLoading = true }
        do {
            let fresh = try await client.previewOmpSession(file: file)
            guard !Task.isCancelled, file == summary.file else { return }
            store.rememberNativePreview(fresh, file: file, updatedAt: summary.updatedAt)
            preview = fresh
            errorMessage = nil
        } catch {
            guard !Task.isCancelled, file == summary.file else { return }
            if let apiError = error as? CompanionAPIError, apiError.kind == .cancelled { return }
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func resumeNow() async {
        guard let client = store.activeClient else { return }
        isResuming = true
        errorMessage = nil
        defer { isResuming = false }
        do {
            let trimmed = followUpMessage.trimmingCharacters(in: .whitespacesAndNewlines)
            let session = try await client.resumeOmpSession(
                file: summary.file,
                message: trimmed,
                model: selectedModel.isEmpty ? nil : selectedModel,
                thinking: selectedThinking.isEmpty ? nil : selectedThinking,
                advisor: advisorEnabled ? true : nil,
                launch: launchOptions?.toDictionary()
            )
            store.integrateSession(session)
            store.notificationManager.triggerHaptic(.success)
            dismiss()
            onResumed(session)
        } catch {
            errorMessage = error.localizedDescription
            store.notificationManager.triggerHaptic(.error)
        }
    }
}
