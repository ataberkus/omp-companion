import SwiftUI
import BackgroundTasks
import UserNotifications
import OMPCompanionKit

@main
struct OMPCompanionApp: App {
    @UIApplicationDelegateAdaptor(OMPAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootContainerView(store: store)
                .preferredColorScheme(store.themePreference.colorScheme)
                .task {
                    appDelegate.store = store
                    // Apple push: once notifications are allowed, ask iOS for this device's token (the delegate below
                    // hands it to the store, which registers it with every saved host).
                    store.notificationManager.onAuthorized = {
                        UIApplication.shared.registerForRemoteNotifications()
                    }
                    store.notificationManager.installDelegate()
                    await store.bootstrap()
                }
                .onOpenURL { url in
                    store.handleIncomingURL(url)
                }
                .onChange(of: scenePhase) { _, phase in
                    Task {
                        await store.handleScenePhaseChange(phase)
                    }
                    if phase == .background {
                        OMPAppDelegate.scheduleBackgroundRefresh()
                    }
                }
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Session") {
                    store.presentQuickStart()
                }
                .keyboardShortcut("n", modifiers: .command)
            }
            CommandMenu("Companion") {
                Button("Quick Switcher") {
                    store.isQuickSwitcherPresented.toggle()
                }
                .keyboardShortcut("k", modifiers: .command)

                Button("Switch Host") {
                    store.isHostSwitcherPresented = true
                }
                .keyboardShortcut("h", modifiers: [.command, .shift])

                Button("Force Sync Now") {
                    Task { await store.forceSync() }
                }
                .keyboardShortcut("r", modifiers: .command)

                Divider()

                Button("Stop Active Turn") {
                    Task { await store.abortActiveSession() }
                }
                .keyboardShortcut(".", modifiers: .command)
                .disabled(store.selectedSession?.isWorking != true)
            }
        }
    }
}

final class OMPAppDelegate: NSObject, UIApplicationDelegate {
    static let refreshTaskId = "dev.omp.companion.refresh"
    weak var store: AppStore? {
        didSet {
            if let store, let token = pendingPushToken {
                pendingPushToken = nil
                Task { @MainActor in store.didRegisterForRemoteNotifications(deviceToken: token) }
            }
        }
    }
    /// A device token iOS delivered before the store was attached.
    private var pendingPushToken: Data?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTaskId, using: nil) { [weak self] task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handleBackgroundRefresh(refreshTask)
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let store else {
            pendingPushToken = deviceToken
            return
        }
        Task { @MainActor in store.didRegisterForRemoteNotifications(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        let store = self.store
        Task { @MainActor in store?.didFailToRegisterForRemoteNotifications(error) }
    }

    static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleBackgroundRefresh(_ task: BGAppRefreshTask) {
        Self.scheduleBackgroundRefresh()
        let work = Task { @MainActor in
            guard let store else {
                task.setTaskCompleted(success: true)
                return
            }
            let ok = await store.performBackgroundAttentionCheck()
            task.setTaskCompleted(success: ok)
        }
        task.expirationHandler = {
            work.cancel()
        }
    }
}
