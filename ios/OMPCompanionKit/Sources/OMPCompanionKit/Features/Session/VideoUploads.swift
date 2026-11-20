import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// A video picked from Photos, copied to a temporary file the app owns (the picker's copy is gone once import returns).
struct PickedMovie: Transferable {
    let url: URL
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: { received in
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("video-uploads", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let name = received.file.lastPathComponent
            let dest = dir.appendingPathComponent("\(UUID().uuidString)-\(name)")
            try FileManager.default.copyItem(at: received.file, to: dest)
            return PickedMovie(url: dest, name: name)
        }
    }
}

/// One video going up to the host from a composer.
struct VideoUpload: Identifiable {
    let id = UUID()
    var name: String
    var fraction: Double = 0
    var task: Task<Void, Never>?
}

/// Videos a composer is uploading (`POST /api/video`). Each one's line for the agent (`ref`) goes to `onRef` when its
/// upload is done; the composer adds it to the draft. Send waits while `uploads` is not empty.
@MainActor
@Observable
final class VideoUploader {
    private(set) var uploads: [VideoUpload] = []

    /// Nonisolated: views create one as a @State default value.
    nonisolated init() {}

    nonisolated static func isVideo(_ item: PhotosPickerItem) -> Bool {
        item.supportedContentTypes.contains { $0.conforms(to: .movie) }
    }

    func start(_ item: PhotosPickerItem, client: CompanionClient, onRef: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
        let upload = VideoUpload(name: "Video")
        let id = upload.id
        uploads.append(upload)
        let task = Task { [weak self] in
            var file: URL?
            defer {
                if let file { try? FileManager.default.removeItem(at: file) }
                self?.uploads.removeAll { $0.id == id }
            }
            do {
                guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
                    throw CompanionAPIError(kind: .unknown, serverMessage: "Could not read this video from Photos.")
                }
                file = movie.url
                self?.update(id) { $0.name = movie.name }
                let mime = UTType(filenameExtension: movie.url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let res = try await client.uploadVideo(fileURL: movie.url, name: movie.name, mimeType: mime) { fraction in
                    Task { @MainActor [weak self] in self?.update(id) { $0.fraction = fraction } }
                }
                try Task.checkCancellation()
                onRef(res.ref)
            } catch {
                if !Task.isCancelled { onError(error.localizedDescription) }
            }
        }
        update(id) { $0.task = task }
    }

    func cancel(_ id: UUID) {
        uploads.first { $0.id == id }?.task?.cancel()
        uploads.removeAll { $0.id == id }
    }

    private func update(_ id: UUID, _ change: (inout VideoUpload) -> Void) {
        guard let i = uploads.firstIndex(where: { $0.id == id }) else { return }
        change(&uploads[i])
    }
}

/// A draft with a video's line added at its end.
func appendingVideoRef(_ ref: String, to text: String) -> String {
    let base = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : text.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    return base.isEmpty ? ref : base + "\n" + ref
}

/// Upload chips: the video's name, progress, and ✕ to cancel.
struct VideoUploadStrip: View {
    @Environment(\.ompPalette) private var palette
    let uploads: [VideoUpload]
    let onCancel: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(uploads) { upload in
                    HStack(spacing: 8) {
                        Image(systemName: "video")
                            .foregroundStyle(palette.muted)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(upload.name)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: 160, alignment: .leading)
                            ProgressView(value: upload.fraction)
                                .frame(width: 120)
                            Text(upload.fraction > 0 ? "Uploading \(Int(upload.fraction * 100))%" : "Preparing…")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(palette.muted)
                        }
                        Button {
                            onCancel(upload.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.white, palette.red)
                        }
                        .accessibilityLabel("Cancel uploading \(upload.name)")
                    }
                    .padding(8)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(palette.surface)
    }
}
