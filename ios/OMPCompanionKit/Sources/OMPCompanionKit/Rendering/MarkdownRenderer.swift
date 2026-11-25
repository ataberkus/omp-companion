import Foundation
import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

// MARK: - Block AST

public enum MarkdownBlock: Identifiable, Equatable, Sendable {
    case heading(id: Int, level: Int, text: String)
    case paragraph(id: Int, text: String)
    case codeBlock(id: Int, language: String, code: String)
    case mathBlock(id: Int, tex: String)
    /// Quotes hold blocks: a quote can carry lists, headings, code and nested quotes.
    case blockquote(id: Int, blocks: [MarkdownBlock])
    /// Each item holds blocks, so `- a` followed by an indented `- b` nests instead of flattening.
    case list(id: Int, ordered: Bool, items: [MarkdownListItem])
    case table(id: Int, headers: [String], rows: [[String]], alignments: [MarkdownTableAlignment])
    case thematicBreak(id: Int)

    public var id: Int {
        switch self {
        case .heading(let id, _, _),
             .paragraph(let id, _),
             .codeBlock(let id, _, _),
             .mathBlock(let id, _),
             .blockquote(let id, _),
             .list(let id, _, _),
             .table(let id, _, _, _),
             .thematicBreak(let id):
            return id
        }
    }
}

/// Column alignment from a GFM separator row: `:--` leading, `:-:` center, `--:` trailing.
public enum MarkdownTableAlignment: Equatable, Sendable {
    case leading
    case center
    case trailing
}

public struct MarkdownListItem: Equatable, Sendable {
    public let indexLabel: String?
    public let checked: Bool?
    public let blocks: [MarkdownBlock]
}

// MARK: - Linear O(N) Parser & Math Formatter

public enum MarkdownParser {
    public static func parse(_ raw: String) -> [MarkdownBlock] {
        parseBlocks(raw, depth: 0)
    }

    /// Quotes and list items are parsed as blocks, so nesting recurses. Past 20 levels (crafted
    /// `- - - …` or `>>>>…`) the rest reads as one paragraph, as the web client caps it.
    private static let maxNestingDepth = 20

    private static func parseBlocks(_ raw: String, depth: Int) -> [MarkdownBlock] {
        guard !raw.isEmpty else { return [] }
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        var blocks: [MarkdownBlock] = []
        var nextId = 0
        func makeId() -> Int { defer { nextId += 1 }; return nextId }

        if depth > maxNestingDepth {
            let joined = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
            return joined.isEmpty ? [] : [.paragraph(id: makeId(), text: joined)]
        }

        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var i = 0
        var paraBuffer: [String] = []
        var unclosedDisplayDelimiters: Set<String> = []

        func flushParagraph() {
            guard !paraBuffer.isEmpty else { return }
            let joined = paraBuffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                blocks.append(.paragraph(id: makeId(), text: joined))
            }
            paraBuffer.removeAll(keepingCapacity: true)
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // 1. Fenced code block ``` or ~~~ (and math / latex / tex formula fences)
            if let openFence = parseFenceOpen(trimmed) {
                flushParagraph()
                var codeLines: [String] = []
                var closed = false
                i += 1
                while i < lines.count {
                    if isFenceClose(lines[i].trimmingCharacters(in: .whitespaces), char: openFence.char, minCount: openFence.count) {
                        closed = true
                        i += 1
                        break
                    }
                    codeLines.append(lines[i])
                    i += 1
                }
                let code = codeLines.joined(separator: "\n")
                if closed && KaTeXValidator.isFormula(code: code, language: openFence.language) {
                    blocks.append(.mathBlock(id: makeId(), tex: code.trimmingCharacters(in: .whitespacesAndNewlines)))
                } else {
                    blocks.append(.codeBlock(id: makeId(), language: openFence.language, code: code))
                }
                continue
            }

            // 2. Display math block $$...$$ or \[...\]
            if trimmed.hasPrefix("$$") || trimmed.hasPrefix("\\[") {
                if let parsedMath = parseDisplayMathBlock(lines: lines, startIndex: i, trimmedLine: trimmed, unclosed: &unclosedDisplayDelimiters) {
                    flushParagraph()
                    blocks.append(.mathBlock(id: makeId(), tex: parsedMath.tex))
                    i = parsedMath.nextIndex
                    continue
                }
            }
            // 3. Blank line
            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            // 4. ATX Heading (closing `#`s are decoration)
            if let heading = parseHeading(trimmed) {
                flushParagraph()
                blocks.append(.heading(id: makeId(), level: heading.level, text: heading.text))
                i += 1
                continue
            }

            // 5. Thematic break: `---`, `***`, `___`, `- - -`, `****` …
            if isThematicBreak(trimmed) {
                flushParagraph()
                blocks.append(.thematicBreak(id: makeId()))
                i += 1
                continue
            }

            // 6. GFM Table
            if i + 1 < lines.count, trimmed.contains("|"), isTableSeparator(lines[i + 1]) {
                flushParagraph()
                let headers = splitTableRow(trimmed)
                let alignments = tableAlignments(lines[i + 1])
                i += 2
                var rows: [[String]] = []
                while i < lines.count {
                    let rt = lines[i].trimmingCharacters(in: .whitespaces)
                    if rt.isEmpty || !rt.contains("|") { break }
                    rows.append(splitTableRow(rt))
                    i += 1
                }
                blocks.append(.table(id: makeId(), headers: headers, rows: rows, alignments: alignments))
                continue
            }

            // 7. Blockquote, with lazy continuation lines and nested blocks
            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoteLines: [String] = []
                while i < lines.count {
                    let quoteLine = lines[i]
                    let qt = quoteLine.trimmingCharacters(in: .whitespaces)
                    if qt.isEmpty {
                        // A blank line keeps the quote going while the next one is still quoted.
                        guard i + 1 < lines.count,
                              lines[i + 1].trimmingCharacters(in: .whitespaces).hasPrefix(">") else { break }
                        quoteLines.append("")
                        i += 1
                        continue
                    }
                    if qt.hasPrefix(">") {
                        quoteLines.append(stripQuoteMarker(quoteLine))
                        i += 1
                        continue
                    }
                    // Lazy continuation: an unquoted line that does not start another block stays in the quote.
                    guard !isBlockStart(quoteLine) else { break }
                    quoteLines.append(quoteLine)
                    i += 1
                }
                blocks.append(.blockquote(id: makeId(), blocks: parseBlocks(quoteLines.joined(separator: "\n"), depth: depth + 1)))
                continue
            }

