import Foundation

/// Run state of a tool call as the companion reports it (`running | done | error`).
public enum ToolRunStatus: String, Hashable, Sendable {
    case running
    case done
    case error

    public init(_ raw: String) {
        self = ToolRunStatus(rawValue: raw.lowercased()) ?? .done
    }

    public var label: String {
        switch self {
        case .running: return "Running"
        case .done: return "Done"
        case .error: return "Error"
        }
    }
}

/// What a tool card shows for one call, read from the call's JSON arguments the way the desktop dashboard does
/// (`keyArg`/`clippedArgs` in local-dist/app.js): the command of a shell call, the file of a read/edit/write, the
/// pattern of a search, then the remaining arguments as label/value rows.
public struct ToolCallSummary: Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case command
        case path
        case search
        case other
    }

    public struct Argument: Hashable, Sendable, Identifiable {
        public var id: String { key }
        public let key: String
        public let value: String
    }

    public let name: String
    public let status: ToolRunStatus
    public let kind: Kind
    /// The argument the card leads with, whole (a full command, a full path).
    public let primary: String?
    /// `primary` for the collapsed card: a path keeps its last three components.
    public let primaryShort: String?
    public let intent: String?
    public let arguments: [Argument]
    public let durationMs: Int?
    public let exitCode: Int?

    private static let pathKeys = ["path", "file_path", "file", "filePath"]
    private static let commandKeys = ["command", "code"]
    private static let searchKeys = ["pattern", "query", "glob"]
    private static let otherKeys = ["url", "op", "id"]
    private static let hiddenKeys: Set<String> = ["i", "intent"]

    public init(tool: ToolRecord, fallbackText: String = "") {
        name = tool.name
        status = ToolRunStatus(tool.status)
        durationMs = tool.ms
        exitCode = tool.exitCode
        let trimmedIntent = tool.intent?.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        intent = (trimmedIntent?.isEmpty == false) ? trimmedIntent : nil

        let rawArgs = tool.args ?? ""
        var args = Self.parseObject(rawArgs) ?? Self.recoverClipped(rawArgs)
        if let command = tool.command, !command.isEmpty, args["command"] == nil {
            args["command"] = .string(command)
        }
        var consumed: Set<String> = []
        var kind: Kind = .other
        var primary: String?
        let taskNames = args["tasks"]?.arrayValue?.compactMap { $0.objectValue?["name"]?.stringValue } ?? []
        if let key = Self.firstStringKey(Self.pathKeys, in: args) {
            kind = .path
            primary = args[key]?.stringValue
            consumed.insert(key)
        } else if let key = Self.firstStringKey(Self.commandKeys, in: args) {
            kind = .command
            primary = args[key]?.stringValue
            consumed.insert(key)
        } else if !taskNames.isEmpty {
            primary = taskNames.joined(separator: ", ")
            consumed.insert("tasks")
        } else if let key = Self.firstStringKey(Self.searchKeys, in: args) {
            kind = .search
            primary = args[key]?.stringValue
            consumed.insert(key)
        } else if let key = Self.firstStringKey(Self.otherKeys, in: args) {
            primary = args[key]?.stringValue
            consumed.insert(key)
        }
        if primary == nil, args.isEmpty {
            // Neither parsed nor recovered: show the call's own text rather than nothing.
            let text = rawArgs.isEmpty ? fallbackText : rawArgs
            let trimmed = text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            if !trimmed.isEmpty, trimmed != "{}" { primary = trimmed }
        }
        self.kind = kind
        self.primary = primary
        self.primaryShort = primary.map { kind == .path ? Self.shortPath($0) : $0 }

        // Multi-line bodies of a call that already shows its diff (write content, edit hunks) would repeat the diff.
        let hasDiff = !(tool.files?.isEmpty ?? true)
        arguments = args.keys.sorted().compactMap { key in
            guard !consumed.contains(key), !Self.hiddenKeys.contains(key), let value = args[key] else { return nil }
            let text = Self.display(value)
            if text.isEmpty || (hasDiff && text.contains("\n")) { return nil }
            return Argument(key: key, value: text)
        }
    }

    /// "820 ms", "4.2 s", "1m 05s".
    public var durationLabel: String? {
        guard let ms = durationMs, ms >= 0 else { return nil }
        if ms < 1000 { return "\(ms) ms" }
        if ms < 60_000 { return String(format: ms < 10_000 ? "%.1f s" : "%.0f s", Double(ms) / 1000) }
        let seconds = ms / 1000
        return "\(seconds / 60)m \(String(format: "%02d", seconds % 60))s"
    }

    /// The spoken description of the card, e.g. "bash command: git status, Done, 820 ms".
    public var accessibilityLabel: String {
        var parts: [String] = []
        if let subject = primary.map(Self.firstLine) {
            switch kind {
            case .command: parts.append("\(name) command: \(subject)")
            case .path: parts.append("\(name) file: \(subject)")
            case .search: parts.append("\(name) search: \(subject)")
            case .other: parts.append("\(name): \(subject)")
            }
        } else {
            parts.append("\(name) tool")
        }
        parts.append(status.label)
        if let durationLabel { parts.append(durationLabel) }
        if let exitCode { parts.append("exit code \(exitCode)") }
        return parts.joined(separator: ", ")
    }

    // MARK: - Argument parsing

    private static func firstLine(_ text: String) -> String {
        text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? text
    }

    private static func firstStringKey(_ keys: [String], in args: [String: JSONValue]) -> String? {
        keys.first { args[$0]?.stringValue?.isEmpty == false }
    }

    static func parseObject(_ text: String) -> [String: JSONValue]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONDecoder().decode(JSONValue.self, from: data))?.objectValue
    }

    /// The companion clips arguments at 6,000 characters, which leaves invalid JSON: recover the leading string fields.
    static func recoverClipped(_ text: String) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for key in pathKeys + commandKeys + searchKeys {
            let pattern = "\"\(NSRegularExpression.escapedPattern(for: key))\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)"
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  let range = Range(match.range(at: 1), in: text) else {
                continue
            }
            out[key] = .string(unescape(String(text[range])))
        }
        return out
    }

    private static func unescape(_ body: String) -> String {
        var candidate = body
        // A clip can cut an escape in half ("\" or "\u12"): drop the broken tail before decoding.
        if let regex = try? NSRegularExpression(pattern: "\\\\(u[0-9a-fA-F]{0,3})?$"),
           let match = regex.firstMatch(in: candidate, range: NSRange(candidate.startIndex..., in: candidate)),
           let range = Range(match.range, in: candidate) {
            candidate.removeSubrange(range)
        }
        guard let data = "\"\(candidate)\"".data(using: .utf8),
              let decoded = try? JSONDecoder().decode(String.self, from: data) else {
            return body
        }
        return decoded
    }

    private static func display(_ value: JSONValue) -> String {
        switch value {
        case .null: return ""
        case .array, .object:
            guard let data = try? JSONEncoder.compactSorted.encode(value),
                  let text = String(data: data, encoding: .utf8) else {
                return value.displayString
            }
            return text
        default:
            return value.displayString
        }
    }

    /// `…/Sources/Kit/File.swift` for paths with more than three components.
    public static func shortPath(_ path: String) -> String {
        let parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        guard parts.count > 3 else { return path }
        return "…/" + parts.suffix(3).joined(separator: "/")
    }
}

extension JSONEncoder {
    static let compactSorted: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
