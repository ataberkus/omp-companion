import Foundation

/// Converts a LaTeX math fragment into readable linear Unicode text
/// (`\mathcal L^{-1}\left\{\tfrac14\cos 2t\right\}` → `ℒ⁻¹{¼ cos 2t}`).
///
/// Not a typesetter: fractions become `a/b` or vulgar fractions, scripts use
/// Unicode super/subscripts when every character has one, and `cases`/matrix
/// environments become multi-line text with bracket pieces. Commands are
/// tokenized by name, so `\left` can never be mistaken for `\le`.
public enum TeXUnicode {
    public static func convert(_ tex: String) -> String {
        var parser = TeXParser(Array(tex))
        return TeXTables.tidy(parser.sequence(inGroup: false, inEnv: false).text)
    }
}

// MARK: - Parser

private struct TeXParser {
    enum Stop { case eof, closeBrace, align, newline, end }

    private let c: [Character]
    private var i = 0
    /// Inside scripts and fraction arguments: no operator spacing.
    private var compact = false

    init(_ chars: [Character]) { c = chars }

    mutating func sequence(inGroup: Bool, inEnv: Bool) -> (text: String, stop: Stop) {
        var out = TeXOutput(compact: compact)
        while i < c.count {
            let ch = c[i]
            switch ch {
            case "}":
                i += 1
                if inGroup { return (out.s, .closeBrace) }
            case "{":
                i += 1
                out.atom(sequence(inGroup: true, inEnv: false).text)
            case "&":
                i += 1
                if inEnv { return (out.s, .align) }
            case "^", "_":
                i += 1
                out.script(TeXTables.script(argument(compactly: true), superscript: ch == "^"))
            case "'":
                var n = 0
                while i < c.count && c[i] == "'" { n += 1; i += 1 }
                out.atom(n == 1 ? "′" : n == 2 ? "″" : n == 3 ? "‴" : String(repeating: "′", count: n))
            case "-":
                i += 1
                out.binary("−")
            case "+":
                i += 1
                out.binary("+")
            case "=", "<", ">":
                i += 1
                out.relation(String(ch))
            case ",", ":", ";":
                i += 1
                out.atom(String(ch))
                if !compact { out.raw(" ") }
            case "~":
                i += 1
                out.raw(" ")
            case "\\":
                if let stop = command(into: &out, inEnv: inEnv) { return (out.s, stop) }
            default:
                i += 1
                if !ch.isWhitespace { out.atom(TeXTables.atomText(ch)) }
            }
        }
        return (out.s, .eof)
    }

    private mutating func skipSpaces() {
        while i < c.count && c[i].isWhitespace { i += 1 }
    }

    /// One macro argument: a braced group, a command, or a single character.
    private mutating func argument(compactly: Bool = false) -> String {
        skipSpaces()
        guard i < c.count else { return "" }
        let saved = compact
        if compactly { compact = true }
        defer { compact = saved }
        let ch = c[i]
        if ch == "{" {
            i += 1
            return sequence(inGroup: true, inEnv: false).text
        }
        if ch == "\\" {
            var out = TeXOutput(compact: compact)
            _ = command(into: &out, inEnv: false)
            return out.s
        }
        i += 1
        return TeXTables.atomText(ch)
    }

    /// Unparsed argument text (environment names, `\text{…}` bodies, colors).
    private mutating func rawArgument() -> String {
        skipSpaces()
        guard i < c.count else { return "" }
        guard c[i] == "{" else {
            i += 1
            return String(c[i - 1])
        }
        var depth = 0
        var s = ""
        while i < c.count {
            let ch = c[i]
            i += 1
            if ch == "{" {
                depth += 1
                if depth == 1 { continue }
            } else if ch == "}" {
                depth -= 1
                if depth == 0 { break }
            }
            s.append(ch)
        }
        return s
    }

