import Foundation

public struct TranscriptSyncCursor: Hashable, Sendable {
    public var epochRev: String
    public var order: [String]
    public var messages: [TranscriptMessage]

    public init(epochRev: String, order: [String], messages: [TranscriptMessage]) {
        self.epochRev = epochRev
        self.order = order
        self.messages = messages
    }
}

public final class SyncDeltaReducer: @unchecked Sendable {
    public private(set) var storeToken: String?
    public private(set) var transcriptCursors: [String: TranscriptSyncCursor] = [:]

    public init() {}

    public func reset() {
        storeToken = nil
        transcriptCursors.removeAll()
    }

    public func sinceToken(for sessionId: String?) -> String? {
        guard let sessionId, !sessionId.isEmpty else { return nil }
        return transcriptCursors[sessionId]?.epochRev
    }

    /// Applies `orderEdit` (`drop`, `at`, `del`, `add`, `n`) matching `companion/sync.mjs`.
    /// Returns `nil` if the local held order does not match preconditions so the caller can fall back to a full transcript fetch.
    public static func applyOrderEdit(currentOrder: [String], edit: OrderEdit) -> [String]? {
        guard edit.drop >= 0, edit.drop <= currentOrder.count else { return nil }
        var base = Array(currentOrder.dropFirst(edit.drop))
        guard edit.at >= 0, edit.del >= 0, edit.at + edit.del <= base.count else { return nil }
        base.replaceSubrange(edit.at..<(edit.at + edit.del), with: edit.add)
        guard base.count == edit.n else { return nil }
        return base
    }

