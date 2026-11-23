import SwiftUI

/// The session's messages held on this phone while the PC was unreachable (`PromptOutbox`), above the composer: waiting
/// to go out on their own, being sent, or failed and left to the user to send again, edit or delete.
struct OutboxQueueBar: View {
    @Environment(\.ompPalette) private var palette
    let store: AppStore
    let sessionID: String
    /// Edit: the item is taken out of the outbox and handed back to the composer.
    var onEdit: (OutboxItem) -> Void

    init(store: AppStore, sessionID: String, onEdit: @escaping (OutboxItem) -> Void) {
        self.store = store
        self.sessionID = sessionID
        self.onEdit = onEdit
    }

    var body: some View {
        let items = store.outboxItems(sessionID: sessionID)
        VStack(alignment: .leading, spacing: 6) {
            if !items.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "tray.and.arrow.up")
                        .font(.caption)
                        .foregroundStyle(palette.amber)
                    Text(items.count == 1 ? "1 message on this phone" : "\(items.count) messages on this phone")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                }
                .accessibilityElement(children: .combine)
                ForEach(items) { item in
                    row(item)
                }
            }
        }
        .padding(.horizontal, items.isEmpty ? 0 : 12)
        .padding(.vertical, items.isEmpty ? 0 : 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(items.isEmpty ? Color.clear : palette.amberSoft.opacity(0.45))
        .overlay(alignment: .top) {
            if !items.isEmpty { Divider().overlay(palette.border) }
        }
        .task(id: store.activeHost?.id) {
            await store.loadOutbox()
        }
    }

    @ViewBuilder
    private func row(_ item: OutboxItem) -> some View {
        let tint = item.state == .failed ? palette.red : palette.amber
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: item.state == .failed ? "exclamationmark.circle" : "clock")
                .font(.caption)
                .foregroundStyle(tint)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(statusLine(item))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tint)
                    .lineLimit(3)
                Text(preview(item))
                    .font(.caption)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(2)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 4)

            if item.state == .sending {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Sending")
            } else {
                Button {
                    Task { await store.sendOutboxItemNow(item.id) }
                } label: {
                    Image(systemName: "arrow.up.circle")
                        .font(.subheadline)
                        .foregroundStyle(palette.accent)
                }
                .accessibilityLabel(item.state == .failed ? "Send this message again" : "Send this message now")

                Button {
                    onEdit(item)
                } label: {
                    Image(systemName: "pencil")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                }
                .accessibilityLabel("Edit this message in the composer")

                Button {
                    Task { await store.deleteOutboxItem(item.id) }
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                        .foregroundStyle(palette.red)
                }
                .accessibilityLabel("Delete this message")
            }
        }
        .buttonStyle(.borderless)
    }

    private func statusLine(_ item: OutboxItem) -> String {
        switch item.state {
        case .pending: return "Waiting to send"
        case .sending: return "Sending…"
        case .failed: return "Failed: \(item.lastError ?? "not sent")"
        }
    }

    private func preview(_ item: OutboxItem) -> String {
        var parts: [String] = []
        let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { parts.append(text) }
        if !item.images.isEmpty { parts.append(item.images.count == 1 ? "1 image" : "\(item.images.count) images") }
        if !item.pdfs.isEmpty { parts.append(item.pdfs.count == 1 ? "1 PDF" : "\(item.pdfs.count) PDFs") }
        return parts.joined(separator: " · ")
    }
}
