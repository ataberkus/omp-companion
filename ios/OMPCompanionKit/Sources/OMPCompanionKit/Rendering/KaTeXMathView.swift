import Foundation
import SwiftUI

#if canImport(JavaScriptCore)
import JavaScriptCore
#endif

#if canImport(UIKit) && canImport(WebKit)
import UIKit
import WebKit
#endif

// MARK: - KaTeX Formula Validator (matches web app.js isFormula)

public enum KaTeXValidator {
    private static let documentPattern = try? NSRegularExpression(
        pattern: #"\\(documentclass|usepackage|begin\s*\{document\})"#,
        options: []
    )
    private static let lock = NSLock()
    private static var validationCache: [String: Bool] = [:]
    #if canImport(JavaScriptCore)
    private static var jsContext: JSContext?
    private static var didAttemptJSLoad = false
    #endif

    public static func looksLikeLatexDocument(_ code: String) -> Bool {
        guard let regex = documentPattern else { return false }
        let range = NSRange(code.startIndex..<code.endIndex, in: code)
        return regex.firstMatch(in: code, options: [], range: range) != nil
    }

    public static func isFormula(code: String, language: String) -> Bool {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let lang = language.lowercased()
        if lang == "math" { return true }
        guard lang == "latex" || lang == "tex" else { return false }
        if looksLikeLatexDocument(trimmed) { return false }
        if trimmed.count > 20_000 { return false }

        #if canImport(JavaScriptCore)
        if let valid = validateWithJSCore(trimmed) {
            return valid
        }
        #endif
        return true
    }

    #if canImport(JavaScriptCore)
    private static func validateWithJSCore(_ tex: String) -> Bool? {
        lock.lock()
        defer { lock.unlock() }

        if let cached = validationCache[tex] {
            return cached
        }

        if !didAttemptJSLoad {
            didAttemptJSLoad = true
            if let jsURL = katexResourceURL(name: "katex.min", ext: "js", subdirectory: nil),
               let source = try? String(contentsOf: jsURL, encoding: .utf8),
               let ctx = JSContext() {
                ctx.exceptionHandler = { _, _ in }
                ctx.evaluateScript(source)
                if ctx.objectForKeyedSubscript("katex")?.isUndefined == false {
                    jsContext = ctx
                }
            }
        }

        guard let ctx = jsContext,
              let katexObj = ctx.objectForKeyedSubscript("katex"),
              !katexObj.isUndefined else {
            return nil
        }

        let opts: [String: Any] = [
            "displayMode": true,
            "throwOnError": false,
            "trust": false,
            "strict": "ignore",
            "output": "htmlAndMathml",
            "maxSize": 50,
            "maxExpand": 1000
        ]
        guard let result = katexObj.invokeMethod("renderToString", withArguments: [tex, opts]),
              let html = result.toString() else {
            return nil
        }

        let ok = !html.hasPrefix("<span class=\"katex-error\"")
        if validationCache.count > 512 {
            validationCache.removeAll(keepingCapacity: true)
        }
        validationCache[tex] = ok
        return ok
    }
    #endif

    static func katexResourceURL(name: String, ext: String, subdirectory: String?) -> URL? {
        let sub = subdirectory.map { "KaTeX/\($0)" } ?? "KaTeX"
        if let url = Bundle.module.url(forResource: name, withExtension: ext, subdirectory: sub) {
            return url
        }
        return Bundle.module.url(forResource: name, withExtension: ext)
    }
}

// MARK: - Height Cache

@MainActor
final class KaTeXHeightCache {
    static let shared = KaTeXHeightCache()

    struct Key: Hashable {
        let contentKey: String
        let widthBucket: Int
        let mathScale: Int
        let fontSizeBucket: Int
    }

    private var storage: [Key: CGSize] = [:]

    func cachedSize(for key: Key) -> CGSize? {
        storage[key]
    }

    func setSize(_ size: CGSize, for key: Key) {
        if storage.count > 2000 {
            storage.removeAll(keepingCapacity: true)
        }
        storage[key] = size
    }

    nonisolated static func compactKey(prefix: String, content: String) -> String {
        if content.count <= 180 {
            return prefix + ":" + content
        }
        var hash: UInt64 = 14695981039346656037
        for byte in content.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1099511628211
        }
        return "\(prefix):\(content.count):\(String(hash, radix: 16))"
    }
}

// MARK: - Payloads & Theme

enum KaTeXRenderMode: Equatable {
    case block(tex: String)
    case inlineHTML(html: String, intrinsicWidth: Bool)