    /// Elements by id; a repeated id keeps the later element instead of trapping like `uniqueKeysWithValues`.
    static func keyedByID<T: Identifiable>(_ items: [T]) -> [T.ID: T] {
        Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { _, later in later })
    }

    public func apply(
        poll: StatePollResponse,
        viewedSessionId: String?,
        currentSnapshot: StoreSnapshot
    ) -> (snapshot: StoreSnapshot, needsFullTranscriptRetry: Bool) {
        var next = currentSnapshot
        var retryTranscript = false

        // 1. Merge store summary & top fields
        if let sx = poll.sx {
            if let top = sx.top {
                next.projects = top.projects
                next.archived = top.archived
                next.pinned = top.pinned
                next.ui = top.ui
                next.drafts = top.drafts
                next.editor = top.editor
                next.enhanceMode = top.enhanceMode
                next.accountChoices = top.accountChoices
                next.instance = top.instance
                next.canRestart = top.canRestart
                next.autoShutdown = top.autoShutdown
            }

            var byId = Self.keyedByID(next.sessions)
            for incoming in sx.changed ?? [] {
                var merged = incoming
                if merged.messages == nil, let existing = byId[incoming.id] {
                    merged.messages = existing.messages
                }
                if merged._btw == nil, let existing = byId[incoming.id] {
                    merged._btw = existing._btw
                }
                byId[merged.id] = merged
            }

            if let order = sx.order {
                var seen = Set<String>()
                next.sessions = order.compactMap { id in seen.insert(id).inserted ? byId[id] : nil }
            } else {
                var updated: [SessionSummary] = []
                var seen = Set<String>()
                for old in next.sessions {
                    if let cur = byId[old.id] {
                        updated.append(cur)
                        seen.insert(old.id)
                    }
                }
                for incoming in sx.changed ?? [] where !seen.contains(incoming.id) {
                    updated.append(byId[incoming.id] ?? incoming)
                    seen.insert(incoming.id)
                }
                next.sessions = updated
            }

            storeToken = "\(sx.epoch).\(sx.rev)"
        } else if let fullSessions = poll.sessions {
            let oldById = Self.keyedByID(next.sessions)
            if let projects = poll.projects { next.projects = projects }
            if let archived = poll.archived { next.archived = archived }
            if let pinned = poll.pinned { next.pinned = pinned }
            if let ui = poll.ui { next.ui = ui }
            if let drafts = poll.drafts { next.drafts = drafts }
            if let editor = poll.editor { next.editor = editor }
            if let enhanceMode = poll.enhanceMode { next.enhanceMode = enhanceMode }
            if let accountChoices = poll.accountChoices { next.accountChoices = accountChoices }
            if let activity = poll.activity { next.activity = activity }
            if let instance = poll.instance { next.instance = instance }
            if let canRestart = poll.canRestart { next.canRestart = canRestart }
            if let autoShutdown = poll.autoShutdown { next.autoShutdown = autoShutdown }

            next.sessions = fullSessions.map { incoming in
                var item = incoming
                if item.messages == nil, let existing = oldById[incoming.id] {
                    item.messages = existing.messages
                }
                if item._btw == nil, let existing = oldById[incoming.id] {
                    item._btw = existing._btw
                }
                return item
            }
        }

        // 2. Merge viewed session transcript delta
        if let tx = poll.tx {
            let sid = tx.session
            if let whole = tx.messages {
                let order = whole.map(\.id)
                if let epoch = tx.epoch, let rev = tx.rev {
                    transcriptCursors[sid] = TranscriptSyncCursor(epochRev: "\(epoch).\(rev)", order: order, messages: whole)
                }
                if let idx = next.sessions.firstIndex(where: { $0.id == sid }) {
                    next.sessions[idx].messages = whole
                }
            } else {
                let prior = transcriptCursors[sid]
                var msgMap = Self.keyedByID(prior?.messages ?? next.sessions.first(where: { $0.id == sid })?.messages ?? [])
                for msg in tx.changed ?? [] {
                    msgMap[msg.id] = msg
                }

                let targetOrder: [String]?
                if let explicitOrder = tx.order {
                    targetOrder = explicitOrder
                } else if let edit = tx.orderEdit {
                    let baseOrder = prior?.order ?? next.sessions.first(where: { $0.id == sid })?.messages?.map(\.id) ?? []
                    targetOrder = Self.applyOrderEdit(currentOrder: baseOrder, edit: edit)
                    if targetOrder == nil {
                        transcriptCursors.removeValue(forKey: sid)
                        retryTranscript = true
                    }
                } else {
                    targetOrder = prior?.order ?? next.sessions.first(where: { $0.id == sid })?.messages?.map(\.id)
                }

                if let order = targetOrder {
                    let resolved = order.compactMap { msgMap[$0] }
                    if let epoch = tx.epoch, let rev = tx.rev {
                        transcriptCursors[sid] = TranscriptSyncCursor(epochRev: "\(epoch).\(rev)", order: order, messages: resolved)
                    }
                    if let idx = next.sessions.firstIndex(where: { $0.id == sid }) {
                        next.sessions[idx].messages = resolved
                    }
                }
            }
        }

        // 3. Merge /btw records on the viewed session
        if let btw = poll.btw, let sid = viewedSessionId,
           let idx = next.sessions.firstIndex(where: { $0.id == sid }) {
            next.sessions[idx]._btw = btw
        }

        // 4. Trim transcript cache to 16 recent sessions to keep memory lean on mobile
        if transcriptCursors.count > 16 {
            let activeIds = Set(next.sessions.prefix(16).map(\.id))
            for key in transcriptCursors.keys where key != viewedSessionId && !activeIds.contains(key) {
                transcriptCursors.removeValue(forKey: key)
                if transcriptCursors.count <= 16 { break }
            }
        }

        return (next, retryTranscript)
    }

    /// Integrates a direct command reply (`SessionSummary`) for a session into snapshot + cursor.
    public func integrateSessionReply(_ session: SessionSummary, into snapshot: inout StoreSnapshot) {
        if let idx = snapshot.sessions.firstIndex(where: { $0.id == session.id }) {
            var merged = session
            if merged.messages == nil {
                merged.messages = snapshot.sessions[idx].messages
            }
            if merged._btw == nil {
                merged._btw = snapshot.sessions[idx]._btw
            }
            snapshot.sessions[idx] = merged
        } else {
            snapshot.sessions.insert(session, at: 0)
        }
        if let msgs = session.messages, var cursor = transcriptCursors[session.id] {
            cursor.messages = msgs
            cursor.order = msgs.map(\.id)
            transcriptCursors[session.id] = cursor
        }
    }
}
