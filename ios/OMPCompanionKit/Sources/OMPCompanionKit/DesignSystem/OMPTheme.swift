import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

public enum ThemePreference: String, CaseIterable, Codable, Identifiable, Sendable {
    case dark
    case light
    case oled
    case system

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .dark: return "Dark"
        case .light: return "Light"
        case .oled: return "OLED Black"
        case .system: return "System"
        }
    }

    public var colorScheme: ColorScheme? {
        switch self {
        case .dark, .oled: return .dark
        case .light: return .light
        case .system: return nil
        }
    }
}

public struct OMPPalette: Sendable {
    public let background: Color
    public let surface: Color
    public let card: Color
    public let raised: Color
    public let border: Color
    public let borderStrong: Color
    public let foreground: Color
    public let muted: Color
    public let accent: Color
    public let accentSoft: Color
    public let accentLine: Color
    public let green: Color
    public let greenSoft: Color
    public let amber: Color
    public let amberSoft: Color
    public let red: Color
    public let redSoft: Color
    public let violet: Color
    public let violetSoft: Color
    public let cyan: Color
    public let codeBackground: Color
    public let diffAddBackground: Color
    public let diffAddText: Color
    public let diffDeleteBackground: Color
    public let diffDeleteText: Color
    public let brandStart: Color
    public let brandMid: Color
    public let brandEnd: Color

    public var brandGradient: LinearGradient {
        LinearGradient(
            colors: [brandStart, brandMid, brandEnd],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    public static let dark = OMPPalette(
        background: Color(hex: 0x09090B),
        surface: Color(hex: 0x0C0C0F),
        card: Color(hex: 0x111114),
        raised: Color(hex: 0x16161A),
        border: Color.white.opacity(0.08),
        borderStrong: Color.white.opacity(0.16),
        foreground: Color(hex: 0xF4F4F6),
        muted: Color.white.opacity(0.60),
        accent: Color(hex: 0xA0A0FF),
        accentSoft: Color(hex: 0xA0A0FF).opacity(0.13),
        accentLine: Color(hex: 0xA0A0FF).opacity(0.40),
        green: Color(hex: 0x34D399),
        greenSoft: Color(hex: 0x34D399).opacity(0.14),
        amber: Color(hex: 0xFBBF24),
        amberSoft: Color(hex: 0xFBBF24).opacity(0.14),
        red: Color(hex: 0xF87171),
        redSoft: Color(hex: 0xF87171).opacity(0.15),
        violet: Color(hex: 0xC084FC),
        violetSoft: Color(hex: 0xC084FC).opacity(0.14),
        cyan: Color(hex: 0x22D3EE),
        codeBackground: Color(hex: 0x0D0D12),
        diffAddBackground: Color(hex: 0x10B981).opacity(0.16),
        diffAddText: Color(hex: 0x6EE7B7),
        diffDeleteBackground: Color(hex: 0xEF4444).opacity(0.16),
        diffDeleteText: Color(hex: 0xFCA5A5),
        brandStart: Color(hex: 0xFF2E8C),
        brandMid: Color(hex: 0xA855F7),
        brandEnd: Color(hex: 0x06B6D4)
    )

    public static let oled = OMPPalette(
        background: .black,
        surface: Color(hex: 0x050507),
        card: Color(hex: 0x0A0A0E),
        raised: Color(hex: 0x111117),
        border: Color.white.opacity(0.11),
        borderStrong: Color.white.opacity(0.20),
        foreground: Color(hex: 0xF8FAFC),
        muted: Color.white.opacity(0.64),
        accent: Color(hex: 0xA5A5FF),
        accentSoft: Color(hex: 0xA5A5FF).opacity(0.16),
        accentLine: Color(hex: 0xA5A5FF).opacity(0.45),
        green: Color(hex: 0x34D399),
        greenSoft: Color(hex: 0x34D399).opacity(0.16),
        amber: Color(hex: 0xFBBF24),
        amberSoft: Color(hex: 0xFBBF24).opacity(0.16),
        red: Color(hex: 0xF87171),
        redSoft: Color(hex: 0xF87171).opacity(0.18),
        violet: Color(hex: 0xC084FC),
        violetSoft: Color(hex: 0xC084FC).opacity(0.16),
        cyan: Color(hex: 0x22D3EE),
        codeBackground: Color(hex: 0x07070A),
        diffAddBackground: Color(hex: 0x10B981).opacity(0.18),
        diffAddText: Color(hex: 0x6EE7B7),
        diffDeleteBackground: Color(hex: 0xEF4444).opacity(0.18),
        diffDeleteText: Color(hex: 0xFCA5A5),
        brandStart: Color(hex: 0xFF2E8C),
        brandMid: Color(hex: 0xA855F7),
        brandEnd: Color(hex: 0x06B6D4)
    )

    public static let light = OMPPalette(
        background: Color(hex: 0xF7F7FA),
        surface: Color(hex: 0xFFFFFF),
        card: Color(hex: 0xFFFFFF),
        raised: Color(hex: 0xEFEFF4),
        border: Color.black.opacity(0.09),
        borderStrong: Color.black.opacity(0.18),
        foreground: Color(hex: 0x111116),
        muted: Color.black.opacity(0.58),
        accent: Color(hex: 0x4F46E5),
        accentSoft: Color(hex: 0x4F46E5).opacity(0.11),
        accentLine: Color(hex: 0x4F46E5).opacity(0.36),
        green: Color(hex: 0x047857),
        greenSoft: Color(hex: 0x059669).opacity(0.12),
        amber: Color(hex: 0xB45309),
        amberSoft: Color(hex: 0xD97706).opacity(0.14),
        red: Color(hex: 0xDC2626),
        redSoft: Color(hex: 0xDC2626).opacity(0.12),
        violet: Color(hex: 0x7E22CE),
        violetSoft: Color(hex: 0x9333EA).opacity(0.12),
        cyan: Color(hex: 0x0891B2),
        codeBackground: Color(hex: 0xF1F2F7),
        diffAddBackground: Color(hex: 0x10B981).opacity(0.14),
        diffAddText: Color(hex: 0x065F46),
        diffDeleteBackground: Color(hex: 0xEF4444).opacity(0.14),
        diffDeleteText: Color(hex: 0x991B1B),
        brandStart: Color(hex: 0xE11D74),
        brandMid: Color(hex: 0x7C3AED),
        brandEnd: Color(hex: 0x0891B2)
    )

    public static func resolve(preference: ThemePreference, colorScheme: ColorScheme) -> OMPPalette {
        switch preference {
        case .dark: return .dark
        case .oled: return .oled
        case .light: return .light
        case .system: return colorScheme == .dark ? .dark : .light
        }
    }
}

public enum OMPTypography {
    /// Code blocks and diffs: the caption size the rest of the app uses for monospaced text.
    public static let monoSmall: Font = .caption.monospaced()
}

public enum KaTeXMathScale {
    public static let defaultsKey = "omp.mathScale"
    public static let minPercent = 80
    public static let maxPercent = 200
    public static let stepPercent = 5
    public static let defaultPercent = 100

    public static func clampAndRound(_ value: Double) -> Int {
        let clamped = min(Double(maxPercent), max(Double(minPercent), value.isFinite ? value : Double(defaultPercent)))
        return Int((clamped / Double(stepPercent)).rounded()) * stepPercent
    }

    public static func clampAndRound(_ value: Int) -> Int {
        clampAndRound(Double(value))
    }

    public static func factor(percent: Int) -> Double {
        Double(clampAndRound(percent)) / 100.0
    }
}

private struct OMPPaletteKey: EnvironmentKey {
    static let defaultValue: OMPPalette = .dark
}

public extension EnvironmentValues {
    var ompPalette: OMPPalette {
        get { self[OMPPaletteKey.self] }
        set { self[OMPPaletteKey.self] = newValue }
    }
}

public extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }

