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
    case blockquote(id: Int, text: String)
    case list(id: Int, ordered: Bool, items: [MarkdownListItem])
    case table(id: Int, headers: [String], rows: [[String]])
    case thematicBreak(id: Int)

    public var id: Int {
        switch self {
        case .heading(let id, _, _),
             .paragraph(let id, _),
             .codeBlock(let id, _, _),
             .mathBlock(let id, _),
             .blockquote(let id, _),
             .list(let id, _, _),
             .table(let id, _, _),
             .thematicBreak(let id):
            return id
        }
    }
}

public struct MarkdownListItem: Equatable, Sendable {
    public let indexLabel: String?
    public let checked: Bool?
    public let text: String
}

// MARK: - Linear O(N) Parser & Math Formatter

public enum MarkdownParser {
    public static func parse(_ raw: String) -> [MarkdownBlock] {
        guard !raw.isEmpty else { return [] }
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [MarkdownBlock] = []
        var nextId = 0
        func makeId() -> Int { defer { nextId += 1 }; return nextId }

        var i = 0
        var paraBuffer: [String] = []

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

            // 1. Fenced code block ``` or ~~~
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = trimmed.hasPrefix("~~~") ? "~~~" : "```"
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                i += 1
                while i < lines.count {
                    if lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                        i += 1
                        break
                    }
                    codeLines.append(lines[i])
                    i += 1
                }
                blocks.append(.codeBlock(id: makeId(), language: lang, code: codeLines.joined(separator: "\n")))
                continue
            }

            // 2. Display math block $$...$$ or \[...\]
            if trimmed.hasPrefix("$$") || trimmed.hasPrefix("\\[") {
                flushParagraph()
                let isDollar = trimmed.hasPrefix("$$")
                let closeMarker = isDollar ? "$$" : "\\]"
                let afterOpen = String(trimmed.dropFirst(2))
                if afterOpen.hasSuffix(closeMarker) && afterOpen.count >= 2 {
                    let body = String(afterOpen.dropLast(2)).trimmingCharacters(in: .whitespaces)
                    blocks.append(.mathBlock(id: makeId(), tex: body))
                    i += 1
                    continue
                }
                var mathLines: [String] = []
                if !afterOpen.trimmingCharacters(in: .whitespaces).isEmpty {
                    mathLines.append(afterOpen)
                }
                i += 1
                while i < lines.count {
                    let cur = lines[i]
                    if let endRange = cur.range(of: closeMarker) {
                        let prefix = String(cur[..<endRange.lowerBound])
                        if !prefix.trimmingCharacters(in: .whitespaces).isEmpty {
                            mathLines.append(prefix)
                        }
                        i += 1
                        break
                    }
                    mathLines.append(cur)
                    i += 1
                }
                blocks.append(.mathBlock(id: makeId(), tex: mathLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)))
                continue
            }

            // 3. Blank line
            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            // 4. Thematic break
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph()
                blocks.append(.thematicBreak(id: makeId()))
                i += 1
                continue
            }

            // 5. ATX Heading
            if let heading = parseHeading(trimmed) {
                flushParagraph()
                blocks.append(.heading(id: makeId(), level: heading.level, text: heading.text))
                i += 1
                continue
            }

            // 6. Blockquote
            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoteLines: [String] = []
                while i < lines.count {
                    let qt = lines[i].trimmingCharacters(in: .whitespaces)
                    if qt.hasPrefix(">") {
                        var body = String(qt.dropFirst())
                        if body.hasPrefix(" ") { body.removeFirst() }
                        quoteLines.append(body)
                        i += 1
                    } else if qt.isEmpty {
                        break
                    } else {
                        break
                    }
                }
                blocks.append(.blockquote(id: makeId(), text: quoteLines.joined(separator: "\n")))
                continue
            }

            // 7. GFM Table
            if i + 1 < lines.count, trimmed.contains("|"), isTableSeparator(lines[i + 1]) {
                flushParagraph()
                let headers = splitTableRow(trimmed)
                i += 2
                var rows: [[String]] = []
                while i < lines.count {
                    let rt = lines[i].trimmingCharacters(in: .whitespaces)
                    if rt.isEmpty || !rt.contains("|") { break }
                    rows.append(splitTableRow(rt))
                    i += 1
                }
                blocks.append(.table(id: makeId(), headers: headers, rows: rows))
                continue
            }

            // 8. Bullet / Ordered / Task Lists
            if let firstList = parseListItem(line) {
                flushParagraph()
                let ordered = firstList.indexLabel != nil
                var items: [MarkdownListItem] = [firstList]
                i += 1
                while i < lines.count {
                    let cur = lines[i]
                    if let nextItem = parseListItem(cur), (nextItem.indexLabel != nil) == ordered {
                        items.append(nextItem)
                        i += 1
                    } else if cur.hasPrefix("  ") && !cur.trimmingCharacters(in: .whitespaces).isEmpty {
                        let last = items.removeLast()
                        items.append(MarkdownListItem(
                            indexLabel: last.indexLabel,
                            checked: last.checked,
                            text: last.text + " " + cur.trimmingCharacters(in: .whitespaces)
                        ))
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.list(id: makeId(), ordered: ordered, items: items))
                continue
            }

            // 9. Plain paragraph line
            paraBuffer.append(line)
            i += 1
        }
        flushParagraph()
        return blocks
    }

    private static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        var count = 0
        for ch in line {
            if ch == "#" { count += 1 } else { break }
        }
        guard (1...6).contains(count) else { return nil }
        let rest = line.dropFirst(count)
        guard rest.first == " " else { return nil }
        return (count, String(rest.dropFirst()).trimmingCharacters(in: .whitespaces))
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("-") && t.contains("|") else { return false }
        let allowed = CharacterSet(charactersIn: "|-: ")
        return t.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }

    private static func parseListItem(_ line: String) -> MarkdownListItem? {
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        // Unordered `- `, `* `, `+ `
        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
            let body = String(trimmed.dropFirst(2))
            if body.hasPrefix("[ ] ") {
                return MarkdownListItem(indexLabel: nil, checked: false, text: String(body.dropFirst(4)))
            }
            if body.hasPrefix("[x] ") || body.hasPrefix("[X] ") {
                return MarkdownListItem(indexLabel: nil, checked: true, text: String(body.dropFirst(4)))
            }
            return MarkdownListItem(indexLabel: nil, checked: nil, text: body)
        }
        // Ordered `1. ` or `12) `
        var digits = ""
        for ch in trimmed {
            if ch.isNumber { digits.append(ch) } else { break }
        }
        if !digits.isEmpty && digits.count <= 4 {
            let afterDigits = trimmed.dropFirst(digits.count)
            if afterDigits.hasPrefix(". ") || afterDigits.hasPrefix(") ") {
                return MarkdownListItem(indexLabel: "\(digits).", checked: nil, text: String(afterDigits.dropFirst(2)))
            }
        }
        return nil
    }

    // MARK: - Inline Formatting & Inline Math ($...$ / \(...\))

    public static func renderInline(_ input: String, palette: OMPPalette) -> AttributedString {
        // Pre-format inline math `$...$` and `\(...\)` safely without regex backtracking
        let mathNormalized = replaceInlineMath(in: input)
        if var attr = try? AttributedString(
            markdown: mathNormalized,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
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
            return attr
        }
        return AttributedString(mathNormalized)
    }

    public static func replaceInlineMath(in input: String) -> String {
        guard input.contains("$") || input.contains("\\(") else { return input }
        var out = ""
        out.reserveCapacity(input.count)
        let chars = Array(input)
        var i = 0
        var inBacktick = false

        while i < chars.count {
            let c = chars[i]
            if c == "`" {
                inBacktick.toggle()
                out.append(c)
                i += 1
                continue
            }
            if !inBacktick && c == "\\" && i + 1 < chars.count && chars[i + 1] == "(" {
                if let end = findClosingDelimiter(chars, from: i + 2, closeA: "\\", closeB: ")") {
                    let tex = String(chars[(i + 2)..<end])
                    out.append("`\(formatMathUnicode(tex))`")
                    i = end + 2
                    continue
                }
            }
            if !inBacktick && c == "$" && (i == 0 || chars[i - 1] != "\\") {
                if i + 1 < chars.count && chars[i + 1] != "$" && chars[i + 1] != " " {
                    if let end = findClosingDollar(chars, from: i + 1) {
                        let tex = String(chars[(i + 1)..<end])
                        if !tex.isEmpty {
                            out.append("`\(formatMathUnicode(tex))`")
                            i = end + 1
                            continue
                        }
                    }
                }
            }
            out.append(c)
            i += 1
        }
        return out
    }

    private static func findClosingDelimiter(_ chars: [Character], from start: Int, closeA: Character, closeB: Character) -> Int? {
        var i = start
        while i + 1 < chars.count {
            if chars[i] == closeA && chars[i + 1] == closeB {
                return i
            }
            if chars[i] == "\n" { return nil }
            i += 1
        }
        return nil
    }

    private static func findClosingDollar(_ chars: [Character], from start: Int) -> Int? {
        var i = start
        while i < chars.count {
            if chars[i] == "\n" { return nil }
            if chars[i] == "$" && chars[i - 1] != "\\" {
                return i
            }
            i += 1
        }
        return nil
    }

    public static func formatMathUnicode(_ tex: String) -> String {
        var s = tex.trimmingCharacters(in: .whitespacesAndNewlines)
        let replacements: [(String, String)] = [
            ("\\alpha", "α"), ("\\beta", "β"), ("\\gamma", "γ"), ("\\delta", "δ"),
            ("\\epsilon", "ε"), ("\\theta", "θ"), ("\\lambda", "λ"), ("\\mu", "μ"),
            ("\\pi", "π"), ("\\sigma", "σ"), ("\\tau", "τ"), ("\\phi", "φ"),
            ("\\omega", "ω"), ("\\Delta", "Δ"), ("\\Sigma", "Σ"), ("\\Omega", "Ω"),
            ("\\Pi", "Π"), ("\\sum", "∑"), ("\\prod", "∏"), ("\\int", "∫"),
            ("\\infty", "∞"), ("\\partial", "∂"), ("\\nabla", "∇"),
            ("\\sqrt", "√"), ("\\times", "×"), ("\\cdot", "·"), ("\\div", "÷"),
            ("\\pm", "±"), ("\\mp", "∓"), ("\\neq", "≠"), ("\\ne", "≠"),
            ("\\leq", "≤"), ("\\le", "≤"), ("\\geq", "≥"), ("\\ge", "≥"),
            ("\\approx", "≈"), ("\\equiv", "≡"), ("\\in", "∈"), ("\\notin", "∉"),
            ("\\subset", "⊂"), ("\\subseteq", "⊆"), ("\\cup", "∪"), ("\\cap", "∩"),
            ("\\forall", "∀"), ("\\exists", "∃"), ("\\to", "→"), ("\\rightarrow", "→"),
            ("\\leftarrow", "←"), ("\\Rightarrow", "⇒"), ("\\iff", "⇔"),
            ("\\ldots", "…"), ("\\dots", "…"), ("\\left", ""), ("\\right", ""),
        ]
        for (cmd, uni) in replacements {
            s = s.replacingOccurrences(of: cmd, with: uni)
        }
        // Simple \frac{a}{b} -> (a)/(b)
        while let fracRange = s.range(of: "\\frac{") {
            let after = fracRange.upperBound
            if let numEnd = matchingBrace(in: s, openIndex: s.index(before: after)),
               s.index(after: numEnd) < s.endIndex,
               s[s.index(after: numEnd)] == "{",
               let denEnd = matchingBrace(in: s, openIndex: s.index(after: numEnd)) {
                let num = String(s[after..<numEnd])
                let denStart = s.index(after: s.index(after: numEnd))
                let den = String(s[denStart..<denEnd])
                s.replaceSubrange(fracRange.lowerBound...denEnd, with: "(\(num))/(\(den))")
            } else {
                break
            }
        }
        s = s.replacingOccurrences(of: "^0", with: "⁰")
            .replacingOccurrences(of: "^1", with: "¹")
            .replacingOccurrences(of: "^2", with: "²")
            .replacingOccurrences(of: "^3", with: "³")
            .replacingOccurrences(of: "^n", with: "ⁿ")
            .replacingOccurrences(of: "_0", with: "₀")
            .replacingOccurrences(of: "_1", with: "₁")
            .replacingOccurrences(of: "_2", with: "₂")
            .replacingOccurrences(of: "_i", with: "ᵢ")
            .replacingOccurrences(of: "_n", with: "ₙ")
        return s
    }

    private static func matchingBrace(in s: String, openIndex: String.Index) -> String.Index? {
        var depth = 0
        var idx = openIndex
        while idx < s.endIndex {
            let ch = s[idx]
            if ch == "{" { depth += 1 }
            else if ch == "}" {
                depth -= 1
                if depth == 0 { return idx }
            }
            idx = s.index(after: idx)
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

    public static func highlight(_ code: String, language: String, palette: OMPPalette) -> AttributedString {
        // Bound highlighting on ultra-huge blocks to keep scrolling 60fps
        if code.count > 20_000 {
            var plain = AttributedString(code)
            plain.font = OMPTypography.monoSmall
            plain.foregroundColor = palette.foreground
            return plain
        }

        let lang = language.lowercased()
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
    @Environment(\.ompPalette) private var palette
    public let text: String

    public init(text: String) {
        self.text = text
    }

    private var blocks: [MarkdownBlock] {
        MarkdownParser.parse(text)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks) { block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(_, let level, let content):
            Text(MarkdownParser.renderInline(content, palette: palette))
                .font(headingFont(level))
                .fontWeight(.semibold)
                .foregroundStyle(palette.foreground)
                .padding(.top, level <= 2 ? 4 : 2)

        case .paragraph(_, let content):
            Text(MarkdownParser.renderInline(content, palette: palette))
                .font(.body)
                .foregroundStyle(palette.foreground)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

        case .codeBlock(_, let language, let code):
            CodeBlockCard(language: language, code: code)

        case .mathBlock(_, let tex):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(MarkdownParser.formatMathUnicode(tex))
                    .font(.system(.callout, design: .serif))
                    .foregroundStyle(palette.foreground)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.codeBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))

        case .blockquote(_, let content):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(palette.accentLine)
                    .frame(width: 3)
                Text(MarkdownParser.renderInline(content, palette: palette))
                    .font(.body)
                    .foregroundStyle(palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
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
                        Text(MarkdownParser.renderInline(item.text, palette: palette))
                            .font(.body)
                            .foregroundStyle(palette.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
            }

        case .table(_, let headers, let rows):
            ScrollView(.horizontal, showsIndicators: true) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        ForEach(Array(headers.enumerated()), id: \.offset) { _, h in
                            Text(MarkdownParser.renderInline(h, palette: palette))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                        }
                    }
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(0..<max(headers.count, row.count)), id: \.self) { cIdx in
                                let cell = cIdx < row.count ? row[cIdx] : ""
                                Text(MarkdownParser.renderInline(cell, palette: palette))
                                    .font(.caption)
                                    .foregroundStyle(palette.foreground)
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
