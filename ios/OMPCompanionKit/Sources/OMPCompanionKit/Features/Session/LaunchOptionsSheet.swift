import SwiftUI

public struct LaunchOptionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette

    public let title: String
    public let applyButtonTitle: String
    public let availableModels: [ModelEntry]
    @State private var options: SessionLaunchOptions
    @State private var toolsText: String
    @State private var skillsText: String
    @State private var addDirsText: String
    @State private var isSaving = false
    public let onSave: (SessionLaunchOptions?) async -> Bool

    public init(
        title: String = "Launch Options",
        applyButtonTitle: String = "Save",
        initial: SessionLaunchOptions?,
        availableModels: [ModelEntry],
        onSave: @escaping (SessionLaunchOptions?) async -> Bool
    ) {
        self.title = title
        self.applyButtonTitle = applyButtonTitle
        self.availableModels = availableModels
        let base = initial ?? SessionLaunchOptions()
        self._options = State(initialValue: base)
        self._toolsText = State(initialValue: (base.tools ?? []).joined(separator: ", "))
        self._skillsText = State(initialValue: (base.skills ?? []).joined(separator: ", "))
        self._addDirsText = State(initialValue: (base.addDirs ?? []).joined(separator: "\n"))
        self.onSave = onSave
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Approval & Planning Flags") {
                    Picker("Approval mode", selection: Binding(
                        get: { options.approvalMode ?? "" },
                        set: { options.approvalMode = $0.isEmpty ? nil : $0 }
                    )) {
                        Text("OMP default").tag("")
                        Text("Always ask").tag("always-ask")
                        Text("Write auto").tag("write")
                        Text("YOLO (no prompts)").tag("yolo")
                    }

                    boolToggle("Prewalk codebase", keyPath: \.prewalk)
                    boolToggle("Plan-YOLO at start", keyPath: \.planYolo)
                    boolToggle("Skip auto-titling (--no-title)", keyPath: \.noTitle)
                }

                Section("Capabilities & Extensions") {
                    boolToggle("Disable tools (--no-tools)", keyPath: \.noTools)
                    boolToggle("Disable LSP (--no-lsp)", keyPath: \.noLsp)
                    boolToggle("Disable PTY (--no-pty)", keyPath: \.noPty)
                    boolToggle("Disable skills (--no-skills)", keyPath: \.noSkills)
                    boolToggle("Disable rules (--no-rules)", keyPath: \.noRules)
                    boolToggle("Disable extensions (--no-extensions)", keyPath: \.noExtensions)

                    TextField("Allowed tools (comma-separated)", text: $toolsText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    TextField("Skill patterns (comma-separated)", text: $skillsText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section("Role Model Overrides") {
                    modelRolePicker("Smol role (--smol)", value: Binding(
                        get: { options.smol ?? "" },
                        set: { options.smol = $0.isEmpty ? nil : $0 }
                    ))
                    modelRolePicker("Slow role (--slow)", value: Binding(
                        get: { options.slow ?? "" },
                        set: { options.slow = $0.isEmpty ? nil : $0 }
                    ))
                    modelRolePicker("Plan role (--plan)", value: Binding(
                        get: { options.plan ?? "" },
                        set: { options.plan = $0.isEmpty ? nil : $0 }
                    ))
                    modelRolePicker("Prewalk into", value: Binding(
                        get: { options.prewalkInto ?? "" },
                        set: { options.prewalkInto = $0.isEmpty ? nil : $0 }
                    ))
                    modelRolePicker("Plan-YOLO into", value: Binding(
                        get: { options.planYoloInto ?? "" },
                        set: { options.planYoloInto = $0.isEmpty ? nil : $0 }
                    ))
                }

                Section("Budget, Extra Folders & System Prompt") {
                    TextField("Max turn time (e.g. 600, 10m, 1h)", text: Binding(
                        get: { options.maxTime ?? "" },
                        set: { options.maxTime = $0.isEmpty ? nil : $0 }
                    ))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Extra folders (--add-dir, one per line)")
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                        TextField("/path/to/repo", text: $addDirsText, axis: .vertical)
                            .lineLimit(2...5)
                            .font(.callout.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Append system prompt")
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                        TextField("Extra instructions added to OMP's prompt", text: Binding(
                            get: { options.appendSystemPrompt ?? "" },
                            set: { options.appendSystemPrompt = $0.isEmpty ? nil : $0 }
                        ), axis: .vertical)
                        .lineLimit(2...6)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Replace system prompt")
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                        TextField("Leave empty to keep OMP's default prompt", text: Binding(
                            get: { options.systemPrompt ?? "" },
                            set: { options.systemPrompt = $0.isEmpty ? nil : $0 }
                        ), axis: .vertical)
                        .lineLimit(2...6)
                    }
                }

                if resolvedOptions().activeCount > 0 {
                    Section {
                        Button("Clear All Launch Options", role: .destructive) {
                            Task {
                                isSaving = true
                                let ok = await onSave(nil)
                                isSaving = false
                                if ok { dismiss() }
                            }
                        }
                        .disabled(isSaving)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : applyButtonTitle) {
                        Task {
                            isSaving = true
                            let candidate = resolvedOptions()
                            let ok = await onSave(candidate.activeCount > 0 ? candidate : nil)
                            isSaving = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(isSaving)
                }
            }
        }
    }

    private func boolToggle(_ label: String, keyPath: WritableKeyPath<SessionLaunchOptions, Bool?>) -> some View {
        Toggle(label, isOn: Binding(
            get: { options[keyPath: keyPath] == true },
            set: { options[keyPath: keyPath] = $0 ? true : nil }
        ))
    }

    @ViewBuilder
    private func modelRolePicker(_ label: String, value: Binding<String>) -> some View {
        if availableModels.isEmpty {
            TextField(label, text: value)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } else {
            Picker(label, selection: value) {
                Text("Default").tag("")
                ForEach(availableModels) { m in
                    Text(m.selector).tag(m.selector)
                }
            }
        }
    }

    private func resolvedOptions() -> SessionLaunchOptions {
        var copy = options
        let tools = toolsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        copy.tools = tools.isEmpty ? nil : tools

        let skills = skillsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        copy.skills = skills.isEmpty ? nil : skills

        let dirs = addDirsText
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        copy.addDirs = dirs.isEmpty ? nil : dirs

        return copy
    }
}
