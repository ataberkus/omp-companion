import Foundation

public enum HostAuthKind: String, Codable, CaseIterable, Hashable, Sendable {
    case connectionToken
    case remotePassword

    public var label: String {
        switch self {
        case .connectionToken: return "Connection token"
        case .remotePassword: return "Remote password (OMP_WEB_PASSWORD)"
        }
    }
}

public enum TailscaleEndpointKind: String, Codable, Hashable, Sendable {
    case tailscaleMagicDNS
    case tailscaleIPv4
    case tailscaleIPv6
    case tailscaleServeHTTPS
    case lan
    case loopback
    case other

    public var badge: String {
        switch self {
        case .tailscaleMagicDNS: return "MagicDNS"
        case .tailscaleIPv4: return "Tailnet IPv4"
        case .tailscaleIPv6: return "Tailnet IPv6"
        case .tailscaleServeHTTPS: return "Tailscale Serve HTTPS"
        case .lan: return "LAN"
        case .loopback: return "Loopback"
        case .other: return "Custom"
        }
    }

    public var isTailscale: Bool {
        switch self {
        case .tailscaleMagicDNS, .tailscaleIPv4, .tailscaleIPv6, .tailscaleServeHTTPS:
            return true
        default:
            return false
        }
    }
}

public struct HostProfile: Codable, Identifiable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    public var baseURL: String
    public var authKind: HostAuthKind
    public var magicDNS: String?
    public var tailscaleIPv4: String?
    public var tailscaleIPv6: String?
    public var lastConnectedAt: Date?
    public var lastLatencyMs: Int?
    public var sortOrder: Int

    public init(
        id: UUID = UUID(),
        name: String,
        baseURL: String,
        authKind: HostAuthKind = .connectionToken,
        magicDNS: String? = nil,
        tailscaleIPv4: String? = nil,
        tailscaleIPv6: String? = nil,
        lastConnectedAt: Date? = nil,
        lastLatencyMs: Int? = nil,
        sortOrder: Int = 0
    ) {
        self.id = id
        self.name = name
        self.baseURL = Self.normalizeBaseURL(baseURL)
        self.authKind = authKind
        self.magicDNS = magicDNS
        self.tailscaleIPv4 = tailscaleIPv4
        self.tailscaleIPv6 = tailscaleIPv6
        self.lastConnectedAt = lastConnectedAt
        self.lastLatencyMs = lastLatencyMs
        self.sortOrder = sortOrder
    }

    public var endpointKind: TailscaleEndpointKind {
        Self.classifyURL(baseURL)
    }

    public var parsedURL: URL? {
        URL(string: Self.normalizeBaseURL(baseURL))
    }

    public var hostDisplay: String {
        guard let url = parsedURL else { return baseURL }
        if let port = url.port {
            return "\(url.host ?? baseURL):\(port)"
        }
        return url.host ?? baseURL
    }

    public static func isTailscaleIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 100 && (64...127).contains(parts[1])
    }

    public static func isTailscaleIPv6(_ host: String) -> Bool {
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        return bare.hasPrefix("fd7a:115c:a1e0:")
    }

    public static func isMagicDNS(_ host: String) -> Bool {
        let lower = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return lower.hasSuffix(".ts.net") && lower.split(separator: ".").count >= 3
    }

    public static func classifyURL(_ raw: String) -> TailscaleEndpointKind {
        guard let url = URL(string: normalizeBaseURL(raw)),
              let host = url.host?.lowercased() else {
            return .other
        }
        let scheme = url.scheme?.lowercased() ?? "http"
        if isMagicDNS(host) {
            return scheme == "https" ? .tailscaleServeHTTPS : .tailscaleMagicDNS
        }
        if isTailscaleIPv4(host) { return .tailscaleIPv4 }
        if isTailscaleIPv6(host) { return .tailscaleIPv6 }
        if host == "localhost" || host == "127.0.0.1" || host == "::1" { return .loopback }
        if host.hasPrefix("192.168.") || host.hasPrefix("10.") || host.hasPrefix("172.") || host.hasSuffix(".local") {
            return .lan
        }
        return scheme == "https" && host.contains(".ts.net") ? .tailscaleServeHTTPS : .other
    }

    /// Normalizes a user-typed host or URL (`my-pc.tail.ts.net`, `100.64.0.5:4545`, `[fd7a:...]:4545`, `https://...`)
    /// into a clean base URL without trailing slash or fragment.
    public static func normalizeBaseURL(_ raw: String, defaultPort: Int = 4545, preferHTTPS: Bool = false) -> String {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }

        // Strip fragment (`#token=...`) if present
        if let hashIdx = trimmed.firstIndex(of: "#") {
            trimmed = String(trimmed[..<hashIdx])
        }

        // Prepend scheme if omitted
        if !trimmed.lowercased().hasPrefix("http://") && !trimmed.lowercased().hasPrefix("https://") {
            // Bare IPv6 without brackets
            if trimmed.contains(":"), !trimmed.hasPrefix("["), trimmed.filter({ $0 == ":" }).count >= 2 {
                trimmed = "[\(trimmed)]"
            }
            let scheme = preferHTTPS ? "https://" : "http://"
            trimmed = scheme + trimmed
        }

        guard var comps = URLComponents(string: trimmed) else {
            return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        if comps.scheme == nil { comps.scheme = preferHTTPS ? "https" : "http" }
        if comps.port == nil, comps.scheme?.lowercased() == "http" {
            comps.port = defaultPort
        }
        comps.path = comps.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if comps.path.isEmpty {
            comps.path = ""
        } else {
            comps.path = "/" + comps.path
        }
        comps.query = nil
        comps.fragment = nil
        var result = comps.string ?? trimmed
        while result.hasSuffix("/") { result.removeLast() }
        return result
    }
}