    var cacheKeyPrefix: String {
        switch self {
        case .block(let tex):
            return KaTeXHeightCache.compactKey(prefix: "B", content: tex)
        case .inlineHTML(let html, let intrinsicWidth):
            return KaTeXHeightCache.compactKey(prefix: intrinsicWidth ? "IT" : "I", content: html)
        }
    }

    var blockTeX: String? {
        if case .block(let tex) = self { return tex }
        return nil
    }

    var isIntrinsicWidth: Bool {
        if case .inlineHTML(_, let intrinsic) = self { return intrinsic }
        return false
    }
}

struct KaTeXTypography: Equatable {
    let fontSize: CGFloat
    let fontWeight: Int
    let lineHeight: CGFloat
    let foreground: Color

    static func paragraph(palette: OMPPalette) -> KaTeXTypography {
        KaTeXTypography(
            fontSize: preferredPointSize(.body, fallback: 17),
            fontWeight: 400,
            lineHeight: 1.48,
            foreground: palette.foreground
        )
    }

    static func heading(level: Int, palette: OMPPalette) -> KaTeXTypography {
        let style: FontStyleToken
        switch level {
        case 1: style = .title3
        case 2: style = .headline
        case 3: style = .subheadline
        default: style = .callout
        }
        return KaTeXTypography(
            fontSize: preferredPointSize(style, fallback: level == 1 ? 20 : 17),
            fontWeight: 600,
            lineHeight: 1.32,
            foreground: palette.foreground
        )
    }

    static func blockquote(palette: OMPPalette) -> KaTeXTypography {
        KaTeXTypography(
            fontSize: preferredPointSize(.body, fallback: 17),
            fontWeight: 400,
            lineHeight: 1.48,
            foreground: palette.muted
        )
    }

    static func tableCell(isHeader: Bool, palette: OMPPalette) -> KaTeXTypography {
        KaTeXTypography(
            fontSize: preferredPointSize(.caption1, fallback: 12),
            fontWeight: isHeader ? 600 : 400,
            lineHeight: 1.4,
            foreground: palette.foreground
        )
    }

    private enum FontStyleToken {
        case body, title3, headline, subheadline, callout, caption1
    }

    private static func preferredPointSize(_ token: FontStyleToken, fallback: CGFloat) -> CGFloat {
        #if canImport(UIKit)
        let style: UIFont.TextStyle
        switch token {
        case .body: style = .body
        case .title3: style = .title3
        case .headline: style = .headline
        case .subheadline: style = .subheadline
        case .callout: style = .callout
        case .caption1: style = .caption1
        }
        return UIFont.preferredFont(forTextStyle: style).pointSize
        #else
        return fallback
        #endif
    }
}

// MARK: - KaTeX SwiftUI Views

