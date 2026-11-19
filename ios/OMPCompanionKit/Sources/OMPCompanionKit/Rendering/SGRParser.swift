import Foundation
import SwiftUI

public struct SGRSpan: Hashable, Sendable {
    public var text: String
    public var foreground: Color?
    public var background: Color?
    public var bold: Bool
    public var dim: Bool
    public var italic: Bool
    public var underline: Bool
    public var strikethrough: Bool
    public var inverse: Bool
}

public enum SGRParser {
    private static let ansi16: [Color] = [
        Color(hex: 0x1E1E24), // 0 black
        Color(hex: 0xF87171), // 1 red
        Color(hex: 0x34D399), // 2 green
        Color(hex: 0xFBBF24), // 3 yellow
        Color(hex: 0x60A5FA), // 4 blue
        Color(hex: 0xC084FC), // 5 magenta
        Color(hex: 0x22D3EE), // 6 cyan
        Color(hex: 0xE4E4E7), // 7 white
        Color(hex: 0x71717A), // 8 bright black
        Color(hex: 0xFCA5A5), // 9 bright red
        Color(hex: 0x6EE7B7), // 10 bright green
        Color(hex: 0xFDE68A), // 11 bright yellow
        Color(hex: 0x93C5FD), // 12 bright blue
        Color(hex: 0xE9D5FF), // 13 bright magenta
        Color(hex: 0x67E8F9), // 14 bright cyan
        Color(hex: 0xFFFFFF), // 15 bright white
    ]

    public static func color256(_ index: Int) -> Color {
        let idx = max(0, min(255, index))
        if idx < 16 { return ansi16[idx] }
        if idx < 232 {
            let n = idx - 16
            let r = n / 36
            let g = (n / 6) % 6
            let b = n % 6
            let map: [Double] = [0, 95, 135, 175, 215, 255]
            return Color(red: map[r] / 255.0, green: map[g] / 255.0, blue: map[b] / 255.0)
        }
        let gray = Double(8 + (idx - 232) * 10) / 255.0
        return Color(red: gray, green: gray, blue: gray)
    }

    public static func stripANSI(_ input: String) -> String {
        parse(input).map(\.text).joined()
    }

    public static func attributedLine(
        _ input: String,
        defaultForeground: Color,
        defaultBackground: Color,
        font: Font
    ) -> AttributedString {
        var result = AttributedString()
        for span in parse(input) where !span.text.isEmpty {
            var attr = AttributedString(span.text)
            attr.font = span.bold ? font.bold() : (span.italic ? font.italic() : font)
            var fg = span.foreground ?? defaultForeground
            var bg = span.background
            if span.inverse {
                let oldFg = fg
                fg = bg ?? defaultBackground
                bg = oldFg
            }
            if span.dim {
                fg = fg.opacity(0.6)
            }
            attr.foregroundColor = fg
            if let bg {
                attr.backgroundColor = bg
            }
            if span.underline {
                attr.underlineStyle = .single
            }
            if span.strikethrough {
                attr.strikethroughStyle = .single
            }
            result.append(attr)
        }
        return result
    }

