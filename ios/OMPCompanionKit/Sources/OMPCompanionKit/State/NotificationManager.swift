import Foundation
import Observation
import UserNotifications

#if canImport(UIKit)
import UIKit
#endif

public struct AttentionBannerItem: Identifiable, Hashable, Sendable {
    public let id: String
    public let hostID: UUID
    public let hostName: String
    public let sessionID: String
    public let sessionTitle: String
    public let kind: String // question | plan | error | review
    public let detail: String
    public let timestamp: Date

    public init(
        hostID: UUID,
        hostName: String,
        sessionID: String,
        sessionTitle: String,
        kind: String,
        detail: String,
        timestamp: Date = Date()
    ) {
        self.id = "\(hostID.uuidString):\(sessionID):\(kind):\(Int(timestamp.timeIntervalSince1970))"
        self.hostID = hostID
        self.hostName = hostName
        self.sessionID = sessionID
        self.sessionTitle = sessionTitle
        self.kind = kind
        self.detail = detail
        self.timestamp = timestamp
    }
}

public enum HapticKind: Sendable {
    case success
    case warning
    case error
    case lightTap
    case selection
}

@Observable
@MainActor
public final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    public var notificationsEnabled: Bool {
        didSet {
            UserDefaults.standard.set(notificationsEnabled, forKey: Self.enabledDefaultsKey)
        }
    }
    public var hapticsEnabled: Bool {
        didSet {
            UserDefaults.standard.set(hapticsEnabled, forKey: Self.hapticsDefaultsKey)
        }
    }
    public private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    public private(set) var activeBanner: AttentionBannerItem?
    public var onRouteToSession: ((UUID, String) -> Void)?

    private var priorAttentionFingerprints: [String: String] = [:]
    private var dismissTask: Task<Void, Never>?
    private var delegateInstalled = false

    private static let enabledDefaultsKey = "omp.notifications.enabled"
    private static let hapticsDefaultsKey = "omp.haptics.enabled"

    public override init() {
        let defaults = UserDefaults.standard
        self.notificationsEnabled = defaults.object(forKey: Self.enabledDefaultsKey) == nil
            ? true
            : defaults.bool(forKey: Self.enabledDefaultsKey)
        self.hapticsEnabled = defaults.object(forKey: Self.hapticsDefaultsKey) == nil
            ? true
            : defaults.bool(forKey: Self.hapticsDefaultsKey)
        super.init()
    }

    public func installDelegate() {
        guard !delegateInstalled else { return }
        delegateInstalled = true
        UNUserNotificationCenter.current().delegate = self
        Task { await refreshAuthorizationStatus() }
    }

    public func refreshAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    @discardableResult
    public func requestAuthorization() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshAuthorizationStatus()
            notificationsEnabled = granted
            return granted
        } catch {
            return false
        }
    }

    public func triggerHaptic(_ kind: HapticKind) {
        guard hapticsEnabled else { return }
        #if canImport(UIKit)
        switch kind {
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .error:
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        case .lightTap:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .selection:
            UISelectionFeedbackGenerator().selectionChanged()
        }
        #endif
    }

    public func resetTracking(for hostID: UUID) {
        let prefix = hostID.uuidString + ":"
        for key in priorAttentionFingerprints.keys where key.hasPrefix(prefix) {
            priorAttentionFingerprints.removeValue(forKey: key)
        }
    }

    /// Evaluates state changes and emits edge-triggered in-app banners + local notifications.
    public func evaluateTransitions(
        host: HostProfile,
        sessions: [SessionSummary],
        selectedSessionID: String?,
        isAppActive: Bool,
        isInitialSnapshot: Bool
    ) {
        var attentionCount = 0
        for session in sessions where session.hidden != true {
            if session.needsAttention { attentionCount += 1 }

            let key = "\(host.id.uuidString):\(session.id)"
            let reqFingerprint = (session.uiRequests ?? []).map(\.id).joined(separator: ",")
            let planFingerprint = session._planReview?.id ?? (session.planMode?.reviewPending == true ? "pending" : "")
            let currentFingerprint: String

            let eventKind: String?
            let detail: String
            if let req = session.uiRequests?.first {
                currentFingerprint = "ui:\(reqFingerprint)"
                eventKind = "question"
                detail = req.title ?? "Waiting for your answer"
            } else if !planFingerprint.isEmpty {
                currentFingerprint = "plan:\(planFingerprint)"
                eventKind = "plan"
                detail = session._planReview?.title ?? "Plan ready for review"
            } else if session.status == .error {
                currentFingerprint = "error:\(session.error ?? "")"
                eventKind = "error"
                detail = session.error ?? "Session failed"
            } else if session.status == .review {
                currentFingerprint = "review:\(session.workFinishedAt ?? session.updatedAt)"
                eventKind = "review"
                detail = "Turn finished and ready for review"
            } else {
                currentFingerprint = "idle:\(session.status.rawValue)"
                eventKind = nil
                detail = ""
            }

            let previous = priorAttentionFingerprints[key]
            priorAttentionFingerprints[key] = currentFingerprint

            // Avoid flooding on initial cold sync
            guard !isInitialSnapshot,
                  let kind = eventKind,
                  previous != nil,
                  previous != currentFingerprint else {
                continue
            }

            // Notify if it's a background session, OR if app itself is backgrounded
            let isCurrentlyViewing = isAppActive && session.id == selectedSessionID
            if !isCurrentlyViewing {
                let banner = AttentionBannerItem(
                    hostID: host.id,
                    hostName: host.name,
                    sessionID: session.id,
                    sessionTitle: session.title,
                    kind: kind,
                    detail: detail
                )
                if isAppActive {
                    showInAppBanner(banner)
                }
                if notificationsEnabled && (!isAppActive || kind == "question" || kind == "error") {
                    scheduleLocalNotification(for: banner)
                }
            }

            if isCurrentlyViewing {
                if kind == "error" {
                    triggerHaptic(.error)
                } else if kind == "review" || kind == "plan" {
                    triggerHaptic(.success)
                } else if kind == "question" {
                    triggerHaptic(.warning)
                }
            }
        }

        #if canImport(UIKit)
        if authorizationStatus == .authorized || authorizationStatus == .provisional {
            UNUserNotificationCenter.current().setBadgeCount(attentionCount) { _ in }
        }
        #endif
    }

    public func showInAppBanner(_ banner: AttentionBannerItem) {
        dismissTask?.cancel()
        activeBanner = banner
        triggerHaptic(banner.kind == "error" ? .error : .warning)
        dismissTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard !Task.isCancelled, let self else { return }
            if self.activeBanner?.id == banner.id {
                self.activeBanner = nil
            }
        }
    }

    public func dismissBanner() {
        dismissTask?.cancel()
        activeBanner = nil
    }

    public func scheduleLocalNotification(for banner: AttentionBannerItem) {
        let content = UNMutableNotificationContent()
        switch banner.kind {
        case "question":
            content.title = "\(banner.sessionTitle) needs input"
        case "plan":
            content.title = "Plan review: \(banner.sessionTitle)"
        case "error":
            content.title = "Error in \(banner.sessionTitle)"
        default:
            content.title = "Ready: \(banner.sessionTitle)"
        }
        content.subtitle = banner.hostName
        content.body = banner.detail
        content.sound = .default
        content.userInfo = [
            "hostID": banner.hostID.uuidString,
            "sessionID": banner.sessionID,
        ]
        content.threadIdentifier = banner.sessionID

        let request = UNNotificationRequest(
            identifier: "omp-\(banner.sessionID)-\(banner.kind)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .sound, .list]
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let hostStr = info["hostID"] as? String,
              let hostID = UUID(uuidString: hostStr),
              let sessionID = info["sessionID"] as? String else {
            return
        }
        await MainActor.run {
            self.onRouteToSession?(hostID, sessionID)
        }
    }
}