public struct KaTeXBlockMathView: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage(KaTeXMathScale.defaultsKey) private var mathScalePercent: Int = KaTeXMathScale.defaultPercent

    public let tex: String
    public var onCopyLaTeX: ((String) -> Void)?

    @State private var measuredSize: CGSize = .zero
    @State private var hasRendered = false
    @State private var containerWidth: CGFloat = 320

    public init(tex: String, onCopyLaTeX: ((String) -> Void)? = nil) {
        self.tex = tex
        self.onCopyLaTeX = onCopyLaTeX
    }

    private var clampedScale: Int {
        KaTeXMathScale.clampAndRound(mathScalePercent)
    }

    private var typography: KaTeXTypography {
        KaTeXTypography.paragraph(palette: palette)
    }

    private var readableFallback: String {
        tex.count <= 20_000 ? TeXUnicode.convert(tex) : String(tex.prefix(500))
    }

    private var cacheKey: KaTeXHeightCache.Key {
        KaTeXHeightCache.Key(
            contentKey: KaTeXHeightCache.compactKey(prefix: "B", content: tex),
            widthBucket: max(1, Int(containerWidth.rounded())),
            mathScale: clampedScale,
            fontSizeBucket: Int(typography.fontSize.rounded())
        )
    }

    private var resolvedHeight: CGFloat {
        if measuredSize.height > 0 { return measuredSize.height }
        if let cached = KaTeXHeightCache.shared.cachedSize(for: cacheKey), cached.height > 0 {
            return cached.height
        }
        let lineCount = max(1, tex.split(separator: "\n", omittingEmptySubsequences: false).count)
        let scale = KaTeXMathScale.factor(percent: clampedScale)
        let extraFractionRoom: CGFloat = (tex.contains("\\frac") || tex.contains("\\dfrac") || tex.contains("\\boxed")) ? 16 : 0
        return max(40, (CGFloat(lineCount) * 28 + extraFractionRoom) * scale)
    }

    public var body: some View {
        let mode = KaTeXRenderMode.block(tex: tex)
        ZStack(alignment: .leading) {
            if !hasRendered {
                Text(readableFallback)
                    .font(.system(.body, design: .serif))
                    .foregroundStyle(palette.foreground.opacity(0.75))
                    .padding(.vertical, 6)
            }

            #if canImport(UIKit) && canImport(WebKit)
            KaTeXWebViewRepresentable(
                mode: mode,
                palette: palette,
                typography: typography,
                mathScalePercent: clampedScale,
                dynamicTypeTrigger: "\(dynamicTypeSize)",
                fallbackHeight: resolvedHeight,
                measuredSize: $measuredSize,
                hasRendered: $hasRendered,
                containerWidth: $containerWidth,
                onCopyLaTeX: copyLaTeXAction
            )
            .opacity(hasRendered ? 1 : 0.01)
            #endif
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: resolvedHeight)
        .contextMenu {
            Button {
                copyLaTeXAction(tex)
            } label: {
                Label("Copy LaTeX", systemImage: "doc.on.doc")
            }
            Button {
                copyText(readableFallback)
            } label: {
                Label("Copy Readable Text", systemImage: "textformat")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(readableFallback)
        .accessibilityValue("Math formula")
        .accessibilityAction(named: "Copy LaTeX") {
            copyLaTeXAction(tex)
        }
        .onChange(of: cacheKey) { _, newKey in
            if let cached = KaTeXHeightCache.shared.cachedSize(for: newKey) {
                measuredSize = cached
            }
        }
    }

    private func copyLaTeXAction(_ value: String) {
        if let onCopyLaTeX {
            onCopyLaTeX(value)
        } else {
            copyText(value)
        }
    }

    private func copyText(_ value: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = value
        let gen = UIImpactFeedbackGenerator(style: .light)
        gen.impactOccurred()
        #endif
    }
}

public struct KaTeXInlineView: View {
    @Environment(\.ompPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @AppStorage(KaTeXMathScale.defaultsKey) private var mathScalePercent: Int = KaTeXMathScale.defaultPercent

    public let rawMarkdown: String
    public let htmlBody: String
    let typography: KaTeXTypography
    public var intrinsicWidth: Bool

    @State private var measuredSize: CGSize = .zero
    @State private var hasRendered = false
    @State private var containerWidth: CGFloat = 320

    init(
        rawMarkdown: String,
        htmlBody: String,
        typography: KaTeXTypography,
        intrinsicWidth: Bool = false
    ) {
        self.rawMarkdown = rawMarkdown
        self.htmlBody = htmlBody
        self.typography = typography
        self.intrinsicWidth = intrinsicWidth
    }

    private var clampedScale: Int {
        KaTeXMathScale.clampAndRound(mathScalePercent)
    }

    private var cacheKey: KaTeXHeightCache.Key {
        KaTeXHeightCache.Key(
            contentKey: KaTeXHeightCache.compactKey(prefix: intrinsicWidth ? "IT" : "I", content: htmlBody),
            widthBucket: intrinsicWidth ? 0 : max(1, Int(containerWidth.rounded())),
            mathScale: clampedScale,
            fontSizeBucket: Int(typography.fontSize.rounded())
        )
    }

    private var estimatedHeight: CGFloat {
        let charsPerLine = max(16.0, Double(containerWidth) / max(8.0, Double(typography.fontSize) * 0.52))
        let lines = max(1, Int(ceil(Double(max(1, rawMarkdown.count)) / charsPerLine)))
        let mathBoost: CGFloat = (rawMarkdown.contains("\\frac") || rawMarkdown.contains("\\dfrac") || rawMarkdown.contains("$$")) ? 12 : 4
        return max(typography.fontSize * typography.lineHeight, CGFloat(lines) * typography.fontSize * typography.lineHeight + mathBoost)
    }

    private var resolvedHeight: CGFloat {
        if measuredSize.height > 0 { return measuredSize.height }
        if let cached = KaTeXHeightCache.shared.cachedSize(for: cacheKey), cached.height > 0 {
            return cached.height
        }
        return estimatedHeight
    }

    private var resolvedIntrinsicWidth: CGFloat? {
        guard intrinsicWidth else { return nil }
        if measuredSize.width > 0 { return measuredSize.width }
        if let cached = KaTeXHeightCache.shared.cachedSize(for: cacheKey), cached.width > 0 {
            return cached.width
        }
        return min(260, max(44, CGFloat(rawMarkdown.count) * typography.fontSize * 0.55))
    }

    public var body: some View {
        let mode = KaTeXRenderMode.inlineHTML(html: htmlBody, intrinsicWidth: intrinsicWidth)
        ZStack(alignment: .leading) {
            if !hasRendered {
                Text(MarkdownParser.renderInline(rawMarkdown, palette: palette))
                    .font(.system(size: typography.fontSize))
                    .foregroundStyle(typography.foreground.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }

            #if canImport(UIKit) && canImport(WebKit)
            KaTeXWebViewRepresentable(
                mode: mode,
                palette: palette,
                typography: typography,
                mathScalePercent: clampedScale,
                dynamicTypeTrigger: "\(dynamicTypeSize)",
                fallbackHeight: resolvedHeight,
                measuredSize: $measuredSize,
                hasRendered: $hasRendered,
                containerWidth: $containerWidth,
                onOpenURL: { url in openURL(url) }
            )
            .opacity(hasRendered ? 1 : 0.01)
            #endif
        }
        .frame(width: resolvedIntrinsicWidth, height: resolvedHeight, alignment: .leading)
        .frame(maxWidth: intrinsicWidth ? nil : .infinity, alignment: .leading)
        .contextMenu {
            Button {
                #if canImport(UIKit)
                UIPasteboard.general.string = rawMarkdown
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                #endif
            } label: {
                Label("Copy Markdown & LaTeX", systemImage: "doc.on.doc")
            }
            Button {
                #if canImport(UIKit)
                UIPasteboard.general.string = String(MarkdownParser.renderInline(rawMarkdown, palette: palette).characters)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                #endif
            } label: {
                Label("Copy Plain Text", systemImage: "textformat")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(MarkdownParser.renderInline(rawMarkdown, palette: palette).characters))
        .onChange(of: cacheKey) { _, newKey in
            if let cached = KaTeXHeightCache.shared.cachedSize(for: newKey) {
                measuredSize = cached
            }
        }
    }
}

// MARK: - Formula Size Controls (Settings & Session Sheet)

public struct FormulaSizeControlsView: View {
    @Environment(\.ompPalette) private var palette
    @AppStorage(KaTeXMathScale.defaultsKey) private var mathScalePercent: Int = KaTeXMathScale.defaultPercent

    public init() {}

    private var clampedPercent: Int {
        KaTeXMathScale.clampAndRound(mathScalePercent)
    }

    private var sliderBinding: Binding<Double> {
        Binding(
            get: { Double(clampedPercent) },
            set: { newValue in
                mathScalePercent = KaTeXMathScale.clampAndRound(newValue)
            }
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Formula Size")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                Spacer()
                Text("\(clampedPercent)%")
                    .font(.subheadline.monospacedDigit().weight(.semibold))
                    .foregroundStyle(palette.accent)
            }

            VStack {
                KaTeXBlockMathView(tex: #"f(t)=\dfrac{e^{t}-e^{-2t}}{t}"#)
                    .frame(minHeight: 54)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(palette.border, lineWidth: 1)
            )
            .accessibilityHidden(true)

            HStack(spacing: 12) {
                Text("A")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
                    .accessibilityHidden(true)
                Slider(
                    value: sliderBinding,
                    in: Double(KaTeXMathScale.minPercent)...Double(KaTeXMathScale.maxPercent),
                    step: Double(KaTeXMathScale.stepPercent)
                )
                .tint(palette.accent)
                .accessibilityLabel("Formula size")
                .accessibilityValue("\(clampedPercent) percent")
                Text("A")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(palette.muted)
                    .accessibilityHidden(true)
            }

            HStack {
                Button("Reset to 100%") {
                    mathScalePercent = KaTeXMathScale.defaultPercent
                }
                .font(.caption.weight(.semibold))
                .disabled(clampedPercent == KaTeXMathScale.defaultPercent)
                Spacer()
            }
        }
    }
}

public struct FormulaSizeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette

    public init() {}

    public var body: some View {
        NavigationStack {
            ScrollView {
                FormulaSizeControlsView()
                    .ompCard(palette)
                    .padding()
            }
            .background(palette.background)
            .navigationTitle("Formula Size")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - WKWebView Implementation

#if canImport(UIKit) && canImport(WebKit)
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

private final class OMPSelectableKaTeXWebView: WKWebView {
    var blockTeX: String?
    var onCopyLaTeX: ((String) -> Void)?

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard let tex = blockTeX, !tex.isEmpty else { return }
        let action = UIAction(title: "Copy LaTeX", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
            self?.onCopyLaTeX?(tex)
        }
        let menu = UIMenu(options: .displayInline, children: [action])
        builder.insertChild(menu, atStartOfMenu: .standardEdit)
    }
}

private struct KaTeXWebViewRepresentable: UIViewRepresentable {
    let mode: KaTeXRenderMode
    let palette: OMPPalette
    let typography: KaTeXTypography
    let mathScalePercent: Int
    let dynamicTypeTrigger: String
    let fallbackHeight: CGFloat
    @Binding var measuredSize: CGSize
    @Binding var hasRendered: Bool
    @Binding var containerWidth: CGFloat
    var onCopyLaTeX: ((String) -> Void)?
    var onOpenURL: ((URL) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(
            measuredSize: $measuredSize,
            hasRendered: $hasRendered,
            containerWidth: $containerWidth,
            onCopyLaTeX: onCopyLaTeX,
            onOpenURL: onOpenURL
        )
    }

    func makeUIView(context: Context) -> OMPSelectableKaTeXWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(WeakScriptMessageHandler(context.coordinator), name: "ompMath")

        let webView = OMPSelectableKaTeXWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.navigationDelegate = context.coordinator
        webView.blockTeX = mode.blockTeX
        webView.onCopyLaTeX = onCopyLaTeX
        context.coordinator.webView = webView

        if let hostURL = KaTeXValidator.katexResourceURL(name: "host", ext: "html", subdirectory: nil) {
            webView.loadFileURL(hostURL, allowingReadAccessTo: hostURL.deletingLastPathComponent())
        }
        return webView
    }

    func updateUIView(_ webView: OMPSelectableKaTeXWebView, context: Context) {
        webView.blockTeX = mode.blockTeX
        webView.onCopyLaTeX = onCopyLaTeX
        context.coordinator.onCopyLaTeX = onCopyLaTeX
        context.coordinator.onOpenURL = onOpenURL
        context.coordinator.update(
            webView: webView,
            mode: mode,
            palette: palette,
            typography: typography,
            mathScalePercent: mathScalePercent,
            dynamicTypeTrigger: dynamicTypeTrigger
        )
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: OMPSelectableKaTeXWebView, context: Context) -> CGSize? {
        let proposedW = proposal.width
        if let w = proposedW, w.isFinite, w > 1 {
            context.coordinator.updateContainerWidth(w)
        }
        let effectiveW: CGFloat
        if mode.isIntrinsicWidth {
            let measuredW = measuredSize.width > 0 ? measuredSize.width : (uiView.bounds.width > 1 ? uiView.bounds.width : 120)
            if let w = proposedW, w.isFinite {
                effectiveW = min(w, measuredW)
            } else {
                effectiveW = measuredW
            }
        } else {
            effectiveW = (proposedW != nil && proposedW!.isFinite && proposedW! > 0)
                ? proposedW!
                : max(containerWidth, uiView.bounds.width)
        }
        let h = measuredSize.height > 0 ? measuredSize.height : (uiView.bounds.height > 1 ? uiView.bounds.height : fallbackHeight)
        return CGSize(width: max(1, effectiveW), height: max(1, h))
    }

    static func dismantleUIView(_ uiView: OMPSelectableKaTeXWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "ompMath")
        uiView.navigationDelegate = nil
        coordinator.webView = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        @Binding var measuredSize: CGSize
        @Binding var hasRendered: Bool
        @Binding var containerWidth: CGFloat
        var onCopyLaTeX: ((String) -> Void)?
        var onOpenURL: ((URL) -> Void)?
        weak var webView: OMPSelectableKaTeXWebView?

        private var isPageLoaded = false
        private var lastContentKey: String?
        private var lastThemeSignature: String?
        private var currentCacheKey: KaTeXHeightCache.Key?
        private var pendingMode: KaTeXRenderMode?
        private var pendingThemeVars: [String: Any]?
        private var pendingThemeSignature: String?
        init(
            measuredSize: Binding<CGSize>,
            hasRendered: Binding<Bool>,
            containerWidth: Binding<CGFloat>,
            onCopyLaTeX: ((String) -> Void)?,
            onOpenURL: ((URL) -> Void)?
        ) {
            _measuredSize = measuredSize
            _hasRendered = hasRendered
            _containerWidth = containerWidth
            self.onCopyLaTeX = onCopyLaTeX
            self.onOpenURL = onOpenURL
        }

        func updateContainerWidth(_ width: CGFloat) {
            let rounded = width.rounded()
            if abs(rounded - containerWidth) > 0.5 {
                DispatchQueue.main.async { [weak self] in
                    self?.containerWidth = rounded
                }
            }
        }

        func update(
            webView: OMPSelectableKaTeXWebView,
            mode: KaTeXRenderMode,
            palette: OMPPalette,
            typography: KaTeXTypography,
            mathScalePercent: Int,
            dynamicTypeTrigger: String
        ) {
            let vars: [String: Any] = [
                "fg": typography.foreground.cssRGBAString,
                "muted": palette.muted.cssRGBAString,
                "accent": palette.accent.cssRGBAString,
                "codeBg": palette.codeBackground.cssRGBAString,
                "red": palette.red.cssRGBAString,
                "mathScale": KaTeXMathScale.factor(percent: mathScalePercent),
                "fontSize": Double(typography.fontSize),
                "fontWeight": typography.fontWeight,
                "lineHeight": Double(typography.lineHeight)
            ]

            let contentKey = mode.cacheKeyPrefix
            let themeSig = "\(vars["fg"] ?? "")|\(vars["muted"] ?? "")|\(vars["accent"] ?? "")|\(vars["codeBg"] ?? "")|\(vars["red"] ?? "")|\(mathScalePercent)|\(Int(typography.fontSize.rounded()))|\(typography.fontWeight)|\(dynamicTypeTrigger)"
            let widthBucket = mode.isIntrinsicWidth ? 0 : max(1, Int(containerWidth.rounded()))
            currentCacheKey = KaTeXHeightCache.Key(
                contentKey: contentKey,
                widthBucket: widthBucket,
                mathScale: mathScalePercent,
                fontSizeBucket: Int(typography.fontSize.rounded())
            )

            guard isPageLoaded else {
                pendingMode = mode
                pendingThemeVars = vars
                pendingThemeSignature = themeSig
                return
            }

            if lastContentKey != contentKey {
                lastContentKey = contentKey
                lastThemeSignature = themeSig
                evaluateRender(webView: webView, mode: mode, vars: vars)
            } else if lastThemeSignature != themeSig {
                lastThemeSignature = themeSig
                evaluateSetTheme(webView: webView, vars: vars)
            }
        }

        private func evaluateRender(webView: WKWebView, mode: KaTeXRenderMode, vars: [String: Any]) {
            var payload: [String: Any] = ["vars": vars]
            switch mode {
            case .block(let tex):
                payload["mode"] = "block"
                payload["tex"] = tex
                payload["intrinsicWidth"] = false
            case .inlineHTML(let html, let intrinsicWidth):
                payload["mode"] = "inline"
                payload["html"] = html
                payload["intrinsicWidth"] = intrinsicWidth
            }
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.__ompRender && window.__ompRender(\(json));", completionHandler: nil)
        }

        private func evaluateSetTheme(webView: WKWebView, vars: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: vars),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.__ompSetTheme && window.__ompSetTheme(\(json));", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isPageLoaded = true
            if let mode = pendingMode, let vars = pendingThemeVars {
                lastContentKey = mode.cacheKeyPrefix
                lastThemeSignature = pendingThemeSignature
                pendingMode = nil
                pendingThemeVars = nil
                pendingThemeSignature = nil
                evaluateRender(webView: webView, mode: mode, vars: vars)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
                DispatchQueue.main.async { [weak self] in
                    if let onOpenURL = self?.onOpenURL {
                        onOpenURL(url)
                    } else {
                        UIApplication.shared.open(url)
                    }
                }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "ompMath",
                  let body = message.body as? [String: Any],
                  let rawH = body["height"] as? Double else { return }
            let rawW = body["width"] as? Double ?? 0
            let newH = max(1, CGFloat(ceil(rawH)))
            let newW = max(0, CGFloat(ceil(rawW)))
            let newSize = CGSize(width: newW, height: newH)

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if let key = self.currentCacheKey {
                    KaTeXHeightCache.shared.setSize(newSize, for: key)
                }
                if abs(self.measuredSize.height - newSize.height) > 0.5 || abs(self.measuredSize.width - newSize.width) > 0.5 {
                    self.measuredSize = newSize
                }
                if !self.hasRendered {
                    self.hasRendered = true
                }
            }
        }
    }
}
#endif
