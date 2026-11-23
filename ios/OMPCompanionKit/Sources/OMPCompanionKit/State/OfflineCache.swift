import Foundation

public struct CachedHostState: Codable, Sendable {
    public var hostID: UUID
    public var savedAt: Date
    public var snapshot: StoreSnapshot
    public var transcripts: [String: [TranscriptMessage]]
    public var diffs: [String: ChangesWorktreeResponse]
    public var activity: [ActivityItem]

    public init(
        hostID: UUID,
        savedAt: Date = Date(),
        snapshot: StoreSnapshot,
        transcripts: [String: [TranscriptMessage]] = [:],
        diffs: [String: ChangesWorktreeResponse] = [:],
        activity: [ActivityItem] = []
    ) {
        self.hostID = hostID
        self.savedAt = savedAt
        self.snapshot = snapshot
        self.transcripts = transcripts
        self.diffs = diffs
        self.activity = activity
    }
}

public actor OfflineCache {
    private let baseDirectory: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(directory: URL? = nil) {
        if let directory {
            self.baseDirectory = directory
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            self.baseDirectory = appSupport.appendingPathComponent("OMPCompanion/OfflineCache", isDirectory: true)
        }
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    private func fileURL(for hostID: UUID) -> URL {
        baseDirectory.appendingPathComponent("\(hostID.uuidString).json", isDirectory: false)
    }

    public func load(hostID: UUID) -> CachedHostState? {
        let url = fileURL(for: hostID)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(CachedHostState.self, from: data)
    }

    public func save(
        hostID: UUID,
        snapshot: StoreSnapshot,
        diffs: [String: ChangesWorktreeResponse],
        activity: [ActivityItem]
    ) {
        var strippedSnapshot = snapshot
        var transcripts: [String: [TranscriptMessage]] = [:]

        // Cache up to 40 newest transcripts separately and cap stored message arrays per session to avoid unbounded disk bloat.
        let ordered = snapshot.sessions.prefix(40)
        for s in ordered {
            if let msgs = s.messages, !msgs.isEmpty {
                transcripts[s.id] = Array(msgs.suffix(300))
            }
        }
        strippedSnapshot.sessions = snapshot.sessions.map { s in
            var copy = s
            copy.messages = nil
            copy._btw = nil
            return copy
        }
        strippedSnapshot.activity = nil

        let trimmedDiffs = Dictionary(uniqueKeysWithValues: diffs.prefix(20).map { ($0.key, $0.value) })
        let payload = CachedHostState(
            hostID: hostID,
            savedAt: Date(),
            snapshot: strippedSnapshot,
            transcripts: transcripts,
            diffs: trimmedDiffs,
            activity: Array(activity.prefix(200))
        )

        do {
            try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
            try excludeFromBackup(baseDirectory)
            let data = try encoder.encode(payload)
            // Transcripts and diffs can hold code and secrets: encrypted while the device is locked, and never in
            // iCloud or computer backups (they are a cache of what the companion already has).
            let url = fileURL(for: hostID)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            try excludeFromBackup(url)
        } catch {
            // Non-fatal offline cache persistence failure
        }
    }

    private func excludeFromBackup(_ url: URL) throws {
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try target.setResourceValues(values)
    }

    public func clear(hostID: UUID) {
        try? FileManager.default.removeItem(at: fileURL(for: hostID))
    }

    public func hydratedSnapshot(from cache: CachedHostState) -> StoreSnapshot {
        var snapshot = cache.snapshot
        snapshot.activity = cache.activity
        snapshot.sessions = snapshot.sessions.map { s in
            var copy = s
            if let cachedMsgs = cache.transcripts[s.id] {
                copy.messages = cachedMsgs
            }
            return copy
        }
        return snapshot
    }
}
