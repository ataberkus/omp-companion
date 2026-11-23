import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

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
                                .accessibilityLabel("Browse folders")
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
            store.showToast(String(localized: "Started \(action.label)", bundle: .main))
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
            store.showToast(String(localized: "Stopped job", bundle: .main))
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
                    .accessibilityLabel("Copy output")
                    #endif
                }
            }
        }
    }
}
