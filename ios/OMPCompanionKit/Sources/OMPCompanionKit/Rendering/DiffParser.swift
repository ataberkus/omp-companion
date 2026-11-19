import Foundation

public enum DiffRowKind: Equatable, Sendable {
    case context
    case add
    case delete
    case hunkHeader
    case note
}

public struct ParsedDiffRow: Identifiable, Hashable, Sendable {
    public let id: Int
    public let kind: DiffRowKind
    public let lineNumber: String
    public let text: String

    public init(id: Int, kind: DiffRowKind, lineNumber: String, text: String) {
        self.id = id
        self.kind = kind
        self.lineNumber = lineNumber
        self.text = text
    }
}

public struct DiffStats: Equatable, Sendable {
    public let additions: Int
    public let deletions: Int
}

public enum DiffParser {
    /// Parses both OMP's line-numbered diff format (`"  12|ctx"`, `"- 12|old"`, `"+ 13|new"`)
    /// and standard unified diff lines (`@@ ... @@`, `+...`, `-...`).
    public static func parse(_ rawDiff: String) -> [ParsedDiffRow] {
        guard !rawDiff.isEmpty else { return [] }
        let lines = rawDiff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var rows: [ParsedDiffRow] = []
        rows.reserveCapacity(lines.count)

        for (index, line) in lines.enumerated() {
            if line.isEmpty {
                if !rows.isEmpty && rows.last?.kind != .hunkHeader {
                    rows.append(ParsedDiffRow(id: index, kind: .hunkHeader, lineNumber: "", text: "⋯"))
                }
                continue
            }

            if line.hasPrefix("@@") || line.hasPrefix("---") || line.hasPrefix("+++") || line.hasPrefix("diff ") || line.hasPrefix("index ") {
                rows.append(ParsedDiffRow(id: index, kind: .hunkHeader, lineNumber: "", text: line))
                continue
            }

            // OMP line-numbered format: [+- ]<digits or spaces>|<content>
            if let pipeIdx = line.firstIndex(of: "|") {
                let prefix = String(line[..<pipeIdx])
                let firstChar = prefix.first
                let numberPart = prefix.dropFirst().trimmingCharacters(in: .whitespaces)
                if (firstChar == "+" || firstChar == "-" || firstChar == " "),
                   numberPart.isEmpty || numberPart.allSatisfy(\.isNumber) {
                    let content = String(line[line.index(after: pipeIdx)...])
                    let kind: DiffRowKind = firstChar == "+" ? .add : (firstChar == "-" ? .delete : .context)
                    rows.append(ParsedDiffRow(id: index, kind: kind, lineNumber: numberPart, text: content))
                    continue
                }
            }

            // Standard unified diff fallback
            if line.hasPrefix("+") {
                rows.append(ParsedDiffRow(id: index, kind: .add, lineNumber: "+", text: String(line.dropFirst())))
            } else if line.hasPrefix("-") {
                rows.append(ParsedDiffRow(id: index, kind: .delete, lineNumber: "-", text: String(line.dropFirst())))
            } else if line.hasPrefix(" ") {
                rows.append(ParsedDiffRow(id: index, kind: .context, lineNumber: "", text: String(line.dropFirst())))
            } else {
                rows.append(ParsedDiffRow(id: index, kind: .note, lineNumber: "", text: line))
            }
        }
        return rows
    }

    public static func stats(for rawDiff: String?) -> DiffStats {
        guard let rawDiff, !rawDiff.isEmpty else {
            return DiffStats(additions: 0, deletions: 0)
        }
        var adds = 0
        var dels = 0
        for row in parse(rawDiff) {
            if row.kind == .add { adds += 1 }
            else if row.kind == .delete { dels += 1 }
        }
        return DiffStats(additions: adds, deletions: dels)
    }
}
