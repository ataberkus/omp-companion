import Foundation
import Observation

/// A message the composer could not hand to the PC, held on this phone until it can be: by `AppStore.flushOutbox` on
/// its own while `pending`, or by the user (Send now) once `failed`.
public struct OutboxItem: Codable, Identifiable, Hashable, Sendable {
    public enum State: String, Codable, Sendable {
        /// Never reached the PC: sent automatically, in order, once it answers.
        case pending
        /// On the wire now. Read back from disk (the app ended mid-send) it becomes `failed`: the PC may have it.
        case sending
        /// Refused by the PC, or sent without an answer so it may have arrived: only the user sends it again.
        case failed
    }

    public let id: UUID
    public let hostID: UUID
    public let sessionID: String
    /// The session's host draft, cleared once this message is delivered (it was cleared on the phone when queued).
    public let draftKey: String
    public var text: String
    public var images: [PendingImageAttachment]
    public var pdfs: [PendingPdfAttachment]
    public let createdAt: Date
    public var lastError: String?
    public var state: State

    public init(
        id: UUID = UUID(),
        hostID: UUID,
        sessionID: String,
        draftKey: String,
        text: String,
        images: [PendingImageAttachment],
        pdfs: [PendingPdfAttachment],
        createdAt: Date = Date(),
        lastError: String? = nil,
        state: State = .pending
    ) {
        self.id = id
        self.hostID = hostID
        self.sessionID = sessionID
        self.draftKey = draftKey
        self.text = text
        self.images = images
        self.pdfs = pdfs
        self.createdAt = createdAt
        self.lastError = lastError
        self.state = state
    }

    /// Base64 the item holds, images and PDFs together.
    public var attachmentBytes: Int {
        images.reduce(0) { $0 + $1.base64Data.utf8.count } + pdfs.reduce(0) { $0 + $1.base64Data.utf8.count }
    }
}

public enum PromptOutboxError: LocalizedError, Sendable {
    case full(limit: Int)
    case attachmentsTooLarge
    case unavailable
    case notSaved(String)

    public var errorDescription: String? {
        switch self {
        case .full(let limit):
            return "\(limit) messages already wait to be sent to this PC. Delete one, or send this when the PC is reachable."
        case .attachmentsTooLarge:
            return "Messages waiting for this PC would hold over 45 MB of images and PDFs. Remove an attachment, or send this when the PC is reachable."
        case .unavailable:
            return "Messages waiting for this PC cannot be read until the device is unlocked."
        case .notSaved(let reason):
            return "The message could not be saved on this phone: \(reason)"
        }
    }
}

/// What the composer keeps of a draft on the phone itself (UserDefaults, per host and session) when the PC cannot
/// store it, so nothing typed is lost; images and PDFs stay with the host draft only.
public struct LocalComposerDraft: Codable, Sendable {
    public var text: String
    public var savedAt: Date

    public init(text: String, savedAt: Date = Date()) {
        self.text = text
        self.savedAt = savedAt
    }
}

