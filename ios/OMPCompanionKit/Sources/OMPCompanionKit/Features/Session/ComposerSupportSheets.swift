import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct HostDirectoryPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var currentPath: String
    @State private var listing: BrowseListing?
    @State private var isLoading = false
    @State private var errorMessage: String?

    public let onSelect: (String) -> Void

    public init(store: AppStore, initialPath: String = "", onSelect: @escaping (String) -> Void) {
        self.store = store
        self._currentPath = State(initialValue: initialPath)
        self.onSelect = onSelect
    }

    public var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                }

                if let listing {
                    Section {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(listing.path)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(palette.foreground)
                                    .lineLimit(3)
                                if listing.isGit == true {
                                    Label("Git repository", systemImage: "arrow.triangle.branch")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(palette.green)
                                }
                            }
                            Spacer()
                            Button("Use Folder") {
                                onSelect(listing.path)
                                dismiss()
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(palette.accent)
                        }
                        .padding(.vertical, 4)

                        if let parent = listing.parent {
                            Button {
                                Task { await load(path: parent) }
                            } label: {
                                Label("Parent Folder", systemImage: "arrow.up.left.square")
                                    .foregroundStyle(palette.accent)
                            }
                        }
                    } header: {
                        Text("Current Folder")
                    }

                    if let recent = listing.recent, !recent.isEmpty {
                        Section("Recent Workspaces") {
                            ForEach(recent) { item in
                                Button {
                                    onSelect(item.path)
                                    dismiss()
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.name)
                                            .font(.subheadline.weight(.medium))
                                            .foregroundStyle(palette.foreground)
                                        Text(item.path)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(palette.muted)
                                            .lineLimit(1)
                                    }
                                }
                            }
                        }
                    }

                    if let roots = listing.roots, !roots.isEmpty {
                        Section("Quick Locations") {
                            ForEach(roots) { root in
                                Button {
                                    Task { await load(path: root.path) }
                                } label: {
                                    Label(root.name, systemImage: "folder.badge.gearshape")
                                        .foregroundStyle(palette.foreground)
                                }
                            }
                        }
                    }

                    Section("Subfolders (\(listing.dirs.count))") {
                        if listing.dirs.isEmpty {
                            Text("No subfolders")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                        } else {
                            ForEach(listing.dirs) { dir in
                                Button {
                                    Task { await load(path: dir.path) }
                                } label: {
                                    HStack {
                                        Label(dir.name, systemImage: "folder")
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
                } else if isLoading {
                    Section {
                        SkeletonListPlaceholder(count: 4)
                    }
                }
            }
            .navigationTitle("Choose Host Folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Button {
                            Task { await load(path: currentPath) }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .accessibilityLabel("Refresh folder")
                    }
                }
            }
            .task {
                await load(path: currentPath)
            }
        }
    }

    private func load(path: String) async {
        guard let client = store.activeClient else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let res = try await client.browse(path: path, includeFiles: false)
            listing = res
            currentPath = res.path
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

public struct PromptEnhanceSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    public let originalText: String
    public let sessionId: String?
    public let path: String?
    public let model: String?
    public let thinking: String?
    public let images: [PendingImageAttachment]
    public let onApply: (String) -> Void

    @State private var selectedMode: EnhanceMode
    @State private var jobId: String?
    @State private var statusText: String = "Ready to enhance"
    @State private var enhanceModelName: String?
    @State private var enhancedText: String?
    @State private var isRunning = false
    @State private var errorMessage: String?
    @State private var pollTask: Task<Void, Never>?
    @State private var showComparison = true

    public init(
        store: AppStore,
        originalText: String,
        sessionId: String? = nil,
        path: String? = nil,
        model: String? = nil,
        thinking: String? = nil,
        images: [PendingImageAttachment] = [],
        onApply: @escaping (String) -> Void
    ) {
        self.store = store
        self.originalText = originalText
        self.sessionId = sessionId
        self.path = path
        self.model = model
        self.thinking = thinking
        self.images = images
        self.onApply = onApply
        let mode = EnhanceMode(rawValue: store.snapshot.enhanceMode ?? "full") ?? .full
        self._selectedMode = State(initialValue: mode)
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Enhancement Mode")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.muted)

                        Picker("Mode", selection: $selectedMode) {
                            ForEach(EnhanceMode.allCases) { mode in
                                Text(mode.title).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)
                        .disabled(isRunning)
                        .onChange(of: selectedMode) { _, newMode in
                            Task { await store.setHostEnhanceMode(newMode.rawValue) }
                        }

                        Text(selectedMode.subtitle)
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                    }
                    .ompCard(palette)

                    if let errorMessage {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(palette.red)
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundStyle(palette.red)
                        }
                        .ompCard(palette)
                    }

                    if isRunning {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                ProgressView()
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(statusText)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(palette.foreground)
                                    if let enhanceModelName {
                                        Text("Using \(enhanceModelName)")
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(palette.muted)
                                    }
                                }
                                Spacer()
                                Button("Stop", role: .destructive) {
                                    Task { await stopJob() }
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                        .ompCard(palette)
                    }

                    if let enhancedText {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Label("Enhanced Specification", systemImage: "sparkles")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(palette.accent)
                                Spacer()
                                Toggle("Show Original", isOn: $showComparison)
                                    .labelsHidden()
                                    .tint(palette.accent)
                                Text("Compare")
                                    .font(.caption2)
                                    .foregroundStyle(palette.muted)
                            }

                            if showComparison {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("BEFORE")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(palette.muted)
                                    Text(originalText)
                                        .font(.caption)
                                        .foregroundStyle(palette.muted)
                                        .padding(8)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
                                }
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                if showComparison {
                                    Text("AFTER")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(palette.green)
                                }
                                MarkdownView(text: enhancedText)
                            }
                        }
                        .ompCard(palette)
                    } else if !isRunning {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Original Draft")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.muted)
                            Text(originalText)
                                .font(.subheadline)
                                .foregroundStyle(palette.foreground)
                        }
                        .ompCard(palette)
                    }
                }
                .padding()
            }
            .background(palette.background)
            .navigationTitle("Enhance Prompt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        pollTask?.cancel()
                        if isRunning { Task { await stopJob() } }
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if let enhancedText {
                        Button("Use Enhanced") {
                            onApply(enhancedText)
                            store.notificationManager.triggerHaptic(.success)
                            dismiss()
                        }
                    } else {
                        Button("Enhance") {
                            Task { await runEnhance() }
                        }
                        .disabled(isRunning || originalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if enhancedText != nil {
                    HStack(spacing: 12) {
                        Button("Re-run (\(selectedMode.title))") {
                            Task { await runEnhance() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(isRunning)

                        Button {
                            if let enhancedText {
                                onApply(enhancedText)
                                store.notificationManager.triggerHaptic(.success)
                                dismiss()
                            }
                        } label: {
                            Label("Replace Draft", systemImage: "checkmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(palette.accent)
                    }
                    .padding()
                    .background(.ultraThinMaterial)
                }
            }
            .onDisappear {
                pollTask?.cancel()
            }
        }
    }

    private func runEnhance() async {
        guard let client = store.activeClient else { return }
        pollTask?.cancel()
        isRunning = true
        enhancedText = nil
        errorMessage = nil
        statusText = "Ground-checking repository…"
        do {
            let start = try await client.startEnhance(
                text: originalText,
                mode: selectedMode.rawValue,
                sessionId: sessionId,
                path: path,
                model: model,
                thinking: thinking,
                images: images.map(\.wireImagePart)
            )
            jobId = start.id
            enhanceModelName = start.model
            pollTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    guard !Task.isCancelled else { return }
                    do {
                        let st = try await client.pollEnhance(id: start.id)
                        await MainActor.run {
                            if let step = st.step, !step.isEmpty { statusText = step }
                            if st.status == "done" {
                                enhancedText = st.text
                                isRunning = false
                                store.notificationManager.triggerHaptic(.success)
                            } else if st.status == "error" {
                                errorMessage = st.error ?? "Enhance failed."
                                isRunning = false
                                store.notificationManager.triggerHaptic(.error)
                            } else if st.status == "cancelled" {
                                statusText = "Cancelled"
                                isRunning = false
                            }
                        }
                        if st.status != "running" { return }
                    } catch {
                        await MainActor.run {
                            errorMessage = error.localizedDescription
                            isRunning = false
                        }
                        return
                    }
                }
            }
        } catch {
            errorMessage = error.localizedDescription
            isRunning = false
        }
    }

    private func stopJob() async {
        guard let client = store.activeClient, let jobId else { return }
        pollTask?.cancel()
        _ = try? await client.stopEnhance(id: jobId)
        isRunning = false
    }
}
