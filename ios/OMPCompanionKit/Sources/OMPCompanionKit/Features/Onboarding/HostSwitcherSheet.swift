import SwiftUI

public struct HostSwitcherSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var editingHost: HostProfile?
    @State private var hostPendingDelete: HostProfile?
    @State private var showAddHost = false

    public init(store: AppStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            List {
                if store.hosts.isEmpty {
                    Section {
                        OMPEmptyStateView(
                            systemImage: "network.badge.shield.half.filled",
                            title: "No Companion Hosts Saved",
                            message: "Add your desktop or workstation running OMP Control Room over Tailscale.",
                            actionTitle: "Add Companion Host"
                        ) {
                            showAddHost = true
                        }
                        .listRowBackground(Color.clear)
                    }
                } else {
                    Section {
                        ForEach(store.hosts) { host in
                            hostRow(host)
                        }
                    } header: {
                        Text("Saved Tailscale Hosts")
                    } footer: {
                        Text("Bearer tokens and remote passwords are stored in the iOS Keychain for each host.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .navigationTitle("Companion Hosts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        Task { await store.probeAllHosts() }
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    .accessibilityLabel("Probe all hosts")

                    Button {
                        showAddHost = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add companion host")
                }
            }
            .task {
                await store.probeAllHosts()
            }
            .sheet(isPresented: $showAddHost) {
                HostSetupView(store: store)
            }
            .sheet(item: $editingHost) { host in
                HostSetupView(store: store, editingHost: host)
            }
            .confirmationDialog(
                "Remove Host?",
                isPresented: Binding(
                    get: { hostPendingDelete != nil },
                    set: { if !$0 { hostPendingDelete = nil } }
                ),
                presenting: hostPendingDelete
            ) { host in
                Button("Remove \(host.name)", role: .destructive) {
                    Task { await store.deleteHost(host.id) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { host in
                Text("Deletes \(host.name) and removes its credential from the iOS Keychain.")
            }
        }
    }

    @ViewBuilder
    private func hostRow(_ host: HostProfile) -> some View {
        let isActive = store.activeHost?.id == host.id
        let reach = store.reachabilityByHost[host.id] ?? .unknown

        Button {
            Task {
                await store.selectHost(host.id)
                store.notificationManager.triggerHaptic(.selection)
                dismiss()
            }
        } label: {
            HStack(spacing: 12) {
                reachabilityDot(reach)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(host.name)
                            .font(.body.weight(isActive ? .semibold : .medium))
                            .foregroundStyle(palette.foreground)
                            .lineLimit(1)

                        if isActive {
                            Text("ACTIVE")
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(palette.accentSoft, in: Capsule())
                                .foregroundStyle(palette.accent)
                        }
                    }

                    Text(host.hostDisplay)
                        .font(.caption.monospaced())
                        .foregroundStyle(palette.muted)
                        .lineLimit(1)

                    HStack(spacing: 8) {
                        Text(host.endpointKind.badge)
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(
                                (host.endpointKind.isTailscale ? palette.greenSoft : palette.amberSoft),
                                in: Capsule()
                            )
                            .foregroundStyle(host.endpointKind.isTailscale ? palette.green : palette.amber)

                        Text(reachabilityLabel(reach, host: host))
                            .font(.caption2)
                            .foregroundStyle(reachabilityColor(reach))
                            .lineLimit(1)
                    }
                }

                Spacer()

                if isActive {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(palette.accent)
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .minTouchTarget()
        .listRowBackground(palette.card)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                hostPendingDelete = host
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button {
                editingHost = host
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            .tint(palette.accent)
        }
        .contextMenu {
            Button {
                Task { await store.probeHost(host.id) }
            } label: {
                Label("Test Reachability", systemImage: "bolt.horizontal")
            }
            Button {
                editingHost = host
            } label: {
                Label("Edit Host & Token", systemImage: "pencil")
            }
            Divider()
            Button(role: .destructive) {
                hostPendingDelete = host
            } label: {
                Label("Remove Host", systemImage: "trash")
            }
        }
    }

    @ViewBuilder
    private func reachabilityDot(_ reach: HostReachability) -> some View {
        switch reach {
        case .checking:
            ProgressView()
                .controlSize(.small)
                .frame(width: 12, height: 12)
        case .reachable:
            Circle()
                .fill(palette.green)
                .frame(width: 10, height: 10)
        case .unreachable:
            Circle()
                .fill(palette.red)
                .frame(width: 10, height: 10)
        case .unknown:
            Circle()
                .fill(palette.muted.opacity(0.4))
                .frame(width: 10, height: 10)
        }
    }

    private func reachabilityLabel(_ reach: HostReachability, host: HostProfile) -> String {
        switch reach {
        case .unknown:
            if let ms = host.lastLatencyMs { return "Last \(ms) ms" }
            return "Not checked"
        case .checking:
            return "Checking…"
        case .reachable(let ms):
            return "\(ms) ms"
        case .unreachable(let msg):
            return msg
        }
    }

    private func reachabilityColor(_ reach: HostReachability) -> Color {
        switch reach {
        case .reachable: return palette.green
        case .unreachable: return palette.red
        case .checking, .unknown: return palette.muted
        }
    }
}
