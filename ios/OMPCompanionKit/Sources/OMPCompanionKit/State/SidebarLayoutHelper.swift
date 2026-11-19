import Foundation

public enum SidebarGroupBy: String, CaseIterable, Identifiable, Sendable {
    case time
    case project

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .time: return "Status"
        case .project: return "Project"
        }
    }
}

public enum SidebarTimeBucket: String, CaseIterable, Identifiable, Sendable {
    case pinned = "Pinned"
    case working = "Working now"
    case review = "Needs your review"
    case today = "Today"
    case yesterday = "Yesterday"
    case previous7Days = "Previous 7 days"
    case older = "Older"

    public var id: String { rawValue }
    public var title: String { rawValue }
}

public enum SidebarLayoutHelper {
    public static let attentionGroupKey = "@attention"

    /// Normalizes a workspace path the same way `local-dist/app.js` `norm()` does,
    /// so Windows and POSIX path separators and casing compare identically across devices.
    public static func normalizePathKey(_ path: String) -> String {
        path.replacingOccurrences(of: "/", with: "\\").lowercased()
    }

    public static func baseName(_ path: String) -> String {
        var trimmed = path
        while trimmed.hasSuffix("/") || trimmed.hasSuffix("\\") {
            trimmed.removeLast()
        }
        let parts = trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        return parts.last.map(String.init) ?? (path.isEmpty ? "Workspace" : path)
    }

    /// Stable color for an unregistered folder, matching `pathColor()` in `local-dist/app.js`.
    public static func pathColor(_ path: String) -> String {
        var h: UInt32 = 0
        for scalar in normalizePathKey(path).unicodeScalars {
            let code = UInt32(scalar.value & 0xFFFF)
            h = h &* 31 &+ code
        }
        return "oklch(.72 .12 \(h % 360))"
    }

    public static func isCollapsedMatch(_ storedKey: String, groupKey: String, legacyProjectID: String? = nil) -> Bool {
        if storedKey == groupKey { return true }
        if let legacyProjectID, !legacyProjectID.isEmpty, storedKey == legacyProjectID { return true }
        if groupKey == attentionGroupKey || SidebarTimeBucket(rawValue: groupKey) != nil {
            return storedKey == groupKey
        }
        return normalizePathKey(storedKey) == normalizePathKey(groupKey)
    }

    /// Reconciles `groupOrder` using the web companion's `groupOrder()` rules:
    /// - Legacy iOS-saved `project.id` entries migrate to `project.path`.
    /// - New workspaces (`visibleKeys`) not yet in `groupOrder` go on top once.
    /// - Once native history is loaded (`allowPrune`), folders with no sessions anywhere leave `groupOrder`.
    public static func reconcileGroupOrder(
        saved: [String],
        visibleKeys: [String],
        presentNormalizedKeys: Set<String>,
        projects: [WorkspaceProject],
        allowPrune: Bool
    ) -> (order: [String], didChange: Bool) {
        let projectsByID = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var didChange = false

        var migrated: [String] = []
        var seenSaved = Set<String>()
        for raw in saved {
            let mapped: String
            if let proj = projectsByID[raw] {
                mapped = proj.path
                if mapped != raw { didChange = true }
            } else {
                mapped = raw
            }
            let norm = normalizePathKey(mapped)
            guard !norm.isEmpty else {
                didChange = true
                continue
            }
            if seenSaved.insert(norm).inserted {
                migrated.append(mapped)
            } else {
                didChange = true
            }
        }

        let kept: [String]
        if allowPrune {
            let filtered = migrated.filter { presentNormalizedKeys.contains(normalizePathKey($0)) }
            if filtered.count != migrated.count { didChange = true }
            kept = filtered
        } else {
            kept = migrated
        }

        var known = Set(kept.map(normalizePathKey))
        var fresh: [String] = []
        for key in visibleKeys {
            let norm = normalizePathKey(key)
            guard !norm.isEmpty else { continue }
            if known.insert(norm).inserted {
                fresh.append(key)
            }
        }
        if !fresh.isEmpty { didChange = true }

        return (fresh + kept, didChange)
    }

    /// Orders projects according to `groupOrder` (normalized path, with fallback for legacy `project.id`),
    /// placing workspaces not yet in `groupOrder` on top.
    public static func orderedProjects(projects: [WorkspaceProject], groupOrder: [String]) -> [WorkspaceProject] {
        guard !groupOrder.isEmpty else { return projects }
        var rankByNorm = [String: Int]()
        for raw in groupOrder {
            let norm = normalizePathKey(raw)
            if rankByNorm[norm] == nil {
                rankByNorm[norm] = rankByNorm.count
            }
        }

        var fresh: [WorkspaceProject] = []
        var ranked: [(rank: Int, project: WorkspaceProject)] = []
        for project in projects {
            if let r = rankByNorm[normalizePathKey(project.path)] ?? rankByNorm[normalizePathKey(project.id)] {
                ranked.append((r, project))
            } else {
                fresh.append(project)
            }
        }
        ranked.sort { $0.rank < $1.rank }
        return fresh + ranked.map(\.project)
    }

    /// Splices `key` before `beforeKey` (`nil` moves to the end), matching `moveGroup(key, beforeKey)` in `local-dist/app.js`.
    public static func moveGroup(
        key: String,
        beforeKey: String?,
        currentOrder: [String],
        visibleKeys: [String]
    ) -> [String] {
        var order: [String] = []
        var seen = Set<String>()
        for k in currentOrder + visibleKeys {
            let norm = normalizePathKey(k)
            if !norm.isEmpty && seen.insert(norm).inserted {
                order.append(k)
            }
        }

        let targetNorm = normalizePathKey(key)
        order.removeAll { normalizePathKey($0) == targetNorm }

        if let beforeKey {
            let beforeNorm = normalizePathKey(beforeKey)
            if let idx = order.firstIndex(where: { normalizePathKey($0) == beforeNorm }) {
                order.insert(key, at: idx)
            } else {
                order.append(key)
            }
        } else {
            order.append(key)
        }
        return order
    }

