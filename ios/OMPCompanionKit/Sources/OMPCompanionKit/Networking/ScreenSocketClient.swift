import Foundation
import CoreGraphics
import ImageIO
import Observation

#if canImport(UIKit)
import UIKit
#endif

public struct ScreenMonitorInfo: Identifiable, Hashable, Sendable {
    public var id: Int { index }
    public let index: Int
    public let name: String
    public let primary: Bool
    public let width: Int
    public let height: Int
}

public struct ScreenDirtyPatch: Sendable {
    public let x: Int
    public let y: Int
    public let width: Int
    public let height: Int
    public let frameWidth: Int
    public let frameHeight: Int
    public let jpegData: Data
}

public enum ScreenSocketState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case closed(code: Int, reason: String)
    case error(String)

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

/// WebSocket client for `/api/screen/ws` (`companion/screen.mjs` + `companion/screen-helper.mjs`).
/// Handles ticket negotiation, JPEG patch decoding + CGImage compositing, frame-credit acks, and pointer/key injection.
@Observable
@MainActor
public final class ScreenSocketClient {
    public private(set) var state: ScreenSocketState = .disconnected
    public private(set) var monitors: [ScreenMonitorInfo] = []
    public private(set) var selectedMonitor: Int = -1
    public private(set) var frameWidth: Int = 0
    public private(set) var frameHeight: Int = 0
    public private(set) var currentFrame: CGImage?
    public private(set) var fpsEstimate: Double = 0

    public var captureWidth: Int = 1280
    public var captureQuality: Int = 60

    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var compositeContext: CGContext?
    private var lastFrameTimes: [CFAbsoluteTime] = []

    public init() {}

