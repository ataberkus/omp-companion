import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct TerminalScreenView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore
    public let session: SessionSummary

    @State private var socket = ScreenSocketClient()
    @State private var screenInfo: ScreenInfoResponse?
    @State private var isLoadingInfo = false
    @State private var infoError: String?

    @State private var zoomScale: CGFloat = 1.0
    @State private var baseZoomScale: CGFloat = 1.0
    @State private var remoteText: String = ""
    @State private var rightClickMode = false

    public init(store: AppStore, session: SessionSummary) {
        self.store = store
        self.session = session
    }

    private var customRequests: [UIRequest] {
        (session.uiRequests ?? []).filter { $0.method == "custom" }
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                // 1. Live `companion/custom-ui.mjs` Terminal Panels (if active on this session)
                if !customRequests.isEmpty {
                    ForEach(customRequests) { req in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Label(req.title ?? "Interactive Terminal Panel", systemImage: "terminal.fill")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(palette.amber)
                                Spacer()
                                Button("Close Panel", role: .destructive) {
                                    Task {
                                        if let client = store.activeClient,
                                           let updated = try? await client.cancelCustomPanel(sessionId: session.id, requestId: req.id) {
                                            store.integrateSession(updated)
                                        }
                                    }
                                }
                                .font(.caption.weight(.semibold))
                                .buttonStyle(.bordered)
                                .disabled(!store.canPerformMutatingActions)
                            }

                            CustomTerminalPanelView(
                                store: store,
                                sessionId: session.id,
                                request: req,
                                compactEmbedded: false
                            )
                        }
                        .ompCard(palette)
                    }
                }

                // 2. Host Remote Screen Streaming (`companion/screen.mjs` WebSocket)
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Label("Host Desktop Screen", systemImage: "display")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.foreground)

                        Spacer()

                        if socket.state.isConnected && socket.fpsEstimate > 0 {
                            Text(String(format: "%.0f fps", socket.fpsEstimate))
                                .font(.caption2.monospacedDigit())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(palette.greenSoft, in: Capsule())
                                .foregroundStyle(palette.green)
                        }

                        Button {
                            Task { await store.openTerminalOnHost(path: session.cwd) }
                        } label: {
                            Label("Open Terminal", systemImage: "terminal")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .disabled(!store.canPerformMutatingActions)
                    }

                    if let infoError {
                        Text(infoError)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }

                    if let info = screenInfo, !info.supported || !info.enabled {
                        OMPEmptyStateView(
                            systemImage: "display.trianglebadge.exclamationmark",
                            title: info.supported ? "Screen Sharing Disabled" : "Screen Sharing Unavailable",
                            message: info.supported
                                ? "Enable \"Allow screen sharing and control\" from the OMP Control Room tray menu on the host, or start the companion with OMP_WEB_SCREEN=1."
                                : "Host remote desktop streaming requires a Windows companion host with screen sharing support."
                        )
                    } else {
                        screenControlsBar
                        screenCanvasSection
                        if socket.state.isConnected {
                            remoteAccessoryKeyboardBar
                        }
                    }
                }
                .ompCard(palette)
            }
            .padding(12)
        }
        .background(palette.background)
        .task(id: session.id) {
            await loadScreenInfo()
        }
        .onDisappear {
            socket.disconnect()
        }
    }

    // MARK: - Screen Controls & Canvas

    @ViewBuilder
    private var screenControlsBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if socket.state.isConnected {
                    Button {
                        socket.disconnect()
                    } label: {
                        Label("Disconnect", systemImage: "xmark.circle.fill")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.red)
                } else {
                    Button {
                        Task { await connectScreen() }
                    } label: {
                        Label(socket.state == .connecting ? "Connecting…" : "Connect Live Screen", systemImage: "play.fill")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.accent)
                    .disabled(!store.canPerformMutatingActions || socket.state == .connecting)
                }

                if !socket.monitors.isEmpty {
                    Menu {
                        ForEach(socket.monitors) { mon in
                            Button {
                                socket.sendConfig(monitor: mon.index)
                            } label: {
                                HStack {
                                    Text("\(mon.name) (\(mon.width)×\(mon.height))")
                                    if mon.index == socket.selectedMonitor {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        Label(
                            socket.monitors.first(where: { $0.index == socket.selectedMonitor })?.name ?? "Display",
                            systemImage: "rectangle.on.rectangle"
                        )
                        .font(.caption.weight(.medium))
                    }
                    .buttonStyle(.bordered)
                }

                Menu {
                    ForEach([960, 1280, 1600, 1920], id: \.self) { w in
                        Button("\(w)px width") { socket.sendConfig(width: w) }
                    }
                    Divider()
                    ForEach([40, 60, 80, 90], id: \.self) { q in
                        Button("Quality \(q)%") { socket.sendConfig(quality: q) }
                    }
                } label: {
                    Label("\(socket.captureWidth)p · \(socket.captureQuality)%", systemImage: "slider.horizontal.3")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.bordered)

                if socket.state.isConnected {
                    Toggle(isOn: $rightClickMode) {
                        Text("Right-Click Tap")
                            .font(.caption.weight(.medium))
                    }
                    .toggleStyle(.button)

                    Button {
                        socket.requestRefresh()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Refresh frame")
                }
            }
        }
    }

    @ViewBuilder
    private var screenCanvasSection: some View {
        switch socket.state {
        case .error(let msg):
            Text(msg)
                .font(.caption)
                .foregroundStyle(palette.red)
        case .closed(_, let reason):
            Text("Screen session closed: \(reason)")
                .font(.caption)
                .foregroundStyle(palette.amber)
        default:
            EmptyView()
        }

        if let cgImage = socket.currentFrame {
            let aspect = CGFloat(max(1, socket.frameWidth)) / CGFloat(max(1, socket.frameHeight))
            GeometryReader { geo in
                let baseW = geo.size.width
                let baseH = geo.size.width / aspect
                Image(decorative: cgImage, scale: 1.0)
                    .resizable()
                    .aspectRatio(aspect, contentMode: .fit)
                    .frame(width: baseW, height: baseH)
                    .scaleEffect(zoomScale)
                    .contentShape(Rectangle())
                    .gesture(
                        SpatialTapGesture(count: 2)
                            .onEnded { _ in
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    zoomScale = 1.0
                                    baseZoomScale = 1.0
                                }
                            }
                    )
                    .gesture(
                        SpatialTapGesture()
                            .onEnded { val in
                                let nx = Double(val.location.x / max(1, baseW))
                                let ny = Double(val.location.y / max(1, baseH))
                                let btn = rightClickMode ? 2 : 0
                                socket.sendButton(btn, down: true, normalizedX: nx, normalizedY: ny)
                                socket.sendButton(btn, down: false, normalizedX: nx, normalizedY: ny)
                                store.notificationManager.triggerHaptic(.lightTap)
                            }
                    )
                    .gesture(
                        DragGesture(minimumDistance: 6)
                            .onChanged { val in
                                let nx = Double(val.location.x / max(1, baseW))
                                let ny = Double(val.location.y / max(1, baseH))
                                socket.sendMove(normalizedX: nx, normalizedY: ny)
                            }
                    )
                    .simultaneousGesture(
                        MagnifyGesture()
                            .onChanged { val in
                                zoomScale = min(3.0, max(1.0, baseZoomScale * val.magnification))
                            }
                            .onEnded { _ in
                                baseZoomScale = zoomScale
                            }
                    )
            }
            .aspectRatio(aspect, contentMode: .fit)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.borderStrong, lineWidth: 1))
        } else {
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(palette.codeBackground)
                    .frame(height: 220)
                VStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                        .font(.largeTitle)
                        .foregroundStyle(palette.muted)
                    Text(socket.state == .connecting ? "Negotiating screen stream…" : "Tap Connect Live Screen to stream and control the host display.")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
            }
        }
    }

    @ViewBuilder
    private var remoteAccessoryKeyboardBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    hostKeyChip("Esc", code: "Escape")
                    hostKeyChip("Tab", code: "Tab")
                    hostKeyChip("Enter", code: "Enter")
                    hostKeyChip("⌫", code: "Backspace")
                    hostKeyChip("↑", code: "ArrowUp")
                    hostKeyChip("↓", code: "ArrowDown")
                    hostKeyChip("←", code: "ArrowLeft")
                    hostKeyChip("→", code: "ArrowRight")
                    Button("Ctrl+C") {
                        socket.sendKey(code: "ControlLeft", down: true)
                        socket.tapKey(code: "KeyC")
                        socket.sendKey(code: "ControlLeft", down: false)
                    }
                    .font(.caption.monospaced().weight(.semibold))
                    .foregroundStyle(palette.red)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
                    Button("Scroll ↑") { socket.sendWheel(dy: 240) }
                        .font(.caption.monospaced())
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
                    Button("Scroll ↓") { socket.sendWheel(dy: -240) }
                        .font(.caption.monospaced())
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
                }
            }

            HStack(spacing: 8) {
                TextField("Send text to host window…", text: $remoteText)
                    .textFieldStyle(.roundedBorder)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .onSubmit {
                        let out = remoteText
                        remoteText = ""
                        socket.sendText(out + "\n")
                    }

                Button("Type") {
                    let out = remoteText
                    remoteText = ""
                    socket.sendText(out)
                }
                .buttonStyle(.bordered)
                .disabled(remoteText.isEmpty)

                Button("Send ↵") {
                    let out = remoteText
                    remoteText = ""
                    socket.sendText(out + "\n")
                }
                .buttonStyle(.borderedProminent)
                .tint(palette.accent)
            }
        }
    }

    @ViewBuilder
    private func hostKeyChip(_ title: String, code: String) -> some View {
        Button(title) {
            socket.tapKey(code: code)
            store.notificationManager.triggerHaptic(.lightTap)
        }
        .font(.caption.monospaced().weight(.semibold))
        .foregroundStyle(palette.foreground)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
    }

    private func loadScreenInfo() async {
        guard let client = store.activeClient else { return }
        isLoadingInfo = true
        infoError = nil
        defer { isLoadingInfo = false }
        do {
            screenInfo = try await client.fetchScreenInfo()
        } catch {
            infoError = error.localizedDescription
        }
    }

    private func connectScreen() async {
        guard let client = store.activeClient else { return }
        await socket.connect(using: client)
    }
}
