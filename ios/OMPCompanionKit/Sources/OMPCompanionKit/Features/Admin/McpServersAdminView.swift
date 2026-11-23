import SwiftUI

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
                        title: String(localized: "No MCP Servers Found", bundle: .main),
                        message: String(localized: "Configure MCP servers in ~/.omp/agent/mcp.json or a project's .mcp.json to manage them here.", bundle: .main)
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
                .accessibilityLabel("Refresh MCP servers")
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
            store.showToast(enabled ? String(localized: "Enabled \(srv.name)", bundle: .main) : String(localized: "Disabled \(srv.name)", bundle: .main))
            store.notificationManager.triggerHaptic(.selection)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}