    public static func parse(_ input: String) -> [SGRSpan] {
        var spans: [SGRSpan] = []
        var fg: Color?
        var bg: Color?
        var bold = false
        var dim = false
        var italic = false
        var underline = false
        var strikethrough = false
        var inverse = false

        var buffer = ""
        let scalars = Array(input.unicodeScalars)
        var i = 0

        func flush() {
            guard !buffer.isEmpty else { return }
            spans.append(SGRSpan(
                text: buffer,
                foreground: fg,
                background: bg,
                bold: bold,
                dim: dim,
                italic: italic,
                underline: underline,
                strikethrough: strikethrough,
                inverse: inverse
            ))
            buffer.removeAll(keepingCapacity: true)
        }

        while i < scalars.count {
            let s = scalars[i]
            if s.value == 0x1B && i + 1 < scalars.count {
                let next = scalars[i + 1]
                if next.value == 0x5B { // '[' CSI sequence
                    var j = i + 2
                    var params = ""
                    while j < scalars.count {
                        let ch = scalars[j]
                        if ch.value >= 0x40 && ch.value <= 0x7E {
                            if ch.value == 0x6D { // 'm' SGR
                                flush()
                                applySGR(
                                    params,
                                    fg: &fg,
                                    bg: &bg,
                                    bold: &bold,
                                    dim: &dim,
                                    italic: &italic,
                                    underline: &underline,
                                    strikethrough: &strikethrough,
                                    inverse: &inverse
                                )
                            }
                            j += 1
                            break
                        }
                        params.unicodeScalars.append(ch)
                        j += 1
                    }
                    i = j
                    continue
                } else if next.value == 0x5D { // ']' OSC sequence until BEL or ST
                    var j = i + 2
                    while j < scalars.count {
                        if scalars[j].value == 0x07 {
                            j += 1
                            break
                        }
                        if scalars[j].value == 0x1B && j + 1 < scalars.count && scalars[j + 1].value == 0x5C {
                            j += 2
                            break
                        }
                        j += 1
                    }
                    i = j
                    continue
                }
            }
            if s.value >= 0x20 || s.value == 0x09 {
                if s.value == 0x09 {
                    buffer.append("  ")
                } else {
                    buffer.unicodeScalars.append(s)
                }
            }
            i += 1
        }
        flush()
        return spans
    }

    private static func applySGR(
        _ raw: String,
        fg: inout Color?,
        bg: inout Color?,
        bold: inout Bool,
        dim: inout Bool,
        italic: inout Bool,
        underline: inout Bool,
        strikethrough: inout Bool,
        inverse: inout Bool
    ) {
        if raw.isEmpty {
            fg = nil; bg = nil; bold = false; dim = false; italic = false
            underline = false; strikethrough = false; inverse = false
            return
        }
        // Support both ';' and ':' subparameters (used by some terminals / chalk)
        let parts = raw.split(whereSeparator: { $0 == ";" || $0 == ":" }).map { Int($0) ?? 0 }
        var idx = 0
        while idx < parts.count {
            let code = parts[idx]
            switch code {
            case 0:
                fg = nil; bg = nil; bold = false; dim = false; italic = false
                underline = false; strikethrough = false; inverse = false
            case 1: bold = true
            case 2: dim = true
            case 3: italic = true
            case 4: underline = true
            case 7: inverse = true
            case 9: strikethrough = true
            case 21, 22: bold = false; dim = false
            case 23: italic = false
            case 24: underline = false
            case 27: inverse = false
            case 29: strikethrough = false
            case 30...37: fg = ansi16[code - 30]
            case 39: fg = nil
            case 40...47: bg = ansi16[code - 40]
            case 49: bg = nil
            case 90...97: fg = ansi16[8 + (code - 90)]
            case 100...107: bg = ansi16[8 + (code - 100)]
            case 38, 48:
                let isBg = code == 48
                if idx + 2 < parts.count && parts[idx + 1] == 5 {
                    let c = color256(parts[idx + 2])
                    if isBg { bg = c } else { fg = c }
                    idx += 2
                } else if idx + 4 < parts.count && parts[idx + 1] == 2 {
                    let r = Double(max(0, min(255, parts[idx + 2]))) / 255.0
                    let g = Double(max(0, min(255, parts[idx + 3]))) / 255.0
                    let b = Double(max(0, min(255, parts[idx + 4]))) / 255.0
                    let c = Color(red: r, green: g, blue: b)
                    if isBg { bg = c } else { fg = c }
                    idx += 4
                } else if idx + 5 < parts.count && parts[idx + 1] == 2 {
                    // ITU colon form `38:2::r:g:b`
                    let r = Double(max(0, min(255, parts[idx + 3]))) / 255.0
                    let g = Double(max(0, min(255, parts[idx + 4]))) / 255.0
                    let b = Double(max(0, min(255, parts[idx + 5]))) / 255.0
                    let c = Color(red: r, green: g, blue: b)
                    if isBg { bg = c } else { fg = c }
                    idx += 5
                }
            default:
                break
            }
            idx += 1
        }
    }
}