/// The outbox files, one per host: encrypted while the device is locked and never in iCloud or computer backups, like
/// `OfflineCache`. Writes carry a version so an older one that arrives late never replaces a newer one.
actor PromptOutboxStorage {
    private let baseDirectory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var latestVersion: [UUID: UInt64] = [:]

    init(directory: URL?) {
        if let directory {
            self.baseDirectory = directory
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            self.baseDirectory = appSupport.appendingPathComponent("OMPCompanion/Outbox", isDirectory: true)
        }
    }

    private func fileURL(for hostID: UUID) -> URL {
        baseDirectory.appendingPathComponent("\(hostID.uuidString).json", isDirectory: false)
    }

    /// The host's items; none without a file. Throws when the file exists but cannot be read (data protection while
    /// the device is locked), so the caller retries rather than overwriting it. An undecodable file is set aside.
    func load(hostID: UUID) throws -> [OutboxItem] {
        let url = fileURL(for: hostID)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let data = try Data(contentsOf: url)
        do {
            return try decoder.decode([OutboxItem].self, from: data)
        } catch {
            let aside = baseDirectory.appendingPathComponent("\(hostID.uuidString).unreadable-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: url, to: aside)
            return []
        }
    }

    func save(hostID: UUID, items: [OutboxItem], version: UInt64) throws {
        if let latest = latestVersion[hostID], version < latest { return }
        latestVersion[hostID] = version
        let url = fileURL(for: hostID)
        if items.isEmpty {
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            return
        }
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        try excludeFromBackup(baseDirectory)
        let data = try encoder.encode(items)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        try excludeFromBackup(url)
    }

    func clear(hostID: UUID, version: UInt64) {
        latestVersion[hostID] = version
        try? FileManager.default.removeItem(at: fileURL(for: hostID))
    }

    private func excludeFromBackup(_ url: URL) throws {
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try target.setResourceValues(values)
    }
}

/// Messages waiting for their PC, per host, in the order they were written. Changes are in memory at once (the UI and
/// `flushOutbox` read them synchronously) and on disk before an `async` mutation returns, so an item is never on the
/// wire unless the file says `sending`.
@Observable
@MainActor
public final class PromptOutbox {
    public static let maxItems = 25
    /// The host's `DRAFT_ATTACH_MAX`, for all of one host's waiting messages together.
    public static let maxAttachmentBytes = PdfAttachmentProcessor.maxDraftAttachmentBytes

    public private(set) var itemsByHost: [UUID: [OutboxItem]] = [:]

    private let storage: PromptOutboxStorage
    @ObservationIgnored private var loadedHosts: Set<UUID> = []
    @ObservationIgnored private var loadTasks: [UUID: Task<Bool, Never>] = [:]
    @ObservationIgnored private var version: UInt64 = 0

    public init(directory: URL? = nil) {
        self.storage = PromptOutboxStorage(directory: directory)
    }

    // MARK: - Reading

    public func items(hostID: UUID) -> [OutboxItem] {
        itemsByHost[hostID] ?? []
    }

    public func items(hostID: UUID, sessionID: String) -> [OutboxItem] {
        items(hostID: hostID).filter { $0.sessionID == sessionID }
    }

    public func item(_ id: UUID, hostID: UUID) -> OutboxItem? {
        items(hostID: hostID).first { $0.id == id }
    }

    /// Items still to be sent on their own (or being sent): a new message of that session must go behind them.
    public func hasUnsent(hostID: UUID, sessionID: String) -> Bool {
        items(hostID: hostID).contains { $0.sessionID == sessionID && $0.state != .failed }
    }

    public func hasPending(hostID: UUID) -> Bool {
        items(hostID: hostID).contains { $0.state == .pending }
    }

    public func isLoaded(hostID: UUID) -> Bool {
        loadedHosts.contains(hostID)
    }

    /// Reads the host's file once; false while it cannot be read (the device is locked). Concurrent calls share one read.
    @discardableResult
    public func load(hostID: UUID) async -> Bool {
        if loadedHosts.contains(hostID) { return true }
        if let running = loadTasks[hostID] { return await running.value }
        let task = Task { [storage] () -> Bool in
            guard var items = try? await storage.load(hostID: hostID) else { return false }
            guard !self.loadedHosts.contains(hostID) else { return true }
            // The app ended while these were on the wire: the PC may have them, so they wait for the user.
            var interrupted = false
            for index in items.indices where items[index].state == .sending {
                items[index].state = .failed
                items[index].lastError = "Sending was interrupted, so the PC may have received this message. Check the transcript before sending it again."
                interrupted = true
            }
            self.itemsByHost[hostID] = items
            self.loadedHosts.insert(hostID)
            if interrupted { try? await self.persist(hostID: hostID) }
            return true
        }
        loadTasks[hostID] = task
        let loaded = await task.value
        loadTasks[hostID] = nil
        return loaded
    }

    // MARK: - Changes

    /// Adds an item behind the host's others, saved to disk before this returns; throws (holding nothing) when the
    /// outbox is full, would pass the attachment cap, or cannot be saved.
    public func enqueue(_ item: OutboxItem) async throws {
        guard await load(hostID: item.hostID) else { throw PromptOutboxError.unavailable }
        let existing = items(hostID: item.hostID)
        guard existing.count < Self.maxItems else { throw PromptOutboxError.full(limit: Self.maxItems) }
        guard existing.reduce(0, { $0 + $1.attachmentBytes }) + item.attachmentBytes <= Self.maxAttachmentBytes else {
            throw PromptOutboxError.attachmentsTooLarge
        }
        itemsByHost[item.hostID, default: []].append(item)
        do {
            try await persist(hostID: item.hostID)
        } catch {
            itemsByHost[item.hostID]?.removeAll { $0.id == item.id }
            throw PromptOutboxError.notSaved(error.localizedDescription)
        }
    }

    /// Sets an item's state at once in memory, then on disk; throws if the disk write failed (the memory change stays).
    public func update(_ id: UUID, hostID: UUID, state: OutboxItem.State, lastError: String?) async throws {
        guard let index = itemsByHost[hostID]?.firstIndex(where: { $0.id == id }) else { return }
        itemsByHost[hostID]?[index].state = state
        itemsByHost[hostID]?[index].lastError = lastError
        try await persist(hostID: hostID)
    }

    /// Removes an item. A failed write leaves it on disk, where the next launch reads it as `failed` at worst (never
    /// sent again on its own).
    public func remove(_ id: UUID, hostID: UUID) async {
        guard itemsByHost[hostID]?.contains(where: { $0.id == id }) == true else { return }
        itemsByHost[hostID]?.removeAll { $0.id == id }
        try? await persist(hostID: hostID)
    }

    /// Drops everything held for a host (the host was removed).
    public func clear(hostID: UUID) async {
        itemsByHost[hostID] = nil
        loadedHosts.remove(hostID)
        version &+= 1
        await storage.clear(hostID: hostID, version: version)
    }

    private func persist(hostID: UUID) async throws {
        version &+= 1
        try await storage.save(hostID: hostID, items: items(hostID: hostID), version: version)
    }

    /// The `lastError` of a message sent without an answer.
    public nonisolated static func uncertainDeliveryMessage(_ error: Error) -> String {
        "No answer from the PC (\(error.localizedDescription)), so it may have received this message. Check the transcript before sending it again."
    }
}
