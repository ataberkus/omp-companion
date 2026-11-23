import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

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
    @State private var isUpdatingApp = false

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
                                store.showToast(String(localized: "Copied Tailscale URL", bundle: .main))
                            } label: {
                                Image(systemName: "doc.on.doc")
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Copy URL")
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

                if store.snapshot.canAppUpdate == true {
                    Button {
                        Task {
                            isUpdatingApp = true
                            await store.updateDesktopApp()
                            isUpdatingApp = false
                        }
                    } label: {
                        HStack {
                            Label("Update Desktop App", systemImage: "arrow.down.app")
                            Spacer()
                            if isUpdatingApp {
                                ProgressView().controlSize(.small)
                            } else if let version = store.snapshot.appVersion, !version.isEmpty {
                                Text(version)
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(palette.muted)
                            }
                        }
                    }
                    .disabled(!store.canPerformMutatingActions || isUpdatingApp)
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
            store.showToast(String(localized: "Started OMP update check", bundle: .main))
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}