    private mutating func command(into out: inout TeXOutput, inEnv: Bool) -> Stop? {
        i += 1
        guard i < c.count else { return nil }
        var name = ""
        if c[i].isASCII && c[i].isLetter {
            while i < c.count && c[i].isASCII && c[i].isLetter {
                name.append(c[i])
                i += 1
            }
        } else {
            name = String(c[i])
            i += 1
        }

        if let sym = TeXTables.symbols[name] { out.atom(sym); return nil }
        if let rel = TeXTables.relations[name] { out.relation(rel); return nil }
        if let bin = TeXTables.binaries[name] { out.binary(bin); return nil }
        if TeXTables.functions.contains(name) { out.function(name); return nil }
        if let op = TeXTables.bigOperators[name] { out.function(op); return nil }
        if let space = TeXTables.spaces[name] { out.raw(space); return nil }
        if TeXTables.ignored.contains(name) {
            if name == "left" || name == "right" || name.hasPrefix("big") || name.hasPrefix("Big") {
                skipSpaces()
                if i < c.count && c[i] == "." { i += 1 }
            }
            return nil
        }

        switch name {
        case "\\":
            if inEnv { return .newline }
            out.raw("\n")
        case "begin":
            out.atom(environment(rawArgument()))
        case "end":
            _ = rawArgument()
            if inEnv { return .end }
        case "frac", "dfrac", "tfrac", "cfrac":
            let num = argument(compactly: true)
            let den = argument(compactly: true)
            out.fraction(TeXTables.fraction(num, den))
        case "binom", "dbinom", "tbinom":
            let n = argument(compactly: true)
            let k = argument(compactly: true)
            out.atom("C(\(TeXTables.trim(n)), \(TeXTables.trim(k)))")
        case "sqrt":
            skipSpaces()
            var index = ""
            if i < c.count && c[i] == "[" {
                i += 1
                while i < c.count && c[i] != "]" { index.append(c[i]); i += 1 }
                i += 1
            }
            let radicand = TeXTables.parenthesized(TeXTables.trim(argument(compactly: true)))
            let root: String
            switch TeXTables.trim(index) {
            case "": root = "√"
            case "3": root = "∛"
            case "4": root = "∜"
            case let n: root = TeXTables.script(n, superscript: true) + "√"
            }
            out.atom(root + radicand)
        case "text", "textrm", "textit", "textbf", "textsf", "texttt", "textnormal", "textup", "mbox", "hbox":
            out.atom(TeXTables.unescapeText(rawArgument()))
        case "mathrm", "mathit", "mathbf", "mathsf", "mathtt", "mathnormal", "boldsymbol", "bm", "boxed", "fbox",
             "underbrace", "overbrace":
            out.atom(argument())
        case "operatorname":
            if i < c.count && c[i] == "*" { i += 1 }
            out.function(TeXTables.trim(argument(compactly: true)))
        case "mathcal", "mathscr":
            out.atom(TeXTables.styled(argument(compactly: true), .script))
        case "mathbb":
            out.atom(TeXTables.styled(argument(compactly: true), .doubleStruck))
        case "mathfrak":
            out.atom(TeXTables.styled(argument(compactly: true), .fraktur))
        case "not":
            let next = TeXTables.trim(argument(compactly: true))
            switch next {
            case "=": out.relation("≠")
            case "∈": out.relation("∉")
            case "≡": out.relation("≢")
            case "<": out.relation("≮")
            case ">": out.relation("≯")
            default: out.atom(next + "\u{0338}")
            }
        case "overset", "stackrel":
            let over = argument(compactly: true)
            let base = argument()
            out.atom(base)
            out.script(TeXTables.script(over, superscript: true))
        case "underset":
            let under = argument(compactly: true)
            let base = argument()
            out.atom(base)
            out.script(TeXTables.script(under, superscript: false))
        case "pmod":
            out.atom(" (mod \(TeXTables.trim(argument())))")
        case "bmod", "mod":
            out.binary("mod")
        case "tag":
            out.raw("\u{2003}(\(rawArgument()))")
        case "label", "color", "hspace", "vspace", "phantom", "hphantom", "vphantom":
            _ = rawArgument()
        case "textcolor", "colorbox":
            _ = rawArgument()
            out.atom(argument())
        default:
            if let mark = TeXTables.accents[name] {
                out.atom(TeXTables.accent(argument(compactly: true), mark: mark, everyChar: name == "overline" || name == "underline"))
            } else {
                // Unknown command: show its name rather than raw TeX.
                out.atom(name)
            }
        }
        return nil
    }

