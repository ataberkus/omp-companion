import SwiftUI

// MARK: - Disk Space & Worktrees Storage Admin

public struct StorageAdminView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    @State private var storage: StorageResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var pollTask: Task<Void, Never>?
    @State private var pendingUnsafeRemoval: (sessionID: String?, orphanDir: String?, reason: String)?
    @State private var confirmClearAttachments = false

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
                            if loc.clearable == true {
                                Button("Clear", role: .destructive) {
                                    confirmClearAttachments = true
                                }
                                .font(.caption.weight(.semibold))
                                .buttonStyle(.bordered)
                                .disabled(!store.canPerformMutatingActions || storage?.job != nil || loc.missing == true || (loc.bytes ?? 0) == 0)
                                .accessibilityLabel("Clear all PDF and video attachments")
                            }
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
        .alert("Delete Every Stored Attachment?", isPresented: $confirmClearAttachments) {
            Button("Delete Attachments", role: .destructive) {
                Task { await clearAttachments() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            let size = storage?.locations.first(where: { $0.clearable == true })?.bytes ?? 0
            Text(size > 0
                ? "Deletes every PDF and video sent from the dashboard (\(formatBytes(size))). Messages keep their PDF chips and video lines, but the files can no longer be opened, and OMP can no longer read them when a message is retried. Attachments waiting in a queued message are kept."
                : "Deletes every PDF and video sent from the dashboard. Messages keep their PDF chips and video lines, but the files can no longer be opened, and OMP can no longer read them when a message is retried. Attachments waiting in a queued message are kept.")
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
            store.showToast(String(localized: "Cleaning ignored files in worktree", bundle: .main))
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func remove(sessions: [String] = [], orphans: [String] = [], confirm: Bool) async {
        guard let client = store.activeClient else { return }
        do {
            storage = try await client.removeWorktrees(sessions: sessions, orphans: orphans, confirm: confirm)
            store.showToast(String(localized: "Removing selected worktree", bundle: .main))
            await store.forceSync()
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func clearAttachments() async {
        guard let client = store.activeClient else { return }
        do {
            let result = try await client.clearAttachments()
            storage = result
            if let cleared = result.cleared {
                store.showToast(cleared.count == 1
                    ? String(localized: "Cleared 1 attachment · freed \(formatBytes(cleared.freed))", bundle: .main)
                    : String(localized: "Cleared \(cleared.count) attachments · freed \(formatBytes(cleared.freed))", bundle: .main))
            }
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func formatBytes(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
