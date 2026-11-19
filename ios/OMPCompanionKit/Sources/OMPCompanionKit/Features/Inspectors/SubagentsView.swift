import SwiftUI

public struct SubagentsView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var backgroundData: BackgroundViewResponse?
    @State private var etag: String?
    @State private var isLoading = false
    @State private var errorMessage: String?

    @State private var inspectingJob: BackgroundJob?
    @State private var inspectingLogJob: BackgroundJob?
    @State private var steeringJob: BackgroundJob?
    @State private var steerMessageInput: String = ""

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    private var jobs: [BackgroundJob] {
        if let backgroundData {
            return backgroundData.resolvedJobs(session: session)
        }
        return BackgroundViewResponse(
            dir: nil,
            live: session.isWorking,
            tasks: nil,
            agents: session.subagentList,
            subagents: nil,
            jobs: nil
        ).resolvedJobs(session: session)
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

            if isLoading && backgroundData == nil && jobs.isEmpty {
                SkeletonListPlaceholder(count: 4)
            } else if jobs.isEmpty {
                OMPEmptyStateView(
                    systemImage: "cpu",
                    title: "No Subagents or Background Jobs",
                    message: "Spawned subagents, background tasks, and async logs for this session appear here."
                )
                .listRowBackground(Color.clear)
            } else {
                Section("Subagents & Tasks (\(jobs.count))") {
                    ForEach(jobs) { job in
                        jobRow(job)
                            .listRowBackground(palette.card)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.background)
        .refreshable {
            await loadBackground(force: true)
        }
        .task(id: session.id) {
            await loadBackground(force: true)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: session.isWorking ? 2_500_000_000 : 7_000_000_000)
                guard !Task.isCancelled else { break }
                await loadBackground(force: false)
            }
        }
        .sheet(item: $inspectingJob) { job in
            SubagentTranscriptSheet(store: store, session: session, job: job)
        }
        .sheet(item: $inspectingLogJob) { job in
            if let logFile = job.logFile {
                BackgroundLogSheet(store: store, title: job.title, file: logFile)
            }
        }
        .alert("Message / Steer Subagent", isPresented: Binding(
            get: { steeringJob != nil },
            set: { if !$0 { steeringJob = nil } }
        )) {
            TextField("Instruction for subagent", text: $steerMessageInput)
            Button("Send") {
                if let job = steeringJob {
                    let msg = steerMessageInput.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !msg.isEmpty {
                        Task { await sendSteerOrMessage(job: job, message: msg) }
                    }
                }
                steeringJob = nil
            }
            Button("Cancel", role: .cancel) { steeringJob = nil }
        }
    }

    @ViewBuilder
    private func jobRow(_ job: BackgroundJob) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle()
                    .fill(statusColor(job.status))
                    .frame(width: 8, height: 8)
                Text(job.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(2)
                Spacer()
                Text(job.status.uppercased())
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(statusColor(job.status).opacity(0.16), in: Capsule())
                    .foregroundStyle(statusColor(job.status))
            }

            HStack(spacing: 10) {
                if let agent = job.agent, !agent.isEmpty {
                    Label(agent, systemImage: "cpu")
                        .font(.caption2.monospaced())
                        .foregroundStyle(palette.accent)
                }
                if let model = job.model, !model.isEmpty {
                    Text(model)
                        .font(.caption2.monospaced())
                        .foregroundStyle(palette.muted)
                        .lineLimit(1)
                }
                if let cost = job.cost, cost > 0 {
                    Text(CompanionFormatters.formatCost(cost))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.muted)
                }
                if let ms = job.durationMs, ms > 0 {
                    Text("\(ms / 1000)s")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.muted)
                }
            }

            if let summary = job.summary ?? job.output, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(palette.muted)
                    .lineLimit(3)
            }

            HStack(spacing: 12) {
                if job.transcript != nil {
                    Button {
                        inspectingJob = job
                    } label: {
                        Label("Transcript", systemImage: "text.bubble")
                            .font(.caption.weight(.semibold))
                    }
                }
                if job.logFile != nil {
                    Button {
                        inspectingLogJob = job
                    } label: {
                        Label("Log", systemImage: "doc.plaintext")
                            .font(.caption.weight(.semibold))
                    }
                }
                if job.isRunning || (job.transcript != nil && session.isWorking) {
                    Button {
                        steerMessageInput = ""
                        steeringJob = job
                    } label: {
                        Label(job.isRunning ? "Steer" : "Message", systemImage: "paperplane")
                            .font(.caption.weight(.semibold))
                    }
                    .disabled(!store.canPerformMutatingActions)
                }
                if job.isRunning {
                    Spacer()
                    Button(role: .destructive) {
                        Task { await cancelJob(job) }
                    } label: {
                        Label("Cancel", systemImage: "stop.circle")
                            .font(.caption.weight(.semibold))
                    }
                    .disabled(!store.canPerformMutatingActions)
                }
            }
            .buttonStyle(.borderless)
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "running": return palette.amber
        case "done": return palette.green
        case "error", "cancelled": return palette.red
        default: return palette.muted
        }
    }

    private func loadBackground(force: Bool) async {
        guard let client = store.activeClient, let file = session.sessionFile, !file.isEmpty else { return }
        if backgroundData == nil { isLoading = true }
        defer { isLoading = false }
        do {
            let res = try await client.fetchBackground(file: file, etag: force ? nil : etag)
            if case .updated(let body, let nextEtag) = res {
                backgroundData = body
                etag = nextEtag
                errorMessage = nil
            }
        } catch {
            if backgroundData == nil {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func cancelJob(_ job: BackgroundJob) async {
        guard let client = store.activeClient else { return }
        do {
            _ = try await client.cancelSubagent(sessionId: session.id, subagentId: job.id)
            store.showToast("Cancelled subagent \(job.title)")
            await loadBackground(force: true)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }

    private func sendSteerOrMessage(job: BackgroundJob, message: String) async {
        guard let client = store.activeClient else { return }
        do {
            if job.isRunning {
                _ = try await client.steerSubagent(sessionId: session.id, subagentId: job.id, message: message)
                store.showToast("Steered subagent")
            } else if let file = job.transcript {
                _ = try await client.messageSubagent(sessionId: session.id, file: file, message: message)
                store.showToast("Sent message to subagent")
            }
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}

private struct SubagentTranscriptSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    let session: SessionSummary
    let job: BackgroundJob

    @State private var transcript: SubagentTranscriptResponse?
    @State private var etag: String?
    @State private var followUpText = ""
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(palette.red).padding(8)
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if isLoading && transcript == nil {
                            SkeletonListPlaceholder(count: 5)
                        } else if let transcript {
                            if transcript.messages.isEmpty {
                                Text("No messages recorded in this subagent yet.")
                                    .font(.caption)
                                    .foregroundStyle(palette.muted)
                            } else {
                                ForEach(transcript.messages) { msg in
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(msg.role.rawValue.uppercased())
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(msg.role == .user ? palette.accent : palette.green)
                                        if !msg.text.isEmpty {
                                            MarkdownView(msg.text)
                                        }
                                        if let tool = msg.tool {
                                            Text("\(tool.name): \(tool.intent ?? tool.args ?? tool.status)")
                                                .font(.caption2.monospaced())
                                                .foregroundStyle(palette.muted)
                                        }
                                    }
                                    .ompCard(palette)
                                }
                            }
                        }
                    }
                    .padding()
                }

                if store.canPerformMutatingActions && (job.isRunning || session.status != .done) {
                    HStack(spacing: 8) {
                        TextField(job.isRunning ? "Steer subagent…" : "Message subagent…", text: $followUpText)
                            .textFieldStyle(.roundedBorder)
                        Button("Send") {
                            Task { await sendFollowUp() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(followUpText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .padding()
                    .background(palette.surface)
                }
            }
            .background(palette.background)
            .navigationTitle(job.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                while !Task.isCancelled {
                    await pollTranscript()
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        }
    }

    private func pollTranscript() async {
        guard let client = store.activeClient, let file = job.transcript else { return }
        do {
            let res = try await client.fetchSubagentTranscript(file: file, etag: etag)
            if case .updated(let body, let nextEtag) = res {
                transcript = body
                etag = nextEtag
                isLoading = false
            } else {
                isLoading = false
            }
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    private func sendFollowUp() async {
        let msg = followUpText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty, let client = store.activeClient else { return }
        followUpText = ""
        do {
            if job.isRunning {
                _ = try await client.steerSubagent(sessionId: session.id, subagentId: job.id, message: msg)
            } else if let file = job.transcript {
                _ = try await client.messageSubagent(sessionId: session.id, file: file, message: msg)
            }
            await pollTranscript()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct BackgroundLogSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    let title: String
    let file: String

    @State private var logText: String = ""
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(palette.red).padding()
                } else if isLoading && logText.isEmpty {
                    SkeletonListPlaceholder(count: 6).padding()
                } else {
                    Text(SGRParser.stripANSI(logText))
                        .font(.caption.monospaced())
                        .foregroundStyle(palette.foreground)
                        .textSelection(.enabled)
                        .padding()
                }
            }
            .background(palette.codeBackground)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await loadLog() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .task {
                await loadLog()
            }
        }
    }

    private func loadLog() async {
        guard let client = store.activeClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            logText = try await client.fetchLog(file: file).text
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