    private mutating func environment(_ rawName: String) -> String {
        let name = TeXTables.trim(rawName)
        if name == "array" || name.hasPrefix("alignat") || name == "alignedat" { _ = rawArgument() }
        var rows: [[String]] = [[]]
        while true {
            let (cell, stop) = sequence(inGroup: false, inEnv: true)
            rows[rows.count - 1].append(TeXTables.tidy(cell))
            if stop == .align { continue }
            if stop == .newline {
                // `\\[2pt]` spacing argument
                skipSpaces()
                if i < c.count && c[i] == "[" {
                    while i < c.count && c[i] != "]" { i += 1 }
                    i += 1
                }
                rows.append([])
                continue
            }
            break
        }
        rows.removeAll { $0.allSatisfy(\.isEmpty) }
        return TeXTables.layout(environment: name, rows: rows)
    }
}

// MARK: - Output builder

private struct TeXOutput {
    var s = ""
    let compact: Bool
    /// Set after a function name or slash fraction so a following letter/digit is separated.
    private var pendingSpace = false

    init(compact: Bool) { self.compact = compact }

    private var lastSignificant: Character? {
        s.last { $0 != " " && $0 != "\u{2009}" && $0 != "\u{2005}" && $0 != "\u{2003}" }
    }

    /// True when the output ends with something an operand can be glued to.
    private var endsWithOperand: Bool {
        guard let last = s.last, !last.isWhitespace else { return false }
        return !TeXTables.operandBreakers.contains(last)
    }

    mutating func raw(_ t: String) {
        pendingSpace = false
        s.append(t)
    }

    mutating func atom(_ t: String) {
        guard let first = t.first else { return }
        if t.contains("\n") {
            block(t.components(separatedBy: "\n"))
            return
        }
        if pendingSpace && (first.isLetter || first.isNumber) { s.append(" ") }
        pendingSpace = false
        s.append(t)
    }

    /// Scripts attach to the preceding atom and keep a pending function space alive (`sin² x`).
    mutating func script(_ t: String) {
        s.append(t)
    }

    mutating func function(_ name: String) {
        if !compact && endsWithOperand { s.append(" ") }
        s.append(name)
        pendingSpace = !compact
    }

    mutating func fraction(_ t: String) {
        if !compact && endsWithOperand { s.append(" ") }
        pendingSpace = false
        s.append(t)
        pendingSpace = !compact && t.contains("/")
    }

    mutating func binary(_ op: String) {
        pendingSpace = false
        let last = lastSignificant
        if compact || last == nil || TeXTables.unaryContext.contains(last!) {
            s.append(op)
        } else {
            s.append(" \(op) ")
        }
    }

    mutating func relation(_ op: String) {
        pendingSpace = false
        s.append(compact ? op : " \(op) ")
    }

    /// Multi-line content: continuation lines are indented under the current column.
    mutating func block(_ lines: [String]) {
        pendingSpace = false
        let lineStart = s.lastIndex(of: "\n").map { s.index(after: $0) } ?? s.startIndex
        let line = String(s[lineStart...])
        let column = TeXTables.collapseSpaces(line).count + (line.last == " " ? 1 : 0)
        let indent = String(repeating: "\u{2007}", count: column)
        s.append(lines.joined(separator: "\n" + indent))
    }
}

// MARK: - Tables

private enum TeXTables {
    enum Alphabet { case script, doubleStruck, fraktur }

