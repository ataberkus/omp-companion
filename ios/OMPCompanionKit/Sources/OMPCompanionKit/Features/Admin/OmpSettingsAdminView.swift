import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// MARK: - OMP Settings Editor

public struct OmpSettingsAdminView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var response: SettingsResponse?
    @State private var searchText: String = ""
    @State private var showModifiedOnly = false
    @State private var selectedGroup: String = "all"
    @State private var isLoading = false
    @State private var savingKey: String?
    @State private var errorMessage: String?
    @State private var editingSetting: SettingItem?

    public init(store: AppStore) {
        self.store = store
    }

    private var groups: [String] {
        guard let items = response?.settings else { return [] }
        var seen = Set<String>()
        var out: [String] = []
        for item in items where !seen.contains(item.group) {
            seen.insert(item.group)
            out.append(item.group)
        }
        return out
    }

    private var filteredSettings: [SettingItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return (response?.settings ?? []).filter { item in
            if showModifiedOnly && !item.modified { return false }
            if selectedGroup != "all" && item.group != selectedGroup { return false }
            if !q.isEmpty {
                let opts = (item.options ?? []).joined(separator: " ").lowercased()
                return item.key.lowercased().contains(q)
                    || item.description.lowercased().contains(q)
                    || item.group.lowercased().contains(q)
                    || opts.contains(q)
            }
            return true
        }
    }

    public var body: some View {
        List {
            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(palette.red)
                }
            }

            if let file = response?.file, !file.isEmpty {
                Section {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Config File")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(palette.muted)
                            Text(file)
                                .font(.caption.monospaced())
                                .foregroundStyle(palette.foreground)
                                .lineLimit(2)
                        }
                        Spacer()
                        Button {
                            #if canImport(UIKit)
                            UIPasteboard.general.string = file
                            store.showToast(String(localized: "Copied config path", bundle: .main))
                            #endif
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                        .accessibilityLabel("Copy config path")
                    }
                }
                .listRowBackground(palette.card)
            }

            Section {
                Toggle("Modified Settings Only", isOn: $showModifiedOnly)
                    .listRowBackground(palette.card)

                if !groups.isEmpty {
                    Picker("Group", selection: $selectedGroup) {
                        Text("All Groups").tag("all")
                        ForEach(groups, id: \.self) { grp in
                            Text(grp.capitalized).tag(grp)
                        }
                    }
                    .listRowBackground(palette.card)
                }
            }

            if isLoading && response == nil {
                Section {
                    SkeletonListPlaceholder(count: 6)
                        .listRowBackground(Color.clear)
                }
            } else if filteredSettings.isEmpty {
                Section {
                    OMPEmptyStateView(
                        systemImage: "slider.horizontal.3",
                        title: String(localized: "No Settings Match", bundle: .main),
                        message: showModifiedOnly ? String(localized: "No settings have been modified from their defaults.", bundle: .main) : String(localized: "Try clearing the search query or group filter.", bundle: .main)
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                Section("Settings (\(filteredSettings.count))") {
                    ForEach(filteredSettings) { item in
                        settingRow(item)
                            .listRowBackground(palette.card)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .searchable(text: $searchText, prompt: "Search OMP settings…")
        .navigationTitle("OMP Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await loadSettings() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh settings")
            }
        }
        .refreshable {
            await loadSettings()
        }
        .task {
            await loadSettings()
        }
        .sheet(item: $editingSetting) { item in
            SettingValueEditorSheet(
                item: item,
                canMutate: store.canPerformMutatingActions
            ) { nextValue in
                await updateSetting(key: item.key, value: nextValue)
            } onReset: {
                await resetSetting(key: item.key)
            }
        }
    }

    @ViewBuilder
    private func settingRow(_ item: SettingItem) -> some View {
        if item.type == "boolean" && !item.sensitive {
            VStack(alignment: .leading, spacing: 4) {
                Toggle(isOn: Binding(
                    get: { item.value?.boolValue ?? false },
                    set: { next in Task { _ = await updateSetting(key: item.key, value: next) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(item.key)
                                .font(.caption.monospaced().weight(.semibold))
                                .foregroundStyle(palette.foreground)
                            if item.modified {
                                badge("modified", tint: palette.amber, soft: palette.amberSoft)
                            }
                        }
                        if !item.description.isEmpty {
                            Text(item.description)
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                        }
                    }
                }
                .disabled(!store.canPerformMutatingActions || savingKey == item.key)

                if item.modified {
                    Button("Reset to default (\(item.default?.displayString ?? "unset"))") {
                        Task { _ = await resetSetting(key: item.key) }
                    }
                    .font(.caption2)
                    .foregroundStyle(palette.accent)
                    .buttonStyle(.borderless)
                    .disabled(!store.canPerformMutatingActions || savingKey == item.key)
                }
            }
            .padding(.vertical, 2)
        } else {
            Button {
                editingSetting = item
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(item.key)
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(palette.foreground)
                            .lineLimit(1)
                        if item.sensitive {
                            badge("secret", tint: palette.red, soft: palette.redSoft)
                        }
                        if item.modified {
                            badge("changed", tint: palette.amber, soft: palette.amberSoft)
                        }
                        Spacer()
                        if savingKey == item.key {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                        }
                    }

                    Text(displayValueSummary(for: item))
                        .font(.caption.monospaced())
                        .foregroundStyle(item.sensitive ? palette.muted : palette.accent)
                        .lineLimit(2)

                    if !item.description.isEmpty {
                        Text(item.description)
                            .font(.caption2)
                            .foregroundStyle(palette.muted)
                            .lineLimit(2)
                    }
                }
                .padding(.vertical, 3)
            }
            .buttonStyle(.plain)
        }
    }

    private func displayValueSummary(for item: SettingItem) -> String {
        if item.sensitive {
            return item.isSet ? "•••••••• (redacted on host)" : "(not set)"
        }
        guard let val = item.value else { return "(unset)" }
        return val.displayString
    }

    @ViewBuilder
    private func badge(_ text: String, tint: Color, soft: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(soft, in: Capsule())
            .foregroundStyle(tint)
    }

    private func loadSettings() async {
        guard let client = store.activeClient else { return }
        if response == nil { isLoading = true }
        defer { isLoading = false }
        do {
            response = try await client.fetchSettings()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    private func updateSetting(key: String, value: Any) async -> Bool {
        guard let client = store.activeClient else { return false }
        savingKey = key
        defer { savingKey = nil }
        do {
            response = try await client.setSetting(key: key, value: value)
            store.showToast(String(localized: "Saved \(key)", bundle: .main))
            store.notificationManager.triggerHaptic(.success)
            return true
        } catch {
            store.showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    @discardableResult
    private func resetSetting(key: String) async -> Bool {
        guard let client = store.activeClient else { return false }
        savingKey = key
        defer { savingKey = nil }
        do {
            response = try await client.resetSetting(key: key)
            store.showToast(String(localized: "Reset \(key)", bundle: .main))
            store.notificationManager.triggerHaptic(.selection)
            return true
        } catch {
            store.showToast(error.localizedDescription, isError: true)
            return false
        }
    }
}

private struct SettingValueEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette

    let item: SettingItem
    let canMutate: Bool
    let onSave: (Any) async -> Bool
    let onReset: () async -> Bool

    @State private var draftText: String
    @State private var selectedOption: String
    @State private var revealSecret = false
    @State private var isSaving = false
    @State private var validationError: String?

    init(
        item: SettingItem,
        canMutate: Bool,
        onSave: @escaping (Any) async -> Bool,
        onReset: @escaping () async -> Bool
    ) {
        self.item = item
        self.canMutate = canMutate
        self.onSave = onSave
        self.onReset = onReset

        let initialText: String
        if item.sensitive {
            initialText = ""
        } else if let v = item.value {
            initialText = v.displayString
        } else {
            initialText = ""
        }
        self._draftText = State(initialValue: initialText)
        self._selectedOption = State(initialValue: item.value?.stringValue ?? item.options?.first ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Setting") {
                    Text(item.key)
                        .font(.callout.monospaced().weight(.semibold))
                    if !item.description.isEmpty {
                        Text(item.description)
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                    }
                    HStack {
                        Text("Type: \(item.type)")
                        Spacer()
                        Text("Group: \(item.group)")
                    }
                    .font(.caption2)
                    .foregroundStyle(palette.muted)
                }

                if let validationError {
                    Section {
                        Text(validationError)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                }

                Section(item.sensitive ? "New Secret Value (never echoed back)" : "Value") {
                    if let opts = item.options, !opts.isEmpty, item.type == "enum" || item.type == "string" {
                        Picker("Option", selection: $selectedOption) {
                            ForEach(opts, id: \.self) { opt in
                                Text(opt).tag(opt)
                            }
                        }
                    } else if item.type == "array" || item.type == "record" {
                        TextEditor(text: $draftText)
                            .font(.caption.monospaced())
                            .frame(minHeight: 160)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } else if item.sensitive {
                        HStack {
                            if revealSecret {
                                TextField("Enter new secret value", text: $draftText)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            } else {
                                SecureField(item.isSet ? "•••••••• (leave blank to keep)" : "Enter secret value", text: $draftText)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            }
                            Button {
                                revealSecret.toggle()
                            } label: {
                                Image(systemName: revealSecret ? "eye.slash" : "eye")
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(revealSecret ? "Hide secret" : "Show secret")
                        }
                    } else {
                        TextField("Value", text: $draftText)
                            .font(.callout.monospaced())
                            .keyboardType(item.type == "number" ? .decimalPad : .default)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }

                if !item.sensitive, let def = item.default {
                    Section("Default") {
                        Text(def.displayString)
                            .font(.caption.monospaced())
                            .foregroundStyle(palette.muted)
                    }
                }

                if item.modified || item.isSet {
                    Section {
                        Button("Reset to Default", role: .destructive) {
                            Task {
                                isSaving = true
                                let ok = await onReset()
                                isSaving = false
                                if ok { dismiss() }
                            }
                        }
                        .disabled(!canMutate || isSaving)
                    }
                }
            }
            .navigationTitle("Edit Setting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task { await submit() }
                    }
                    .disabled(!canMutate || isSaving)
                }
            }
        }
    }

    private func submit() async {
        validationError = nil
        let payloadValue: Any

        if let opts = item.options, !opts.isEmpty, item.type == "enum" || item.type == "string" {
            payloadValue = selectedOption
        } else if item.type == "number" {
            let trimmed = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let num = Double(trimmed), num.isFinite else {
                validationError = "Enter a valid finite number."
                return
            }
            payloadValue = num
        } else if item.type == "array" {
            guard let data = draftText.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [Any] else {
                validationError = "Enter a valid JSON array (for example: [\"item1\", \"item2\"])."
                return
            }
            payloadValue = parsed
        } else if item.type == "record" {
            guard let data = draftText.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                validationError = "Enter a valid JSON object (for example: {\"default\": \"...\"})."
                return
            }
            payloadValue = parsed
        } else {
            if item.sensitive && draftText.isEmpty {
                validationError = "Enter a new secret value, or tap Reset to Default."
                return
            }
            payloadValue = draftText
        }

        isSaving = true
        let ok = await onSave(payloadValue)
        isSaving = false
        if ok { dismiss() }
    }
}
