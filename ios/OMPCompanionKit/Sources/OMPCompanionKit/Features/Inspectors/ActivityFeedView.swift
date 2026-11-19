import SwiftUI

public struct ActivityFeedView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    private enum SeverityFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case errors = "Errors"
        case reviews = "Ready"
        case done = "Done"

        var id: String { rawValue }
    }

    @State private var severity: SeverityFilter = .all
    @State private var selectedProjectId: String = ""
    @State private var searchText: String = ""

    public init(store: AppStore) {
        self.store = store
    }

    private var filteredItems: [ActivityItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.activityItems.filter { item in
            switch severity {
            case .errors where item.type != "error": return false
            case .reviews where item.type != "review": return false
            case .done where item.type != "done": return false
            default: break
            }
            if !selectedProjectId.isEmpty && item.projectId != selectedProjectId {
                return false
            }
            if !q.isEmpty {
                let projName = store.snapshot.projects.first(where: { $0.id == item.projectId })?.name.lowercased() ?? ""
                return item.text.lowercased().contains(q) || projName.contains(q)
            }
            return true
        }
    }

    public var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Severity", selection: $severity) {
                        ForEach(SeverityFilter.allCases) { f in
                            Text(f.rawValue).tag(f)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

                    if !store.visibleProjects.isEmpty {
                        Picker("Workspace", selection: $selectedProjectId) {
                            Text("All Workspaces").tag("")
                            ForEach(store.visibleProjects) { p in
                                Text(p.name).tag(p.id)
                            }
                        }
                        .listRowBackground(palette.card)
                    }
                }

                if filteredItems.isEmpty {
                    Section {
                        OMPEmptyStateView(
                            systemImage: "bell.slash",
                            title: "No Activity Recorded",
                            message: "Completions, errors, and workspace alerts appear here."
                        )
                        .listRowBackground(Color.clear)
                    }
                } else {
                    Section("Events (\(filteredItems.count))") {
                        ForEach(filteredItems) { item in
                            Button {
                                if let sid = item.sessionId,
                                   store.snapshot.sessions.contains(where: { $0.id == sid }) {
                                    dismiss()
                                    Task { await store.selectSession(sid, tab: .chat) }
                                }
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: icon(for: item.type))
                                        .foregroundStyle(color(for: item.type))
                                        .padding(.top, 2)

                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item.text)
                                            .font(.subheadline)
                                            .foregroundStyle(palette.foreground)
                                            .multilineTextAlignment(.leading)

                                        HStack(spacing: 8) {
                                            if let pid = item.projectId,
                                               let proj = store.snapshot.projects.first(where: { $0.id == pid }) {
                                                Text(proj.name)
                                                    .font(.caption2.weight(.semibold))
                                                    .foregroundStyle(Color.fromCSS(proj.color))
                                            }
                                            Text(CompanionFormatters.relativeDate(item.at))
                                                .font(.caption2)
                                                .foregroundStyle(palette.muted)
                                        }
                                    }
                                    Spacer()
                                    if item.sessionId != nil {
                                        Image(systemName: "chevron.right")
                                            .font(.caption2)
                                            .foregroundStyle(palette.muted)
                                    }
                                }
                                .padding(.vertical, 3)
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(palette.card)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .searchable(text: $searchText, prompt: "Search activity events…")
            .refreshable {
                await store.refreshActivityOnly()
            }
            .navigationTitle("Global Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await store.refreshActivityOnly() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .task {
                await store.refreshActivityOnly()
            }
        }
    }

    private func icon(for type: String) -> String {
        switch type {
        case "error": return "exclamationmark.octagon.fill"
        case "review": return "checkmark.bubble.fill"
        case "done": return "checkmark.circle.fill"
        case "paused": return "pause.circle.fill"
        default: return "bolt.circle.fill"
        }
    }

    private func color(for type: String) -> Color {
        switch type {
        case "error": return palette.red
        case "review": return palette.amber
        case "done": return palette.green
        case "paused": return palette.muted
        default: return palette.accent
        }
    }
}
