import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

public struct HostSetupView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    public let editingHost: HostProfile?

    @State private var name: String = ""
    @State private var urlInput: String = ""
    @State private var authKind: HostAuthKind = .connectionToken
    @State private var secret: String = ""
    @State private var showSecret = false
    @State private var isTesting = false
    @State private var isSaving = false
    @State private var testStatus: TestResultBanner?
    @State private var showScanner = false
    /// The action waiting on the user's consent to send the credential unencrypted, and the URL they already accepted.
    @State private var pendingInsecureAction: InsecureAction?
    @State private var acceptedInsecureURL: String?

    private enum InsecureAction: Identifiable {
        case test, save
        var id: Self { self }
    }

    private enum TestResultBanner {
        case success(latencyMs: Int, hostName: String?, urls: [String])
        case failure(CompanionAPIError)
    }

    public init(store: AppStore, editingHost: HostProfile? = nil) {
        self.store = store
        self.editingHost = editingHost
    }

    private var normalizedPreview: String {
        HostProfile.normalizeBaseURL(urlInput)
    }

    private var endpointKind: TailscaleEndpointKind {
        HostProfile.classifyURL(urlInput)
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan Pair QR Code", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .minTouchTarget()

                    Button {
                        pastePairingPayload()
                    } label: {
                        Label("Paste Connection URL or Pairing Link", systemImage: "doc.on.clipboard")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .minTouchTarget()
                } header: {
                    Text("Quick Onboarding")
                } footer: {
                    Text("Accepts `omp://connect` links, QR payloads, or companion URLs with `#token=…`.")
                }

                Section {
                    TextField("Host Label (e.g., Windows PC, MacBook Pro)", text: $name)
                        .textContentType(.name)

                    TextField("MagicDNS, Tailnet IP, or https:// URL", text: $urlInput)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    if !normalizedPreview.isEmpty {
                        HStack {
                            Text(normalizedPreview)
                                .font(.caption.monospaced())
                                .foregroundStyle(palette.muted)
                            Spacer()
                            Text(endpointKind.badge)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(
                                    (endpointKind.isTailscale ? palette.green : palette.amber).opacity(0.16),
                                    in: Capsule()
                                )
                                .foregroundStyle(endpointKind.isTailscale ? palette.green : palette.amber)
                        }
                    }
                } header: {
                    Text("Tailscale Host")
                } footer: {
                    Text("Ensure the Tailscale app is active on this device. Supports `.ts.net` MagicDNS, `100.64.0.0/10` IPv4, `[fd7a:115c:a1e0::...]` IPv6, and `tailscale serve` HTTPS URLs.")
                }

                Section {
                    Picker("Authentication", selection: $authKind) {
                        ForEach(HostAuthKind.allCases, id: \.self) { kind in
                            Text(kind.label).tag(kind)
                        }
                    }

                    HStack {
                        Group {
                            if showSecret {
                                TextField(authKind == .remotePassword ? "Remote Password" : "Bearer Token", text: $secret)
                            } else {
                                SecureField(authKind == .remotePassword ? "Remote Password" : "Bearer Token", text: $secret)
                            }
                        }
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                        Button {
                            showSecret.toggle()
                        } label: {
                            Image(systemName: showSecret ? "eye.slash" : "eye")
                                .foregroundStyle(palette.muted)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(showSecret ? "Hide secret" : "Reveal secret")
                    }
                } header: {
                    Text("Credentials (Stored in iOS Keychain)")
                }

                Section {
                    Button {
                        guardCleartext(.test)
                    } label: {
                        HStack {
                            if isTesting {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "bolt.horizontal.circle")
                            }
                            Text(isTesting ? "Testing Tailscale Reachability…" : "Test Connection")
                        }
                    }
                    .disabled(normalizedPreview.isEmpty || secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isTesting)

                    if let testStatus {
                        switch testStatus {
                        case .success(let latencyMs, let hostName, let urls):
                            VStack(alignment: .leading, spacing: 6) {
                                Label("Connected in \(latencyMs) ms", systemImage: "checkmark.circle.fill")
                                    .foregroundStyle(palette.green)
                                    .font(.subheadline.weight(.semibold))
                                if let hostName, !hostName.isEmpty {
                                    Text("MagicDNS: \(hostName)")
                                        .font(.caption.monospaced())
                                        .foregroundStyle(palette.muted)
                                }
                                if !urls.isEmpty {
                                    Menu("Switch to Discovered URL") {
                                        ForEach(urls, id: \.self) { u in
                                            Button(u) { urlInput = u }
                                        }
                                    }
                                    .font(.caption.weight(.medium))
                                }
                            }
                            .padding(.vertical, 4)

                        case .failure(let apiError):
                            DiagnosticErrorBanner(
                                title: apiError.kind.title,
                                message: apiError.localizedDescription,
                                kind: apiError.kind
                            )
                        }
                    }
                }
            }
            .navigationTitle(editingHost == nil ? "Connect Companion Host" : "Edit Host")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        store.pendingPairingPayload = nil
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        guardCleartext(.save)
                    }
                    .disabled(normalizedPreview.isEmpty || secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                }
            }
            .sheet(isPresented: $showScanner) {
                QRScannerView { scanned in
                    applyPairingText(scanned)
                }
            }
            .alert(
                "Send credential unencrypted?",
                isPresented: Binding(get: { pendingInsecureAction != nil }, set: { if !$0 { pendingInsecureAction = nil } }),
                presenting: pendingInsecureAction
            ) { action in
                Button("Send over plain HTTP", role: .destructive) {
                    acceptedInsecureURL = normalizedPreview
                    perform(action)
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text(authKind == .remotePassword
                    ? "\(normalizedPreview) is not a Tailscale address, so the password would cross this network as plain HTTP that anyone on it can read. Use the PC's MagicDNS name, its 100.x Tailscale address or a tailscale serve https:// URL instead."
                    : "\(normalizedPreview) is not a Tailscale address, so the token would cross this network as plain HTTP that anyone on it can read. Use the PC's MagicDNS name, its 100.x Tailscale address or a tailscale serve https:// URL instead.")
            }
            .onAppear {
                if let host = editingHost {
                    name = host.name
                    urlInput = host.baseURL
                    authKind = host.authKind
                    secret = store.secret(for: host.id) ?? ""
                } else if let pending = store.pendingPairingPayload {
                    applyParsedPayload(pending)
                    store.pendingPairingPayload = nil
                }
            }
        }
    }

    private func pastePairingPayload() {
        #if canImport(UIKit)
        guard let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            store.showToast(String(localized: "Clipboard is empty.", bundle: .main), isError: true)
            return
        }
        applyPairingText(text)
        #endif
    }

    private func applyPairingText(_ raw: String) {
        guard let parsed = PairingPayload.parse(raw) else {
            store.showToast(String(localized: "Could not parse a companion URL from that code.", bundle: .main), isError: true)
            return
        }
        applyParsedPayload(parsed)
    }

    private func applyParsedPayload(_ parsed: PairingPayload) {
        urlInput = parsed.baseURL
        if let parsedName = parsed.name, !parsedName.isEmpty {
            name = parsedName
        }
        authKind = parsed.authKind
        if let tok = parsed.token, !tok.isEmpty {
            secret = tok
        }
        guardCleartext(.test)
    }

    /// Runs `action` at once unless it would send the credential as plain HTTP off the tailnet to a URL the user has not
    /// accepted yet; then asks first.
    private func guardCleartext(_ action: InsecureAction) {
        if HostProfile.sendsCredentialInClear(urlInput), acceptedInsecureURL != normalizedPreview {
            pendingInsecureAction = action
        } else {
            perform(action)
        }
    }

    private func perform(_ action: InsecureAction) {
        switch action {
        case .test: Task { await runConnectionTest() }
        case .save: Task { await save() }
        }
    }

    private func runConnectionTest() async {
        isTesting = true
        defer { isTesting = false }
        let result = await store.testHostConnection(baseURL: urlInput, secret: secret)
        switch result {
        case .success(let info):
            testStatus = .success(latencyMs: info.latencyMs, hostName: info.tailscale.tailscale?.name, urls: info.tailscale.tailnetUrls)
            if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let tsName = info.tailscale.tailscale?.name, !tsName.isEmpty {
                name = tsName.split(separator: ".").first.map(String.init) ?? tsName
            }
            store.notificationManager.triggerHaptic(.success)
        case .failure(let err):
            testStatus = .failure(err)
            store.notificationManager.triggerHaptic(.error)
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await store.saveHost(
                existingID: editingHost?.id,
                name: name,
                baseURL: urlInput,
                authKind: authKind,
                secret: secret,
                selectAsActive: true
            )
            store.notificationManager.triggerHaptic(.success)
            dismiss()
        } catch let err as CompanionAPIError {
            testStatus = .failure(err)
        } catch {
            store.showToast(error.localizedDescription, isError: true)
        }
    }
}