public struct PairingPayload: Hashable, Sendable {
    public var baseURL: String
    public var token: String?
    public var name: String?
    public var authKind: HostAuthKind

    public static func parse(_ rawInput: String, defaultPort: Int = 4545) -> PairingPayload? {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // 1. JSON payload {"url": "...", "token": "...", "name": "..."}
        if trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let urlStr = (obj["url"] as? String) ?? (obj["baseURL"] as? String) {
            let normalized = HostProfile.normalizeBaseURL(urlStr, defaultPort: defaultPort)
            guard !normalized.isEmpty else { return nil }
            let token = (obj["token"] as? String) ?? (obj["password"] as? String)
            let isPw = (obj["password"] as? String) != nil || (obj["authKind"] as? String) == "remotePassword"
            let name = obj["name"] as? String
            return PairingPayload(
                baseURL: normalized,
                token: token?.isEmpty == true ? nil : token,
                name: (name?.isEmpty == false ? name : nil) ?? URL(string: normalized)?.host,
                authKind: isPw ? .remotePassword : .connectionToken
            )
        }

        // 2. Deep link omp://connect?url=...&token=...&name=...
        if trimmed.lowercased().hasPrefix("omp://"),
           let comps = URLComponents(string: trimmed) {
            let items = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).compactMap { item in
                item.value.map { (item.name.lowercased(), $0) }
            })
            if let urlStr = items["url"], !urlStr.isEmpty {
                let normalized = HostProfile.normalizeBaseURL(urlStr, defaultPort: defaultPort)
                let token = items["token"] ?? items["password"]
                let isPw = items["password"] != nil || items["auth"] == "password"
                let name = items["name"] ?? URL(string: normalized)?.host
                return PairingPayload(
                    baseURL: normalized,
                    token: token?.isEmpty == true ? nil : token,
                    name: name,
                    authKind: isPw ? .remotePassword : .connectionToken
                )
            }
        }

        // 3. Companion tray link http(s)://host:port/#token=...
        if let comps = URLComponents(string: trimmed),
           comps.scheme?.lowercased() == "http" || comps.scheme?.lowercased() == "https",
           let host = comps.host, !host.isEmpty {
            var token: String?
            var authKind: HostAuthKind = .connectionToken
            if let frag = comps.fragment, !frag.isEmpty {
                let fragItems = URLComponents(string: "http://x?\(frag)")?.queryItems ?? []
                if let tok = fragItems.first(where: { $0.name == "token" })?.value, !tok.isEmpty {
                    token = tok
                } else if let pw = fragItems.first(where: { $0.name == "password" })?.value, !pw.isEmpty {
                    token = pw
                    authKind = .remotePassword
                }
            }
            let normalized = HostProfile.normalizeBaseURL(trimmed, defaultPort: defaultPort)
            return PairingPayload(
                baseURL: normalized,
                token: token,
                name: host.split(separator: ".").first.map(String.init) ?? host,
                authKind: authKind
            )
        }

        // 4. Bare host/IP string
        let normalized = HostProfile.normalizeBaseURL(trimmed, defaultPort: defaultPort)
        guard let url = URL(string: normalized), let host = url.host, !host.isEmpty else {
            return nil
        }
        return PairingPayload(
            baseURL: normalized,
            token: nil,
            name: host.split(separator: ".").first.map(String.init) ?? host,
            authKind: .connectionToken
        )
    }
}