    /// Parses `#RRGGBB` or CSS `oklch(L C H)` project colors returned by `companion/workspaces.mjs`.
    static func fromCSS(_ value: String?, fallback: Color = Color(hex: 0xA0A0FF)) -> Color {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return fallback
        }
        if raw.hasPrefix("#"), raw.count == 7, let val = UInt32(raw.dropFirst(), radix: 16) {
            return Color(hex: val)
        }
        if raw.lowercased().hasPrefix("oklch("), raw.hasSuffix(")") {
            let inner = raw.dropFirst(6).dropLast()
            let parts = inner.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            if parts.count >= 3 {
                let lRaw = parts[0]
                let l: Double
                if lRaw.hasSuffix("%"), let p = Double(lRaw.dropLast()) {
                    l = p / 100.0
                } else {
                    l = Double(lRaw) ?? 0.72
                }
                let c = Double(parts[1]) ?? 0.13
                let hDeg = Double(parts[2]) ?? 265.0
                return oklch(l: l, c: c, hDegrees: hDeg)
            }
        }
        return fallback
    }

    static func oklch(l: Double, c: Double, hDegrees: Double) -> Color {
        let hRad = hDegrees * .pi / 180.0
        let a = c * cos(hRad)
        let b = c * sin(hRad)

        let l_ = l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = l - 0.0894841775 * a - 1.2914855480 * b

        let l3 = l_ * l_ * l_
        let m3 = m_ * m_ * m_
        let s3 = s_ * s_ * s_

        let rLin = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
        let gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
        let bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3

        func gamma(_ x: Double) -> Double {
            let clamped = max(0.0, min(1.0, x))
            if clamped <= 0.0031308 {
                return 12.92 * clamped
            }
            return 1.055 * pow(clamped, 1.0 / 2.4) - 0.055
        }
        return Color(.sRGB, red: gamma(rLin), green: gamma(gLin), blue: gamma(bLin), opacity: 1.0)
    }

    var cssRGBAString: String {
        #if canImport(UIKit)
        var r: CGFloat = 0
        var g: CGFloat = 0
        var b: CGFloat = 0
        var a: CGFloat = 1
        let ui = UIColor(self).resolvedColor(with: UITraitCollection.current)
        if ui.getRed(&r, green: &g, blue: &b, alpha: &a) {
            return String(
                format: "rgba(%d,%d,%d,%.3f)",
                locale: Locale(identifier: "en_US_POSIX"),
                Int((r * 255).rounded()),
                Int((g * 255).rounded()),
                Int((b * 255).rounded()),
                Double(a)
            )
        }
        #endif
        return "rgba(244,244,246,1.000)"
    }
}

public extension View {
    /// Ensures touch targets meet iOS 44x44 pt ergonomics and accessibility guidelines.
    func minTouchTarget(_ size: CGFloat = 44) -> some View {
        frame(minWidth: size, minHeight: size)
    }

    func ompCard(_ palette: OMPPalette, padding: CGFloat = 12, radius: CGFloat = 12) -> some View {
        self
            .padding(padding)
            .background(palette.card)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(palette.border, lineWidth: 1)
            )
    }
}
