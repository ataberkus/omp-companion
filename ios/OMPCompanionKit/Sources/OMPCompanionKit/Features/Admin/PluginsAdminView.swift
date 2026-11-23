import SwiftUI

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
                .accessibilityLabel("Refresh plugins")
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
            store.showToast(String(localized: "Plugin \(action) complete: \(id)", bundle: .main))
            store.notificationManager.triggerHaptic(.success)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}