    public static func parseISODate(_ isoString: String?) -> Date? {
        guard let isoString, !isoString.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: isoString) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: isoString)
    }

    /// Matches `ago(iso)` in `local-dist/app.js`: `now`, `5m`, `2h`, `3d`, or `Oct 12`.
    public static func formatCompactAgo(_ isoString: String?, now: Date = Date()) -> String {
        guard let date = parseISODate(isoString) else { return "" }
        let seconds = now.timeIntervalSince(date)
        if !seconds.isFinite { return "" }
        if seconds < 45 { return "now" }
        if seconds < 3600 { return "\(max(1, Int((seconds / 60).rounded())))m" }
        if seconds < 86400 { return "\(Int((seconds / 3600).rounded()))h" }
        if seconds < 86400 * 7 { return "\(Int((seconds / 86400).rounded()))d" }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "MMM d"
        return fmt.string(from: date)
    }

    /// Matches `fmtMs(ms)` in `local-dist/app.js`.
    public static func formatDurationMs(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        if ms < 60_000 {
            let sec = Double(ms) / 1000.0
            return ms < 10_000 ? String(format: "%.1fs", sec) : String(format: "%.0fs", sec)
        }
        let seconds = Int((Double(ms) / 1000.0).rounded())
        let hours = seconds / 3600
        let mins = (seconds % 3600) / 60
        let secs = seconds % 60
        return (hours > 0 ? "\(hours)h " : "") + "\(mins)m \(secs)s"
    }

    /// Matches `workTime(s)` in `local-dist/app.js`: `"Running 5m 54s"` or `"Last run 1m 23s"`.
    public static func formatWorkDuration(startedAt: String?, finishedAt: String?, now: Date = Date()) -> String? {
        guard let start = parseISODate(startedAt) else { return nil }
        let end = finishedAt.flatMap { parseISODate($0) } ?? now
        let rawMs = max(0, Int(floor(end.timeIntervalSince(start))) * 1000)
        let prefix = finishedAt != nil ? "Last run " : "Running "
        return prefix + (rawMs > 0 ? formatDurationMs(rawMs) : "0s")
    }
}

public struct ParsedSidebarSearch: Hashable, Sendable {
    public let terms: [String]
    public let scopes: [String]
    public let isEmpty: Bool

    public init(query: String) {
        let words = query
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        var parsedScopes: [String] = []
        var parsedTerms: [String] = []
        for word in words {
            if word.count > 3 && word.hasPrefix("in:") {
                parsedScopes.append(String(word.dropFirst(3)))
            } else {
                parsedTerms.append(word)
            }
        }
        self.terms = parsedTerms
        self.scopes = parsedScopes
        self.isEmpty = words.isEmpty
    }

    public func matches(
        title: String,
        cwd: String,
        folderName: String,
        branch: String? = nil,
        model: String? = nil,
        preview: String? = nil
    ) -> Bool {
        if !scopes.isEmpty {
            let folderLower = folderName.lowercased()
            let normCwd = SidebarLayoutHelper.normalizePathKey(cwd)
            let scopeMatched = scopes.contains { scope in
                folderLower.contains(scope) || normCwd.contains(SidebarLayoutHelper.normalizePathKey(scope))
            }
            if !scopeMatched { return false }
        }
        guard !terms.isEmpty else { return true }
        let haystack = [title, cwd, folderName, branch ?? "", model ?? "", preview ?? ""]
            .joined(separator: " ")
            .lowercased()
        return terms.allSatisfy { haystack.contains($0) }
    }
}

public enum UsageFormatting {
    public static func percentage(fraction: Double?) -> Int? {
        guard let fraction, fraction.isFinite else { return nil }
        let clamped = max(0.0, fraction * 100.0)
        return Int(clamped.rounded())
    }

    /// Matches `usageReset(t)` in `local-dist/app.js`:
    /// - `<= 0` -> `"resetting"`
    /// - `< 24h` -> `"resets in 2h 5m"` / `"resets in 15m"`
    /// - `>= 24h` -> `"Resets Tue 14:00"`
    public static func resetLabel(resetsAtMs: Double?, fallback: String?, now: Date = Date()) -> String? {
        guard let resetsAtMs, resetsAtMs.isFinite else {
            return fallback
        }
        let ms = resetsAtMs - now.timeIntervalSince1970 * 1000.0
        if ms <= 0 {
            return "resetting"
        }
        if ms < 86_400_000.0 {
            let totalMinutes = Int((ms / 60_000.0).rounded())
            let hours = totalMinutes / 60
            let mins = totalMinutes % 60
            return hours > 0 ? "resets in \(hours)h \(mins)m" : "resets in \(mins)m"
        }
        let date = Date(timeIntervalSince1970: resetsAtMs / 1000.0)
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "EEE HH:mm"
        return "Resets " + fmt.string(from: date)
    }

    public static func updatedClockLabel(isoString: String?, fallbackDate: Date? = nil) -> String? {
        let date = SidebarLayoutHelper.parseISODate(isoString) ?? fallbackDate
        guard let date else { return nil }
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm"
        return "Updated " + fmt.string(from: date)
    }

    public static func unavailableMessage(_ reason: String) -> String {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Remaining quota unavailable." }
        let suffix = trimmed.hasSuffix(".") ? "" : "."
        return "Remaining quota unavailable: \(trimmed)\(suffix)"
    }
}
