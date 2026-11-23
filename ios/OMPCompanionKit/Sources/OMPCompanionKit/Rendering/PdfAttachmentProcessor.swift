import Foundation
import UniformTypeIdentifiers

#if canImport(PDFKit)
import PDFKit
#endif

/// A PDF staged in the composer. It goes up whole (base64) with the message as `pdfs: [{data, name}]`; the host stores it
/// and adds the "Attached PDF:" line that OMP's read tool opens (`companion/pdfs.mjs`).
public struct PendingPdfAttachment: Identifiable, Hashable, Sendable, Codable {
    public let id: UUID
    public var name: String
    public var base64Data: String
    public var byteCount: Int
    public var pages: Int?
    public var estimatedTokens: Int

    public init(
        id: UUID = UUID(),
        name: String,
        base64Data: String,
        byteCount: Int,
        pages: Int?,
        estimatedTokens: Int
    ) {
        self.id = id
        self.name = name
        self.base64Data = base64Data
        self.byteCount = byteCount
        self.pages = pages
        self.estimatedTokens = estimatedTokens
    }

    /// One entry of a chat request's `pdfs`.
    public var wirePromptEntry: [String: Any] {
        ["data": base64Data, "name": name]
    }

    /// One entry of a draft save's `pdfs` (`draftPdfs`, which caps the estimate at 10M); the host reads the page count
    /// and size again.
    public func wireDraftEntry() -> [String: Any] {
        [
            "pdf": ["type": "pdf", "mimeType": "application/pdf", "data": base64Data],
            "name": name,
            "tokens": min(estimatedTokens, 10_000_000),
        ]
    }

    public static func fromDraftEntry(_ entry: DraftPdfEntry) -> PendingPdfAttachment? {
        guard let part = entry.pdf else { return nil }
        let decodedCount = entry.bytes ?? Data(base64Encoded: part.data)?.count ?? (part.data.count * 3 / 4)
        return PendingPdfAttachment(
            name: entry.name,
            base64Data: part.data,
            byteCount: decodedCount,
            pages: entry.pages,
            estimatedTokens: entry.tokens
        )
    }

    /// "12 pages · 1.4 MB", as the chip shows it.
    public var detail: String {
        PdfAttachmentProcessor.detail(pages: pages, bytes: byteCount)
    }
}

public enum PdfAttachmentError: LocalizedError, Sendable {
    case unreadable(name: String)
    case notPdf(name: String)
    case tooLarge(name: String, bytes: Int)
    case tooMany
    case alreadyAttached(name: String)
    case exceedsDraftPayloadLimit

    public var errorDescription: String? {
        switch self {
        case .unreadable(let name):
            return "Could not read \(name)."
        case .notPdf(let name):
            return "\(name) is not a valid PDF."
        case .tooLarge(let name, let bytes):
            return "\(name) is \(PdfAttachmentProcessor.sizeLabel(bytes)); the limit is \(PdfAttachmentProcessor.maxPdfBytes / 1_048_576) MB."
        case .tooMany:
            return "One message can carry at most \(PdfAttachmentProcessor.maxPdfs) PDFs. Send these first, then attach the rest."
        case .alreadyAttached(let name):
            return "\(name) is already attached."
        case .exceedsDraftPayloadLimit:
            return "Attachments must stay under \(PdfAttachmentProcessor.maxDraftAttachmentBytes / 1_048_576) MB together. Send these first, then attach the rest."
        }
    }
}

/// Mirrors `companion/pdfs.mjs`: limits, token estimate, names and the "Attached PDF:" reference lines.
public enum PdfAttachmentProcessor {
    /// `MAX_PDF_BYTES`: one file, decoded.
    public static let maxPdfBytes = 20 * 1024 * 1024
    /// `MAX_PDFS`: per chat request.
    public static let maxPdfs = 20
    /// `DRAFT_ATTACH_MAX`: base64 data one composer holds, images and PDFs together, under the 48 MB request cap.
    public static let maxDraftAttachmentBytes = 45 * 1024 * 1024

    /// `pdfTokens`: 1,500 tokens a page, or a quarter of the ~4 bytes a token when the page count is unknown.
    public static func estimateTokens(pages: Int?, bytes: Int) -> Int {
        if let pages, pages > 0 { return pages * 1500 }
        return (max(0, bytes) + 15) / 16
    }

    /// The `mb` size label the host writes into reference lines: "820 KB", "1.4 MB", "12 MB".
    public static func sizeLabel(_ bytes: Int) -> String {
        if bytes >= 1_048_576 {
            let mb = Double(bytes) / 1_048_576
            return String(format: bytes >= 10_485_760 ? "%.0f MB" : "%.1f MB", mb)
        }
        return "\(max(1, Int((Double(bytes) / 1024).rounded()))) KB"
    }

    public static func pagesLabel(_ pages: Int?) -> String? {
        guard let pages, pages > 0 else { return nil }
        return "\(pages) \(pages == 1 ? "page" : "pages")"
    }

    public static func detail(pages: Int?, bytes: Int?) -> String {
        [bytes.flatMap { $0 > 0 ? sizeLabel($0) : nil }, pagesLabel(pages)].compactMap { $0 }.joined(separator: " · ")
    }

