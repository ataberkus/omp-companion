import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct StatusPill: View {
    @Environment(\.ompPalette) private var palette
    public let status: SessionStatus
    public var compact: Bool = false

    public init(status: SessionStatus, compact: Bool = false) {
        self.status = status
        self.compact = compact
    }

    private var tint: Color {
        switch status {
        case .running, .queued: return palette.accent
        case .review: return palette.green
        case .paused: return palette.amber
        case .done: return palette.muted
        case .error: return palette.red
        }
    }

    public var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(tint)
                .frame(width: 7, height: 7)
            if !compact {
                Text(status.label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tint)
            }
        }
        .padding(.horizontal, compact ? 5 : 8)
        .padding(.vertical, 3)
        .background(tint.opacity(0.14), in: Capsule())
        .accessibilityLabel("Status: \(status.label)")
    }
}

public struct DiagnosticErrorBanner: View {
    @Environment(\.ompPalette) private var palette
    public let title: String
    public let message: String
    public let kind: TailscaleErrorKind
    public let isOfflineCache: Bool
    public var onRetry: (() -> Void)?
    public var onEditHost: (() -> Void)?

    public init(
        title: String,
        message: String,
        kind: TailscaleErrorKind,
        isOfflineCache: Bool = false,
        onRetry: (() -> Void)? = nil,
        onEditHost: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.kind = kind
        self.isOfflineCache = isOfflineCache
        self.onRetry = onRetry
        self.onEditHost = onEditHost
    }

    private var tint: Color {
        isOfflineCache ? palette.amber : palette.red
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: isOfflineCache ? "wifi.slash" : "exclamationmark.triangle.fill")
                    .foregroundStyle(tint)
                    .font(.subheadline)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                    Text(kind.remediation)
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                if let onRetry {
                    Button {
                        onRetry()
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(tint.opacity(0.18), in: Capsule())
                            .foregroundStyle(tint)
                    }
                    .buttonStyle(.plain)
                }
                if let onEditHost, kind.isAuthFailure || kind.isConnectivityFailure {
                    Button {
                        onEditHost()
                    } label: {
                        Label("Host Settings", systemImage: "slider.horizontal.3")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(palette.raised, in: Capsule())
                            .foregroundStyle(palette.foreground)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(tint.opacity(0.35), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}

public struct SkeletonListPlaceholder: View {
    @Environment(\.ompPalette) private var palette
    public var count: Int = 5
    @State private var shimmer = false

    public init(count: Int = 5) {
        self.count = count
    }

    public var body: some View {
        VStack(spacing: 10) {
            ForEach(0..<count, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 5)
                        .fill(palette.raised)
                        .frame(width: 180, height: 14)
                    RoundedRectangle(cornerRadius: 5)
                        .fill(palette.raised)
                        .frame(maxWidth: .infinity)
                        .frame(height: 11)
                    RoundedRectangle(cornerRadius: 5)
                        .fill(palette.raised)
                        .frame(width: 120, height: 10)
                }
                .padding(12)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .opacity(shimmer ? 0.45 : 0.85)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) {
                shimmer = true
            }
        }
    }
}

public struct OMPEmptyStateView: View {
    @Environment(\.ompPalette) private var palette
    public let systemImage: String
    public let title: String
    public let message: String
    public var actionTitle: String?
    public var action: (() -> Void)?

    public init(
        systemImage: String,
        title: String,
        message: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.systemImage = systemImage
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 36, weight: .medium))
                .foregroundStyle(palette.accent)
            Text(title)
                .font(.headline)
                .foregroundStyle(palette.foreground)
                .multilineTextAlignment(.center)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(palette.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 340)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(palette.accent)
                    .padding(.top, 4)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }
}

public struct DataURLImageView: View {
    public let dataURL: String
    @State private var decodedData: Data?

    public init(dataURL: String) {
        self.dataURL = dataURL
    }

    public var body: some View {
        Group {
            if let data = decodedData ?? ImageAttachmentProcessor.decodeDataURL(dataURL) {
                PlatformRawImageView(data: data)
            } else {
                Color.secondary.opacity(0.2)
            }
        }
        .onAppear {
            decodedData = ImageAttachmentProcessor.decodeDataURL(dataURL)
        }
    }
}

public struct PlatformRawImageView: View {
    public let data: Data

    public init(data: Data) {
        self.data = data
    }

    public var body: some View {
        #if canImport(UIKit)
        if let uiImage = UIImage(data: data) {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFit()
        } else {
            Image(systemName: "photo")
                .foregroundStyle(.secondary)
        }
        #else
        Image(systemName: "photo")
        #endif
    }
}

#if canImport(UIKit)
public struct CameraImagePicker: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    public let onCapture: (UIImage) -> Void

    public init(onCapture: @escaping (UIImage) -> Void) {
        self.onCapture = onCapture
    }

    public func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    public func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    public func makeCoordinator() -> Coordinator {
        Coordinator(dismiss: dismiss, onCapture: onCapture)
    }

    public final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let dismiss: DismissAction
        let onCapture: (UIImage) -> Void

        init(dismiss: DismissAction, onCapture: @escaping (UIImage) -> Void) {
            self.dismiss = dismiss
            self.onCapture = onCapture
        }

        public func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                onCapture(image)
            }
            dismiss()
        }

        public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            dismiss()
        }
    }
}
#endif

public enum CompanionFormatters {
    // Formatters are expensive to create and this runs per row; the shared instances are thread-safe.
    nonisolated(unsafe) private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    public static func relativeDate(_ isoString: String?) -> String {
        guard let date = SidebarLayoutHelper.parseISODate(isoString) else { return "" }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    public static func formatTokens(_ n: Int?) -> String {
        guard let n else { return "0" }
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }

    public static func formatCost(_ cost: Double?) -> String {
        guard let cost, cost > 0 else { return "$0.00" }
        if cost < 0.01 { return String(format: "$%.4f", cost) }
        return String(format: "$%.2f", cost)
    }

    public static func formatBytes(_ bytes: Int64?) -> String {
        guard let bytes else { return "0 B" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