    static let operandBreakers: Set<Character> = Set("([{⟨|/^_−+±∓=<>≤≥≠≈≡→⇒⇔∈,;:·×÷\n")
    static let unaryContext: Set<Character> = Set("([{⟨|,;:=<>≤≥≠≈≡∼≃≅∝→←↔⇒⇐⇔↦∈∉⊂⊆⊃⊇+−±∓×·÷^_\n")

    static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    static func atomText(_ ch: Character) -> String {
        switch ch {
        case "-": return "−"
        case "*": return "∗"
        case "'": return "′"
        default: return String(ch)
        }
    }

    static func collapseSpaces(_ line: String) -> String {
        var out = ""
        out.reserveCapacity(line.count)
        var lastWasSpace = false
        for ch in line {
            if ch == " " {
                if lastWasSpace { continue }
                lastWasSpace = true
            } else {
                lastWasSpace = false
            }
            out.append(ch)
        }
        // Only ASCII spaces are trimmed; figure-space indentation is kept.
        while out.first == " " { out.removeFirst() }
        while out.last == " " { out.removeLast() }
        return out
    }

    static func tidy(_ s: String) -> String {
        let lines = s.components(separatedBy: "\n").map(collapseSpaces)
        return lines.joined(separator: "\n").trimmingCharacters(in: .newlines)
    }

    static func unescapeText(_ s: String) -> String {
        var out = ""
        var it = s.makeIterator()
        while let ch = it.next() {
            if ch == "\\", let next = it.next() {
                out.append(next)
            } else {
                out.append(ch)
            }
        }
        return out
    }

    static func parenthesized(_ s: String) -> String {
        guard s.count > 1, s.contains(where: { " +−-=<>≤≥·×/,±∓".contains($0) }) else { return s }
        return "(\(s))"
    }