            // 8. Bullet / Ordered / Task Lists, with nested blocks
            if let marker = parseListMarker(line) {
                flushParagraph()
                let baseIndent = indentWidth(line)
                let ordered = marker.ordered
                var listLines: [String] = []
                while i < lines.count {
                    let current = lines[i]
                    if current.trimmingCharacters(in: .whitespaces).isEmpty {
                        // A blank line stays in the list before a deeper block or another item.
                        guard i + 1 < lines.count else { break }
                        let next = lines[i + 1]
                        let nextIndent = indentWidth(next)
                        let nextKind = parseListMarker(next)?.ordered
                        if nextIndent > baseIndent || (nextKind == ordered && nextIndent == baseIndent) {
                            listLines.append("")
                            i += 1
                            continue
                        }
                        break
                    }
                    let indent = indentWidth(current)
                    if indent < baseIndent { break }
                    if indent == baseIndent {
                        if let nextMarker = parseListMarker(current) {
                            if nextMarker.ordered != ordered { break }
                        } else if isBlockStart(current) {
                            break
                        }
                    }
                    listLines.append(current)
                    i += 1
                }
                blocks.append(.list(id: makeId(), ordered: ordered, items: parseListItems(listLines, baseIndent: baseIndent, depth: depth)))
                continue
            }

