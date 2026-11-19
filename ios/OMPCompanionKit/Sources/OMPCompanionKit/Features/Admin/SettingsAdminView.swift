import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct SettingsAdminView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    private enum AdminDestination: String, Hashable, CaseIterable {
        case spend
        case accounts
        case settings
        case mcp
        case plugins
        case tools
        case storage
        case system
    }

    @State private var navPath: [AdminDestination] = []
    @State private var showAddHost = false
    @State private var editingHost: HostProfile?

    public init(store: AppStore) {
        self.store = store
    }

    private let editorChoices: [(id: String, label: String)] = [
        ("auto", "Automatic"),
        ("vscode", "VS Code"),
        ("vscode-insiders", "VS Code Insiders"),
        ("cursor", "Cursor"),
        ("windsurf", "Windsurf"),
        ("reveal", "Show in Folder"),
    ]

    public var body: some View {
        NavigationStack(path: $navPath) {
            List {
                // 1. App Appearance, Biometrics & Notifications
                Section("App & Security") {
                    Picker("Theme", selection: $store.themePreference) {
                        ForEach(ThemePreference.allCases) { theme in
                            Text(theme.label).tag(theme)
                        }
                    }
                    .listRowBackground(palette.card)

                    Toggle(isOn: Binding(
                        get: { store.biometricLock.isEnabled },
                        set: { next in
                            store.biometricLock.isEnabled = next
                            store.notificationManager.triggerHaptic(.selection)
                        }
                    )) {
                        Label(
                            "\(store.biometricLock.biometryDisplayName) Lock & Privacy Blur",
                            systemImage: store.biometricLock.biometrySystemImage
                        )
                    }
                    .disabled(!store.biometricLock.canUseDeviceAuthentication)
                    .listRowBackground(palette.card)

                    if store.biometricLock.isEnabled {
                        Button {
                            store.biometricLock.lockNow()
                            dismiss()
                        } label: {
                            Label("Lock App Now", systemImage: "lock.fill")
                        }
                        .listRowBackground(palette.card)
                    }

                    Toggle("Attention Notifications", isOn: $store.notificationManager.notificationsEnabled)
                        .listRowBackground(palette.card)

                    if store.notificationManager.authorizationStatus == .notDetermined {
                        Button {
                            Task { _ = await store.notificationManager.requestAuthorization() }
                        } label: {
                            Label("Allow Notification Permissions", systemImage: "bell.badge")
                                .foregroundStyle(palette.accent)
                        }
                        .listRowBackground(palette.card)
                    } else if store.notificationManager.authorizationStatus == .denied {
                        HStack {
                            Text("System notification permission is denied in iOS Settings.")
                                .font(.caption)
                                .foregroundStyle(palette.amber)
                            Spacer()
                            #if canImport(UIKit)
                            Button("Open iOS Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) {
                                    UIApplication.shared.open(url)
                                }
                            }
                            .font(.caption.weight(.semibold))
                            #endif
                        }
                        .listRowBackground(palette.card)
                    }

                    Toggle("Haptic Feedback", isOn: $store.notificationManager.hapticsEnabled)
                        .listRowBackground(palette.card)
                }

                // 2. Saved Tailscale Companion Hosts
                Section {
                    ForEach(store.hosts) { host in
                        HStack(spacing: 10) {
                            hostDot(for: host)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(host.name)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(palette.foreground)
                                    Text(host.endpointKind.badge)
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 1)
                                        .background(palette.raised, in: Capsule())
                                        .foregroundStyle(host.endpointKind.isTailscale ? palette.green : palette.amber)
                                }
                                Text(host.baseURL)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(palette.muted)
                                    .lineLimit(1)
                            }
                            Spacer()
                            if host.id == store.activeHostID {
                                Text("Active")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(palette.green)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if host.id != store.activeHostID {
                                Task { await store.selectHost(host.id) }
                            } else {
                                editingHost = host
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button("Edit") {
                                editingHost = host
                            }
                            .tint(palette.accent)

                            Button("Delete", role: .destructive) {
                                Task { await store.deleteHost(host.id) }
                            }
                        }
                        .listRowBackground(palette.card)
                    }

                    Button {
                        showAddHost = true
                    } label: {
                        Label("Add Companion Host", systemImage: "plus.circle.fill")
                            .foregroundStyle(palette.accent)
                    }
                    .listRowBackground(palette.card)

                    if let ts = store.lastTailscaleInfo, let magic = ts.tailscale?.name, !magic.isEmpty {
                        HStack {
                            Text("Active Host MagicDNS")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                            Spacer()
                            Text(magic)
                                .font(.caption.monospaced())
                                .foregroundStyle(palette.foreground)
                        }
                        .listRowBackground(palette.card)
                    }
                } header: {
                    Text("Tailscale Companion Hosts")
                } footer: {
                    Text("Credentials are stored in iOS Keychain and protected from app-switcher previews when biometric lock is enabled.")
                }

                // 3. Host Dashboard & Enhance Preferences
                if store.activeHost != nil {
                    Section("Host Dashboard Preferences") {
                        Picker("Open Files In", selection: Binding(
                            get: { store.snapshot.editor ?? "auto" },
                            set: { next in Task { await store.setHostEditor(next) } }
                        )) {
                            ForEach(editorChoices, id: \.id) { choice in
                                Text(choice.label).tag(choice.id)
                            }
                        }
                        .disabled(!store.canPerformMutatingActions)
                        .listRowBackground(palette.card)

                        Picker("Prompt Enhance Mode", selection: Binding(
                            get: { store.snapshot.enhanceMode ?? "full" },
                            set: { next in Task { await store.setHostEnhanceMode(next) } }
                        )) {
                            ForEach(EnhanceMode.allCases) { mode in
                                Text(mode.title).tag(mode.rawValue)
                            }
                        }
                        .disabled(!store.canPerformMutatingActions)
                        .listRowBackground(palette.card)

                        if let adv = store.advisorConfig {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Advisor Config")
                                        .font(.subheadline)
                                    Text(adv.source)
                                        .font(.caption2)
                                        .foregroundStyle(palette.muted)
                                }
                                Spacer()
                                Text(adv.model.isEmpty ? "Not set" : adv.model)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(adv.enabled ? palette.violet : palette.muted)
                                    .lineLimit(1)
                            }
                            .listRowBackground(palette.card)
                        }
                    }
                }

                // 4. Control Room & Host Administration Subpages
                Section("Spend, Accounts & Configuration") {
                    adminNavRow(
                        destination: .spend,
                        title: "Spend & Usage Charts",
                        subtitle: "Swift Charts daily & model cost breakdowns",
                        icon: "chart.bar.xaxis",
                        tint: palette.green
                    )
                    adminNavRow(
                        destination: .accounts,
                        title: "Accounts & Rate Limits",
                        subtitle: "OAuth accounts and live quota windows",
                        icon: "person.2.badge.key",
                        tint: palette.accent
                    )
                    adminNavRow(
                        destination: .settings,
                        title: "OMP Settings",
                        subtitle: "Searchable config schema with redacted secrets",
                        icon: "slider.horizontal.3",
                        tint: palette.violet
                    )
                    adminNavRow(
                        destination: .mcp,
                        title: "MCP Servers",
                        subtitle: "Inspect user & project servers, toggle state",
                        icon: "cable.connector",
                        tint: palette.cyan
                    )
                    adminNavRow(
                        destination: .plugins,
                        title: "Plugins",
                        subtitle: "Install, enable, disable, and manage plugins",
                        icon: "puzzlepiece.extension",
                        tint: palette.amber
                    )
                }

                Section("Tools, Disk Space & Host Lifecycle") {
                    adminNavRow(
                        destination: .tools,
                        title: "OMP CLI Tools & Jobs",
                        subtitle: "Run structured OMP CLI actions & stream logs",
                        icon: "wrench.and.screwdriver",
                        tint: palette.accent
                    )
                    adminNavRow(
                        destination: .storage,
                        title: "Disk Space & Worktrees",
                        subtitle: "Scan worktrees, clean ignored files, prune orphans",
                        icon: "internaldrive",
                        tint: palette.amber
                    )
                    adminNavRow(
                        destination: .system,
                        title: "OMP Updates & Host Power",
                        subtitle: store.snapshot.autoShutdown?.on == true
                            ? "Auto-shutdown armed · Restart & update controls"
                            : "Update OMP, auto-shutdown, restart & power off",
                        icon: "power",
                        tint: palette.red
                    )
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .navigationTitle("Settings & Admin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(for: AdminDestination.self) { dest in
                switch dest {
                case .spend:
                    SpendChartsView(store: store)
                case .accounts:
                    ProviderAccountsAdminView(store: store)
                case .settings:
                    OmpSettingsAdminView(store: store)
                case .mcp:
                    McpServersAdminView(store: store)
                case .plugins:
                    PluginsAdminView(store: store)
                case .tools:
                    CliToolsAdminView(store: store)
                case .storage:
                    StorageAdminView(store: store)
                case .system:
                    SystemPowerAdminView(store: store)
                }
            }
            .onAppear {
                if let raw = store.settingsInitialSection,
                   let dest = AdminDestination(rawValue: raw) {
                    navPath = [dest]
                    store.settingsInitialSection = nil
                }
            }
            .sheet(isPresented: $showAddHost) {
                HostSetupView(store: store)
            }
            .sheet(item: $editingHost) { host in
                HostSetupView(store: store, editingHost: host)
            }
        }
    }

    @ViewBuilder
    private func adminNavRow(
        destination: AdminDestination,
        title: String,
        subtitle: String,
        icon: String,
        tint: Color
    ) -> some View {
        NavigationLink(value: destination) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 28, height: 28)
                    .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 7))

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(palette.foreground)
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 2)
        }
        .disabled(store.activeHost == nil)
        .listRowBackground(palette.card)
    }

    @ViewBuilder
    private func hostDot(for host: HostProfile) -> some View {
        switch store.reachabilityByHost[host.id] {
        case .reachable:
            Circle().fill(palette.green).frame(width: 9, height: 9)
        case .checking:
            ProgressView().controlSize(.mini)
        case .unreachable:
            Circle().fill(palette.red).frame(width: 9, height: 9)
        default:
            Circle().fill(palette.muted.opacity(0.45)).frame(width: 9, height: 9)
        }
    }
}
