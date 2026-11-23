import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// MARK: - Mode Controls, Preferences, Context Actions & Modals

public struct ModeControlsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var planWorkflow: String
    @State private var goalInput: String = ""
    @State private var loopInput: String = ""
    @State private var vibeArgs: String = ""
    @State private var compactInstructions: String = ""
    @State private var handoffInstructions: String = ""
    @State private var bashCommand: String = ""
    @State private var isBusy = false
    @State private var errorMessage: String?

    @State private var showModelPicker = false
    @State private var showAdvisorModelPicker = false
    @State private var showLaunchOptions = false
    @State private var showPlanReview = false
    @State private var showRewindSheet = false
    @State private var showTreeSheet = false
    @State private var showStatsSheet = false
    @State private var showUsageSheet = false
    @State private var showLoginSheet = false
    @State private var confirmFreshSession = false

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
        self._planWorkflow = State(initialValue: session.planMode?.workflow ?? "parallel")
    }

    private var liveSession: SessionSummary {
        store.snapshot.sessions.first(where: { $0.id == session.id }) ?? session
    }

    private var isFastOn: Bool {
        liveSession.prefs?.fast ?? liveSession.fast?.enabled ?? false
    }

    private var isAutoCompactionOn: Bool {
        liveSession.prefs?.autoCompaction ?? liveSession.autoCompaction ?? false
    }

    private var isAutoRetryOn: Bool {
        liveSession.prefs?.autoRetry ?? false
    }

    private var isSlowOn: Bool {
        liveSession.prefs?.slowMode ?? liveSession._slow?.enabled ?? false
    }

    private var steeringMode: String {
        liveSession.prefs?.steeringMode ?? liveSession.modes?.steering ?? "one-at-a-time"
    }

    private var followUpMode: String {
        liveSession.prefs?.followUpMode ?? liveSession.modes?.followUp ?? "one-at-a-time"
    }

    private var interruptMode: String {
        liveSession.prefs?.interruptMode ?? liveSession.modes?.interrupt ?? "immediate"
    }

    private var cacheWarming: String {
        liveSession.prefs?.cacheWarming ?? liveSession._cacheWarming ?? "off"
    }

    public var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                }

                // Model & Thinking
                Section("Model & Reasoning") {
                    Button {
                        showModelPicker = true
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Model")
                                    .font(.subheadline)
                                    .foregroundStyle(palette.foreground)
                                Text(liveSession.effectiveModelSelector ?? liveSession.model ?? "OMP Default")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(palette.muted)
                            }
                            Spacer()
                            if let thinking = liveSession.thinkingChoice ?? liveSession.thinking {
                                Text(thinking)
                                    .font(.caption2.monospaced().weight(.semibold))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(palette.accentSoft, in: Capsule())
                                    .foregroundStyle(palette.accent)
                            }
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                        }
                    }
                    .disabled(!store.canPerformMutatingActions || isBusy)

                    HStack {
                        Button("Cycle Model") {
                            Task { await perform { try await $0.cycleModel(sessionId: liveSession.id) } }
                        }
                        Spacer()
                        Button("Cycle Thinking") {
                            Task { await perform { try await $0.cycleThinking(sessionId: liveSession.id) } }
                        }
                    }
                    .buttonStyle(.borderless)
                    .disabled(!store.canPerformMutatingActions || isBusy)
                }

                // Agent Safety & Modes
                Section("Agent Modes") {
                    Toggle("Auto-Approve Tools & UI", isOn: Binding(
                        get: { liveSession.autoApprove == true },
                        set: { next in Task { await perform { try await $0.setAutoApprove(sessionId: liveSession.id, enabled: next) } } }
                    ))
                    .disabled(!store.canPerformMutatingActions || isBusy)

                    Toggle("Plan Mode", isOn: Binding(
                        get: { liveSession.planMode?.enabled == true },
                        set: { next in
                            Task { await perform { try await $0.setPlanMode(sessionId: liveSession.id, enabled: next, workflow: planWorkflow) } }
                        }
                    ))
                    .disabled(!store.canPerformMutatingActions || isBusy || liveSession.isWorking || liveSession._planSupported == false)

                    if liveSession._planSupported != false {
                        Picker("Plan Workflow", selection: $planWorkflow) {
                            Text("Parallel").tag("parallel")
                            Text("Iterative").tag("iterative")
                        }
                        .onChange(of: planWorkflow) { _, next in
                            if liveSession.planMode?.enabled == true {
                                Task { await perform { try await $0.setPlanMode(sessionId: liveSession.id, enabled: true, workflow: next) } }
                            }
                        }

                        if liveSession.hasPlanReviewPending || liveSession.planMode?.available == true {
                            Button {
                                showPlanReview = true
                            } label: {
                                Label(
                                    liveSession.hasPlanReviewPending ? "Review Pending Plan" : "Open Plan Review",
                                    systemImage: "doc.text.magnifyingglass"
                                )
                                .foregroundStyle(liveSession.hasPlanReviewPending ? palette.amber : palette.accent)
                            }
                        }
                    }

                    // Vibe Mode
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Vibe Mode")
                            Text(liveSession.isVibeActive ? "Active" : "Standard coding mode")
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                        }
                        Spacer()
                        Button(liveSession.isVibeActive ? "Toggle Off" : "Enable /vibe") {
                            Task { await perform { try await $0.toggleVibeMode(sessionId: liveSession.id, args: vibeArgs) } }
                        }
                        .buttonStyle(.bordered)
                        .disabled(!store.canPerformMutatingActions || isBusy)
                    }

                    // Pause Gate Mode
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Pause Mode (/pause)")
                            Text(liveSession.isPauseGateActive ? "Paused via gate" : "Run full-screen pause overlay")
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                        }
                        Spacer()
                        Button(liveSession.isPauseGateActive ? "Resume" : "Pause") {
                            Task { await perform { try await $0.togglePauseMode(sessionId: liveSession.id) } }
                        }
                        .buttonStyle(.bordered)
                        .disabled(!store.canPerformMutatingActions || isBusy)
                    }
                }

                // Goal & Loop Orchestration
                Section("Goal & Loop Control") {
                    if let goal = liveSession.goal {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Active Goal: \(goal.status ?? "running")")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.green)
                            if let obj = goal.objective, !obj.isEmpty {
                                Text(obj)
                                    .font(.caption)
                                    .foregroundStyle(palette.foreground)
                            }
                            if let used = goal.tokensUsed, let budget = goal.tokenBudget, budget > 0 {
                                ProgressView(value: min(1.0, Double(used) / Double(budget)))
                                    .tint(palette.accent)
                                Text("\(CompanionFormatters.formatTokens(used)) / \(CompanionFormatters.formatTokens(budget)) tokens")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.muted)
                            }
                        }
                    }

                    HStack {
                        TextField("Goal objective or /goal args…", text: $goalInput)
                        Button("Run /goal") {
                            let arg = goalInput
                            goalInput = ""
                            Task { await perform { try await $0.runGoalCommand(sessionId: liveSession.id, args: arg) } }
                        }
                        .disabled(!store.canPerformMutatingActions || isBusy)
                    }

                    Button("Start Guided Goal (/guided-goal)") {
                        let arg = goalInput
                        goalInput = ""
                        Task { await perform { try await $0.startGuidedGoal(sessionId: liveSession.id, initial: arg) } }
                    }
                    .disabled(!store.canPerformMutatingActions || isBusy)

                    if let loop = liveSession._loop {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Loop: \(loop.state.capitalized)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.cyan)
                            if let desc = loop.description, !desc.isEmpty {
                                Text(desc).font(.caption).foregroundStyle(palette.muted)
                            }
                        }
                    }

                    HStack {
                        TextField("Loop args (e.g. 5m check status)…", text: $loopInput)
                        Button("Run /loop") {
                            let arg = loopInput
                            loopInput = ""
                            Task { await perform { try await $0.runLoopCommand(sessionId: liveSession.id, args: arg) } }
                        }
                        .disabled(!store.canPerformMutatingActions || isBusy)
                    }
                }

                // Advisor
                Section("Advisor Reviewer") {
                    let adv = liveSession.advisor
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(adv?.enabled == true ? "Advisor Enabled" : "Advisor Disabled")
                                .font(.subheadline.weight(.medium))
                            if let model = adv?.model ?? store.advisorConfig?.model {
                                Text(model)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(palette.muted)
                            }
                        }
                        Spacer()
                        Button(adv?.enabled == true ? "Turn Off" : "Turn On") {
                            let action = adv?.enabled == true ? "off" : "on"
                            Task { await perform { try await $0.setAdvisor(sessionId: liveSession.id, action: action) } }
                        }
                        .buttonStyle(.bordered)
                        .disabled(!store.canPerformMutatingActions || isBusy)
                    }

                    Button("Change Advisor Model…") {
                        showAdvisorModelPicker = true
                    }
                    .disabled(!store.canPerformMutatingActions || isBusy || liveSession.isWorking)

                    Button("Refresh Advisor Status") {
                        Task { await perform { try await $0.setAdvisor(sessionId: liveSession.id, action: "status") } }
                    }
                    .disabled(!store.canPerformMutatingActions || isBusy)
                }

                // Runtime Preferences
                Section("Session Preferences") {
                    Toggle("Fast Mode", isOn: Binding(
                        get: { isFastOn },
                        set: { val in Task { await perform { try await $0.setPref(sessionId: liveSession.id, key: "fast", value: val) } } }
                    ))
                    Toggle("Auto-Compaction", isOn: Binding(
                        get: { isAutoCompactionOn },
                        set: { val in Task { await perform { try await $0.setPref(sessionId: liveSession.id, key: "autoCompaction", value: val) } } }
                    ))
                    Toggle("Auto-Retry", isOn: Binding(
                        get: { isAutoRetryOn },
                        set: { val in Task { await perform { try await $0.setPref(sessionId: liveSession.id, key: "autoRetry", value: val) } } }
                    ))
                    Toggle("Slow Mode", isOn: Binding(
                        get: { isSlowOn },
                        set: { val in Task { await perform { try await $0.setPref(sessionId: liveSession.id, key: "slowMode", value: val) } } }
                    ))

                    Picker("Steering Delivery", selection: Binding(
                        get: { steeringMode },
                        set: { val in Task { await perform { try await $0.setPref(sessionId: liveSession.id, key: "steeringMode", value: val) } } }
                    )) {
                        Text("One at a time").tag("one-at-a-time")
                        Text("All").tag("all")
                    }

                    Picker("Follow-up Queue", selection: Binding(
                        get: { followUpMode },
                        set: { val in Task { await perform { try await $0.setPref(sessionId: liveSession.id, key: "followUpMode", value: val) } } }
                    )) {
                        Text("One at a time").tag("one-at-a-time")
                        Text("All").tag("all")
                    }

                    Picker("Interrupt Behavior", selection: Binding(
                        get: { interruptMode },
                        set: { val in Task { await perform { try await $0.setPref(sessionId: liveSession.id, key: "interruptMode", value: val) } } }
                    )) {
                        Text("Immediate").tag("immediate")
                        Text("Wait").tag("wait")
                    }

                    Picker("Cache Warming", selection: Binding(
                        get: { cacheWarming },
                        set: { val in Task { await perform { try await $0.setPref(sessionId: liveSession.id, key: "cacheWarming", value: val) } } }
                    )) {
                        Text("Off").tag("off")
                        Text("Streaming").tag("streaming")
                        Text("Idle").tag("idle")
                    }

                    Button {
                        showLaunchOptions = true
                    } label: {
                        HStack {
                            Text("Launch Options")
                            Spacer()
                            let cnt = liveSession.launch?.activeCount ?? 0
                            if cnt > 0 {
                                Text("\(cnt) active")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(palette.accent)
                            }
                        }
                    }
                }

                // Context & History Actions
                Section("Context, Branch & Rewind") {
                    HStack {
                        TextField("Compact instructions (optional)", text: $compactInstructions)
                        Button("Compact") {
                            let inst = compactInstructions.trimmingCharacters(in: .whitespacesAndNewlines)
                            compactInstructions = ""
                            Task { await perform { try await $0.compactSession(sessionId: liveSession.id, instructions: inst.isEmpty ? nil : inst) } }
                        }
                        .disabled(!store.canPerformMutatingActions || isBusy || liveSession.isWorking)
                    }

                    HStack {
                        TextField("Handoff instructions (optional)", text: $handoffInstructions)
                        Button("Handoff") {
                            let inst = handoffInstructions.trimmingCharacters(in: .whitespacesAndNewlines)
                            handoffInstructions = ""
                            Task { await perform { try await $0.handoffSession(sessionId: liveSession.id, instructions: inst.isEmpty ? nil : inst) } }
                        }
                        .disabled(!store.canPerformMutatingActions || isBusy || liveSession.isWorking)
                    }

                    Button {
                        showRewindSheet = true
                    } label: {
                        Label("Rewind / Fork from Turn…", systemImage: "arrow.uturn.backward.circle")
                    }
                    .disabled(!store.canPerformMutatingActions || liveSession.isWorking)

                    Button {
                        showTreeSheet = true
                    } label: {
                        Label("Session Tree Map", systemImage: "point.3.connected.trianglepath.dotted")
                    }

                    Button("Start Fresh Session File") {
                        confirmFreshSession = true
                    }
                    .disabled(!store.canPerformMutatingActions || liveSession.isWorking)
                }

                // Host Shell, Stats, Usage & Login
                Section("Diagnostics, Shell & Auth") {
                    HStack {
                        TextField("Run host bash command in session cwd…", text: $bashCommand)
                            .font(.callout.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Run") {
                            let cmd = bashCommand.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !cmd.isEmpty else { return }
                            bashCommand = ""
                            Task { await perform { try await $0.runBash(sessionId: liveSession.id, command: cmd) } }
                        }
                        .disabled(!store.canPerformMutatingActions || isBusy || bashCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    if liveSession._bash != nil {
                        Button("Abort Running Bash", role: .destructive) {
                            Task { await perform { try await $0.abortBash(sessionId: liveSession.id) } }
                        }
                    }

                    Button {
                        showStatsSheet = true
                    } label: {
                        Label("Session Stats & HTML Export", systemImage: "chart.bar.doc.horizontal")
                    }

                    Button {
                        showUsageSheet = true
                    } label: {
                        Label("Provider Quotas & Rate Limits", systemImage: "gauge.with.needle")
                    }

                    Button {
                        showLoginSheet = true
                    } label: {
                        Label("OAuth Provider Login", systemImage: "person.badge.key")
                    }
                    .disabled(!store.canPerformMutatingActions)
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .navigationTitle("Session Controls")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showModelPicker) {
                ModelPickerSheet(
                    store: store,
                    selectedModel: liveSession.effectiveModelSelector ?? "",
                    selectedThinking: liveSession.thinkingChoice ?? liveSession.thinking ?? ""
                ) { model, thinking in
                    Task {
                        await perform {
                            try await $0.setModel(
                                sessionId: liveSession.id,
                                model: model.isEmpty ? nil : model,
                                thinking: thinking.isEmpty ? nil : thinking
                            )
                        }
                    }
                }
            }
            .sheet(isPresented: $showAdvisorModelPicker) {
                ModelPickerSheet(
                    store: store,
                    title: "Advisor Model",
                    selectedModel: liveSession.advisor?.model ?? store.advisorConfig?.model ?? "",
                    selectedThinking: ""
                ) { model, thinking in
                    guard !model.isEmpty else { return }
                    let spec = thinking.isEmpty ? model : "\(model):\(thinking)"
                    Task {
                        await perform { try await $0.setAdvisorModel(sessionId: liveSession.id, model: spec) }
                    }
                }
            }
            .sheet(isPresented: $showLaunchOptions) {
                LaunchOptionsSheet(
                    initial: liveSession.launch,
                    availableModels: store.availableModels
                ) { opts in
                    guard let client = store.activeClient else { return false }
                    do {
                        let updated = try await client.updateLaunchOptions(sessionId: liveSession.id, launch: opts?.toDictionary())
                        store.integrateSession(updated)
                        return true
                    } catch {
                        errorMessage = error.localizedDescription
                        return false
                    }
                }
            }
            .sheet(isPresented: $showPlanReview) {
                PlanReviewSheet(store: store, session: liveSession)
            }
            .sheet(isPresented: $showRewindSheet) {
                BranchRewindSheet(store: store, session: liveSession)
            }
            .sheet(isPresented: $showTreeSheet) {
                TreeViewerSheet(store: store, session: liveSession)
            }
            .sheet(isPresented: $showStatsSheet) {
                SessionStatsSheet(store: store, session: liveSession)
            }
            .sheet(isPresented: $showUsageSheet) {
                UsagePopoverSheet(store: store, session: liveSession)
            }
            .sheet(isPresented: $showLoginSheet) {
                LoginProvidersSheet(store: store, session: liveSession)
            }
            .confirmationDialog("Start a Fresh Session File?", isPresented: $confirmFreshSession, titleVisibility: .visible) {
                Button("Start Fresh Session", role: .destructive) {
                    Task { await perform { try await $0.startFreshSession(sessionId: liveSession.id) } }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Resets the live conversation into a brand-new transcript file in this workspace.")
            }
        }
    }

    private func perform(_ op: (CompanionClient) async throws -> SessionSummary) async {
        guard let client = store.activeClient else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let updated = try await op(client)
            store.integrateSession(updated)
            store.notificationManager.triggerHaptic(.selection)
        } catch {
            errorMessage = error.localizedDescription
            store.notificationManager.triggerHaptic(.error)
        }
    }
}

