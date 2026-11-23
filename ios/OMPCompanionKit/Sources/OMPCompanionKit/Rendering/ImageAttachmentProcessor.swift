import Foundation
import CoreGraphics
import ImageIO

#if canImport(UIKit)
import UIKit
#endif

public struct PendingImageAttachment: Identifiable, Hashable, Sendable, Codable {
    public let id: UUID
    public var name: String
    public var mimeType: String
    public var base64Data: String
    public var previewDataURL: String?
    public var byteCount: Int
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var estimatedTokens: Int

    public init(
        id: UUID = UUID(),
        name: String,
        mimeType: String,
        base64Data: String,
        previewDataURL: String?,
        byteCount: Int,
        pixelWidth: Int,
        pixelHeight: Int,
        estimatedTokens: Int
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.base64Data = base64Data
        self.previewDataURL = previewDataURL
        self.byteCount = byteCount
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.estimatedTokens = estimatedTokens
    }

    public var wireImagePart: [String: Any] {
        [
            "type": "image",
            "mimeType": mimeType,
            "data": base64Data,
        ]
    }

    public func wireDraftImageEntry() -> [String: Any] {
        var obj: [String: Any] = [
            "name": name,
            "mimeType": mimeType,
            "tokens": estimatedTokens,
            "image": wireImagePart,
        ]
        if let previewDataURL {
            obj["preview"] = previewDataURL
        }
        return obj
    }

    public static func fromDraftEntry(_ entry: DraftImageEntry) -> PendingImageAttachment? {
        guard let part = entry.image else { return nil }
        let decodedCount = Data(base64Encoded: part.data)?.count ?? (part.data.count * 3 / 4)
        return PendingImageAttachment(
            name: entry.name,
            mimeType: part.mimeType,
            base64Data: part.data,
            previewDataURL: entry.preview,
            byteCount: decodedCount,
            pixelWidth: 0,
            pixelHeight: 0,
            estimatedTokens: entry.tokens
        )
    }
}

public enum ImageAttachmentError: LocalizedError, Sendable {
    case unreadableImage
    case exceedsSingleImageLimit
    case exceedsDraftPayloadLimit

    public var errorDescription: String? {
        switch self {
        case .unreadableImage:
            return "Could not read or encode that image."
        case .exceedsSingleImageLimit:
            return "Image still exceeds the 5 MB companion limit after compression."
        case .exceedsDraftPayloadLimit:
            return "Total attachments exceed the 45 MB draft limit. Remove an image or PDF before attaching more."
        }
    }
}

public enum ImageAttachmentProcessor {
    public static let maxSingleImageBytes = 5 * 1024 * 1024
    public static let maxDraftImagesBytes = 45 * 1024 * 1024
    public static let maxPreviewBytes = 900 * 1024

    /// Exact mirror of `companion/images.mjs`:
    /// `(w * h) / 750` after downscaling to `<= 1568px` max edge and `<= 1.15 MP`.
    public static func estimateTokens(width: Int, height: Int) -> Int {
        guard width > 0, height > 0 else { return 1600 }
        let w = Double(width)
        let h = Double(height)
        let k = min(1.0, 1568.0 / max(w, h), sqrt(1_150_000.0 / (w * h)))
        return Int(ceil(w * h * k * k / 750.0))
    }

    public static func detectImageFormat(data: Data) -> (mimeType: String, width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            return nil
        }
        let width = (props[kCGImagePropertyPixelWidth] as? Int) ?? 0
        let height = (props[kCGImagePropertyPixelHeight] as? Int) ?? 0