    static func fraction(_ numerator: String, _ denominator: String) -> String {
        let n = trim(numerator), d = trim(denominator)
        if let v = vulgar["\(n)/\(d)"] { return v }
        let isDigits: (String) -> Bool = { !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } }
        if isDigits(n) && isDigits(d) {
            return script(n, superscript: true) + "⁄" + script(d, superscript: false)
        }
        return parenthesized(n) + "/" + parenthesized(d)
    }

    static func script(_ raw: String, superscript: Bool) -> String {
        let t = raw.filter { !$0.isWhitespace }
        guard !t.isEmpty else { return "" }
        if superscript && t == "∘" { return "°" }
        let table = superscript ? sup : sub
        var out = ""
        for ch in t {
            guard let m = table[ch] else {
                return (superscript ? "^" : "_") + (t.count == 1 ? t : "(\(t))")
            }
            out.append(m)
        }
        return out
    }

    static func accent(_ base: String, mark: Character, everyChar: Bool) -> String {
        let t = trim(base)
        guard !t.isEmpty else { return String(mark) }
        if everyChar { return t.map { "\($0)\(mark)" }.joined() }
        return t + String(mark)
    }

    static func styled(_ s: String, _ alphabet: Alphabet) -> String {
        var out = ""
        for ch in s {
            guard ch.isASCII, let v = ch.asciiValue else { out.append(ch); continue }
            let mapped: Character?
            switch alphabet {
            case .script:
                mapped = scriptExceptions[ch] ?? offset(v, upper: 0x1D49C, lower: 0x1D4B6, digit: nil)
            case .doubleStruck:
                mapped = doubleStruckExceptions[ch] ?? offset(v, upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8)
            case .fraktur:
                mapped = frakturExceptions[ch] ?? offset(v, upper: 0x1D504, lower: 0x1D51E, digit: nil)
            }
            out.append(mapped ?? ch)
        }
        return out
    }

    private static func offset(_ v: UInt8, upper: UInt32, lower: UInt32, digit: UInt32?) -> Character? {
        let scalar: UInt32
        switch v {
        case 65...90: scalar = upper + UInt32(v - 65)
        case 97...122: scalar = lower + UInt32(v - 97)
        case 48...57:
            guard let digit else { return nil }
            scalar = digit + UInt32(v - 48)
        default: return nil
        }
        return Unicode.Scalar(scalar).map(Character.init)
    }

    static func layout(environment rawName: String, rows: [[String]]) -> String {
        guard !rows.isEmpty else { return "" }
        let name = rawName.replacingOccurrences(of: "*", with: "")
        switch name {
        case "cases", "dcases", "rcases", "numcases":
            let width = rows.map { $0[0].count }.max() ?? 0
            let lines = rows.map { row -> String in
                let rest = row.dropFirst().filter { !$0.isEmpty }.joined(separator: " ")
                guard !rest.isEmpty else { return row[0] }
                return row[0] + String(repeating: "\u{2007}", count: width - row[0].count) + "\u{2003}" + rest
            }
            return name == "rcases" ? bracket(lines, left: nil, right: "}") : bracket(lines, left: "{", right: nil)
        case "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "array":
            let columns = rows.map(\.count).max() ?? 0
            let widths = (0..<columns).map { col in rows.map { col < $0.count ? $0[col].count : 0 }.max() ?? 0 }
            let lines = rows.map { row in
                (0..<columns).map { col -> String in
                    let cell = col < row.count ? row[col] : ""
                    return cell + String(repeating: "\u{2007}", count: widths[col] - cell.count)
                }.joined(separator: "\u{2003}")
            }
            let delimiters: (Character?, Character?)
            switch name {
            case "pmatrix": delimiters = ("(", ")")
            case "bmatrix": delimiters = ("[", "]")
            case "Bmatrix": delimiters = ("{", "}")
            case "vmatrix": delimiters = ("|", "|")
            case "Vmatrix": delimiters = ("‖", "‖")
            default: delimiters = (nil, nil)
            }
            return bracket(lines, left: delimiters.0, right: delimiters.1)
        default:
            // aligned, align, gathered, split, equation, multline…: `&` is only an alignment point.
            return rows.map { $0.filter { !$0.isEmpty }.joined(separator: " ") }.joined(separator: "\n")
        }
    }

    private static func bracket(_ lines: [String], left: Character?, right: Character?) -> String {
        guard left != nil || right != nil else { return lines.joined(separator: "\n") }
        let width = lines.map(\.count).max() ?? 0
        return lines.enumerated().map { index, line in
            let l = left.map { String(piece($0, index: index, count: lines.count)) + " " } ?? ""
            let r = right.map {
                String(repeating: "\u{2007}", count: width - line.count) + " " + String(piece($0, index: index, count: lines.count))
            } ?? ""
            return l + line + r
        }.joined(separator: "\n")
    }

    private static func piece(_ delimiter: Character, index: Int, count: Int) -> Character {
        guard count > 1 else { return delimiter }
        let position = index == 0 ? 0 : index == count - 1 ? 2 : 1
        switch delimiter {
        case "(": return Array("⎛⎜⎝")[position]
        case ")": return Array("⎞⎟⎠")[position]
        case "[": return Array("⎡⎢⎣")[position]
        case "]": return Array("⎤⎥⎦")[position]
        case "{", "}":
            let open = delimiter == "{"
            if position != 1 { return open ? (position == 0 ? "⎧" : "⎩") : (position == 0 ? "⎫" : "⎭") }
            return index == (count - 1) / 2 ? (open ? "⎨" : "⎬") : "⎪"
        case "|": return "│"
        default: return delimiter
        }
    }

    static let symbols: [String: String] = [
        // Greek
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ϵ", "varepsilon": "ε",
        "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ",
        "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "omicron": "ο", "pi": "π", "varpi": "ϖ",
        "rho": "ρ", "varrho": "ϱ", "sigma": "σ", "varsigma": "ς", "tau": "τ", "upsilon": "υ",
        "phi": "ϕ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
        "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π",
        "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
        // Misc
        "infty": "∞", "partial": "∂", "nabla": "∇", "emptyset": "∅", "varnothing": "∅",
        "forall": "∀", "exists": "∃", "nexists": "∄", "neg": "¬", "lnot": "¬",
        "aleph": "ℵ", "hbar": "ℏ", "ell": "ℓ", "Re": "ℜ", "Im": "ℑ", "wp": "℘",
        "angle": "∠", "triangle": "△", "square": "□", "Box": "□", "qed": "∎", "checkmark": "✓",
        "top": "⊤", "bot": "⊥", "prime": "′", "degree": "°", "surd": "√",
        "cdots": "⋯", "ldots": "…", "dots": "…", "dotsc": "…", "dotsb": "⋯", "vdots": "⋮", "ddots": "⋱",
        "therefore": "∴", "because": "∵", "dagger": "†", "ddagger": "‡", "star": "⋆",
        "langle": "⟨", "rangle": "⟩", "lfloor": "⌊", "rfloor": "⌋", "lceil": "⌈", "rceil": "⌉",
        "lbrace": "{", "rbrace": "}", "lbrack": "[", "rbrack": "]",
        "vert": "|", "lvert": "|", "rvert": "|", "Vert": "‖", "lVert": "‖", "rVert": "‖",
        "colon": ":", "backslash": "∖",
        // Escaped single characters
        "{": "{", "}": "}", "|": "‖", "%": "%", "&": "&", "_": "_", "#": "#", "$": "$",
    ]

    /// Spaced from their operand like function names: `∑ᵢ₌₁ⁿ xᵢ`.
    static let bigOperators: [String: String] = [
        "sum": "∑", "prod": "∏", "coprod": "∐", "int": "∫", "iint": "∬", "iiint": "∭", "oint": "∮",
        "bigcup": "⋃", "bigcap": "⋂", "bigoplus": "⨁", "bigotimes": "⨂",
    ]

    static let relations: [String: String] = [
        "le": "≤", "leq": "≤", "leqslant": "≤", "ge": "≥", "geq": "≥", "geqslant": "≥",
        "ne": "≠", "neq": "≠", "approx": "≈", "equiv": "≡", "sim": "∼", "simeq": "≃", "cong": "≅",
        "propto": "∝", "ll": "≪", "gg": "≫", "prec": "≺", "succ": "≻", "doteq": "≐",
        "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂", "subseteq": "⊆", "supset": "⊃", "supseteq": "⊇",
        "to": "→", "rightarrow": "→", "leftarrow": "←", "gets": "←", "leftrightarrow": "↔",
        "Rightarrow": "⇒", "Leftarrow": "⇐", "Leftrightarrow": "⇔", "implies": "⇒", "impliedby": "⇐", "iff": "⇔",
        "longrightarrow": "⟶", "longleftarrow": "⟵", "Longrightarrow": "⟹", "Longleftrightarrow": "⟺",
        "mapsto": "↦", "uparrow": "↑", "downarrow": "↓", "nearrow": "↗", "searrow": "↘",
        "perp": "⊥", "parallel": "∥", "mid": "∣", "nmid": "∤", "models": "⊨", "vdash": "⊢",
    ]

    static let binaries: [String: String] = [
        "pm": "±", "mp": "∓", "times": "×", "cdot": "·", "div": "÷", "ast": "∗", "circ": "∘", "bullet": "•",
        "cup": "∪", "cap": "∩", "setminus": "∖", "oplus": "⊕", "ominus": "⊖", "otimes": "⊗", "odot": "⊙",
        "wedge": "∧", "land": "∧", "vee": "∨", "lor": "∨", "sqcup": "⊔", "sqcap": "⊓",
    ]

    static let functions: Set<String> = [
        "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
        "sinh", "cosh", "tanh", "coth", "log", "ln", "lg", "exp", "lim", "liminf", "limsup",
        "sup", "inf", "max", "min", "det", "dim", "ker", "hom", "gcd", "lcm", "deg", "arg", "Pr",
    ]

    static let spaces: [String: String] = [
        ",": "\u{2009}", "thinspace": "\u{2009}", ":": "\u{2005}", ";": "\u{2005}", ">": "\u{2005}",
        "medspace": "\u{2005}", "thickspace": "\u{2005}", "enspace": "\u{2002}",
        "quad": "\u{2003}", "qquad": "\u{2003}\u{2003}", " ": " ", "!": "",
    ]

    /// Sizing and style commands with no visible output of their own.
    static let ignored: Set<String> = [
        "left", "right", "middle", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr",
        "biggl", "biggr", "Biggl", "Biggr", "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle",
        "limits", "nolimits", "nonumber", "notag", "mathstrut", "strut", "allowbreak", "nobreak",
    ]

    static let accents: [String: Character] = [
        "hat": "\u{0302}", "widehat": "\u{0302}", "check": "\u{030C}", "tilde": "\u{0303}", "widetilde": "\u{0303}",
        "bar": "\u{0304}", "overline": "\u{0305}", "underline": "\u{0332}", "vec": "\u{20D7}",
        "overrightarrow": "\u{20D7}", "dot": "\u{0307}", "ddot": "\u{0308}", "acute": "\u{0301}",
        "grave": "\u{0300}", "breve": "\u{0306}",
    ]

    static let vulgar: [String: String] = [
        "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾", "1/5": "⅕", "2/5": "⅖",
        "3/5": "⅗", "4/5": "⅘", "1/6": "⅙", "5/6": "⅚", "1/7": "⅐", "1/8": "⅛", "3/8": "⅜",
        "5/8": "⅝", "7/8": "⅞", "1/9": "⅑", "1/10": "⅒",
    ]

    static let sup: [Character: Character] = [
        "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
        "+": "⁺", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
        "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "f": "ᶠ", "g": "ᵍ", "h": "ʰ", "i": "ⁱ",
        "j": "ʲ", "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "n": "ⁿ", "o": "ᵒ", "p": "ᵖ", "r": "ʳ", "s": "ˢ",
        "t": "ᵗ", "u": "ᵘ", "v": "ᵛ", "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ",
        "A": "ᴬ", "B": "ᴮ", "D": "ᴰ", "E": "ᴱ", "G": "ᴳ", "H": "ᴴ", "I": "ᴵ", "J": "ᴶ", "K": "ᴷ",
        "L": "ᴸ", "M": "ᴹ", "N": "ᴺ", "O": "ᴼ", "P": "ᴾ", "R": "ᴿ", "T": "ᵀ", "U": "ᵁ", "V": "ⱽ", "W": "ᵂ",
        "β": "ᵝ", "γ": "ᵞ", "δ": "ᵟ", "θ": "ᶿ", "φ": "ᵠ", "χ": "ᵡ",
        "′": "′", "″": "″", "‴": "‴", "∗": "*",
    ]

    static let sub: [Character: Character] = [
        "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
        "+": "₊", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
        "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ",
        "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
        "β": "ᵦ", "γ": "ᵧ", "ρ": "ᵨ", "φ": "ᵩ", "χ": "ᵪ",
    ]

    static let scriptExceptions: [Character: Character] = [
        "B": "ℬ", "E": "ℰ", "F": "ℱ", "H": "ℋ", "I": "ℐ", "L": "ℒ", "M": "ℳ", "R": "ℛ",
        "e": "ℯ", "g": "ℊ", "o": "ℴ",
    ]
    static let doubleStruckExceptions: [Character: Character] = [
        "C": "ℂ", "H": "ℍ", "N": "ℕ", "P": "ℙ", "Q": "ℚ", "R": "ℝ", "Z": "ℤ",
    ]
    static let frakturExceptions: [Character: Character] = [
        "C": "ℭ", "H": "ℌ", "I": "ℑ", "R": "ℜ", "Z": "ℨ",
    ]
}
