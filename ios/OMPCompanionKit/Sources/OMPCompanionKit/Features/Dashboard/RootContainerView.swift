import SwiftUI

public struct RootContainerView: View {
    @Environment(\.colorScheme) private var systemColorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var store: AppStore

    public init(store: AppStore) {
        self.store = store
    }

    private var palette: OMPPalette {
        OMPPalette.resolve(preference: store.themePreference, colorScheme: systemColorScheme)
    }

    public var body: some View {
        Group {
            if store.hosts.isEmpty {
                onboardingLanding
            } else if horizontalSizeClass == .regular {
                splitViewContent
            } else {
                compactStackContent
            }
        }
        .environment(\.ompPalette, palette)
        .tint(palette.accent)
        .privacyShield(lock: store.biometricLock)
        .overlay(alignment: .top) {
            if let banner = store.notificationManager.activeBanner {
                attentionBannerOverlay(banner)
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .top).combined(with: .opacity))
            }
        }
        .overlay(alignment: .bottom) {
            if let toast = store.toast {
                toastOverlay(toast)
                    .padding(.horizontal)
                    .padding(.bottom, 16)
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: store.notificationManager.activeBanner?.id)
        .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.88), value: store.toast?.id)
        .sheet(isPresented: $store.isQuickStartPresented) {
            QuickStartSheet(store: store)
                .environment(\.ompPalette, palette)
        }
        .sheet(isPresented: $store.isQuickSwitcherPresented) {
            QuickSwitcherView(store: store)
                .environment(\.ompPalette, palette)
        }
        .sheet(isPresented: $store.isHostSwitcherPresented) {
            HostSwitcherSheet(store: store)
                .environment(\.ompPalette, palette)
        }
        .sheet(isPresented: $store.isAddHostPresented) {
            HostSetupView(store: store)
                .environment(\.ompPalette, palette)
        }
        .sheet(isPresented: $store.isActivityPresented) {
            ActivityFeedView(store: store)
                .environment(\.ompPalette, palette)
        }
        .sheet(isPresented: $store.isHistoryPresented) {
            NativeHistoryView(store: store)
                .environment(\.ompPalette, palette)
        }
        .sheet(isPresented: $store.isWorkspacesPresented) {
            WorkspacesView(store: store)
                .environment(\.ompPalette, palette)
        }
        .sheet(isPresented: $store.isSettingsPresented) {
            SettingsAdminView(store: store)
                .environment(\.ompPalette, palette)
        }
        .background {
            VStack {
                Button("") { store.isActivityPresented = true }
                    .keyboardShortcut("6", modifiers: .command)
                Button("") { store.isHistoryPresented = true }
                    .keyboardShortcut("7", modifiers: .command)
                Button("") { store.isWorkspacesPresented = true }
                    .keyboardShortcut("8", modifiers: .command)
                Button("") { store.isSettingsPresented = true }
                    .keyboardShortcut("9", modifiers: .command)
            }
            .frame(width: 0, height: 0)
            .opacity(0)
            .accessibilityHidden(true)
        }
    }

    private var splitViewContent: some View {
        NavigationSplitView {
            DashboardView(store: store)
        } detail: {
            if let session = store.selectedSession {
                SessionDetailView(store: store, session: session)
            } else {
                OMPEmptyStateView(
                    systemImage: "sparkles.rectangle.stack",
                    title: String(localized: "Select or Start a Session", bundle: .main),
                    message: String(localized: "Pick a session from the sidebar, press Cmd+K to jump anywhere, or start a new session.", bundle: .main),
                    actionTitle: store.canPerformMutatingActions ? String(localized: "New Session", bundle: .main) : nil
                ) {
                    store.presentQuickStart()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.background)
            }
        }
        .task(id: store.visibleSessions.first?.id) {
            if store.selectedSessionID == nil, let first = store.visibleSessions.first {
                await store.selectSession(first.id, openDetail: false)
            }
        }
    }

    private var compactStackContent: some View {
        NavigationStack {
            DashboardView(store: store)
                .navigationDestination(isPresented: $store.isDetailActiveOnCompact) {
                    if let session = store.selectedSession {
                        SessionDetailView(store: store, session: session)
                    } else {
                        OMPEmptyStateView(
                            systemImage: "bubble.left.and.bubble.right",
                            title: String(localized: "Session Unavailable", bundle: .main),
                            message: String(localized: "This session was hidden or closed on the companion host.", bundle: .main)
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(palette.background)
                    }
                }
        }
    }

    private var onboardingLanding: some View {
        NavigationStack {
            ZStack {
                palette.background.ignoresSafeArea()
                VStack(spacing: 24) {
                    Spacer()

                    ZStack {
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .fill(palette.brandGradient.opacity(0.18))
                            .frame(width: 96, height: 96)
                        Image(systemName: "network.badge.shield.half.filled")
                            .font(.system(size: 44, weight: .semibold))
                            .foregroundStyle(palette.brandGradient)
                    }
                    .accessibilityHidden(true)

                    VStack(spacing: 10) {
                        Text("OMP Control Room")
                            .font(.largeTitle.bold())
                            .foregroundStyle(palette.foreground)
                        Text("Control your coding agents across Windows, macOS, and Linux directly over your Tailscale VPN.")
                            .font(.body)
                            .foregroundStyle(palette.muted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 360)
                    }

                    VStack(spacing: 12) {
                        Button {
                            store.isAddHostPresented = true
                        } label: {
                            Label("Connect Companion Host", systemImage: "plus.circle.fill")
                                .font(.headline)
                                .frame(maxWidth: 320)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(palette.accent)
                        .minTouchTarget()
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Label("Make sure Tailscale VPN is active on this device", systemImage: "checkmark.shield")
                        Label("Supports MagicDNS (.ts.net), 100.64/10, fd7a::/48 & HTTPS", systemImage: "lock.fill")
                        Label("In OMP Control Room on desktop: Settings -> Pair iOS app", systemImage: "qrcode")
                    }
                    .font(.caption)
                    .foregroundStyle(palette.muted)
                    .padding()
                    .background(palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.border, lineWidth: 1))

                    Spacer()
                }
                .padding()
            }
        }
    }

    @ViewBuilder
    private func attentionBannerOverlay(_ banner: AttentionBannerItem) -> some View {
        Button {
            store.notificationManager.dismissBanner()
            Task {
                if store.activeHostID != banner.hostID {
                    await store.selectHost(banner.hostID)
                }
                await store.selectSession(banner.sessionID, tab: .chat, openDetail: true)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: banner.kind == "error" ? "exclamationmark.triangle.fill" : "bell.badge.fill")
                    .foregroundStyle(banner.kind == "error" ? palette.red : palette.amber)
                    .font(.title3)
                    .accessibilityLabel(banner.kind == "error" ? "Error" : "Needs attention")

                VStack(alignment: .leading, spacing: 2) {
                    Text("\(banner.hostName) · \(banner.sessionTitle)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                    Text(banner.detail)
                        .font(.caption2)
                        .foregroundStyle(palette.muted)
                        .lineLimit(2)
                }

                Spacer()

                Button {
                    store.notificationManager.dismissBanner()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.muted)
                        .padding(6)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss notification")
            }
            .padding(12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(banner.kind == "error" ? palette.red.opacity(0.4) : palette.amber.opacity(0.4), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func toastOverlay(_ toast: AppToast) -> some View {
        HStack(spacing: 8) {
            Image(systemName: toast.isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(toast.isError ? palette.red : palette.green)
                .accessibilityLabel(toast.isError ? "Error" : "Success")
            Text(toast.message)
                .font(.caption.weight(.medium))
                .foregroundStyle(palette.foreground)
                .lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(toast.isError ? palette.red.opacity(0.35) : palette.borderStrong, lineWidth: 1))
        .shadow(color: .black.opacity(0.22), radius: 8, y: 3)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Double tap to dismiss")
        .onTapGesture {
            store.toast = nil
        }
    }
}
