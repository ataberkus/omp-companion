import Foundation

/// The side of a diff a line number counts on: removed lines carry their old number, context and added lines their new one.
public enum DiffSide: String, Codable, Hashable, Sendable {
    case old = "o"
    case new = "n"
}

/// A diff line a review comment can attach to.
public struct DiffLineAnchor: Hashable, Sendable {
    public let side: DiffSide
    public let line: Int

    public init(side: DiffSide, line: Int) {
        self.side = side
        self.line = line
    }
}

/// One context, removed or added line with its old/new line numbers (nil where the diff carries none).
public struct DiffLine: Hashable, Sendable {
    public let kind: DiffRowKind
    public let oldLine: Int?
    public let newLine: Int?
    public let text: String
    /// The number shown in a single-column (unified) gutter.
    public let label: String
    /// The changed span, in characters, of a removed line paired with an added one (word-level highlight).
    public let mark: Range<Int>?

    public init(kind: DiffRowKind, oldLine: Int?, newLine: Int?, text: String, label: String, mark: Range<Int>? = nil) {
        self.kind = kind
        self.oldLine = oldLine
        self.newLine = newLine
        self.text = text
        self.label = label
        self.mark = mark
    }

    public var anchor: DiffLineAnchor? {
        switch kind {
        case .delete: return oldLine.map { DiffLineAnchor(side: .old, line: $0) }
        case .add, .context: return newLine.map { DiffLineAnchor(side: .new, line: $0) }
        case .hunkHeader, .note: return nil
        }
    }

    func marked(_ mark: Range<Int>?) -> DiffLine {
        DiffLine(kind: kind, oldLine: oldLine, newLine: newLine, text: text, label: label, mark: mark)
    }
}

public struct DiffDisplayRow: Identifiable, Hashable, Sendable {
    public enum Content: Hashable, Sendable {
        /// A hunk separator (`⋯ line N`, `@@ … @@`) or a note such as `… (binary file)`.
        case gap(kind: DiffRowKind, text: String)
        /// Unified layout: one line.
        case line(DiffLine)
        /// Split layout: the old and new columns of one row; a context line fills both.
        case pair(old: DiffLine?, new: DiffLine?)
    }

    public let id: Int
    public let content: Content
}

/// Display rows for the diff viewer, as the web dashboard's diff table builds them: removed/added runs are paired so
/// changed lines line up (split) and get a word-level mark of what changed.
public enum DiffLayout {
    /// Lines past this many characters get no word-level mark.
    public static let maxMarkedLineLength = 10_000

    public static func rows(_ rawDiff: String, split: Bool) -> [DiffDisplayRow] {
        var out: [DiffDisplayRow] = []
        var dels: [DiffLine] = []
        var adds: [DiffLine] = []

        func append(_ content: DiffDisplayRow.Content) {
            out.append(DiffDisplayRow(id: out.count, content: content))
        }
        func flush() {
            guard !dels.isEmpty || !adds.isEmpty else { return }
            let marks = dels.indices.map { i in i < adds.count ? wordMarks(dels[i].text, adds[i].text) : nil }
            let d = dels.indices.map { dels[$0].marked(marks[$0]?.old) }
            let a = adds.indices.map { adds[$0].marked($0 < marks.count ? marks[$0]?.new : nil) }
            if split {
                for i in 0..<max(d.count, a.count) {
                    append(.pair(old: i < d.count ? d[i] : nil, new: i < a.count ? a[i] : nil))
                }
            } else {
                d.forEach { append(.line($0)) }
                a.forEach { append(.line($0)) }
            }
            dels.removeAll()
            adds.removeAll()
        }

        var delta = 0
        var lastOld: Int?
        var lastNew: Int?
        var pendingGap = false
        var started = false
        for row in DiffParser.parse(rawDiff) {
            switch row.kind {
            case .hunkHeader, .note:
                flush()
                lastOld = nil
                lastNew = nil
                // The blank line between OMP hunks becomes a gap naming the line the next hunk starts at.
                if row.kind == .hunkHeader && row.text == "⋯" {
                    pendingGap = true
                } else {
                    append(.gap(kind: row.kind, text: row.text))
                    started = true
                }
            case .context, .delete, .add:
                let number = Int(row.lineNumber)
                let old: Int? = row.kind == .add ? nil : number
                let new: Int? = row.kind == .delete ? nil : (row.kind == .context ? number.map { $0 + delta } : number)
                // One edit can touch distant places: a jump in line numbers starts a new hunk.
                if row.kind == .add {
                    if let lastNew, let new, new != lastNew + 1 { pendingGap = true }
                } else if let lastOld, let old, old != lastOld + 1 {
                    pendingGap = true
                }
                if pendingGap || (!started && (old ?? new ?? 1) > 1) {
                    flush()
                    append(.gap(kind: .hunkHeader, text: (old ?? new).map { "⋯ line \($0)" } ?? "⋯"))
                    pendingGap = false
                }
                started = true

                let label: String
                switch row.kind {
                case .delete: label = old.map { String($0) } ?? row.lineNumber
                default: label = new.map { String($0) } ?? row.lineNumber
                }
                let line = DiffLine(kind: row.kind, oldLine: old, newLine: new, text: row.text, label: label)
                switch row.kind {
                case .context:
                    flush()
                    append(split ? .pair(old: line, new: line) : .line(line))
                    lastOld = old
                    lastNew = new
                case .delete:
                    if !adds.isEmpty { flush() }
                    dels.append(line)
                    lastOld = old
                    delta -= 1
                default:
                    adds.append(line)
                    lastNew = new
                    delta += 1
                }
            }
        }
        flush()
        return out
    }

    /// A new file has nothing on the left, so it always shows unified.
    public static func isCreation(op: String?, rawDiff: String) -> Bool {
        if op == "create" || op == "write" { return true }
        var firstAdd: String?
        for row in DiffParser.parse(rawDiff) {
            switch row.kind {
            case .context, .delete: return false
            case .add: if firstAdd == nil { firstAdd = row.lineNumber }
            case .hunkHeader, .note: continue
            }
        }
        return firstAdd == "1"
    }

    /// The changed middle of two lines after their common prefix and suffix, or nil when they share nothing or most of
    /// both lines changed (the web dashboard's `wordMarks`). Characters are grapheme clusters, so emoji never split.
    public static func wordMarks(_ a: String, _ b: String) -> (old: Range<Int>, new: Range<Int>)? {
        guard a.utf8.count <= maxMarkedLineLength * 4, b.utf8.count <= maxMarkedLineLength * 4 else { return nil }
        let x = Array(a)
        let y = Array(b)
        guard x.count <= maxMarkedLineLength, y.count <= maxMarkedLineLength else { return nil }
        var p = 0
        while p < x.count, p < y.count, x[p] == y[p] { p += 1 }
        var s = 0
        while s < x.count - p, s < y.count - p, x[x.count - 1 - s] == y[y.count - 1 - s] { s += 1 }
        let changedOld = x.count - p - s
        let changedNew = y.count - p - s
        if p + s == 0 || (Double(changedOld) > Double(x.count) * 0.7 && Double(changedNew) > Double(y.count) * 0.7) {
            return nil
        }
        return (p..<(x.count - s), p..<(y.count - s))
    }
}
