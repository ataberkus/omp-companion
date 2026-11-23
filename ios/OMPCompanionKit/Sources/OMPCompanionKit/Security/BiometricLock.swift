import Foundation
import LocalAuthentication
import Observation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@Observable
@MainActor
public final class BiometricLock {
    public var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: Self.enabledDefaultsKey)
            if !isEnabled {
                isLocked = false
                lastError = nil
            }
            if oldValue != isEnabled { onEnabledChanged?(isEnabled) }
        }
    }
    public private(set) var isLocked: Bool = false {
        didSet { if oldValue != isLocked { onLockChanged?(isLocked) } }
    }
    /// Called on every lock/unlock (not for the initial value): the store stops polling while locked and resumes after.
    @ObservationIgnored public var onLockChanged: ((Bool) -> Void)?
    /// Called when the lock is switched on or off (not for the initial value): the store re-registers Apple push, whose
    /// alerts are generic while the lock is on.
    @ObservationIgnored public var onEnabledChanged: ((Bool) -> Void)?
    public private(set) var isAuthenticating: Bool = false
    public private(set) var lastError: String?
    public var gracePeriodSeconds: TimeInterval = 30

    private var backgroundedAt: Date?
    private var lastUnlockedAt: Date?
    private static let enabledDefaultsKey = "omp.biometricLock.enabled"

    public init() {
        let saved = UserDefaults.standard.bool(forKey: Self.enabledDefaultsKey)
        self.isEnabled = saved
        self.isLocked = saved
    }

    public var biometryDisplayName: String {
        let context = LAContext()
        var error: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return String(localized: "Passcode", bundle: .main)
        }
    }

    public var biometrySystemImage: String {
        let context = LAContext()
        var error: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        switch context.biometryType {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        default: return "lock.fill"
        }
    }

    public var canUseDeviceAuthentication: Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    public func noteScenePhase(_ phase: ScenePhase) {
        guard isEnabled else {
            isLocked = false
            return
        }
        switch phase {
        case .background:
            backgroundedAt = Date()
        case .active:
            if let bg = backgroundedAt, Date().timeIntervalSince(bg) >= gracePeriodSeconds {
                isLocked = true
            }
            backgroundedAt = nil
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    public func lockNow() {
        guard isEnabled else { return }
        isLocked = true
    }

    @discardableResult
    public func unlock(reason: String = String(localized: "Unlock OMP Control Room", bundle: .main)) async -> Bool {
        guard isEnabled else {
            isLocked = false
            return true
        }
        if let last = lastUnlockedAt, Date().timeIntervalSince(last) < 2, !isLocked {
            return true
        }
        guard !isAuthenticating else { return false }

        let context = LAContext()
        context.localizedCancelTitle = String(localized: "Cancel", bundle: .main)
        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
            lastError = authError?.localizedDescription ?? String(localized: "Device authentication is unavailable.", bundle: .main)
            return false
        }

        isAuthenticating = true
        lastError = nil
        defer { isAuthenticating = false }

        do {
            let success = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            if success {
                isLocked = false
                lastUnlockedAt = Date()
                lastError = nil
            }
            return success
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }
}

/// Masks transcripts and credentials whenever the scene is not `.active` (the iOS app-switcher snapshot is taken then)
/// and hosts the Face ID / passcode lock screen while `BiometricLock` is locked. On UIKit the shield lives in its own
/// key window above every sheet and alert, so presented sheets (host tokens, plan reviews) are covered too and hardware
/// keyboard shortcuts cannot reach the locked UI underneath.
public struct PrivacyShieldModifier: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.ompPalette) private var palette
    let lock: BiometricLock
    #if canImport(UIKit)
    @State private var scene: UIWindowScene?
    @State private var holder = ShieldWindowHolder()
    #endif

    private var shielded: Bool {
        scenePhase != .active || (lock.isEnabled && lock.isLocked)
    }

    public func body(content: Content) -> some View {
        #if canImport(UIKit)
        content
            .background(WindowSceneReader { found in
                DispatchQueue.main.async { scene = found }
            })
            .onChange(of: scenePhase, initial: true) { _, phase in
                // Decide the lock before the shield can drop, so returning after the grace period never flashes content.
                lock.noteScenePhase(phase)
                sync()
            }
            .onChange(of: shielded) { _, _ in sync() }
            .onChange(of: scene) { _, _ in sync() }
        #else
        content.overlay {
            if shielded {
                PrivacyShieldView(lock: lock).environment(\.ompPalette, palette)
            }
        }
        #endif
    }

    #if canImport(UIKit)
    private func sync() {
        guard shielded, let scene else {
            holder.hide()
            return
        }
        holder.show(in: scene, rootView: PrivacyShieldView(lock: lock).environment(\.ompPalette, palette))
    }
    #endif
}

