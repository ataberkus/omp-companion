import SwiftUI

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
                                                    .accessibilityHidden(true)
                                            }
                                        }
                                        .padding(.vertical, 4)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityAddTraits(isChosen ? .isSelected : [])
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
                        title: String(localized: "No Multi-Account Providers", bundle: .main),
                        message: String(localized: "Authenticated providers with switchable OAuth accounts appear here.", bundle: .main)
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
                .accessibilityLabel("Refresh accounts")
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
            store.showToast(String(localized: "Selected \(account) for \(provider)", bundle: .main))
            store.notificationManager.triggerHaptic(.selection)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}