    public func connect(using client: CompanionClient) async {
        disconnect()
        state = .connecting
        do {
            let ticketResp = try await client.requestScreenTicket()
            guard let wsURL = makeWebSocketURL(baseURL: client.host.baseURL, ticket: ticketResp.ticket) else {
                state = .error("Invalid WebSocket URL for host.")
                return
            }
            var request = URLRequest(url: wsURL)
            request.setValue(nil, forHTTPHeaderField: "Origin")
            let wsTask = client.session.webSocketTask(with: request)
            self.task = wsTask
            wsTask.resume()
            state = .connected

            sendJSON([
                "t": "config",
                "monitor": selectedMonitor,
                "width": captureWidth,
                "quality": captureQuality,
            ])
            startReceiveLoop(wsTask)
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    public func disconnect() {
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        if case .closed = state { } else if case .error = state { } else {
            state = .disconnected
        }
    }

    public func sendConfig(monitor: Int? = nil, width: Int? = nil, quality: Int? = nil) {
        if let monitor { selectedMonitor = monitor }
        if let width { captureWidth = max(320, min(7680, width)) }
        if let quality { captureQuality = max(10, min(95, quality)) }
        sendJSON([
            "t": "config",
            "monitor": selectedMonitor,
            "width": captureWidth,
            "quality": captureQuality,
        ])
    }

    public func requestRefresh() {
        sendJSON(["t": "refresh"])
    }

    public func releaseAllInputs() {
        sendJSON(["t": "release"])
    }

    public func sendMove(normalizedX: Double, normalizedY: Double) {
        sendJSON([
            "t": "move",
            "x": max(0, min(1, normalizedX)),
            "y": max(0, min(1, normalizedY)),
        ])
    }

    public func sendButton(_ button: Int, down: Bool, normalizedX: Double? = nil, normalizedY: Double? = nil) {
        var payload: [String: Any] = ["t": "button", "b": button, "down": down]
        if let x = normalizedX, let y = normalizedY {
            payload["x"] = max(0, min(1, x))
            payload["y"] = max(0, min(1, y))
        }
        sendJSON(payload)
    }

    public func sendWheel(dx: Int = 0, dy: Int = 0) {
        sendJSON(["t": "wheel", "dx": dx, "dy": dy])
    }

    public func sendKey(code: String, down: Bool) {
        sendJSON(["t": "key", "code": code, "down": down])
    }

    public func tapKey(code: String) {
        sendKey(code: code, down: true)
        sendKey(code: code, down: false)
    }

    public func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        sendJSON(["t": "text", "text": text])
    }

    private func sendJSON(_ object: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        task.send(.string(text)) { _ in }
    }

    private func startReceiveLoop(_ wsTask: URLSessionWebSocketTask) {
        receiveLoop = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await wsTask.receive()
                    guard let self else { return }
                    switch message {
                    case .data(let data):
                        if let patch = Self.decodeBinaryPatch(data) {
                            self.applyPatch(patch)
                            self.sendJSON(["t": "ack"])
                        }
                    case .string(let text):
                        self.handleTextMessage(text)
                    @unknown default:
                        break
                    }
                } catch {
                    guard let self else { return }
                    let closeCode = wsTask.closeCode.rawValue
                    let closeReason = wsTask.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    if closeCode != 0 && closeCode != 1000 {
                        self.state = .closed(code: closeCode, reason: closeReason.isEmpty ? error.localizedDescription : closeReason)
                    } else if !Task.isCancelled {
                        self.state = .error(error.localizedDescription)
                    }
                    break
                }
            }
        }
    }

    private func handleTextMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        if let rawMonitors = obj["monitors"] as? [[String: Any]] {
            monitors = rawMonitors.enumerated().map { idx, item in
                ScreenMonitorInfo(
                    index: (item["index"] as? Int) ?? idx,
                    name: (item["name"] as? String) ?? "Display \(idx + 1)",
                    primary: (item["primary"] as? Bool) ?? (idx == 0),
                    width: (item["width"] as? Int) ?? 0,
                    height: (item["height"] as? Int) ?? 0
                )
            }
            if let current = obj["current"] as? Int {
                selectedMonitor = current
            }
        }
        if let err = obj["error"] as? String, !err.isEmpty {
            state = .error(err)
        }
    }

    private func applyPatch(_ patch: ScreenDirtyPatch) {
        guard patch.frameWidth > 0, patch.frameHeight > 0 else { return }
        if frameWidth != patch.frameWidth || frameHeight != patch.frameHeight || compositeContext == nil {
            frameWidth = patch.frameWidth
            frameHeight = patch.frameHeight
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            compositeContext = CGContext(
                data: nil,
                width: patch.frameWidth,
                height: patch.frameHeight,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            )
        }
        guard let ctx = compositeContext,
              let source = CGImageSourceCreateWithData(patch.jpegData as CFData, nil),
              let tile = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return
        }
        // CoreGraphics origin is bottom-left while screen coordinates are top-left.
        let cgY = CGFloat(patch.frameHeight - patch.y - patch.height)
        let rect = CGRect(x: CGFloat(patch.x), y: cgY, width: CGFloat(patch.width), height: CGFloat(patch.height))
        ctx.draw(tile, in: rect)
        currentFrame = ctx.makeImage()

        let now = CFAbsoluteTimeGetCurrent()
        lastFrameTimes.append(now)
        lastFrameTimes.removeAll { now - $0 > 2.0 }
        if lastFrameTimes.count >= 2, let first = lastFrameTimes.first, now > first {
            fpsEstimate = Double(lastFrameTimes.count - 1) / (now - first)
        }
    }

    public static func decodeBinaryPatch(_ data: Data) -> ScreenDirtyPatch? {
        guard data.count > 13, data[data.startIndex] == 1 else { return nil }
        func readU16LE(_ offset: Int) -> Int {
            let idx = data.startIndex + offset
            return Int(data[idx]) | (Int(data[idx + 1]) << 8)
        }
        let x = readU16LE(1)
        let y = readU16LE(3)
        let w = readU16LE(5)
        let h = readU16LE(7)
        let fw = readU16LE(9)
        let fh = readU16LE(11)
        let jpeg = data.subdata(in: (data.startIndex + 13)..<data.endIndex)
        return ScreenDirtyPatch(x: x, y: y, width: w, height: h, frameWidth: fw, frameHeight: fh, jpegData: jpeg)
    }

    private func makeWebSocketURL(baseURL: String, ticket: String) -> URL? {
        let normalized = HostProfile.normalizeBaseURL(baseURL)
        guard var comps = URLComponents(string: normalized) else { return nil }
        comps.scheme = comps.scheme?.lowercased() == "https" ? "wss" : "ws"
        let basePath = comps.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        comps.path = basePath.isEmpty ? "/api/screen/ws" : "/\(basePath)/api/screen/ws"
        comps.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        return comps.url
    }
}