        let bytes = [UInt8](data.prefix(12))
        if bytes.count >= 8 && bytes[0...7] == [137, 80, 78, 71, 13, 10, 26, 10] {
            return ("image/png", width, height)
        }
        if bytes.count >= 3 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255 {
            return ("image/jpeg", width, height)
        }
        if bytes.count >= 12,
           String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
           String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" {
            return ("image/webp", width, height)
        }
        if bytes.count >= 6 {
            let hdr = String(bytes: bytes[0..<6], encoding: .ascii)
            if hdr == "GIF87a" || hdr == "GIF89a" {
                return ("image/gif", width, height)
            }
        }
        return nil
    }

    public static func processRawImageData(
        _ rawData: Data,
        suggestedName: String = "image.jpg",
        existingBase64Bytes: Int = 0
    ) throws -> PendingImageAttachment {
        // Keep valid PNG/JPEG/WebP/GIF directly if already under 5 MB and <= 2048px
        if let info = detectImageFormat(data: rawData),
           rawData.count <= maxSingleImageBytes,
           max(info.width, info.height) <= 2048 {
            let b64 = rawData.base64EncodedString()
            guard existingBase64Bytes + b64.utf8.count <= maxDraftImagesBytes else {
                throw ImageAttachmentError.exceedsDraftPayloadLimit
            }
            let preview = makePreviewDataURL(from: rawData)
            let tokens = estimateTokens(width: info.width, height: info.height)
            return PendingImageAttachment(
                name: sanitizeFilename(suggestedName, fallbackExt: info.mimeType == "image/png" ? "png" : "jpg"),
                mimeType: info.mimeType,
                base64Data: b64,
                previewDataURL: preview,
                byteCount: rawData.count,
                pixelWidth: info.width,
                pixelHeight: info.height,
                estimatedTokens: tokens
            )
        }

        #if canImport(UIKit)
        guard let uiImage = UIImage(data: rawData) else {
            throw ImageAttachmentError.unreadableImage
        }
        return try processUIImage(uiImage, suggestedName: suggestedName, existingBase64Bytes: existingBase64Bytes)
        #else
        throw ImageAttachmentError.unreadableImage
        #endif
    }

    #if canImport(UIKit)
    public static func processUIImage(
        _ image: UIImage,
        suggestedName: String = "photo.jpg",
        existingBase64Bytes: Int = 0
    ) throws -> PendingImageAttachment {
        let maxEdge: CGFloat = 1568
        let origW = image.size.width * image.scale
        let origH = image.size.height * image.scale
        let scale = min(1.0, maxEdge / max(1, max(origW, origH)))
        let targetSize = CGSize(width: max(1, floor(origW * scale)), height: max(1, floor(origH * scale)))

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: targetSize, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }

        var jpegData: Data?
        for quality in [0.85, 0.72, 0.56, 0.42] as [CGFloat] {
            if let candidate = rendered.jpegData(compressionQuality: quality), candidate.count <= maxSingleImageBytes {
                jpegData = candidate
                break
            }
        }
        guard let encoded = jpegData else {
            throw ImageAttachmentError.exceedsSingleImageLimit
        }
        let b64 = encoded.base64EncodedString()
        guard existingBase64Bytes + b64.utf8.count <= maxDraftImagesBytes else {
            throw ImageAttachmentError.exceedsDraftPayloadLimit
        }
        let preview = makePreviewDataURL(fromUIImage: rendered)
        let w = Int(targetSize.width)
        let h = Int(targetSize.height)
        return PendingImageAttachment(
            name: sanitizeFilename(suggestedName, fallbackExt: "jpg"),
            mimeType: "image/jpeg",
            base64Data: b64,
            previewDataURL: preview,
            byteCount: encoded.count,
            pixelWidth: w,
            pixelHeight: h,
            estimatedTokens: estimateTokens(width: w, height: h)
        )
    }

    private static func makePreviewDataURL(fromUIImage image: UIImage) -> String? {
        let maxThumb: CGFloat = 320
        let scale = min(1.0, maxThumb / max(1, max(image.size.width, image.size.height)))
        let size = CGSize(width: max(1, floor(image.size.width * scale)), height: max(1, floor(image.size.height * scale)))
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1.0
        fmt.opaque = true
        let thumb = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let data = thumb.jpegData(compressionQuality: 0.7), data.count <= maxPreviewBytes else {
            return nil
        }
        return "data:image/jpeg;base64,\(data.base64EncodedString())"
    }
    #endif

    private static func makePreviewDataURL(from data: Data) -> String? {
        #if canImport(UIKit)
        guard let img = UIImage(data: data) else { return nil }
        return makePreviewDataURL(fromUIImage: img)
        #else
        if data.count <= maxPreviewBytes {
            return "data:image/jpeg;base64,\(data.base64EncodedString())"
        }
        return nil
        #endif
    }

    public static func decodeDataURL(_ dataURL: String) -> Data? {
        guard let comma = dataURL.firstIndex(of: ",") else { return nil }
        let b64 = String(dataURL[dataURL.index(after: comma)...])
        return Data(base64Encoded: b64)
    }

    private static func sanitizeFilename(_ raw: String, fallbackExt: String) -> String {
        let base = URL(fileURLWithPath: raw).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        if base.isEmpty { return "image.\(fallbackExt)" }
        return String(base.prefix(80))
    }
}
