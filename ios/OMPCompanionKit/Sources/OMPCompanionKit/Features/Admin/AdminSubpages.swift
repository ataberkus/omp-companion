import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// MARK: - Provider Accounts & Rate Limits

public struct ProviderAccountsAdminView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var accountsResponse: AccountsResponse?
    @State private var usageResponse: ProviderUsageResponse?
    @State private var isLoadingAccounts = false
    @State private var isLoadingUsage = false
    @State private var savingProvider: String?
    @State private var errorMessage: String?

    public init(store: AppStore) {
        self.store = store
    }

    private var activeUsageSession: SessionSummary? {
        store.selectedSession ?? store.visibleSessions.first(where: { $0.hidden != true })
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

            Section {
                if isLoadingAccounts && accountsResponse == nil {
                    SkeletonListPlaceholder(count: 3)
                        .listRowBackground(Color.clear)
                } else if let providers = accountsResponse?.providers, !providers.isEmpty {
                    ForEach(providers) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(group.name)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(palette.foreground)
                                Spacer()
                                if savingProvider == group.id {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Text(group.selected ?? "Auto / Active")
                                        .font(.caption.monospaced())
                                        .foregroundStyle(palette.accent)
                                }
                            }

                            if group.accounts.isEmpty {
                                Text("No saved OAuth accounts reported.")
                                    .font(.caption)
                                    .foregroundStyle(palette.muted)
                            } else {
                                ForEach(group.accounts, id: \.self) { account in
                                    let isChosen = (group.selected ?? store.snapshot.accountChoices?[group.id]) == account
                                    Button {
                                        Task { await select(provider: group.id, account: account) }
                                    } label: {
                                        HStack {
                                            Text(account)
                                                .font(.caption.monospaced())
                                                .foregroundStyle(palette.foreground)
                                            Spacer()
                                            if isChosen {
                                                Image(systemName: "checkmark.circle.fill")
                                                    .foregroundStyle(palette.green)
                                            }
                                        }
                                        .padding(.vertical, 4)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(!store.canPerformMutatingActions || savingProvider != nil)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                        .listRowBackground(palette.card)
                    }
                } else {
                    OMPEmptyStateView(
                        systemImage: "person.2.badge.key",
                        title: "No Multi-Account Providers",
                        message: "Authenticated providers with switchable OAuth accounts appear here."
                    )
                    .listRowBackground(Color.clear)
                }
            } header: {
                Text("Provider OAuth Accounts")
            } footer: {
                Text("OMP matches your chosen account label the next time a session prompts with that provider.")
            }

            Section("Active Rate Limits & Quotas") {
                if isLoadingUsage && usageResponse == nil {
                    SkeletonListPlaceholder(count: 2)
                        .listRowBackground(Color.clear)
                } else if let usage = usageResponse, !usage.providers.isEmpty {
                    ForEach(usage.providers) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(group.provider)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                            if let unavailable = group.unavailable {
                                Text(unavailable)
                                    .font(.caption)
                                    .foregroundStyle(palette.muted)
                            }
                            ForEach(group.accounts) { acc in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(acc.name)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(palette.accent)
                                    ForEach(acc.limits) { lim in
                                        VStack(alignment: .leading, spacing: 2) {
                                            HStack {
                                                Text(lim.label)
                                                    .font(.caption2.weight(.medium))
                                                Spacer()
                                                Text(lim.summary)
                                                    .font(.caption2.monospacedDigit())
                                                    .foregroundStyle(palette.muted)
                                            }
                                            if let frac = lim.fraction {
                                                ProgressView(value: min(1.0, max(0.0, frac)))
                                                    .tint(frac > 0.85 ? palette.red : (frac > 0.65 ? palette.amber : palette.green))
                                            }
                                            if let reset = lim.resetLabel, !reset.isEmpty {
                                                Text("Resets \(reset)")
                                                    .font(.caption2)
                                                    .foregroundStyle(palette.muted)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 4)
                        .listRowBackground(palette.card)
                    }
                } else {
                    Text(activeUsageSession == nil ? "Start or open a session to inspect provider rate limits." : "No active quota windows reported.")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                        .listRowBackground(palette.card)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .navigationTitle("Accounts & Quotas")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await reloadAll() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
        .refreshable {
            await reloadAll()
        }
        .task {
            await reloadAll()
        }
    }

    private func reloadAll() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await loadAccounts() }
            group.addTask { await loadUsage() }
        }
    }

    private func loadAccounts() async {
        guard let client = store.activeClient else { return }
        isLoadingAccounts = true
        defer { isLoadingAccounts = false }
        do {
            accountsResponse = try await client.fetchAccounts()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadUsage() async {
        guard let client = store.activeClient, let sid = activeUsageSession?.id else { return }
        isLoadingUsage = true
        defer { isLoadingUsage = false }
        if let res = try? await client.fetchUsage(sessionId: sid) {
            usageResponse = res
        }
    }

    private func select(provider: String, account: String) async {
        guard let client = store.activeClient else { return }
        savingProvider = provider
        defer { savingProvider = nil }
        do {
            try await client.selectAccount(provider: provider, account: account)
            accountsResponse = try await client.fetchAccounts()
            store.showToast("Selected \(account) for \(provider)")
            store.notificationManager.triggerHaptic(.selection)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}

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
                            store.showToast("Copied config path")
                            #endif
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
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
                        title: "No Settings Match",
                        message: showModifiedOnly ? "No settings have been modified from their defaults." : "Try clearing the search query or group filter."
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
            store.showToast("Saved \(key)")
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
            store.showToast("Reset \(key)")
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

// MARK: - MCP Servers Inspector & Toggle

public struct McpServersAdminView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var response: McpResponse?
    @State private var searchText: String = ""
    @State private var isLoading = false
    @State private var togglingId: String?
    @State private var errorMessage: String?

    public init(store: AppStore) {
        self.store = store
    }

    private var filteredServers: [McpServerItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return (response?.servers ?? []).filter { s in
            guard !q.isEmpty else { return true }
            let fields = [s.name, s.command, s.url, s.source.path, s.source.providerName, s.project?.name]
                .compactMap { $0?.lowercased() }
            return fields.contains(where: { $0.contains(q) })
        }
    }

    private var userServers: [McpServerItem] {
        filteredServers.filter { $0.project == nil }
    }

    private var projectServersGrouped: [(projectName: String, servers: [McpServerItem])] {
        var map: [String: [McpServerItem]] = [:]
        for srv in filteredServers where srv.project != nil {
            let name = srv.project?.name ?? "Project"
            map[name, default: []].append(srv)
        }
        return map.keys.sorted().map { ($0, map[$0] ?? []) }
    }

    public var body: some View {
        List {
            if let errorMessage {
                Section {
                    Text(errorMessage).font(.caption).foregroundStyle(palette.red)
                }
            }

            if let warnings = response?.warnings, !warnings.isEmpty {
                Section("Discovery Warnings") {
                    ForEach(warnings, id: \.self) { w in
                        Text(w)
                            .font(.caption)
                            .foregroundStyle(palette.amber)
                    }
                }
            }

            if let resp = response, !resp.projectConfig, resp.servers.contains(where: { $0.project != nil }) {
                Section {
                    Label("mcp.enableProjectConfig is off, so project-level servers below are not loaded.", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(palette.amber)
                }
            }

            if isLoading && response == nil {
                Section {
                    SkeletonListPlaceholder(count: 4).listRowBackground(Color.clear)
                }
            } else if filteredServers.isEmpty {
                Section {
                    OMPEmptyStateView(
                        systemImage: "cable.connector",
                        title: "No MCP Servers Found",
                        message: "Configure MCP servers in ~/.omp/agent/mcp.json or a project's .mcp.json to manage them here."
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                if !userServers.isEmpty {
                    Section("User MCP Servers (\(userServers.count))") {
                        ForEach(userServers) { srv in
                            mcpRow(srv)
                                .listRowBackground(palette.card)
                        }
                    }
                }

                ForEach(projectServersGrouped, id: \.projectName) { grp in
                    Section("Project: \(grp.projectName)") {
                        ForEach(grp.servers) { srv in
                            mcpRow(srv)
                                .listRowBackground(palette.card)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .searchable(text: $searchText, prompt: "Filter MCP servers…")
        .navigationTitle("MCP Servers")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await loadMcp() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
        .refreshable {
            await loadMcp()
        }
        .task {
            await loadMcp()
        }
    }

    @ViewBuilder
    private func mcpRow(_ srv: McpServerItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(srv.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                        Text(srv.state)
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(stateColor(srv.state).opacity(0.15), in: Capsule())
                            .foregroundStyle(stateColor(srv.state))
                    }
                    Text("\(srv.source.providerName) · \(srv.transport.uppercased())")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }

                Spacer()

                if srv.state == "shadowed" {
                    Text("Overridden")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                } else if togglingId == srv.id {
                    ProgressView().controlSize(.small)
                } else {
                    Toggle("", isOn: Binding(
                        get: { srv.enabled },
                        set: { next in Task { await toggleServer(srv, enabled: next) } }
                    ))
                    .labelsHidden()
                    .disabled(!store.canPerformMutatingActions || togglingId != nil)
                }
            }

            if let cmd = srv.command {
                let line = ([cmd] + (srv.args ?? [])).joined(separator: " ")
                Text(line)
                    .font(.caption2.monospaced())
                    .foregroundStyle(palette.accent)
                    .lineLimit(2)
            } else if let url = srv.url {
                Text(url)
                    .font(.caption2.monospaced())
                    .foregroundStyle(palette.accent)
                    .lineLimit(2)
            }

            if let env = srv.env, !env.isEmpty {
                Text("Redacted env keys: \(env.joined(separator: ", "))")
                    .font(.caption2)
                    .foregroundStyle(palette.muted)
            }

            if let headers = srv.headers, !headers.isEmpty {
                Text("Redacted headers: \(headers.joined(separator: ", "))")
                    .font(.caption2)
                    .foregroundStyle(palette.muted)
            }

            if let reason = srv.reason, !reason.isEmpty {
                Text(reason)
                    .font(.caption2)
                    .foregroundStyle(palette.amber)
            }

            if let path = srv.source.path, !path.isEmpty {
                Text(path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(palette.muted)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }

    private func stateColor(_ state: String) -> Color {
        switch state {
        case "active": return palette.green
        case "disabled": return palette.amber
        default: return palette.muted
        }
    }

    private func loadMcp() async {
        guard let client = store.activeClient else { return }
        if response == nil { isLoading = true }
        defer { isLoading = false }
        do {
            response = try await client.fetchMcp()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggleServer(_ srv: McpServerItem, enabled: Bool) async {
        guard let client = store.activeClient else { return }
        togglingId = srv.id
        defer { togglingId = nil }
        do {
            response = try await client.mcpAction(
                action: enabled ? "enable" : "disable",
                name: srv.name,
                projectId: srv.project?.id
            )
            store.showToast("\(enabled ? "Enabled" : "Disabled") \(srv.name)")
            store.notificationManager.triggerHaptic(.selection)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}

// MARK: - Plugins Manager

public struct PluginsAdminView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var response: PluginsResponse?
    @State private var installSpec: String = ""
    @State private var installScope: String = "user"
    @State private var searchText: String = ""
    @State private var isLoading = false
    @State private var busyPluginId: String?
    @State private var confirmUninstallPlugin: PluginItem?
    @State private var errorMessage: String?

    public init(store: AppStore) {
        self.store = store
    }

    private var installedIds: Set<String> {
        Set((response?.plugins ?? []).map { $0.id.lowercased() })
    }

    private var filteredInstalled: [PluginItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return (response?.plugins ?? []).filter {
            q.isEmpty || $0.id.lowercased().contains(q) || ($0.description?.lowercased().contains(q) ?? false)
        }
    }

    private var filteredAvailable: [AvailablePlugin] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return (response?.available ?? []).filter { avail in
            !installedIds.contains(avail.id.lowercased())
                && (q.isEmpty || avail.id.lowercased().contains(q) || avail.description.lowercased().contains(q))
        }
    }

    public var body: some View {
        List {
            if let errorMessage {
                Section {
                    Text(errorMessage).font(.caption).foregroundStyle(palette.red)
                }
            }

            Section("Install Plugin") {
                TextField("name@marketplace or owner/repo", text: $installSpec)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Picker("Scope", selection: $installScope) {
                    Text("User").tag("user")
                    Text("Project").tag("project")
                }
                .pickerStyle(.segmented)

                Button {
                    let spec = installSpec.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !spec.isEmpty {
                        Task {
                            await runPluginAction("install", id: spec, scope: installScope)
                            installSpec = ""
                        }
                    }
                } label: {
                    if busyPluginId == installSpec.trimmingCharacters(in: .whitespacesAndNewlines) && !installSpec.isEmpty {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("Installing…")
                        }
                    } else {
                        Label("Install Plugin", systemImage: "square.and.arrow.down")
                    }
                }
                .disabled(!store.canPerformMutatingActions || installSpec.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busyPluginId != nil)
            }
            .listRowBackground(palette.card)

            if isLoading && response == nil {
                Section {
                    SkeletonListPlaceholder(count: 4).listRowBackground(Color.clear)
                }
            } else {
                Section("Installed (\(filteredInstalled.count))") {
                    if filteredInstalled.isEmpty {
                        Text("No installed plugins match.")
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                            .listRowBackground(palette.card)
                    } else {
                        ForEach(filteredInstalled) { plugin in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(plugin.id)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(palette.foreground)
                                        HStack(spacing: 8) {
                                            if let ver = plugin.version, !ver.isEmpty {
                                                Text("v\(ver)")
                                            }
                                            if let scope = plugin.scope, !scope.isEmpty {
                                                Text(scope)
                                            }
                                        }
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(palette.muted)
                                    }
                                    Spacer()
                                    if busyPluginId == plugin.id {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Toggle("", isOn: Binding(
                                            get: { plugin.enabled },
                                            set: { next in
                                                Task { await runPluginAction(next ? "enable" : "disable", id: plugin.id, scope: nil) }
                                            }
                                        ))
                                        .labelsHidden()
                                        .disabled(!store.canPerformMutatingActions || busyPluginId != nil)
                                    }
                                }

                                if let desc = plugin.description, !desc.isEmpty {
                                    Text(desc)
                                        .font(.caption2)
                                        .foregroundStyle(palette.muted)
                                }

                                HStack {
                                    Spacer()
                                    Button(role: .destructive) {
                                        confirmUninstallPlugin = plugin
                                    } label: {
                                        Label("Uninstall", systemImage: "trash")
                                            .font(.caption2.weight(.semibold))
                                    }
                                    .buttonStyle(.borderless)
                                    .disabled(!store.canPerformMutatingActions || busyPluginId != nil)
                                }
                            }
                            .padding(.vertical, 3)
                            .listRowBackground(palette.card)
                        }
                    }
                }

                if !filteredAvailable.isEmpty {
                    Section("Discoverable Plugins (\(filteredAvailable.count))") {
                        ForEach(filteredAvailable) { avail in
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(avail.id)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(palette.foreground)
                                    if !avail.description.isEmpty {
                                        Text(avail.description)
                                            .font(.caption2)
                                            .foregroundStyle(palette.muted)
                                            .lineLimit(3)
                                    }
                                }
                                Spacer()
                                if busyPluginId == avail.id {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Button("Install") {
                                        Task { await runPluginAction("install", id: avail.id, scope: installScope) }
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    .disabled(!store.canPerformMutatingActions || busyPluginId != nil)
                                }
                            }
                            .padding(.vertical, 3)
                            .listRowBackground(palette.card)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .searchable(text: $searchText, prompt: "Search plugins…")
        .navigationTitle("Plugins")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await loadPlugins() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
        .refreshable {
            await loadPlugins()
        }
        .task {
            await loadPlugins()
        }
        .confirmationDialog(
            "Uninstall Plugin",
            isPresented: Binding(
                get: { confirmUninstallPlugin != nil },
                set: { if !$0 { confirmUninstallPlugin = nil } }
            ),
            presenting: confirmUninstallPlugin
        ) { plugin in
            Button("Uninstall \(plugin.id)", role: .destructive) {
                Task { await runPluginAction("uninstall", id: plugin.id, scope: nil) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func loadPlugins() async {
        guard let client = store.activeClient else { return }
        if response == nil { isLoading = true }
        defer { isLoading = false }
        do {
            response = try await client.fetchPlugins()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func runPluginAction(_ action: String, id: String, scope: String?) async {
        guard let client = store.activeClient else { return }
        busyPluginId = id
        defer { busyPluginId = nil }
        do {
            response = try await client.pluginAction(action: action, id: id, scope: scope)
            store.showToast("Plugin \(action) complete: \(id)")
            store.notificationManager.triggerHaptic(.success)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}

// MARK: - CLI Tools & Background Jobs

public struct CliToolsAdminView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var catalog: [String: CliToolCatalogEntry] = [:]
    @State private var jobsById: [String: CliJob] = [:]
    @State private var jobOrder: [String] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    @State private var selectedToolId: String = ""
    @State private var selectedActionId: String = ""
    @State private var stringValues: [String: String] = [:]
    @State private var boolValues: [String: Bool] = [:]
    @State private var intValues: [String: Int] = [:]
    @State private var cwdInput: String = ""
    @State private var showFolderPicker = false
    @State private var pendingConfirmation: String?
    @State private var inspectingJob: CliJob?
    @State private var pollTask: Task<Void, Never>?

    public init(store: AppStore) {
        self.store = store
    }

    private var sortedToolIds: [String] {
        catalog.keys.sorted { (catalog[$0]?.title ?? $0) < (catalog[$1]?.title ?? $1) }
    }

    private var currentTool: CliToolCatalogEntry? {
        catalog[selectedToolId]
    }

    private var sortedActionIds: [String] {
        (currentTool?.actions.keys.sorted()) ?? []
    }

    private var currentAction: CliToolAction? {
        currentTool?.actions[selectedActionId]
    }

    private var orderedJobs: [CliJob] {
        jobOrder.compactMap { jobsById[$0] }
    }

    public var body: some View {
        List {
            if let errorMessage {
                Section {
                    Text(errorMessage).font(.caption).foregroundStyle(palette.red)
                }
            }

            if isLoading && catalog.isEmpty {
                Section {
                    SkeletonListPlaceholder(count: 4).listRowBackground(Color.clear)
                }
            } else if !catalog.isEmpty {
                Section("Run OMP CLI Tool") {
                    Picker("Tool", selection: $selectedToolId) {
                        ForEach(sortedToolIds, id: \.self) { id in
                            Text(catalog[id]?.title ?? id).tag(id)
                        }
                    }
                    .onChange(of: selectedToolId) { _, _ in
                        syncDefaultActionAndFields()
                    }

                    if let desc = currentTool?.description, !desc.isEmpty {
                        Text(desc)
                            .font(.caption2)
                            .foregroundStyle(palette.muted)
                    }

                    if !sortedActionIds.isEmpty {
                        Picker("Action", selection: $selectedActionId) {
                            ForEach(sortedActionIds, id: \.self) { act in
                                Text(currentTool?.actions[act]?.label ?? act).tag(act)
                            }
                        }
                        .onChange(of: selectedActionId) { _, _ in
                            resetFieldValues()
                        }
                    }

                    if let action = currentAction {
                        Text(action.command)
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.accent)

                        ForEach(action.fields) { field in
                            fieldEditor(field)
                        }

                        if action.cwd != nil {
                            HStack {
                                TextField(action.cwd == "required" ? "Working directory (required)" : "Working directory (optional)", text: $cwdInput)
                                    .font(.caption.monospaced())
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                Button {
                                    showFolderPicker = true
                                } label: {
                                    Image(systemName: "folder")
                                }
                                .buttonStyle(.borderless)
                            }
                        }

                        Button {
                            triggerRun(action)
                        } label: {
                            Label("Run \(action.label)", systemImage: "play.fill")
                                .fontWeight(.semibold)
                        }
                        .disabled(!store.canPerformMutatingActions)
                    }
                }
                .listRowBackground(palette.card)
            }

            Section("Recent & Running Jobs (\(orderedJobs.count))") {
                if orderedJobs.isEmpty {
                    Text("No CLI jobs run in this companion session yet.")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                        .listRowBackground(palette.card)
                } else {
                    ForEach(orderedJobs) { job in
                        VStack(alignment: .leading, spacing: 6) {
                            Button {
                                inspectingJob = job
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Circle()
                                            .fill(jobStatusColor(job.status))
                                            .frame(width: 8, height: 8)
                                        Text(job.command ?? "\(job.tool ?? "omp") \(job.action ?? "")")
                                            .font(.caption.monospaced().weight(.semibold))
                                            .foregroundStyle(palette.foreground)
                                            .lineLimit(2)
                                        Spacer()
                                        Text(job.status.uppercased())
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(jobStatusColor(job.status))
                                    }

                                    if let out = job.output, !out.isEmpty {
                                        Text(SGRParser.stripANSI(out))
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(palette.muted)
                                            .lineLimit(3)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)

                            if job.status == "running" {
                                HStack {
                                    ProgressView().controlSize(.mini)
                                    Text("Running…")
                                        .font(.caption2)
                                        .foregroundStyle(palette.amber)
                                    Spacer()
                                    Button("Stop", role: .destructive) {
                                        Task { await stopJob(job) }
                                    }
                                    .font(.caption2.weight(.semibold))
                                    .buttonStyle(.bordered)
                                }
                            }
                        }
                        .padding(.vertical, 3)
                        .listRowBackground(palette.card)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .navigationTitle("OMP CLI Tools")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await pollCli(initial: true)
            pollTask = Task {
                while !Task.isCancelled {
                    let hasRunning = orderedJobs.contains(where: { $0.status == "running" })
                    try? await Task.sleep(nanoseconds: hasRunning ? 1_200_000_000 : 5_000_000_000)
                    guard !Task.isCancelled else { break }
                    await pollCli(initial: false)
                }
            }
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
        .sheet(isPresented: $showFolderPicker) {
            HostDirectoryPickerSheet(store: store, initialPath: cwdInput) { chosen in
                cwdInput = chosen
            }
        }
        .sheet(item: $inspectingJob) { job in
            let liveJob = jobsById[job.id] ?? job
            CliJobOutputSheet(job: liveJob, canMutate: store.canPerformMutatingActions) {
                Task { await stopJob(liveJob) }
            }
        }
        .alert("Confirm Command", isPresented: Binding(
            get: { pendingConfirmation != nil },
            set: { if !$0 { pendingConfirmation = nil } }
        )) {
            Button("Run Command", role: .destructive) {
                pendingConfirmation = nil
                Task { await executeCurrentAction() }
            }
            Button("Cancel", role: .cancel) { pendingConfirmation = nil }
        } message: {
            Text(pendingConfirmation ?? "")
        }
    }

    @ViewBuilder
    private func fieldEditor(_ field: CliToolField) -> some View {
        switch field.type {
        case "bool":
            Toggle(field.label, isOn: Binding(
                get: { boolValues[field.name] ?? field.default?.boolValue ?? false },
                set: { boolValues[field.name] = $0 }
            ))
        case "int":
            let low = field.min ?? 0
            let high = max(low, field.max ?? 1_000_000)
            let val = intValues[field.name] ?? Int(field.default?.doubleValue ?? Double(low))
            Stepper(value: Binding(
                get: { val },
                set: { intValues[field.name] = $0 }
            ), in: low...high) {
                HStack {
                    Text(field.label)
                    Spacer()
                    Text("\(val)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(palette.accent)
                }
            }
        case "select":
            let options = field.options ?? []
            Picker(field.label, selection: Binding(
                get: { stringValues[field.name] ?? field.default?.stringValue ?? options.first ?? "" },
                set: { stringValues[field.name] = $0 }
            )) {
                ForEach(options, id: \.self) { opt in
                    Text(opt.isEmpty ? "(Default)" : opt).tag(opt)
                }
            }
        case "model":
            Picker(field.label, selection: Binding(
                get: { stringValues[field.name] ?? "" },
                set: { stringValues[field.name] = $0 }
            )) {
                Text("Default").tag("")
                ForEach(store.availableModels) { m in
                    Text(m.name).tag(m.selector)
                }
            }
        case "session":
            Picker(field.label, selection: Binding(
                get: { stringValues[field.name] ?? "" },
                set: { stringValues[field.name] = $0 }
            )) {
                Text("Select Session…").tag("")
                ForEach(store.nativeSessions.prefix(40)) { s in
                    Text(s.title ?? URL(fileURLWithPath: s.file).lastPathComponent).tag(s.file)
                }
            }
        case "dir":
            TextField(field.placeholder ?? field.label, text: Binding(
                get: { stringValues[field.name] ?? "" },
                set: { stringValues[field.name] = $0 }
            ))
            .font(.caption.monospaced())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        default:
            TextField(
                field.placeholder ?? (field.required == true ? "\(field.label) (required)" : field.label),
                text: Binding(
                    get: { stringValues[field.name] ?? field.default?.stringValue ?? "" },
                    set: { stringValues[field.name] = $0 }
                )
            )
            .font(.callout.monospaced())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
    }

    private func syncDefaultActionAndFields() {
        selectedActionId = sortedActionIds.first ?? ""
        resetFieldValues()
    }

    private func resetFieldValues() {
        stringValues = [:]
        boolValues = [:]
        intValues = [:]
        if let action = currentAction {
            for f in action.fields {
                if let b = f.default?.boolValue { boolValues[f.name] = b }
                if let s = f.default?.stringValue { stringValues[f.name] = s }
                if let d = f.default?.doubleValue { intValues[f.name] = Int(d) }
                if f.type == "select", stringValues[f.name] == nil, let first = f.options?.first {
                    stringValues[f.name] = first
                }
            }
        }
        if cwdInput.isEmpty {
            cwdInput = store.selectedSession?.cwd ?? store.visibleProjects.first?.path ?? ""
        }
    }

    private func triggerRun(_ action: CliToolAction) {
        if let msg = action.confirm {
            if let cond = action.confirmIf {
                if boolValues[cond] == true {
                    pendingConfirmation = msg
                    return
                }
            } else {
                pendingConfirmation = msg
                return
            }
        }
        Task { await executeCurrentAction() }
    }

    private func executeCurrentAction() async {
        guard let client = store.activeClient, let action = currentAction else { return }
        var values: [String: Any] = [:]
        for field in action.fields {
            switch field.type {
            case "bool":
                if boolValues[field.name] == true {
                    values[field.name] = true
                }
            case "int":
                if let val = intValues[field.name] {
                    values[field.name] = val
                }
            default:
                if let raw = stringValues[field.name]?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
                    values[field.name] = raw
                }
            }
        }

        let trimmedCwd = cwdInput.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let job = try await client.runCli(
                tool: selectedToolId,
                action: selectedActionId,
                values: values,
                cwd: (action.cwd != nil && !trimmedCwd.isEmpty) ? trimmedCwd : nil
            )
            jobsById[job.id] = job
            jobOrder.removeAll { $0 == job.id }
            jobOrder.insert(job.id, at: 0)
            store.showToast("Started \(action.label)")
            store.notificationManager.triggerHaptic(.lightTap)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func stopJob(_ job: CliJob) async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.stopCli(id: job.id)
            jobsById[updated.id] = updated
            store.showToast("Stopped job")
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func pollCli(initial: Bool) async {
        guard let client = store.activeClient else { return }
        if initial && catalog.isEmpty { isLoading = true }
        defer { isLoading = false }
        let have = jobOrder.compactMap { id -> String? in
            guard let rev = jobsById[id]?.rev else { return nil }
            return "\(id).\(rev)"
        }
        do {
            let res = try await client.fetchCli(revs: true, have: have, includeCatalog: catalog.isEmpty)
            if let tools = res.tools {
                catalog = tools
                if selectedToolId.isEmpty, let first = tools.keys.sorted().first {
                    selectedToolId = first
                    syncDefaultActionAndFields()
                }
            }
            var nextOrder: [String] = []
            for job in res.jobs {
                nextOrder.append(job.id)
                if job.unchanged == true, let existing = jobsById[job.id] {
                    jobsById[job.id] = existing
                } else {
                    jobsById[job.id] = job
                }
            }
            jobOrder = nextOrder
            errorMessage = nil
        } catch {
            if catalog.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    private func jobStatusColor(_ status: String) -> Color {
        switch status {
        case "running": return palette.amber
        case "done": return palette.green
        default: return palette.red
        }
    }
}

private struct CliJobOutputSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    let job: CliJob
    let canMutate: Bool
    let onStop: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(job.command ?? "omp")
                        .font(.caption.monospaced().weight(.semibold))
                        .foregroundStyle(palette.accent)
                    Text(SGRParser.stripANSI(job.output ?? "(waiting for output…)"))
                        .font(.caption.monospaced())
                        .foregroundStyle(palette.foreground)
                        .textSelection(.enabled)
                }
                .padding()
            }
            .background(palette.codeBackground)
            .navigationTitle("Job Output")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if job.status == "running" {
                        Button("Stop", role: .destructive, action: onStop)
                            .disabled(!canMutate)
                    }
                    #if canImport(UIKit)
                    Button {
                        UIPasteboard.general.string = SGRParser.stripANSI(job.output ?? "")
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    #endif
                }
            }
        }
    }
}

// MARK: - Disk Space & Worktrees Storage Admin

public struct StorageAdminView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var storage: StorageResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var pollTask: Task<Void, Never>?
    @State private var pendingUnsafeRemoval: (sessionID: String?, orphanDir: String?, reason: String)?

    public init(store: AppStore) {
        self.store = store
    }

    public var body: some View {
        List {
            if let err = errorMessage ?? (storage?.error?.isEmpty == false ? storage?.error : nil) {
                Section {
                    Text(err).font(.caption).foregroundStyle(palette.red)
                }
            }

            if let job = storage?.job {
                Section {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Running \(job.kind ?? "scan")…")
                                .font(.caption.weight(.semibold))
                            if let total = job.total, total > 0, let done = job.done {
                                Text("\(done) / \(total) items checked")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.muted)
                            }
                        }
                    }
                    .listRowBackground(palette.amberSoft)
                }
            }

            Section {
                Button {
                    Task { await startScan() }
                } label: {
                    Label(storage?.job != nil ? "Scanning…" : "Scan Disk Space & Worktrees", systemImage: "internaldrive")
                        .fontWeight(.semibold)
                }
                .disabled(!store.canPerformMutatingActions || storage?.job != nil)
                .listRowBackground(palette.card)

                if let scanned = storage?.scannedAt {
                    Text("Last scanned \(CompanionFormatters.relativeDate(scanned))")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                        .listRowBackground(palette.card)
                }
            }

            if let worktrees = storage?.worktrees, !worktrees.isEmpty {
                Section("Session Worktrees (\(worktrees.count))") {
                    ForEach(worktrees) { wt in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(wt.title ?? wt.branch ?? wt.id)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(palette.foreground)
                                Spacer()
                                if let bytes = wt.bytes {
                                    Text(formatBytes(bytes))
                                        .font(.caption.monospacedDigit().weight(.semibold))
                                        .foregroundStyle(palette.accent)
                                }
                            }
                            if let branch = wt.branch {
                                Text(branch)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(palette.muted)
                            }
                            HStack(spacing: 8) {
                                if wt.safe == true {
                                    Text("Safe to remove")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(palette.green)
                                } else {
                                    Text("Dirty: \(wt.dirty ?? 0) · Ahead: \(wt.ahead ?? 0)")
                                        .font(.caption2)
                                        .foregroundStyle(palette.amber)
                                }
                                if let linked = wt.linked, linked > 0 {
                                    Text("(\(formatBytes(linked)) hardlinked)")
                                        .font(.caption2)
                                        .foregroundStyle(palette.muted)
                                }
                            }
                            if let problem = wt.problem ?? wt.error {
                                Text(problem)
                                    .font(.caption2)
                                    .foregroundStyle(palette.red)
                            }
                            HStack(spacing: 12) {
                                Button("Clean Ignored") {
                                    Task { await cleanSession(wt.id) }
                                }
                                .font(.caption.weight(.semibold))
                                .buttonStyle(.bordered)
                                .disabled(!store.canPerformMutatingActions || wt.busy == true || storage?.job != nil)

                                Button("Remove Worktree", role: .destructive) {
                                    if wt.safe == true {
                                        Task { await remove(sessions: [wt.id], confirm: false) }
                                    } else {
                                        pendingUnsafeRemoval = (
                                            wt.id,
                                            nil,
                                            "\(wt.branch ?? "Worktree") has \(wt.dirty ?? 0) uncommitted change(s) and \(wt.ahead ?? 0) commit(s) not merged into \(wt.base ?? "base"). Removing it will discard that work."
                                        )
                                    }
                                }
                                .font(.caption.weight(.semibold))
                                .buttonStyle(.bordered)
                                .disabled(!store.canPerformMutatingActions || wt.busy == true || storage?.job != nil)
                            }
                        }
                        .padding(.vertical, 3)
                        .listRowBackground(palette.card)
                    }
                }
            }

            if let orphans = storage?.orphans, !orphans.isEmpty {
                Section("Orphan Worktree Folders (\(orphans.count))") {
                    ForEach(orphans) { orphan in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(orphan.name ?? URL(fileURLWithPath: orphan.dir).lastPathComponent)
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                if let bytes = orphan.bytes {
                                    Text(formatBytes(bytes))
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(palette.amber)
                                }
                            }
                            Text(orphan.dir)
                                .font(.caption2.monospaced())
                                .foregroundStyle(palette.muted)
                                .lineLimit(2)
                            Button("Remove Orphan Folder", role: .destructive) {
                                if (orphan.dirty ?? 0) > 0 {
                                    pendingUnsafeRemoval = (
                                        nil,
                                        orphan.dir,
                                        "Orphan folder has \(orphan.dirty ?? 0) uncommitted changes."
                                    )
                                } else {
                                    Task { await remove(orphans: [orphan.dir], confirm: false) }
                                }
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.bordered)
                            .disabled(!store.canPerformMutatingActions || storage?.job != nil)
                        }
                        .padding(.vertical, 3)
                        .listRowBackground(palette.card)
                    }
                }
            }

            if let locations = storage?.locations, !locations.isEmpty {
                Section("OMP & Companion Locations") {
                    ForEach(locations) { loc in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(loc.label)
                                    .font(.subheadline)
                                if let path = loc.path {
                                    Text(path)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(palette.muted)
                                        .lineLimit(1)
                                }
                            }
                            Spacer()
                            Text(loc.missing == true ? "Empty" : formatBytes(loc.bytes ?? 0))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(palette.muted)
                        }
                        .listRowBackground(palette.card)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .navigationTitle("Disk Space & Worktrees")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadStorage()
            pollTask = Task {
                while !Task.isCancelled {
                    let delayNs: UInt64 = storage?.job != nil ? 1_200_000_000 : 6_000_000_000
                    try? await Task.sleep(nanoseconds: delayNs)
                    guard !Task.isCancelled else { break }
                    if storage?.job != nil {
                        await loadStorage()
                    }
                }
            }
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
        .alert("Remove Worktree With Unmerged Changes?", isPresented: Binding(
            get: { pendingUnsafeRemoval != nil },
            set: { if !$0 { pendingUnsafeRemoval = nil } }
        )) {
            Button("Remove Anyway", role: .destructive) {
                if let p = pendingUnsafeRemoval {
                    Task {
                        await remove(
                            sessions: p.sessionID.map { [$0] } ?? [],
                            orphans: p.orphanDir.map { [$0] } ?? [],
                            confirm: true
                        )
                    }
                }
                pendingUnsafeRemoval = nil
            }
            Button("Cancel", role: .cancel) { pendingUnsafeRemoval = nil }
        } message: {
            Text(pendingUnsafeRemoval?.reason ?? "")
        }
    }

    private func loadStorage() async {
        guard let client = store.activeClient else { return }
        if storage == nil { isLoading = true }
        defer { isLoading = false }
        do {
            storage = try await client.fetchStorage()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startScan() async {
        guard let client = store.activeClient else { return }
        do {
            storage = try await client.scanStorage()
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func cleanSession(_ id: String) async {
        guard let client = store.activeClient else { return }
        do {
            storage = try await client.cleanWorktrees(sessions: [id])
            store.showToast("Cleaning ignored files in worktree")
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func remove(sessions: [String] = [], orphans: [String] = [], confirm: Bool) async {
        guard let client = store.activeClient else { return }
        do {
            storage = try await client.removeWorktrees(sessions: sessions, orphans: orphans, confirm: confirm)
            store.showToast("Removing selected worktree")
            await store.forceSync()
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func formatBytes(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

// MARK: - OMP Updates & Host Power / Restart Controls

public struct SystemPowerAdminView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var updateState: UpdateStateResponse?
    @State private var tailscaleInfo: TailscaleInfoResponse?
    @State private var isLoading = false
    @State private var pollTask: Task<Void, Never>?
    @State private var confirmRestart = false
    @State private var confirmShutdown = false

    public init(store: AppStore) {
        self.store = store
    }

    public var body: some View {
        List {
            Section("OMP CLI & SDK Updates") {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Status: \(updateState?.status.capitalized ?? "Unknown")")
                            .font(.subheadline.weight(.semibold))
                        if let finished = updateState?.finishedAt {
                            Text("Last run \(CompanionFormatters.relativeDate(finished))")
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                        }
                    }
                    Spacer()
                    if updateState?.status == "running" {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Check & Update") {
                            Task { await triggerUpdate() }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(palette.accent)
                        .disabled(!store.canPerformMutatingActions)
                    }
                }
                .listRowBackground(palette.card)

                if let err = updateState?.error, !err.isEmpty {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(palette.red)
                        .listRowBackground(palette.redSoft)
                }

                if let output = updateState?.output, !output.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(SGRParser.stripANSI(output))
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.foreground)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 160)
                    .listRowBackground(palette.codeBackground)
                }
            }

            if let ts = tailscaleInfo ?? store.lastTailscaleInfo {
                Section("Tailscale & Host Network Diagnostics") {
                    if let magic = ts.tailscale?.name, !magic.isEmpty {
                        LabeledContent("MagicDNS", value: magic)
                    }
                    if let port = ts.port {
                        LabeledContent("Listening Port", value: String(port))
                    }
                    ForEach(ts.tailnetUrls, id: \.self) { url in
                        HStack {
                            Text(url)
                                .font(.caption.monospaced())
                            Spacer()
                            #if canImport(UIKit)
                            Button {
                                UIPasteboard.general.string = url
                                store.showToast("Copied Tailscale URL")
                            } label: {
                                Image(systemName: "doc.on.doc")
                            }
                            .buttonStyle(.borderless)
                            #endif
                        }
                    }
                }
                .listRowBackground(palette.card)
            }

            Section {
                Toggle("Shut Down PC When All Work Finishes", isOn: Binding(
                    get: { store.snapshot.autoShutdown?.on == true },
                    set: { next in Task { await store.setAutoShutdown(on: next) } }
                ))
                .disabled(!store.canPerformMutatingActions)
                .listRowBackground(palette.card)

                if let autoErr = store.snapshot.autoShutdown?.error?.message, !autoErr.isEmpty {
                    Text(autoErr)
                        .font(.caption)
                        .foregroundStyle(palette.red)
                        .listRowBackground(palette.redSoft)
                }

                Button {
                    confirmRestart = true
                } label: {
                    Label("Restart Companion Process", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(!store.canPerformMutatingActions || store.snapshot.canRestart != true)
                .listRowBackground(palette.card)

                if store.snapshot.canRestart != true {
                    Text("Restart requires launching the companion via the desktop app or start.bat/start.command wrapper.")
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                        .listRowBackground(palette.card)
                }

                Button(role: .destructive) {
                    confirmShutdown = true
                } label: {
                    Label("Shut Down Host Computer", systemImage: "power")
                }
                .disabled(!store.canPerformMutatingActions)
                .listRowBackground(palette.card)
            } header: {
                Text("Host Power & Lifecycle")
            } footer: {
                Text("Restarting pauses active sessions first and resumes them automatically when the companion returns. Shutting down pauses and saves all sessions before issuing the host power-off command.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .navigationTitle("Updates & Host Power")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadAll()
            pollTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard !Task.isCancelled else { break }
                    if updateState?.status == "running" {
                        await loadUpdateState()
                    }
                }
            }
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
        .alert("Restart Companion?", isPresented: $confirmRestart) {
            Button("Restart Companion", role: .destructive) {
                Task { await store.restartCompanionHost() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Active turns will be paused cleanly and automatically resumed once the companion relaunches.")
        }
        .alert("Shut Down Host Computer?", isPresented: $confirmShutdown) {
            Button("Shut Down Now", role: .destructive) {
                Task { await store.shutdownCompanionHost() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will power off the remote companion computer over Tailscale after pausing active sessions.")
        }
    }

    private func loadAll() async {
        await loadUpdateState()
        if let client = store.activeClient, let ts = try? await client.fetchTailscaleInfo() {
            tailscaleInfo = ts
        }
    }

    private func loadUpdateState() async {
        guard let client = store.activeClient else { return }
        isLoading = true
        defer { isLoading = false }
        if let state = try? await client.fetchUpdateState() {
            updateState = state
        }
    }

    private func triggerUpdate() async {
        guard let client = store.activeClient else { return }
        do {
            updateState = try await client.startOmpUpdate()
            store.showToast("Started OMP update check")
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}