    /// `pdfName`, then the dashboard's 200-character cut: one line, no path separators.
    public static func sanitizeName(_ raw: String) -> String {
        var out = String.UnicodeScalarView()
        var inRun = false
        for scalar in raw.unicodeScalars {
            if scalar == "/" || scalar == "\\" || scalar.value < 0x20 || scalar.value == 0x7f {
                if !inRun { out.append("_") }
                inRun = true
            } else {
                out.append(scalar)
                inRun = false
            }
        }
        let trimmed = String(String(out).trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        return trimmed.isEmpty ? "document.pdf" : trimmed
    }

    /// Drafts tell attachments apart by name: "report.pdf" becomes "report (2).pdf" when taken.
    public static func uniqueName(_ base: String, taken: Set<String>) -> String {
        guard taken.contains(base) else { return base }
        let dot = base.lastIndex(of: ".").flatMap { $0 > base.startIndex ? $0 : nil }
        var n = 2
        while true {
            let candidate = dot.map { "\(base[..<$0]) (\(n))\(base[$0...])" } ?? "\(base) (\(n))"
            if !taken.contains(candidate) { return candidate }
            n += 1
        }
    }

    public static func isPdf(url: URL) -> Bool {
        if url.pathExtension.lowercased() == "pdf" { return true }
        return (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType?.conforms(to: .pdf)) == true
    }

    /// Reads an imported file inside its security scope, refusing one over the size limit before loading it.
    public static func readFile(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > maxPdfBytes {
            throw PdfAttachmentError.tooLarge(name: name, bytes: size)
        }
        do {
            return try Data(contentsOf: url)
        } catch {
            throw PdfAttachmentError.unreadable(name: name)
        }
    }

    /// Checks one PDF as the host will (`checkPdf`, `MAX_PDFS`, `DRAFT_ATTACH_MAX`) and stages it under a name no other
    /// attachment of this composer has.
    public static func process(
        _ data: Data,
        suggestedName: String,
        existing: [PendingPdfAttachment],
        takenNames: Set<String>,
        existingBase64Bytes: Int
    ) throws -> PendingPdfAttachment {
        let label = suggestedName.isEmpty ? "document.pdf" : suggestedName
        guard existing.count < maxPdfs else { throw PdfAttachmentError.tooMany }
        guard data.count <= maxPdfBytes else { throw PdfAttachmentError.tooLarge(name: label, bytes: data.count) }
        guard data.prefix(5) == Data("%PDF-".utf8) else { throw PdfAttachmentError.notPdf(name: label) }
        let b64 = data.base64EncodedString()
        if existing.contains(where: { $0.byteCount == data.count && $0.base64Data == b64 }) {
            throw PdfAttachmentError.alreadyAttached(name: label)
        }
        guard existingBase64Bytes + b64.utf8.count <= maxDraftAttachmentBytes else {
            throw PdfAttachmentError.exceedsDraftPayloadLimit
        }
        // Encrypted or unusual files may report no pages; they are still attached, with the size-based estimate.
        var pages: Int?
        #if canImport(PDFKit)
        if let count = PDFDocument(data: data)?.pageCount, count > 0 { pages = count }
        #endif
        return PendingPdfAttachment(
            name: uniqueName(sanitizeName(label), taken: takenNames),
            base64Data: b64,
            byteCount: data.count,
            pages: pages,
            estimatedTokens: estimateTokens(pages: pages, bytes: data.count)
        )
    }

    // MARK: - Reference Lines

    private static let refRegex = try! NSRegularExpression(
        pattern: #"^Attached PDF: (.+) \((?:(\d+) pages?|(\d+(?:\.\d+)?) (KB|MB))\) — (.*[\\/]([0-9a-f]{64})\.pdf)$"#
    )

    /// `pdfRef`: the line that hands a stored PDF to the agent; nil without its stored path.
    public static func refLine(_ pdf: MessagePdf) -> String? {
        guard let path = pdf.path, !path.isEmpty else { return nil }
        let size = pagesLabel(pdf.pages) ?? sizeLabel(pdf.bytes ?? 0)
        return "Attached PDF: \(pdf.name) (\(size)) — \(path)"
    }

    /// `withPdfRefs`: a message's own text followed by its PDFs' reference lines.
    public static func withPdfRefs(_ text: String, pdfs: [MessagePdf]) -> String {
        let lines = pdfs.compactMap(refLine)
        guard !lines.isEmpty else { return text }
        return [trimmingTrailingWhitespace(text), lines.joined(separator: "\n")].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// `splitPdfRefs`: a message's own text and the PDFs its trailing "Attached PDF:" lines name.
    public static func splitPdfRefs(_ value: String) -> (text: String, pdfs: [MessagePdf]) {
        guard value.contains("Attached PDF: ") else { return (value, []) }
        // Split on U+000A scalars: Swift treats "\r\n" as one Character, which would never equal "\n".
        let lines = value.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map { String(String.UnicodeScalarView($0)) }
        var pdfs: [MessagePdf] = []
        var i = lines.count
        while i > 0 {
            var line = lines[i - 1]
            if line.unicodeScalars.last == "\r" { line.unicodeScalars.removeLast() }
            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !pdfs.isEmpty {
                i -= 1
                continue
            }
            let ns = line as NSString
            guard let m = refRegex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { break }
            let group: (Int) -> String? = { idx in
                let r = m.range(at: idx)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }
            let size = group(3).flatMap { Double($0) }
            let unit = group(4)
            pdfs.insert(MessagePdf(
                id: group(6),
                name: group(1) ?? "",
                pages: group(2).flatMap { Int($0) },
                bytes: size.map { Int(($0 * (unit == "MB" ? 1_048_576 : 1024)).rounded()) },
                path: group(5)
            ), at: 0)
            i -= 1
        }
        guard !pdfs.isEmpty else { return (value, []) }
        return (trimmingTrailingWhitespace(lines[0..<i].joined(separator: "\n")), pdfs)
    }

    private static func trimmingTrailingWhitespace(_ s: String) -> String {
        var scalars = s.unicodeScalars
        while let last = scalars.last, CharacterSet.whitespacesAndNewlines.contains(last) {
            scalars.removeLast()
        }
        return String(scalars)
    }
}