/// The shield's content: the lock screen while locked, otherwise an opaque inactive mask.
struct PrivacyShieldView: View {
    @Environment(\.ompPalette) private var palette
    let lock: BiometricLock

    var body: some View {
        ZStack {
            palette.background.ignoresSafeArea()
            if lock.isEnabled && lock.isLocked {
                VStack(spacing: 20) {
                    Image(systemName: lock.biometrySystemImage)
                        .font(.system(size: 52, weight: .semibold))
                        .foregroundStyle(palette.brandGradient)
                        .accessibilityHidden(true)
                    Text("OMP Control Room Locked")
                        .font(.title2.bold())
                        .foregroundStyle(palette.foreground)
                    Text("Authenticate with \(lock.biometryDisplayName) or your device passcode to access sessions and Keychain credentials.")
                        .font(.subheadline)
                        .foregroundStyle(palette.muted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)
                    if let err = lock.lastError {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(palette.red)
                    }
                    Button {
                        Task { await lock.unlock() }
                    } label: {
                        Label("Unlock with \(lock.biometryDisplayName)", systemImage: lock.biometrySystemImage)
                            .font(.headline)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.accent)
                    .disabled(lock.isAuthenticating)
                }
                .padding()
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "lock.shield.fill")
                        .font(.system(size: 42, weight: .semibold))
                        .foregroundStyle(palette.brandGradient)
                        .accessibilityHidden(true)
                    Text("OMP Control Room")
                        .font(.headline)
                        .foregroundStyle(palette.foreground)
                    Text("Protected while inactive")
                        .font(.caption)
                        .foregroundStyle(palette.muted)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

#if canImport(UIKit)
/// Reports the `UIWindowScene` hosting this view, so the shield attaches to the right scene on multi-window iPad.
private struct WindowSceneReader: UIViewRepresentable {
    let onScene: (UIWindowScene?) -> Void

    func makeUIView(context: Context) -> ReaderView { ReaderView(onScene: onScene) }
    func updateUIView(_ uiView: ReaderView, context: Context) { uiView.onScene = onScene }

    final class ReaderView: UIView {
        var onScene: (UIWindowScene?) -> Void
        init(onScene: @escaping (UIWindowScene?) -> Void) {
            self.onScene = onScene
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            onScene(window?.windowScene)
        }
    }
}

/// Owns the shield window: above alerts, key while shown (so key commands stop at it), previous key window restored on hide.
private final class ShieldWindowHolder {
    private var window: UIWindow?
    private weak var previousKey: UIWindow?

    @MainActor
    func show(in scene: UIWindowScene, rootView: some View) {
        if let window, window.windowScene !== scene { hide() }
        if let host = window?.rootViewController as? UIHostingController<AnyView> {
            host.rootView = AnyView(rootView)
            return
        }
        previousKey = scene.keyWindow
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        let host = UIHostingController(rootView: AnyView(rootView))
        w.rootViewController = host
        w.makeKeyAndVisible()
        window = w
    }

    @MainActor
    func hide() {
        guard let w = window else { return }
        w.isHidden = true
        window = nil
        previousKey?.makeKey()
        previousKey = nil
    }
}
#endif

public extension View {
    /// Window-level app-switcher mask plus the biometric lock screen; always on, since transcripts and tokens are sensitive.
    func privacyShield(lock: BiometricLock) -> some View {
        modifier(PrivacyShieldModifier(lock: lock))
    }
}