// MARK: - Model & Thinking Picker Sheet

public struct ModelPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    public var title: String
    @State private var searchText = ""
    /// Same key and format as the web companion's localStorage (`omp-fav-models`): a JSON array of selectors.
    @AppStorage("omp-fav-models") private var favoriteModelsJSON: String = "[]"
    @State private var selectedModel: String
    @State private var selectedThinking: String
    public let onApply: (String, String) -> Void

    public init(
        store: AppStore,
        title: String = "Select Model & Thinking",
        selectedModel: String,
        selectedThinking: String,
        onApply: @escaping (String, String) -> Void
    ) {
        self.store = store
        self.title = title
        self._selectedModel = State(initialValue: selectedModel)
        self._selectedThinking = State(initialValue: selectedThinking)
        self.onApply = onApply
    }

    private var favoriteSelectors: [String] {
        guard let data = favoriteModelsJSON.data(using: .utf8),
              let list = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return list
    }

    /// Search puts favorites first, as the web picker does.
    private var filteredModels: [ModelEntry] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return store.availableModels }
        let favs = Set(favoriteSelectors)
        let hits = store.availableModels.filter {
            $0.name.lowercased().contains(q)
                || $0.selector.lowercased().contains(q)
                || $0.provider.lowercased().contains(q)
        }
        return hits.filter { favs.contains($0.selector) } + hits.filter { !favs.contains($0.selector) }
    }

    private var groupedProviders: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for m in filteredModels where !seen.contains(m.provider) {
            seen.insert(m.provider)
            out.append(m.provider)
        }
        return out
    }

    /// Favorites in the order saved (newest first), limited to models the host offers.
    private var favoriteModels: [ModelEntry] {
        let bySelector = Dictionary(store.availableModels.map { ($0.selector, $0) }, uniquingKeysWith: { first, _ in first })
        return favoriteSelectors.compactMap { bySelector[$0] }
    }

    private func toggleFavorite(_ selector: String) {
        var favs = favoriteSelectors
        if let i = favs.firstIndex(of: selector) {
            favs.remove(at: i)
        } else {
            favs.insert(selector, at: 0)
        }
        favoriteModelsJSON = (try? String(data: JSONEncoder().encode(favs), encoding: .utf8)) ?? "[]"
        store.notificationManager.triggerHaptic(.selection)
    }

    @ViewBuilder
    private func modelRow(_ model: ModelEntry) -> some View {
        let isFavorite = favoriteSelectors.contains(model.selector)
        HStack {
            Button {
                selectedModel = model.selector
                onApply(model.selector, selectedThinking)
                dismiss()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(model.name)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(palette.foreground)
                            if model.fast == true {
                                Text("FAST")
                                    .font(.caption2.weight(.bold))
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(palette.cyan.opacity(0.18), in: Capsule())
                                    .foregroundStyle(palette.cyan)
                            }
                        }
                        Text(model.selector)
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.muted)
                    }
                    Spacer()
                    if let ctx = model.contextWindow, ctx > 0 {
                        Text("\(CompanionFormatters.formatTokens(ctx)) ctx")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(palette.muted)
                    }
                    if selectedModel == model.selector {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(palette.accent)
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selectedModel == model.selector ? .isSelected : [])

            Button {
                toggleFavorite(model.selector)
            } label: {
                Image(systemName: isFavorite ? "star.fill" : "star")
                    .foregroundStyle(isFavorite ? palette.amber : palette.muted)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(isFavorite ? "Remove \(model.name) from favorites" : "Add \(model.name) to favorites")
            .accessibilityAddTraits(isFavorite ? .isSelected : [])
        }
        .listRowBackground(palette.card)
    }

    private var thinkingOptions: [String] {
        if let entry = store.availableModels.first(where: { $0.selector == selectedModel }),
           let levels = entry.thinking, !levels.isEmpty {
            return levels
        }
        return store.thinkingLevels
    }

    public var body: some View {
        NavigationStack {
            List {
                Section("Thinking Level") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            thinkingChip("auto", label: "Auto")
                            ForEach(thinkingOptions, id: \.self) { lvl in
                                thinkingChip(lvl, label: lvl.capitalized)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .listRowBackground(palette.card)
                }

                if store.availableModels.isEmpty {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Loading available models from host…")
                                .font(.caption)
                                .foregroundStyle(palette.muted)
                            Button("Refresh Models") {
                                Task { await store.refreshModels() }
                            }
                        }
                    }
                } else {
                    if searchText.trimmingCharacters(in: .whitespaces).isEmpty, !favoriteModels.isEmpty {
                        Section("★ FAVORITES") {
                            ForEach(favoriteModels) { model in
                                modelRow(model)
                            }
                        }
                    }
                    ForEach(groupedProviders, id: \.self) { provider in
                        Section(provider.uppercased()) {
                            ForEach(filteredModels.filter { $0.provider == provider }) { model in
                                modelRow(model)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .searchable(text: $searchText, prompt: "Filter models or providers…")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        onApply(selectedModel, selectedThinking)
                        dismiss()
                    }
                }
            }
            .task {
                if store.availableModels.isEmpty {
                    await store.refreshModels()
                }
            }
        }
    }

    @ViewBuilder
    private func thinkingChip(_ value: String, label: String) -> some View {
        let active = selectedThinking == value || (value == "auto" && selectedThinking.isEmpty)
        Button {
            selectedThinking = value == "auto" ? "" : value
            store.notificationManager.triggerHaptic(.selection)
        } label: {
            Text(label)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(active ? palette.accentSoft : palette.raised, in: Capsule())
                .foregroundStyle(active ? palette.accent : palette.foreground)
                .overlay(Capsule().stroke(active ? palette.accentLine : palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Rewind & Branch Sheet

public struct BranchRewindSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary
    public var onPrefillComposer: ((String) -> Void)?

    @State private var messages: [BranchMessageItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    public init(store: AppStore, session: SessionSummary, onPrefillComposer: ((String) -> Void)? = nil) {
        self.store = store
        self.session = session
        self.onPrefillComposer = onPrefillComposer
    }

    public var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                }

                Section("Quick Actions") {
                    Button {
                        Task { await editLast() }
                    } label: {
                        Label("Rewind to Before Last Message (Edit)", systemImage: "pencil.and.outline")
                    }
                    Button {
                        Task { await regenerateLast() }
                    } label: {
                        Label("Regenerate Last Reply", systemImage: "arrow.clockwise")
                    }
                }

                Section("Fork Before Earlier Prompt (\(messages.count))") {
                    if isLoading {
                        SkeletonListPlaceholder(count: 4)
                    } else if messages.isEmpty {
                        Text("No user turns available to branch from yet.")
                            .font(.caption)
                            .foregroundStyle(palette.muted)
                    } else {
                        ForEach(messages) { item in
                            Button {
                                Task { await branchFrom(entryId: item.entryId) }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.text)
                                        .font(.subheadline)
                                        .foregroundStyle(palette.foreground)
                                        .lineLimit(3)
                                    Text("Entry \(item.entryId)")
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(palette.muted)
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
            .navigationTitle("Rewind & Branch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task {
                await loadBranchMessages()
            }
        }
    }

    private func loadBranchMessages() async {
        guard let client = store.activeClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            messages = try await client.fetchBranchMessages(sessionId: session.id).messages
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func branchFrom(entryId: String) async {
        guard let client = store.activeClient else { return }
        do {
            let res = try await client.branchSession(sessionId: session.id, entryId: entryId)
            store.integrateSession(res.session)
            if !res.text.isEmpty {
                onPrefillComposer?(res.text)
                if let client = store.activeClient {
                    _ = try? await client.saveDraft(key: session.draftKey, text: res.text)
                }
            }
            store.showToast(String(localized: "Branched session; message placed in composer", bundle: .main))
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func editLast() async {
        guard let client = store.activeClient else { return }
        do {
            let res = try await client.editLastMessage(sessionId: session.id)
            store.integrateSession(res.session)
            if !res.text.isEmpty {
                onPrefillComposer?(res.text)
                _ = try? await client.saveDraft(key: session.draftKey, text: res.text)
            }
            store.showToast(String(localized: "Rewound before last prompt", bundle: .main))
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func regenerateLast() async {
        guard let client = store.activeClient else { return }
        do {
            let updated = try await client.regenerateLastMessage(sessionId: session.id)
            store.integrateSession(updated)
            store.showToast(String(localized: "Regenerating last turn", bundle: .main))
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Session Tree Viewer Sheet

public struct TreeViewerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var nodes: [TreeNodeItem] = []
    @State private var leafId: String?
    @State private var isLoading = true
    @State private var errorMessage: String?

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    public var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.caption).foregroundStyle(palette.red)
                    }
                }
                if isLoading {
                    SkeletonListPlaceholder(count: 6)
                } else if nodes.isEmpty {
                    OMPEmptyStateView(
                        systemImage: "point.3.connected.trianglepath.dotted",
                        title: String(localized: "No Tree Entries", bundle: .main),
                        message: String(localized: "Conversation tree nodes appear once turns are recorded in this session.", bundle: .main)
                    )
                } else {
                    ForEach(nodes) { node in
                        HStack(alignment: .top, spacing: 8) {
                            let indent = CGFloat(min(6, max(0, node.depth ?? 0))) * 12
                            Spacer().frame(width: indent)

                            Circle()
                                .fill(node.onPath == true ? palette.accent : palette.muted.opacity(0.4))
                                .frame(width: 8, height: 8)
                                .padding(.top, 5)

                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text((node.kind ?? "entry").uppercased())
                                        .font(.caption2.monospaced().weight(.bold))
                                        .foregroundStyle(node.onPath == true ? palette.accent : palette.muted)
                                    if let label = node.label, !label.isEmpty {
                                        Text(label)
                                            .font(.caption2.weight(.semibold))
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 1)
                                            .background(palette.amberSoft, in: Capsule())
                                            .foregroundStyle(palette.amber)
                                    }
                                    if node.id == leafId {
                                        Text("LEAF")
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(palette.green)
                                    }
                                    if let forks = node.forks, forks > 1 {
                                        Text("\(forks) branches")
                                            .font(.caption2)
                                            .foregroundStyle(palette.violet)
                                    }
                                }
                                if let text = node.text, !text.isEmpty {
                                    Text(text)
                                        .font(.caption)
                                        .foregroundStyle(palette.foreground)
                                        .lineLimit(3)
                                }
                            }
                        }
                        .listRowBackground(node.onPath == true ? palette.accentSoft.opacity(0.35) : palette.card)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .navigationTitle("Conversation Tree")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task {
                guard let client = store.activeClient else { return }
                isLoading = true
                defer { isLoading = false }
                do {
                    let res = try await client.fetchTree(sessionId: session.id)
                    nodes = res.nodes ?? []
                    leafId = res.leafId
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

// MARK: - Session Stats & HTML Export Sheet

public struct SessionStatsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var stats: [String: JSONValue] = [:]
    @State private var exportedHtml: String?
    @State private var exportName: String = "omp-session.html"
    @State private var isLoading = true
    @State private var isExporting = false
    @State private var errorMessage: String?

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    public var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.caption).foregroundStyle(palette.red)
                    }
                }

                if isLoading {
                    SkeletonListPlaceholder(count: 5)
                } else {
                    Section("Metrics") {
                        ForEach(stats.keys.sorted(), id: \.self) { key in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(key)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(palette.muted)
                                Text(stats[key]?.displayString ?? "")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(palette.foreground)
                            }
                            .listRowBackground(palette.card)
                        }
                    }

                    Section("Transcript Export") {
                        Button {
                            Task { await exportHtml() }
                        } label: {
                            HStack {
                                Label(isExporting ? "Generating HTML…" : "Export Session HTML", systemImage: "square.and.arrow.up")
                                Spacer()
                                if isExporting { ProgressView().controlSize(.small) }
                            }
                        }
                        .disabled(isExporting || !store.canPerformMutatingActions)

                        if let exportedHtml {
                            ShareLink(item: exportedHtml, preview: SharePreview(exportName)) {
                                Label("Share \(exportName)", systemImage: "square.and.arrow.up.fill")
                            }
                            #if canImport(UIKit)
                            Button {
                                UIPasteboard.general.string = exportedHtml
                                store.showToast(String(localized: "Copied HTML export", bundle: .main))
                            } label: {
                                Label("Copy Raw HTML", systemImage: "doc.on.doc")
                            }
                            #endif
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .navigationTitle("Session Stats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                guard let client = store.activeClient else { return }
                isLoading = true
                defer { isLoading = false }
                do {
                    stats = try await client.fetchSessionStats(sessionId: session.id).stats
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func exportHtml() async {
        guard let client = store.activeClient else { return }
        isExporting = true
        defer { isExporting = false }
        do {
            let res = try await client.exportSessionHtml(sessionId: session.id)
            exportedHtml = res.html
            exportName = res.name
            store.notificationManager.triggerHaptic(.success)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Provider Usage Sheet

public struct UsagePopoverSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var usage: ProviderUsageResponse?
    @State private var isLoading = true
    @State private var isRefreshing = false
    @State private var activeUsageFetches = 0
    @State private var lastFetchedAt: Date?
    @State private var errorMessage: String?
    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    public var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.caption).foregroundStyle(palette.red)
                    }
                }
                if isLoading && usage == nil {
                    SkeletonListPlaceholder(count: 4)
                } else if let usage {
                    Section {
                        HStack(spacing: 8) {
                            let headerModel = [usage.provider, usage.model].filter { !$0.isEmpty }.joined(separator: "/")
                            Text(headerModel.isEmpty ? "Usage" : "Usage · \(headerModel)")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            if isRefreshing {
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }
                        .listRowBackground(palette.card)
                    }

                    ForEach(usage.providers) { group in
                        Section(group.provider) {
                            if let unavail = group.unavailable, !unavail.isEmpty {
                                Text(UsageFormatting.unavailableMessage(unavail))
                                    .font(.caption)
                                    .foregroundStyle(palette.muted)
                                    .listRowBackground(palette.card)
                            }
                            ForEach(group.accounts) { account in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(account.name)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(palette.foreground)

                                    ForEach(account.notes, id: \.self) { note in
                                        Text(note)
                                            .font(.caption2)
                                            .foregroundStyle(palette.muted)
                                    }

                                    if let accUnavail = account.unavailable, !accUnavail.isEmpty {
                                        Text(UsageFormatting.unavailableMessage(accUnavail))
                                            .font(.caption)
                                            .foregroundStyle(palette.muted)
                                    } else {
                                        ForEach(account.limits) { limit in
                                            usageLimitRow(limit)
                                        }
                                    }
                                }
                                .padding(.vertical, 4)
                                .listRowBackground(palette.card)
                            }
                        }
                    }

                    Section {
                        HStack(spacing: 8) {
                            if isRefreshing {
                                ProgressView()
                                    .controlSize(.mini)
                                Text("Refreshing…")
                                    .font(.caption2)
                                    .foregroundStyle(palette.muted)
                            } else if let updated = UsageFormatting.updatedClockLabel(isoString: usage.updatedAt, fallbackDate: lastFetchedAt) {
                                Text("\(updated) · every 2 min")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.muted)
                            }
                        }
                        .listRowBackground(Color.clear)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .refreshable {
                await loadUsage()
            }
            .navigationTitle("Provider Quotas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Post /usage") {
                        Task {
                            if let client = store.activeClient,
                               let updated = try? await client.sendSessionPrompt(sessionId: session.id, type: "prompt", message: "/usage") {
                                store.integrateSession(updated)
                                dismiss()
                            }
                        }
                    }
                    .disabled(!store.canPerformMutatingActions)
                }
            }
            .task(id: session.id) {
                await loadUsage()
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 120_000_000_000)
                    guard !Task.isCancelled else { break }
                    await loadUsage()
                }
            }
        }
    }

    @ViewBuilder
    private func usageLimitRow(_ limit: UsageLimit) -> some View {
        let pct = UsageFormatting.percentage(fraction: limit.fraction)
        let resetText = UsageFormatting.resetLabel(resetsAtMs: limit.resetsAt, fallback: limit.resetLabel)
        let progressValue = pct.map { min(1.0, max(0.0, Double($0) / 100.0)) } ?? 0.0
        let isHot = (pct ?? 0) >= 90

        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(limit.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.foreground)
                if let detail = limit.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
                Spacer(minLength: 4)
                HStack(spacing: 4) {
                    if let resetText, !resetText.isEmpty {
                        Text(resetText)
                            .font(.caption2)
                            .foregroundStyle(palette.muted)
                    }
                    if let pct {
                        Text("\(pct)%")
                            .font(.caption.monospacedDigit().weight(.bold))
                            .foregroundStyle(isHot ? palette.red : palette.foreground)
                            .accessibilityLabel("\(pct) percent used")
                    } else {
                        Text(limit.summary)
                            .font(.caption2.monospacedDigit().weight(.bold))
                            .foregroundStyle(palette.foreground)
                    }
                }
            }

            if limit.fraction != nil {
                ProgressView(value: progressValue)
                    .tint(isHot ? palette.red : palette.accent)
            }

            if !limit.notes.isEmpty {
                ForEach(limit.notes, id: \.self) { note in
                    Text(note)
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(usageRowAccessibilityLabel(limit: limit, resetText: resetText, pct: pct))
    }

    private func usageRowAccessibilityLabel(limit: UsageLimit, resetText: String?, pct: Int?) -> String {
        var parts = [limit.label]
        if let detail = limit.detail, !detail.isEmpty { parts.append(detail) }
        if let resetText, !resetText.isEmpty { parts.append(resetText) }
        if let pct {
            parts.append("\(pct) percent used")
        } else if !limit.summary.isEmpty {
            parts.append(limit.summary)
        }
        return parts.joined(separator: ", ")
    }

    private func loadUsage() async {
        guard let client = store.activeClient else {
            isLoading = false
            return
        }
        activeUsageFetches += 1
        if usage == nil {
            isLoading = true
        } else {
            isRefreshing = true
        }
        defer {
            activeUsageFetches = max(0, activeUsageFetches - 1)
            if activeUsageFetches == 0 {
                isLoading = false
                isRefreshing = false
            }
        }
        do {
            let next = try await client.fetchUsage(sessionId: session.id)
            usage = next
            lastFetchedAt = Date()
            errorMessage = nil
        } catch {
            if let apiError = error as? CompanionAPIError, apiError.kind == .cancelled { return }
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - OAuth Login Sheet

public struct LoginProvidersSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var providers: [LoginProviderInfo] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    public var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.caption).foregroundStyle(palette.red)
                    }
                }
                if isLoading {
                    SkeletonListPlaceholder(count: 4)
                } else if providers.isEmpty {
                    Text("No OAuth login providers reported by OMP.")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                } else {
                    Section("Providers") {
                        ForEach(providers) { p in
                            Button {
                                Task {
                                    guard let client = store.activeClient else { return }
                                    do {
                                        let updated = try await client.startLogin(sessionId: session.id, provider: p.id)
                                        store.integrateSession(updated)
                                        store.showToast(String(localized: "Started \(p.name) login — check sign-in prompt in chat", bundle: .main))
                                        dismiss()
                                    } catch {
                                        errorMessage = error.localizedDescription
                                    }
                                }
                            } label: {
                                HStack {
                                    Text(p.name)
                                        .foregroundStyle(palette.foreground)
                                    Spacer()
                                    if p.authenticated {
                                        Label("Logged in", systemImage: "checkmark.circle.fill")
                                            .font(.caption)
                                            .foregroundStyle(palette.green)
                                    }
                                }
                            }
                            .disabled(!p.available)
                            .listRowBackground(palette.card)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .navigationTitle("Provider OAuth Login")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task {
                guard let client = store.activeClient else { return }
                isLoading = true
                defer { isLoading = false }
                do {
                    providers = try await client.fetchLoginProviders(sessionId: session.id).providers
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}