            // 9. Plain paragraph line
            paraBuffer.append(line)
            i += 1
        }
        flushParagraph()
        return blocks
    }

    private static func parseFenceOpen(_ trimmed: String) -> (char: Character, count: Int, language: String)? {
        guard let first = trimmed.first, first == "`" || first == "~" else { return nil }
        var count = 0
        for ch in trimmed {
            if ch == first { count += 1 } else { break }
        }
        guard count >= 3 else { return nil }
        let rest = String(trimmed.dropFirst(count)).trimmingCharacters(in: .whitespaces)
        // Info string of backtick fence cannot contain backticks (CommonMark)
        if first == "`" && rest.contains("`") { return nil }
        let language = rest.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        return (first, count, language)
    }

    private static func isFenceClose(_ trimmed: String, char: Character, minCount: Int) -> Bool {
        var count = 0
        for ch in trimmed {
            if ch == char { count += 1 } else { break }
        }
        guard count >= minCount else { return false }
        return trimmed.dropFirst(count).allSatisfy(\.isWhitespace)
    }

    private static func parseDisplayMathBlock(
        lines: [String],
        startIndex: Int,
        trimmedLine: String,
        unclosed: inout Set<String>
    ) -> (tex: String, nextIndex: Int)? {
        let closeMarker = trimmedLine.hasPrefix("$$") ? "$$" : "\\]"
        if unclosed.contains(closeMarker) { return nil }

        var bodyLines: [String] = []
        var rest = String(trimmedLine.dropFirst(2))
        var j = startIndex
        while true {
            if let endRange = rest.range(of: closeMarker) {
                let afterClose = rest[endRange.upperBound...]
                if !afterClose.trimmingCharacters(in: .whitespaces).isEmpty {
                    return nil
                }
                bodyLines.append(String(rest[..<endRange.lowerBound]))
                let tex = bodyLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                return tex.isEmpty ? nil : (tex, j + 1)
            }
            bodyLines.append(rest)
            j += 1
            if j >= lines.count {
                unclosed.insert(closeMarker)
                return nil
            }
            rest = lines[j]
        }
    }

    private static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        var count = 0
        for ch in line {
            if ch == "#" { count += 1 } else { break }
        }
        guard (1...6).contains(count) else { return nil }
        let rest = line.dropFirst(count)
        guard rest.first?.isWhitespace == true else { return nil }
        let text = String(rest.dropFirst()).trimmingCharacters(in: .whitespaces)
        return (count, stripClosingHashes(text))
    }

    /// `## Title ##` is a heading titled `Title`; `# C#` keeps its `#`.
    private static func stripClosingHashes(_ text: String) -> String {
        var body = text
        var hashes = 0
        while body.hasSuffix("#") {
            body.removeLast()
            hashes += 1
        }
        guard hashes > 0 else { return text }
        guard body.isEmpty || body.last?.isWhitespace == true else { return text }
        return body.trimmingCharacters(in: .whitespaces)
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("-") && t.contains("|") else { return false }
        let allowed = CharacterSet(charactersIn: "|-: ")
        return t.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private static func tableAlignments(_ line: String) -> [MarkdownTableAlignment] {
        splitTableRow(line).map { cell in
            if cell.hasPrefix(":") && cell.hasSuffix(":") { return .center }
            if cell.hasSuffix(":") { return .trailing }
            return .leading
        }
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") && !t.hasSuffix("\\|") { t.removeLast() }

        let chars = Array(t)
        var cells: [String] = []
        var current = ""
        var i = 0
        var backtickRun = 0

        while i < chars.count {
            let c = chars[i]
            if c == "`" {
                var run = 0
                while i + run < chars.count && chars[i + run] == "`" { run += 1 }
                if backtickRun == 0 {
                    backtickRun = run
                } else if backtickRun == run {
                    backtickRun = 0
                }
                current.append(contentsOf: chars[i..<(i + run)])
                i += run
                continue
            }
            if backtickRun == 0 {
                if c == "\\" && i + 1 < chars.count {
                    let next = chars[i + 1]
                    if next == "|" {
                        current.append("|")
                        i += 2
                        continue
                    }
                    if next == "(" {
                        if let end = findClosingDelimiter(chars, from: i + 2, closeA: "\\", closeB: ")") {
                            current.append(contentsOf: chars[i..<(end + 2)])
                            i = end + 2
                            continue
                        }
                    }
                    current.append(c)
                    current.append(next)
                    i += 2
                    continue
                }
                if c == "$" {
                    if i + 1 < chars.count && chars[i + 1] == "$" {
                        if let end = findClosingDelimiter(chars, from: i + 2, closeA: "$", closeB: "$"), end > i + 2 {
                            current.append(contentsOf: chars[i..<(end + 2)])
                            i = end + 2
                            continue
                        }
                    } else if i + 1 < chars.count && !chars[i + 1].isWhitespace,
                              let end = findClosingDollar(chars, from: i + 1) {
                        current.append(contentsOf: chars[i..<(end + 1)])
                        i = end + 1
                        continue
                    }
                }
                if c == "|" {
                    cells.append(current.trimmingCharacters(in: .whitespaces))
                    current.removeAll(keepingCapacity: true)
                    i += 1
                    continue
                }
            }
            current.append(c)
            i += 1
        }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private struct ListMarker {
        let ordered: Bool
        let indexLabel: String?
        let markerLength: Int
        let text: String
    }

    /// Bullet `- `, `* `, `+ ` or ordered `1. `, `12) ` at any indentation; nil when the line is not an item.
    private static func parseListMarker(_ line: String) -> ListMarker? {
        var rest = Substring(line)
        while let first = rest.first, first == " " || first == "\t" { rest.removeFirst() }
        guard let first = rest.first else { return nil }

        if first == "-" || first == "*" || first == "+" {
            let after = rest.dropFirst()
            guard let space = after.first, space == " " || space == "\t" else { return nil }
            return ListMarker(
                ordered: false,
                indexLabel: nil,
                markerLength: 1,
                text: String(after.drop(while: { $0 == " " || $0 == "\t" }))
            )
        }

        var digits = ""
        for ch in rest {
            if ch.isASCII && ch.isNumber { digits.append(ch) } else { break }
        }
        guard (1...9).contains(digits.count) else { return nil }
        let afterDigits = rest.dropFirst(digits.count)
        guard let delimiter = afterDigits.first, delimiter == "." || delimiter == ")" else { return nil }
        let afterDelimiter = afterDigits.dropFirst()
        guard let space = afterDelimiter.first, space == " " || space == "\t" else { return nil }
        return ListMarker(
            ordered: true,
            indexLabel: "\(digits).",
            markerLength: digits.count + 1,
            text: String(afterDelimiter.drop(while: { $0 == " " || $0 == "\t" }))
        )
    }

    /// Groups a list's lines into items: a marker at the list's indentation starts an item, anything else
    /// continues the previous one (indentation up to the marker width stripped, so nested lists keep their own).
    private static func parseListItems(_ lines: [String], baseIndent: Int, depth: Int) -> [MarkdownListItem] {
        var items: [(label: String?, body: [String], width: Int)] = []
        for line in lines {
            if let marker = parseListMarker(line), indentWidth(line) <= baseIndent + 1 {
                items.append((marker.indexLabel, [marker.text], indentWidth(line) + marker.markerLength + 1))
            } else if !items.isEmpty {
                let width = items[items.count - 1].width
                items[items.count - 1].body.append(stripLeadingIndent(line, maximum: width))
            }
        }
        return items.map { item in
            var body = item.body
            var checked: Bool?
            if let first = body.first {
                if first.hasPrefix("[ ] ") {
                    checked = false
                    body[0] = String(first.dropFirst(4))
                } else if first.hasPrefix("[x] ") || first.hasPrefix("[X] ") {
                    checked = true
                    body[0] = String(first.dropFirst(4))
                }
            }
            return MarkdownListItem(
                indexLabel: item.label,
                checked: checked,
                blocks: parseBlocks(body.joined(separator: "\n"), depth: depth + 1)
            )
        }
    }

    /// Indentation in columns, tabs counted as four, as the web client measures it.
    private static func indentWidth(_ line: String) -> Int {
        var width = 0
        for ch in line {
            if ch == " " { width += 1 }
            else if ch == "\t" { width += 4 }
            else { break }
        }
        return width
    }

    private static func stripLeadingIndent(_ line: String, maximum: Int) -> String {
        var index = line.startIndex
        var removed = 0
        while index < line.endIndex, removed < maximum, line[index] == " " || line[index] == "\t" {
            index = line.index(after: index)
            removed += 1
        }
        return String(line[index...])
    }

    /// Drops the leading whitespace, `>` and its optional space from a quoted line.
    private static func stripQuoteMarker(_ line: String) -> String {
        var rest = Substring(line)
        while let first = rest.first, first.isWhitespace { rest.removeFirst() }
        guard rest.first == ">" else { return line }
        rest.removeFirst()
        if rest.first == " " { rest.removeFirst() }
        return String(rest)
    }

    /// `- - -`, `***`, `___`, `**** …` — three or more of one marker, spaces allowed between them.
    private static func isThematicBreak(_ line: String) -> Bool {
        let body = line.trimmingCharacters(in: .whitespaces)
        guard let marker = body.first, marker == "-" || marker == "*" || marker == "_" else { return false }
        var count = 0
        for ch in body {
            if ch == marker { count += 1 }
            else if ch.isWhitespace { continue }
            else { return false }
        }
        return count >= 3
    }

    /// A line that starts a block, and so ends a blockquote's lazy continuation or a list item's run of lines.
    private static func isBlockStart(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return false }
        if parseFenceOpen(trimmed) != nil { return true }
        if trimmed.hasPrefix("$$") || trimmed.hasPrefix("\\[") { return true }
        if parseHeading(trimmed) != nil { return true }
        if trimmed.hasPrefix(">") { return true }
        if parseListMarker(line) != nil { return true }
        return isThematicBreak(trimmed)
    }

    // MARK: - Inline Formatting & Inline Math ($...$ / \(...\))

    public static func renderInline(_ input: String, palette: OMPPalette) -> AttributedString {
        // Math is swapped for private-use placeholders so Markdown never sees TeX
        // (`_`, `*`, `\`), then each placeholder is replaced by its Unicode rendering.
        let (text, math) = extractInlineMath(in: input)
        var attr = (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
        for run in attr.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                attr[run.range].font = .system(.callout, design: .monospaced)
                attr[run.range].foregroundColor = palette.accent
                attr[run.range].backgroundColor = palette.codeBackground
            } else if run.link != nil {
                attr[run.range].foregroundColor = palette.accent
                attr[run.range].underlineStyle = .single
            }
        }
        for (index, rendered) in math.enumerated() {
            guard let range = attr.range(of: mathPlaceholder(index)) else { continue }
            let attributes = attr[range].runs.first?.attributes ?? AttributeContainer()
            attr.replaceSubrange(range, with: AttributedString(rendered, attributes: attributes))
        }
        return attr
    }

    private static func mathPlaceholder(_ index: Int) -> String { "\u{E000}\(index)\u{E001}" }

    public struct InlineMathToken: Equatable, Sendable {
        public let tex: String
        public let isDisplay: Bool
    }

    public static func containsMath(_ input: String) -> Bool {
        guard input.contains("$") || input.contains("\\(") || input.contains("\\[") else { return false }
        return !extractInlineMathTokens(in: input).tokens.isEmpty
    }

    /// Replaces `$…$`, `$$…$$`, `\(…\)`, and `\[…\]` outside code spans with placeholders;
    /// returns the rewritten text and the Unicode rendering of each formula.
    public static func extractInlineMath(in input: String) -> (text: String, math: [String]) {
        let (text, tokens) = extractInlineMathTokens(in: input)
        return (text, tokens.map { TeXUnicode.convert($0.tex) })
    }

    public static func extractInlineMathTokens(in input: String) -> (text: String, tokens: [InlineMathToken]) {
        guard input.contains("$") || input.contains("\\(") || input.contains("\\[") else { return (input, []) }
        var out = ""
        out.reserveCapacity(input.count)
        var tokens: [InlineMathToken] = []
        let chars = Array(input)
        var i = 0
        var backtickRun = 0

        func emit(_ rawTex: String, isDisplay: Bool) -> Bool {
            let trimmed = rawTex.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return false }
            out.append(mathPlaceholder(tokens.count))
            tokens.append(InlineMathToken(tex: isDisplay ? trimmed : rawTex, isDisplay: isDisplay))
            return true
        }

        while i < chars.count {
            let c = chars[i]
            if c == "`" {
                var run = 0
                while i + run < chars.count && chars[i + run] == "`" { run += 1 }
                if backtickRun == 0 {
                    backtickRun = run
                } else if backtickRun == run {
                    backtickRun = 0
                }
                out.append(contentsOf: chars[i..<(i + run)])
                i += run
                continue
            }
            if backtickRun == 0 && c == "\\" && i + 1 < chars.count {
                let next = chars[i + 1]
                if next == "(" {
                    if let end = findClosingDelimiter(chars, from: i + 2, closeA: "\\", closeB: ")"),
                       emit(String(chars[(i + 2)..<end]), isDisplay: false) {
                        i = end + 2
                        continue
                    }
                } else if next == "[" {
                    if let end = findClosingDelimiter(chars, from: i + 2, closeA: "\\", closeB: "]"),
                       emit(String(chars[(i + 2)..<end]), isDisplay: true) {
                        i = end + 2
                        continue
                    }
                } else if next == "\\" || next == "$" {
                    out.append(c)
                    out.append(next)
                    i += 2
                    continue
                }
            }
            if backtickRun == 0 && c == "$" {
                if i + 1 < chars.count && chars[i + 1] == "$" {
                    if let end = findClosingDelimiter(chars, from: i + 2, closeA: "$", closeB: "$"),
                       end > i + 2,
                       emit(String(chars[(i + 2)..<end]), isDisplay: true) {
                        i = end + 2
                        continue
                    }
                } else if i + 1 < chars.count && !chars[i + 1].isWhitespace,
                          let end = findClosingDollar(chars, from: i + 1),
                          emit(String(chars[(i + 1)..<end]), isDisplay: false) {
                    i = end + 1
                    continue
                }
            }
            out.append(c)
            i += 1
        }
        return (out, tokens)
    }

    /// Converts inline markdown + math into HTML with `<span class="omp-math">` slots for KaTeX.
    public static func renderInlineHTML(_ input: String, hardBreaks: Bool = false) -> String {
        let cleaned = input.replacingOccurrences(of: "\u{0000}", with: "")
        var slots: [String] = []
        func hold(_ html: String) -> String {
            let idx = slots.count
            slots.append(html)
            return "\u{0000}\(idx)\u{0000}"
        }
        func unhold(_ s: String) -> String {
            guard s.contains("\u{0000}") else { return s }
            var out = ""
            out.reserveCapacity(s.count)
            let scalars = Array(s)
            var idx = 0
            while idx < scalars.count {
                if scalars[idx] == "\u{0000}" {
                    var j = idx + 1
                    while j < scalars.count && scalars[j] != "\u{0000}" { j += 1 }
                    if j < scalars.count, let slotIdx = Int(String(scalars[(idx + 1)..<j])), slotIdx < slots.count {
                        out.append(slots[slotIdx])
                        idx = j + 1
                        continue
                    }
                }
                out.append(scalars[idx])
                idx += 1
            }
            return out
        }

        // 1. Hold backtick code spans
        var afterCode = ""
        afterCode.reserveCapacity(cleaned.count)
        let chars = Array(cleaned)
        var i = 0
        while i < chars.count {
            if chars[i] == "`" {
                var run = 0
                while i + run < chars.count && chars[i + run] == "`" { run += 1 }
                var j = i + run
                var foundClose: Int?
                while j < chars.count {
                    if chars[j] == "`" {
                        var closeRun = 0
                        while j + closeRun < chars.count && chars[j + closeRun] == "`" { closeRun += 1 }
                        if closeRun == run {
                            foundClose = j
                            break
                        }
                        j += closeRun
                        continue
                    }
                    j += 1
                }
                if let closeIdx = foundClose, closeIdx > i + run {
                    var codeBody = String(chars[(i + run)..<closeIdx])
                    if codeBody.count >= 2 && codeBody.hasPrefix(" ") && codeBody.hasSuffix(" ") && !codeBody.allSatisfy({ $0 == " " }) {
                        codeBody = String(codeBody.dropFirst().dropLast())
                    }
                    afterCode.append(hold("<code class=\"omp-code\">\(escapeHTML(codeBody))</code>"))
                    i = closeIdx + run
                    continue
                }
                afterCode.append(contentsOf: chars[i..<(i + run)])
                i += run
                continue
            }
            afterCode.append(chars[i])
            i += 1
        }

        // 2. Hold \$ and math spans ($...$, $$...$$, \(...\), \[...\])
        var afterMath = ""
        afterMath.reserveCapacity(afterCode.count)
        let mChars = Array(afterCode)
        i = 0
        while i < mChars.count {
            let c = mChars[i]
            if c == "\\" && i + 1 < mChars.count {
                let next = mChars[i + 1]
                if next == "$" {
                    afterMath.append(hold("$"))
                    i += 2
                    continue
                } else if next == "(" {
                    if let end = findClosingDelimiter(mChars, from: i + 2, closeA: "\\", closeB: ")") {
                        let tex = String(mChars[(i + 2)..<end])
                        if !tex.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !tex.contains("\u{0000}") {
                            afterMath.append(hold("<span class=\"omp-math\" data-display=\"0\" data-tex=\"\(escapeHTML(tex))\"></span>"))
                            i = end + 2
                            continue
                        }
                    }
                } else if next == "[" {
                    if let end = findClosingDelimiter(mChars, from: i + 2, closeA: "\\", closeB: "]") {
                        let tex = String(mChars[(i + 2)..<end])
                        let trimmed = tex.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty && !tex.contains("\u{0000}") {
                            afterMath.append(hold("<span class=\"omp-math\" data-display=\"1\" data-tex=\"\(escapeHTML(trimmed))\"></span>"))
                            i = end + 2
                            continue
                        }
                    }
                } else if next == "\\" {
                    afterMath.append("\\")
                    afterMath.append("\\")
                    i += 2
                    continue
                }
            }
            if c == "$" {
                if i + 1 < mChars.count && mChars[i + 1] == "$" {
                    if let end = findClosingDelimiter(mChars, from: i + 2, closeA: "$", closeB: "$"), end > i + 2 {
                        let tex = String(mChars[(i + 2)..<end])
                        let trimmed = tex.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty && !tex.contains("\u{0000}") {
                            afterMath.append(hold("<span class=\"omp-math\" data-display=\"1\" data-tex=\"\(escapeHTML(trimmed))\"></span>"))
                            i = end + 2
                            continue
                        }
                    }
                } else if i + 1 < mChars.count && !mChars[i + 1].isWhitespace,
                          let end = findClosingDollar(mChars, from: i + 1) {
                    let tex = String(mChars[(i + 1)..<end])
                    if !tex.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !tex.contains("\u{0000}") {
                        afterMath.append(hold("<span class=\"omp-math\" data-display=\"0\" data-tex=\"\(escapeHTML(tex))\"></span>"))
                        i = end + 1
                        continue
                    }
                }
            }
            afterMath.append(c)
            i += 1
        }

        // 3. Links
        var s = afterMath
        s = replaceRegex(Self.autoLinkRegex, in: s) { src, match in
            let u = substring(src, range: match.range(at: 1))
            return hold("<a href=\"\(escapeHTML(u))\">\(escapeHTML(u))</a>")
        }
        s = replaceRegex(Self.mdLinkRegex, in: s) { src, match in
            let label = substring(src, range: match.range(at: 1))
            let url = substring(src, range: match.range(at: 2))
            return hold("<a href=\"\(escapeHTML(url))\">\(unhold(escapeHTML(label)))</a>")
        }
        s = replaceRegex(Self.bareLinkRegex, in: s) { src, match in
            let pre = substring(src, range: match.range(at: 1))
            let url = substring(src, range: match.range(at: 2))
            return pre + hold("<a href=\"\(escapeHTML(url))\">\(escapeHTML(url))</a>")
        }

        // 4. Escape prose and apply emphasis
        s = escapeHTML(s)
        s = replaceRegex(Self.boldStarRegex, in: s) { src, m in "<strong>\(substring(src, range: m.range(at: 1)))</strong>" }
        s = replaceRegex(Self.boldUnderRegex, in: s) { src, m in "<strong>\(substring(src, range: m.range(at: 1)))</strong>" }
        s = replaceRegex(Self.italicStarRegex, in: s) { src, m in "\(substring(src, range: m.range(at: 1)))<em>\(substring(src, range: m.range(at: 2)))</em>" }
        s = replaceRegex(Self.italicUnderRegex, in: s) { src, m in "\(substring(src, range: m.range(at: 1)))<em>\(substring(src, range: m.range(at: 2)))</em>" }
        s = replaceRegex(Self.strikeRegex, in: s) { src, m in "<del>\(substring(src, range: m.range(at: 1)))</del>" }

        // 5. Line breaks
        if hardBreaks {
            s = s.replacingOccurrences(of: "\n", with: "<br>")
        } else {
            s = replaceRegex(Self.hardBreakRegex, in: s) { _, _ in "<br>" }
            s = s.replacingOccurrences(of: "\n", with: " ")
        }

        return unhold(s)
    }

    private static func escapeHTML(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for ch in text {
            switch ch {
            case "&": out.append("&amp;")
            case "<": out.append("&lt;")
            case ">": out.append("&gt;")
            case "\"": out.append("&quot;")
            case "'": out.append("&#39;")
            default: out.append(ch)
            }
        }
        return out
    }

    private static let autoLinkRegex = try! NSRegularExpression(pattern: #"<((?:https?:\/\/|mailto:)[^\s<>\u0000]+)>"#)
    private static let mdLinkRegex = try! NSRegularExpression(pattern: #"\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)(?:[^\s()\u0000]|\([^\s()\u0000]*\))+)(?:\s+"[^"]*")?\)"#)
    private static let bareLinkRegex = try! NSRegularExpression(pattern: #"(^|[\s(])(https?:\/\/(?:[^\s<>()\u0000]|\([^\s<>()\u0000]*\))*(?:[^\s<>().,;:!?'"\u0000]|\([^\s<>()\u0000]*\)))"#)
    private static let boldStarRegex = try! NSRegularExpression(pattern: #"\*\*(?=\S)((?:[^*]|\*(?!\*))*?\S)\*\*"#)
    private static let boldUnderRegex = try! NSRegularExpression(pattern: #"__(?=\S)((?:[^_]|_(?!_))*?\S)__(?!\w)"#)
    private static let italicStarRegex = try! NSRegularExpression(pattern: #"(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)"#)
    private static let italicUnderRegex = try! NSRegularExpression(pattern: #"(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)"#)
    private static let strikeRegex = try! NSRegularExpression(pattern: #"~~(?=\S)((?:[^~]|~(?!~))*?\S)~~"#)
    private static let hardBreakRegex = try! NSRegularExpression(pattern: #"(?<! ) {2,}\n"#)

    private static func substring(_ string: String, range: NSRange) -> String {
        guard range.location != NSNotFound, let r = Range(range, in: string) else { return "" }
        return String(string[r])
    }

    private static func replaceRegex(
        _ regex: NSRegularExpression,
        in string: String,
        transform: (String, NSTextCheckingResult) -> String
    ) -> String {
        let nsRange = NSRange(string.startIndex..<string.endIndex, in: string)
        let matches = regex.matches(in: string, options: [], range: nsRange)
        guard !matches.isEmpty else { return string }
        var out = ""
        var cursor = string.startIndex
        for m in matches {
            guard let fullRange = Range(m.range, in: string) else { continue }
            out.append(contentsOf: string[cursor..<fullRange.lowerBound])
            out.append(transform(string, m))
            cursor = fullRange.upperBound
        }
        out.append(contentsOf: string[cursor...])
        return out
    }

    private static func findClosingDelimiter(_ chars: [Character], from start: Int, closeA: Character, closeB: Character) -> Int? {
        var i = start
        while i + 1 < chars.count {
            if chars[i] == closeA && chars[i + 1] == closeB {
                return i
            }
            i += 1
        }
        return nil
    }

    /// Closing `$` of inline math: not escaped, not preceded by a space
    /// and not followed by a digit (so "$5 and $10" stays prose).
    private static func findClosingDollar(_ chars: [Character], from start: Int) -> Int? {
        var i = start
        while i < chars.count {
            if chars[i] == "`" { return nil }
            if chars[i] == "\n" && i + 1 < chars.count && chars[i + 1] == "\n" { return nil }
            if chars[i] == "$" && i + 1 < chars.count && chars[i + 1] == "$" {
                // `$$` opens or closes display math, never closes inline math.
                i += 2
                continue
            }
            if chars[i] == "$" && chars[i - 1] != "\\" && !chars[i - 1].isWhitespace {
                if i + 1 < chars.count && chars[i + 1].isNumber {
                    i += 1
                    continue
                }
                return i
            }
            i += 1
        }
        return nil
    }
}

// MARK: - Syntax Highlighting

public enum CodeHighlighter {
    private static let sharedKeywords: Set<String> = [
        "import", "export", "from", "return", "if", "else", "for", "while", "switch", "case",
        "break", "continue", "default", "func", "function", "def", "fn", "let", "var", "const",
        "struct", "class", "enum", "protocol", "interface", "type", "impl", "pub", "public",
        "private", "internal", "async", "await", "try", "catch", "throw", "throws", "in",
        "true", "false", "nil", "null", "None", "self", "Self", "this", "super", "guard", "defer",
    ]

    /// Fence languages that hold output rather than code: colouring them is noise, as the web client agrees.
    private static let plainTextLanguages: Set<String> = ["text", "txt", "plain", "plaintext", "console", "log", "output"]

    public static func highlight(_ code: String, language: String, palette: OMPPalette) -> AttributedString {
        let lang = language.lowercased()
        // Bound highlighting on ultra-huge blocks to keep scrolling 60fps
        if code.count > 20_000 || plainTextLanguages.contains(lang) {
            var plain = AttributedString(code)
            plain.font = OMPTypography.monoSmall
            plain.foregroundColor = palette.foreground
            return plain
        }

        let isDiff = lang == "diff" || lang == "patch"
        var out = AttributedString()
        let lines = code.split(separator: "\n", omittingEmptySubsequences: false)

        for (lineIndex, lineSub) in lines.enumerated() {
            let line = String(lineSub)
            if isDiff {
                var attr = AttributedString(line)
                attr.font = OMPTypography.monoSmall
                if line.hasPrefix("+") && !line.hasPrefix("+++") {
                    attr.foregroundColor = palette.diffAddText
                } else if line.hasPrefix("-") && !line.hasPrefix("---") {
                    attr.foregroundColor = palette.diffDeleteText
                } else if line.hasPrefix("@@") {
                    attr.foregroundColor = palette.cyan
                } else {
                    attr.foregroundColor = palette.foreground
                }
                out.append(attr)
            } else {
                out.append(highlightCodeLine(line, palette: palette))
            }
            if lineIndex + 1 < lines.count {
                out.append(AttributedString("\n"))
            }
        }
        return out
    }

    private static func highlightCodeLine(_ line: String, palette: OMPPalette) -> AttributedString {
        var result = AttributedString()
        let chars = Array(line)
        var i = 0

        func append(_ text: String, color: Color) {
            var attr = AttributedString(text)
            attr.font = OMPTypography.monoSmall
            attr.foregroundColor = color
            result.append(attr)
        }

        while i < chars.count {
            let c = chars[i]
            // Line comment `//` or `#`
            if (c == "/" && i + 1 < chars.count && chars[i + 1] == "/") || (c == "#" && (i == 0 || chars[i - 1] == " ")) {
                append(String(chars[i...]), color: palette.muted)
                break
            }
            // String literal `"..."` or `'...'`
            if c == "\"" || c == "'" {
                let quote = c
                var j = i + 1
                while j < chars.count {
                    if chars[j] == "\\" && j + 1 < chars.count {
                        j += 2
                        continue
                    }
                    if chars[j] == quote {
                        j += 1
                        break
                    }
                    j += 1
                }
                append(String(chars[i..<j]), color: palette.green)
                i = j
                continue
            }
            // Word / Keyword / Number
            if c.isLetter || c == "_" {
                var j = i + 1
                while j < chars.count && (chars[j].isLetter || chars[j].isNumber || chars[j] == "_") {
                    j += 1
                }
                let word = String(chars[i..<j])
                if sharedKeywords.contains(word) {
                    append(word, color: palette.violet)
                } else if word.first?.isUppercase == true {
                    append(word, color: palette.cyan)
                } else {
                    append(word, color: palette.foreground)
                }
                i = j
                continue
            }
            if c.isNumber {
                var j = i + 1
                while j < chars.count && (chars[j].isNumber || chars[j] == "." || chars[j] == "_" || chars[j] == "x" || ("a"..."f").contains(chars[j].lowercased())) {
                    j += 1
                }
                append(String(chars[i..<j]), color: palette.amber)
                i = j
                continue
            }
            append(String(c), color: palette.foreground)
            i += 1
        }
        return result
    }
}

// MARK: - SwiftUI Markdown View

public struct MarkdownView: View {
    public let text: String

    public init(text: String) {
        self.text = text
    }

    public var body: some View {
        MarkdownBlockList(blocks: MarkdownParser.parse(text), muted: false, spacing: 8)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Nested quote and list content recurses through this view: a struct, not a function returning
/// `some View`, which Swift cannot make recursive.
private struct MarkdownBlockList: View {
    let blocks: [MarkdownBlock]
    let muted: Bool
    let spacing: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(blocks) { block in
                MarkdownBlockRow(block: block, muted: muted)
            }
        }
    }
}

private struct MarkdownBlockRow: View {
    @Environment(\.ompPalette) private var palette
    let block: MarkdownBlock
    let muted: Bool

    var body: some View {
        switch block {
        case .heading(_, let level, let content):
            if MarkdownParser.containsMath(content) {
                KaTeXInlineView(
                    rawMarkdown: content,
                    htmlBody: MarkdownParser.renderInlineHTML(content),
                    typography: .heading(level: level, palette: palette, muted: muted)
                )
                .padding(.top, level <= 2 ? 4 : 2)
            } else {
                Text(MarkdownParser.renderInline(content, palette: palette))
                    .font(headingFont(level))
                    .fontWeight(.semibold)
                    .foregroundStyle(muted ? palette.muted : palette.foreground)
                    .padding(.top, level <= 2 ? 4 : 2)
            }

        case .paragraph(_, let content):
            if MarkdownParser.containsMath(content) {
                KaTeXInlineView(
                    rawMarkdown: content,
                    htmlBody: MarkdownParser.renderInlineHTML(content),
                    typography: muted ? .blockquote(palette: palette) : .paragraph(palette: palette)
                )
            } else {
                Text(MarkdownParser.renderInline(content, palette: palette))
                    .font(.body)
                    .foregroundStyle(muted ? palette.muted : palette.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

        case .codeBlock(_, let language, let code):
            CodeBlockCard(language: language, code: code)

        case .mathBlock(_, let tex):
            KaTeXBlockMathView(tex: tex)

        case .blockquote(_, let children):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(palette.accentLine)
                    .frame(width: 3)
                MarkdownBlockList(blocks: children, muted: true, spacing: 6)
            }
            .padding(.vertical, 2)

        case .list(_, let ordered, let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 8) {
                        if let checked = item.checked {
                            Image(systemName: checked ? "checkmark.square.fill" : "square")
                                .foregroundStyle(checked ? palette.green : palette.muted)
                                .font(.callout)
                                .padding(.top, 2)
                                .accessibilityLabel(checked ? "Done" : "Not done")
                        } else if ordered, let idxLabel = item.indexLabel {
                            Text(idxLabel)
                                .font(.callout.monospacedDigit())
                                .foregroundStyle(palette.muted)
                                .frame(minWidth: 20, alignment: .trailing)
                        } else {
                            Text("•")
                                .foregroundStyle(palette.accent)
                                .bold()
                        }
                        MarkdownBlockList(blocks: item.blocks, muted: muted, spacing: 4)
                    }
                }
            }

        case .table(_, let headers, let rows, let alignments):
            ScrollView(.horizontal, showsIndicators: true) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        ForEach(Array(headers.enumerated()), id: \.offset) { cIdx, h in
                            tableCell(h, column: cIdx, alignments: alignments, isHeader: true)
                        }
                    }
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(0..<max(headers.count, row.count)), id: \.self) { cIdx in
                                let cell = cIdx < row.count ? row[cIdx] : ""
                                tableCell(cell, column: cIdx, alignments: alignments, isHeader: false)
                            }
                        }
                    }
                }
                .padding(10)
            }
            .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))

        case .thematicBreak:
            Divider().overlay(palette.borderStrong)
        }
    }

    @ViewBuilder
    private func tableCell(_ content: String, column: Int, alignments: [MarkdownTableAlignment], isHeader: Bool) -> some View {
        if MarkdownParser.containsMath(content) {
            KaTeXInlineView(
                rawMarkdown: content,
                htmlBody: MarkdownParser.renderInlineHTML(content),
                typography: .tableCell(isHeader: isHeader, palette: palette),
                intrinsicWidth: true
            )
            .gridColumnAlignment(columnAlignment(alignments, column))
        } else {
            Text(MarkdownParser.renderInline(content, palette: palette))
                .font(isHeader ? .caption.weight(.semibold) : .caption)
                .foregroundStyle(palette.foreground)
                .multilineTextAlignment(textAlignment(alignments, column))
                .gridColumnAlignment(columnAlignment(alignments, column))
        }
    }

    private func columnAlignment(_ alignments: [MarkdownTableAlignment], _ column: Int) -> HorizontalAlignment {
        switch column < alignments.count ? alignments[column] : .leading {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func textAlignment(_ alignments: [MarkdownTableAlignment], _ column: Int) -> TextAlignment {
        switch column < alignments.count ? alignments[column] : .leading {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title3
        case 2: return .headline
        case 3: return .subheadline
        default: return .callout
        }
    }
}

public struct CodeBlockCard: View {
    @Environment(\.ompPalette) private var palette
    public let language: String
    public let code: String
    @State private var copied = false

    public init(language: String, code: String) {
        self.language = language
        self.code = code
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.caption2.monospaced())
                    .foregroundStyle(palette.muted)
                Spacer()
                Button {
                    copyToPasteboard(code)
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                        .foregroundStyle(copied ? palette.green : palette.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Code copied" : "Copy code block")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(palette.raised)

            Divider().overlay(palette.border)

            ScrollView(.horizontal, showsIndicators: true) {
                Text(CodeHighlighter.highlight(code, language: language, palette: palette))
                    .textSelection(.enabled)
                    .padding(10)
            }
        }
        .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(palette.border, lineWidth: 1)
        )
    }

    private func copyToPasteboard(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }
}
