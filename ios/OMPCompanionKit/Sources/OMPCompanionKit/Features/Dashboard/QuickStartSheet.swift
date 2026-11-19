import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

#if canImport(UIKit)
import UIKit
#endif

public struct QuickStartSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var folderPath: String = ""
    @State private var title: String = ""
    @State private var prompt: String = ""
    @State private var isolate: Bool = false
    @State private var selectedModel: String = ""
    @State private var selectedThinking: String = ""
    @State private var autoApprove: Bool = false
    @State private var fastMode: Bool = false
    @State private var advisorEnabled: Bool = false
    @State private var launchOptions: SessionLaunchOptions?
    @State private var attachments: [PendingImageAttachment] = []

    @State private var showFolderPicker = false
    @State private var showLaunchOptions = false
    @State private var showEnhanceSheet = false
    @State private var showCamera = false
    @State private var showFileImporter = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var isStarting = false
    @State private var errorMessage: String?

    public init(store: AppStore) {
        self.store = store
    }

    private var currentModelEntry: ModelEntry? {
        store.availableModels.first { $0.selector == selectedModel }
    }

    private var availableThinkingLevels: [String] {
        if let entry = currentModelEntry, let levels = entry.thinking, !levels.isEmpty {
            return levels
        }
        return store.thinkingLevels
    }

    private var estimatedTotalTokens: Int {
        let imgTokens = attachments.reduce(0) { $0 + $1.estimatedTokens }
        let textTokens = max(0, (prompt.utf8.count + 3) / 4)
        return imgTokens + textTokens
    }

    public var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                }

                Section("Workspace Folder") {
                    if !store.visibleProjects.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(store.visibleProjects) { project in
                                    Button {
                                        folderPath = project.path
                                    } label: {
                                        HStack(spacing: 6) {
                                            Circle()
                                                .fill(Color.fromCSS(project.color))
                                                .frame(width: 8, height: 8)
                                            Text(project.name)
                                                .font(.caption.weight(.medium))
                                        }
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(
                                            folderPath == project.path ? palette.accentSoft : palette.raised,
                                            in: Capsule()
                                        )
                                        .foregroundStyle(folderPath == project.path ? palette.accent : palette.foreground)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }

                    HStack(spacing: 8) {
                        TextField("/path/to/workspace", text: $folderPath)
                            .font(.callout.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                        Button {
                            showFolderPicker = true
                        } label: {
                            Image(systemName: "folder.badge.plus")
                        }
                        .accessibilityLabel("Browse host folders")
                    }

                    Toggle(isOn: $isolate) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Isolate in Git Worktree")
                            Text("Creates an isolated `omp-web/...` branch & working directory")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                        }
                    }
                }

                Section("Session & Model") {
                    TextField("Session Title (optional — auto-generated from prompt)", text: $title)

                    Picker("Model", selection: $selectedModel) {
                        Text("OMP Default").tag("")
                        ForEach(store.availableModels) { model in
                            Text("\(model.name) (\(model.provider))").tag(model.selector)
                        }
                    }

                    Picker("Reasoning Effort", selection: $selectedThinking) {
                        Text("Auto").tag("")
                        ForEach(availableThinkingLevels, id: \.self) { level in
                            Text(level).tag(level)
                        }
                    }

                    Toggle("Auto-Approve Tool Prompts", isOn: $autoApprove)
                    Toggle("Fast Mode", isOn: $fastMode)
                    Toggle("Enable Advisor", isOn: $advisorEnabled)

                    Button {
                        showLaunchOptions = true
                    } label: {
                        HStack {
                            Label("Launch Options", systemImage: "slider.horizontal.3")
                            Spacer()
                            let count = launchOptions?.activeCount ?? 0
                            Text(count > 0 ? "\(count) active" : "Default")
                                .font(.caption)
                                .foregroundStyle(count > 0 ? palette.accent : palette.muted)
                        }
                    }
                }

                Section {
                    ZStack(alignment: .topLeading) {
                        if prompt.isEmpty {
                            Text("Describe the task, bug, or feature for OMP…")
                                .font(.body)
                                .foregroundStyle(palette.muted.opacity(0.6))
                                .padding(.top, 8)
                                .padding(.leading, 4)
                        }
                        TextEditor(text: $prompt)
                            .frame(minHeight: 120, maxHeight: 240)
                            .scrollContentBackground(.hidden)
                    }

                    if !attachments.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(attachments) { att in
                                    ZStack(alignment: .topTrailing) {
                                        if let preview = att.previewDataURL {
                                            DataURLImageView(dataURL: preview)
                                                .frame(width: 68, height: 68)
                                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                        } else {
                                            RoundedRectangle(cornerRadius: 8)
                                                .fill(palette.raised)
                                                .frame(width: 68, height: 68)
                                                .overlay(Image(systemName: "photo"))
                                        }
                                        Button {
                                            attachments.removeAll { $0.id == att.id }
                                        } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .foregroundStyle(.white, palette.red)
                                        }
                                        .offset(x: 5, y: -5)
                                    }
                                    .padding(.top, 6)
                                }
                            }
                        }
                    }

                    HStack(spacing: 14) {
                        PhotosPicker(selection: $photoItems, maxSelectionCount: 6, matching: .images) {
                            Label("Photos", systemImage: "photo.on.rectangle")
                                .font(.caption.weight(.medium))
                        }
                        .onChange(of: photoItems) { _, items in
                            Task { await loadPhotos(items) }
                        }

                        Button {
                            showCamera = true
                        } label: {
                            Label("Camera", systemImage: "camera")
                                .font(.caption.weight(.medium))
                        }

                        Button {
                            showFileImporter = true
                        } label: {
                            Label("Files", systemImage: "doc")
                                .font(.caption.weight(.medium))
                        }

                        #if canImport(UIKit)
                        Button {
                            pasteClipboardImage()
                        } label: {
                            Label("Paste", systemImage: "doc.on.clipboard")
                                .font(.caption.weight(.medium))
                        }
                        #endif

                        Spacer()

                        if !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Button {
                                showEnhanceSheet = true
                            } label: {
                                Label("Enhance", systemImage: "sparkles")
                                    .font(.caption.weight(.semibold))
                            }
                            .tint(palette.accent)
                        }
                    }
                    .buttonStyle(.borderless)
                } header: {
                    HStack {
                        Text("Initial Prompt")
                        Spacer()
                        if estimatedTotalTokens > 0 {
                            Text("~\(CompanionFormatters.formatTokens(estimatedTotalTokens)) tokens")
                                .font(.caption2.monospaced())
                                .foregroundStyle(palette.muted)
                        }
                    }
                }
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Menu {
                        Button {
                            Task { await launchSession(asDraft: false) }
                        } label: {
                            Label("Start Session", systemImage: "play.fill")
                        }
                        Button {
                            Task { await launchSession(asDraft: true) }
                        } label: {
                            Label("Create as Draft Session", systemImage: "doc.badge.plus")
                        }
                    } label: {
                        if isStarting {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Start")
                                .fontWeight(.semibold)
                        }
                    } primaryAction: {
                        Task { await launchSession(asDraft: false) }
                    }
                    .disabled(folderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isStarting || !store.canPerformMutatingActions)
                }
            }
            .onAppear {
                if let initial = store.quickStartInitialPath, !initial.isEmpty {
                    folderPath = initial
                    store.quickStartInitialPath = nil
                } else if let selectedProj = store.selectedProjectID,
                          let p = store.snapshot.projects.first(where: { $0.id == selectedProj }) {
                    folderPath = p.path
                } else if let first = store.visibleProjects.first {
                    folderPath = first.path
                }
            }
            .sheet(isPresented: $showFolderPicker) {
                HostDirectoryPickerSheet(store: store, initialPath: folderPath) { chosen in
                    folderPath = chosen
                }
            }
            .sheet(isPresented: $showLaunchOptions) {
                LaunchOptionsSheet(
                    title: "Session Launch Options",
                    applyButtonTitle: "Use Options",
                    initial: launchOptions,
                    availableModels: store.availableModels
                ) { next in
                    launchOptions = next
                    return true
                }
            }
            .sheet(isPresented: $showEnhanceSheet) {
                PromptEnhanceSheet(
                    store: store,
                    originalText: prompt,
                    path: folderPath.isEmpty ? nil : folderPath,
                    model: selectedModel.isEmpty ? nil : selectedModel,
                    thinking: selectedThinking.isEmpty ? nil : selectedThinking,
                    images: attachments
                ) { enhanced in
                    prompt = enhanced
                }
            }
            #if canImport(UIKit)
            .sheet(isPresented: $showCamera) {
                CameraImagePicker { image in
                    let existingBytes = attachments.reduce(0) { $0 + $1.base64Data.utf8.count }
                    do {
                        let processed = try ImageAttachmentProcessor.processUIImage(image, suggestedName: "camera.jpg", existingBase64Bytes: existingBytes)
                        attachments.append(processed)
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
            }
            #endif
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result else { return }
                Task { await importImageFiles(urls) }
            }
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) async {
        defer { photoItems = [] }
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self) {
                let existingBytes = attachments.reduce(0) { $0 + $1.base64Data.utf8.count }
                do {
                    let processed = try ImageAttachmentProcessor.processRawImageData(
                        data,
                        suggestedName: "photo.jpg",
                        existingBase64Bytes: existingBytes
                    )
                    attachments.append(processed)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func importImageFiles(_ urls: [URL]) async {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let existingBytes = attachments.reduce(0) { $0 + $1.base64Data.utf8.count }
            do {
                let processed = try ImageAttachmentProcessor.processRawImageData(
                    data,
                    suggestedName: url.lastPathComponent,
                    existingBase64Bytes: existingBytes
                )
                attachments.append(processed)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    #if canImport(UIKit)
    private func pasteClipboardImage() {
        guard let image = UIPasteboard.general.image else {
            store.showToast("No image on clipboard.", isError: true)
            return
        }
        let existingBytes = attachments.reduce(0) { $0 + $1.base64Data.utf8.count }
        do {
            let processed = try ImageAttachmentProcessor.processUIImage(image, suggestedName: "clipboard.jpg", existingBase64Bytes: existingBytes)
            attachments.append(processed)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
    #endif

    private func launchSession(asDraft: Bool) async {
        guard let client = store.activeClient else { return }
        let cleanPath = folderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanPath.isEmpty else { return }
        isStarting = true
        errorMessage = nil
        defer { isStarting = false }

        do {
            let previews = attachments.compactMap(\.previewDataURL)
            let created = try await client.quickStart(
                path: cleanPath,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : title,
                prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                images: attachments.map(\.wireImagePart),
                preview: previews.isEmpty ? nil : previews,
                isolate: isolate,
                model: selectedModel.isEmpty ? nil : selectedModel,
                thinking: selectedThinking.isEmpty ? nil : selectedThinking,
                autoApprove: autoApprove ? true : nil,
                fast: fastMode ? true : nil,
                advisor: advisorEnabled ? true : nil,
                draft: asDraft,
                launch: launchOptions?.toDictionary()
            )
            store.integrateSession(created)
            store.notificationManager.triggerHaptic(.success)
            dismiss()
            await store.selectSession(created.id, tab: .chat)
        } catch {
            errorMessage = error.localizedDescription
            store.notificationManager.triggerHaptic(.error)
        }
    }
}
