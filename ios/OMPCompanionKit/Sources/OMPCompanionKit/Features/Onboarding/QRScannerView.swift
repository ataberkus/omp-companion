import SwiftUI
import AVFoundation

#if canImport(UIKit)
import UIKit
#endif

public struct QRScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    public let onScanned: (String) -> Void

    @State private var permissionDenied = false
    @State private var cameraUnavailable = false
    @State private var manualLink = ""

    public init(onScanned: @escaping (String) -> Void) {
        self.onScanned = onScanned
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                palette.background.ignoresSafeArea()

                if cameraUnavailable || permissionDenied {
                    VStack(spacing: 16) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 48))
                            .foregroundStyle(palette.accent)
                            .accessibilityHidden(true)
                        Text(permissionDenied ? "Camera access is disabled" : "Camera is unavailable on this device")
                            .font(.headline)
                            .foregroundStyle(palette.foreground)
                        Text("Copy the pairing link from OMP Control Room on your computer (Settings → Pair iOS app) and paste it below.")
                            .font(.subheadline)
                            .foregroundStyle(palette.muted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)

                        TextField("omp://connect?url=... or JSON", text: $manualLink, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .autocorrectionDisabled()
                            .padding(.horizontal)

                        Button("Use Pasted Link") {
                            let trimmed = manualLink.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !trimmed.isEmpty else { return }
                            onScanned(trimmed)
                            dismiss()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(palette.accent)
                        .disabled(manualLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .padding()
                } else {
                    #if canImport(UIKit)
                    CameraQRPreview(
                        onCode: { code in
                            onScanned(code)
                            dismiss()
                        },
                        onUnavailable: {
                            cameraUnavailable = true
                        }
                    )
                    .ignoresSafeArea()
                    #endif

                    VStack {
                        Spacer()
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(palette.accent, lineWidth: 3)
                            .frame(width: 240, height: 240)
                            .background(Color.black.opacity(0.05))
                        Spacer()
                        VStack(spacing: 8) {
                            Text("Point your camera at the Pair iOS App QR code in OMP Control Room")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(.white)
                                .multilineTextAlignment(.center)
                            Button("Paste From Clipboard Instead") {
                                #if canImport(UIKit)
                                if let text = UIPasteboard.general.string, !text.isEmpty {
                                    onScanned(text)
                                    dismiss()
                                }
                                #endif
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.accent)
                        }
                        .padding()
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .padding()
                    }
                }
            }
            .navigationTitle("Scan Pairing QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                await checkCameraPermission()
            }
        }
    }

    private func checkCameraPermission() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            permissionDenied = false
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            permissionDenied = !granted
        default:
            permissionDenied = true
        }
    }
}

#if canImport(UIKit)
private struct CameraQRPreview: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onUnavailable: () -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onCode = onCode
        controller.onUnavailable = onUnavailable
        return controller
    }

    func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
}

private final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onUnavailable: (() -> Void)?

    private var session: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmit = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let s = session
        DispatchQueue.global(qos: .userInitiated).async {
            if s?.isRunning == false { s?.startRunning() }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let s = session
        DispatchQueue.global(qos: .userInitiated).async {
            if s?.isRunning == true { s?.stopRunning() }
        }
    }

    private func setupSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            onUnavailable?()
            return
        }
        let session = AVCaptureSession()
        guard session.canAddInput(input) else {
            onUnavailable?()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onUnavailable?()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        guard output.availableMetadataObjectTypes.contains(.qr) else {
            onUnavailable?()
            return
        }
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        self.previewLayer = preview
        self.session = session
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didEmit,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let stringValue = obj.stringValue,
              !stringValue.isEmpty else {
            return
        }
        didEmit = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        session?.stopRunning()
        onCode?(stringValue)
    }
}
#endif
