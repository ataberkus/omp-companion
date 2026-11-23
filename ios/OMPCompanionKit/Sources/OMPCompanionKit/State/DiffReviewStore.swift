import Foundation

/// A review comment on one diff line. Removed lines are addressed by their old line number.
public struct DiffReviewNote: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var path: String
    public var side: DiffSide
    public var line: Int
    public var text: String

    public init(id: String = UUID().uuidString, path: String, side: DiffSide, line: Int, text: String) {
        self.id = id
        self.path = path
        self.side = side
        self.line = line
        self.text = text
    }
}

private struct ScopedEntry<Value: Codable>: Codable {
    var key: String
    var value: Value
}

/// Changes-review state the web dashboard keeps client-side in localStorage (`omp-viewed`, `omp-review-notes`), kept on
/// this device in UserDefaults per host and session. "Viewed" records the signature of the diff that was marked, so a
/// file whose diff changes again unfolds itself; comments stay until they are sent or deleted.
public struct DiffReviewStore {
    static let viewedDefaultsKey = "omp.diffViewed.v1"
    static let notesDefaultsKey = "omp.diffReviewNotes.v1"
    /// Most recently written scopes kept, as the web trims its maps.
    static let maxViewedScopes = 200
    static let maxNoteScopes = 100

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public static func scope(hostID: UUID?, sessionID: String) -> String {
        "\(hostID?.uuidString ?? "-")|\(sessionID)"
    }

    /// The web's `fileSig` for one file: count of diffs, then a djb2-xor hash of their text in base 36.
    public static func signature(of diff: String?) -> String {
        var hash: UInt32 = 5381
        for unit in (diff ?? "").utf16 {
            hash = (hash &* 33) ^ UInt32(unit)
        }
        return "1." + String(hash, radix: 36)
    }

    // MARK: Viewed

    /// File path → signature of the diff it was marked viewed at.
    public func viewedFiles(scope: String) -> [String: String] {
        load([String: String].self, key: Self.viewedDefaultsKey).first { $0.key == scope }?.value ?? [:]
    }

    @discardableResult
    public func setViewed(_ viewed: Bool, path: String, signature: String, scope: String) -> [String: String] {
        var files = viewedFiles(scope: scope)
        if viewed { files[path] = signature } else { files.removeValue(forKey: path) }
        store(files.isEmpty ? nil : files, scope: scope, key: Self.viewedDefaultsKey, limit: Self.maxViewedScopes)
        return files
    }

    // MARK: Comments

    public func notes(scope: String) -> [DiffReviewNote] {
        load([DiffReviewNote].self, key: Self.notesDefaultsKey).first { $0.key == scope }?.value ?? []
    }

    public func saveNotes(_ notes: [DiffReviewNote], scope: String) {
        store(notes.isEmpty ? nil : notes, scope: scope, key: Self.notesDefaultsKey, limit: Self.maxNoteScopes)
    }

    /// The web's "Request changes" message: one line per comment, `path:line: note`, paths relative to the session folder,
    /// sorted by path then line; removed lines carry their old line number and say so.
    public static func reviewMessage(_ notes: [DiffReviewNote], cwd: String) -> String {
        notes
            .sorted { a, b in
                let order = a.path.localizedCompare(b.path)
                return order == .orderedSame ? a.line < b.line : order == .orderedAscending
            }
            .map { note in
                let text = note.text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: "\n  ")
                return "\(relativePath(note.path, cwd: cwd)):\(note.line): \(note.side == .old ? "(removed line) " : "")\(text)"
            }
            .joined(separator: "\n")
    }

    /// The path as the agent sees it: relative to the session folder when inside it.
    public static func relativePath(_ path: String, cwd: String) -> String {
        func normalized(_ s: String) -> String {
            var out = s.replacingOccurrences(of: "\\", with: "/")
            while out.hasSuffix("/") { out.removeLast() }
            return out
        }
        let file = normalized(path)
        let folder = normalized(cwd)
        guard !folder.isEmpty, file.lowercased().hasPrefix(folder.lowercased() + "/") else { return file }
        return String(file.dropFirst(folder.count + 1))
    }

    // MARK: Storage

    private func load<Value: Codable>(_: Value.Type, key: String) -> [ScopedEntry<Value>] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([ScopedEntry<Value>].self, from: data)) ?? []
    }

    /// Writes (or with nil removes) one scope's value, moving it to the newest end and dropping the oldest past `limit`.
    private func store<Value: Codable>(_ value: Value?, scope: String, key: String, limit: Int) {
        var entries = load(Value.self, key: key).filter { $0.key != scope }
        if let value { entries.append(ScopedEntry(key: scope, value: value)) }
        if entries.count > limit { entries.removeFirst(entries.count - limit) }
        if entries.isEmpty {
            defaults.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(entries) {
            defaults.set(data, forKey: key)
        }
    }
}
