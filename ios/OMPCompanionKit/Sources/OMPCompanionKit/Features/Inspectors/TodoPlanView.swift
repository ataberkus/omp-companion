import SwiftUI

public struct TodoPlanView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var newPhaseName: String = ""
    @State private var newTaskContent: String = ""
    @State private var showAddTaskSheet = false
    @State private var showPlanReviewSheet = false
    @State private var isUpdatingTodos = false

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    private var phases: [TodoPhase] {
        session.todos ?? []
    }

    private var totalTasks: Int {
        phases.reduce(0) { $0 + $1.tasks.count }
    }

    private var completedTasks: Int {
        phases.reduce(0) { $0 + $1.tasks.filter { $0.status == .completed }.count }
    }

    public var body: some View {
        List {
            // Plan Mode & Active Proposal
            Section("Plan Mode") {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session.planMode?.enabled == true ? "Plan Mode Active" : "Standard Execution")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                        if let wf = session.planMode?.workflow {
                            Text("Workflow: \(wf.capitalized)")
                                .font(.caption2)
                                .foregroundStyle(palette.muted)
                        }
                        if let path = session._planReview?.resolvedFilePath ?? session.planMode?.planFilePath, !path.isEmpty {
                            Text(path)
                                .font(.caption2.monospaced())
                                .foregroundStyle(palette.muted)
                                .lineLimit(2)
                        }
                    }
                    Spacer()
                    if session.hasPlanReviewPending {
                        Button("Review Plan") {
                            showPlanReviewSheet = true
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(palette.amber)
                    } else if session.planMode?.available == true {
                        Button("Inspect") {
                            showPlanReviewSheet = true
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .listRowBackground(palette.card)

                if let planMd = session._planReview?.markdownContent, !planMd.isEmpty {
                    MarkdownView(text: planMd)
                        .padding(.vertical, 4)
                        .listRowBackground(palette.card)
                }
            }

            // Goal & Loop Status
            if session.goal != nil || session._loop != nil || session.advisor != nil {
                Section("Orchestration") {
                    if let goal = session.goal {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Label("Goal Mode", systemImage: "target")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(palette.green)
                                Spacer()
                                Text(goal.status ?? "active")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(palette.muted)
                            }
                            if let obj = goal.objective, !obj.isEmpty {
                                Text(obj).font(.subheadline).foregroundStyle(palette.foreground)
                            }
                            if let used = goal.tokensUsed, let budget = goal.tokenBudget, budget > 0 {
                                ProgressView(value: min(1.0, Double(used) / Double(budget)))
                                    .tint(palette.green)
                                Text("\(CompanionFormatters.formatTokens(used)) / \(CompanionFormatters.formatTokens(budget)) tokens")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(palette.muted)
                            }
                        }
                        .listRowBackground(palette.card)
                    }

                    if let loop = session._loop {
                        VStack(alignment: .leading, spacing: 4) {
                            Label("Loop: \(loop.state.capitalized)", systemImage: "repeat")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.cyan)
                            if let desc = loop.description, !desc.isEmpty {
                                Text(desc).font(.subheadline).foregroundStyle(palette.foreground)
                            }
                            if let p = loop.prompt, !p.isEmpty {
                                Text(p).font(.caption.monospaced()).foregroundStyle(palette.muted)
                            }
                        }
                        .listRowBackground(palette.card)
                    }

                    if let adv = session.advisor, adv.enabled == true {
                        HStack {
                            Label("Advisor", systemImage: "eye.trianglebadge.exclamationmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.violet)
                            Spacer()
                            Text(adv.model ?? "enabled")
                                .font(.caption2.monospaced())
                                .foregroundStyle(palette.muted)
                        }
                        .listRowBackground(palette.card)
                    }
                }
            }

            // Todos Progress & Phases
            Section {
                if phases.isEmpty {
                    OMPEmptyStateView(
                        systemImage: "checklist",
                        title: String(localized: "No Todo Phases", bundle: .main),
                        message: String(localized: "When OMP creates a structured implementation plan or task list, phases and items update live here.", bundle: .main),
                        actionTitle: store.canPerformMutatingActions ? String(localized: "Add Todo Item", bundle: .main) : nil
                    ) {
                        showAddTaskSheet = true
                    }
                    .listRowBackground(Color.clear)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("\(completedTasks) of \(totalTasks) tasks completed")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                            Spacer()
                            if totalTasks > 0 {
                                Text("\(Int((Double(completedTasks) / Double(totalTasks)) * 100))%")
                                    .font(.caption.monospacedDigit().weight(.bold))
                                    .foregroundStyle(palette.accent)
                            }
                        }
                        if totalTasks > 0 {
                            ProgressView(value: Double(completedTasks), total: Double(totalTasks))
                                .tint(palette.green)
                        }
                    }
                    .listRowBackground(palette.card)

                    ForEach(Array(phases.enumerated()), id: \.offset) { pIdx, phase in
                        Section(phase.name) {
                            ForEach(Array(phase.tasks.enumerated()), id: \.offset) { tIdx, task in
                                Button {
                                    Task { await cycleTaskStatus(phaseIndex: pIdx, taskIndex: tIdx) }
                                } label: {
                                    HStack(alignment: .top, spacing: 10) {
                                        Image(systemName: iconForTodo(task.status))
                                            .foregroundStyle(colorForTodo(task.status))
                                            .padding(.top, 2)
                                            .accessibilityHidden(true)

                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(task.content)
                                                .font(.subheadline)
                                                .foregroundStyle(task.status == .completed || task.status == .abandoned ? palette.muted : palette.foreground)
                                                .strikethrough(task.status == .completed || task.status == .abandoned)
                                                .multilineTextAlignment(.leading)

                                            if let details = task.details, !details.isEmpty {
                                                Text(details)
                                                    .font(.caption)
                                                    .foregroundStyle(palette.muted)
                                            }
                                            if let blocker = task.blocker, !blocker.isEmpty {
                                                Text("Blocker: \(blocker)")
                                                    .font(.caption2.weight(.semibold))
                                                    .foregroundStyle(palette.red)
                                            }
                                            if let notes = task.notes, !notes.isEmpty {
                                                ForEach(notes, id: \.self) { note in
                                                    Text("• \(note)")
                                                        .font(.caption2)
                                                        .foregroundStyle(palette.muted)
                                                }
                                            }
                                        }
                                        Spacer()
                                        Text(task.status.label)
                                            .font(.caption2.weight(.semibold))
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(colorForTodo(task.status).opacity(0.15), in: Capsule())
                                            .foregroundStyle(colorForTodo(task.status))
                                    }
                                    .padding(.vertical, 3)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Double tap to change status")
                                .disabled(isUpdatingTodos || !store.canPerformMutatingActions)
                                .listRowBackground(palette.card)
                            }
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Tasks")
                    Spacer()
                    if store.canPerformMutatingActions {
                        Button {
                            showAddTaskSheet = true
                        } label: {
                            Label("Add", systemImage: "plus")
                                .font(.caption.weight(.semibold))
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .sheet(isPresented: $showPlanReviewSheet) {
            PlanReviewSheet(store: store, session: session)
        }
        .sheet(isPresented: $showAddTaskSheet) {
            NavigationStack {
                Form {
                    Section("Phase") {
                        TextField("Phase Name (e.g. Implementation)", text: $newPhaseName)
                    }
                    Section("Task") {
                        TextField("Describe task…", text: $newTaskContent, axis: .vertical)
                            .lineLimit(2...5)
                    }
                }
                .navigationTitle("Add Todo")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showAddTaskSheet = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add") {
                            Task { await addTodoTask() }
                        }
                        .disabled(newTaskContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .onAppear {
                    if newPhaseName.isEmpty {
                        newPhaseName = phases.last?.name ?? "Tasks"
                    }
                }
            }
        }
    }

    private func iconForTodo(_ status: TodoStatus) -> String {
        switch status {
        case .pending: return "circle"
        case .inProgress: return "clock.fill"
        case .completed: return "checkmark.circle.fill"
        case .abandoned: return "minus.circle"
        case .blocked: return "exclamationmark.octagon.fill"
        }
    }

    private func colorForTodo(_ status: TodoStatus) -> Color {
        switch status {
        case .pending: return palette.muted
        case .inProgress: return palette.amber
        case .completed: return palette.green
        case .abandoned: return palette.muted
        case .blocked: return palette.red
        }
    }

    private func cycleTaskStatus(phaseIndex: Int, taskIndex: Int) async {
        guard let client = store.activeClient else { return }
        var updatedPhases = phases
        guard updatedPhases.indices.contains(phaseIndex),
              updatedPhases[phaseIndex].tasks.indices.contains(taskIndex) else { return }
        let current = updatedPhases[phaseIndex].tasks[taskIndex].status
        let next: TodoStatus = {
            switch current {
            case .pending: return .inProgress
            case .inProgress: return .completed
            case .completed: return .pending
            case .blocked: return .inProgress
            case .abandoned: return .pending
            }
        }()
        updatedPhases[phaseIndex].tasks[taskIndex].status = next
        isUpdatingTodos = true
        defer { isUpdatingTodos = false }
        do {
            let updatedSession = try await client.setTodos(sessionId: session.id, phases: updatedPhases)
            store.integrateSession(updatedSession)
            store.notificationManager.triggerHaptic(.selection)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func addTodoTask() async {
        guard let client = store.activeClient else { return }
        let phaseTitle = newPhaseName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Tasks" : newPhaseName.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = newTaskContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }

        var updatedPhases = phases
        let item = TodoItem(content: content, status: .pending)
        if let idx = updatedPhases.firstIndex(where: { $0.name.caseInsensitiveCompare(phaseTitle) == .orderedSame }) {
            updatedPhases[idx].tasks.append(item)
        } else {
            updatedPhases.append(TodoPhase(name: phaseTitle, tasks: [item]))
        }

        newTaskContent = ""
        showAddTaskSheet = false
        isUpdatingTodos = true
        defer { isUpdatingTodos = false }
        do {
            let updatedSession = try await client.setTodos(sessionId: session.id, phases: updatedPhases)
            store.integrateSession(updatedSession)
            store.notificationManager.triggerHaptic(.success)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}
