import Foundation

public enum TailscaleErrorKind: Equatable, Sendable {
    case tailscaleInactiveOrUnreachable
    case atsOrTlsMismatch
    case invalidToken
    case wrongPassword
    case hostHeaderRejected
    case originRejected
    case payloadTooLarge(limitLabel: String)
    case unsupportedMediaType
    case conflict
    case rateLimited
    case companionRestarting
    case notFound
    case serverError(status: Int)
    case invalidURL
    case decodingFailed
    case cancelled
    case unknown

    public var title: String {
        switch self {
        case .tailscaleInactiveOrUnreachable: return String(localized: "Host unreachable over Tailscale", bundle: .main)
        case .atsOrTlsMismatch: return String(localized: "TLS / HTTP transport blocked", bundle: .main)
        case .invalidToken: return String(localized: "Invalid connection token", bundle: .main)
        case .wrongPassword: return String(localized: "Wrong remote password", bundle: .main)
        case .hostHeaderRejected: return String(localized: "Host header rejected (403)", bundle: .main)
        case .originRejected: return String(localized: "Origin rejected (403)", bundle: .main)
        case .payloadTooLarge(let limit): return String(localized: "Upload exceeds \(limit) limit", bundle: .main)
        case .unsupportedMediaType: return String(localized: "Unsupported request type", bundle: .main)
        case .conflict: return String(localized: "Action conflict (409)", bundle: .main)
        case .rateLimited: return String(localized: "Too many requests (429)", bundle: .main)
        case .companionRestarting: return String(localized: "Companion restarting", bundle: .main)
        case .notFound: return String(localized: "Route or item not found", bundle: .main)
        case .serverError(let status): return String(localized: "Companion error (\(status))", bundle: .main)
        case .invalidURL: return String(localized: "Invalid host URL", bundle: .main)
        case .decodingFailed: return String(localized: "Unexpected server response", bundle: .main)
        case .cancelled: return String(localized: "Request cancelled", bundle: .main)
        case .unknown: return String(localized: "Connection error", bundle: .main)
        }
    }

    public var remediation: String {
        switch self {
        case .tailscaleInactiveOrUnreachable:
            return String(localized: "Verify the Tailscale app is connected on this iPhone/iPad and the host PC is online with OMP Control Room listening on its tailnet address.", bundle: .main)
        case .atsOrTlsMismatch:
            return String(localized: "Check whether the companion uses plain HTTP on port 4545 or HTTPS via `tailscale serve`, and confirm the port and scheme match.", bundle: .main)
        case .invalidToken:
            return String(localized: "Update the bearer token in Host Settings or scan a fresh QR code from the desktop dashboard.", bundle: .main)
        case .wrongPassword:
            return String(localized: "Enter the exact remote password configured in OMP_WEB_PASSWORD on the companion host.", bundle: .main)
        case .hostHeaderRejected:
            return String(localized: "Companion rejected the HTTP Host header. Connect via its MagicDNS name, tailnet IP, or add the host to OMP_WEB_PUBLIC_HOSTS.", bundle: .main)
        case .originRejected:
            return String(localized: "Companion rejected the request Origin. Native iOS requests omit Origin; check proxy headers if using a custom reverse proxy.", bundle: .main)
        case .payloadTooLarge(let limit):
            return String(localized: "Reduce text or remove/compress attached images so the request stays under \(limit).", bundle: .main)
        case .unsupportedMediaType:
            return String(localized: "Ensure JSON request content-type headers are intact.", bundle: .main)
        case .conflict:
            return String(localized: "Another action or turn is currently active on this session.", bundle: .main)
        case .rateLimited:
            return String(localized: "Wait a few seconds before retrying.", bundle: .main)
        case .companionRestarting:
            return String(localized: "The companion host is shutting down or restarting; syncing will resume automatically once back up.", bundle: .main)
        case .notFound:
            return String(localized: "This resource may have been removed or your companion version may not expose this endpoint.", bundle: .main)
        case .serverError:
            return String(localized: "Check the companion console or desktop log on the host machine.", bundle: .main)
        case .invalidURL:
            return String(localized: "Enter a valid MagicDNS hostname (e.g. pc.tail.ts.net:4545), tailnet IP, or HTTPS URL.", bundle: .main)
        case .decodingFailed:
            return String(localized: "Update OMP Control Room on the host or verify the URL points to the companion server.", bundle: .main)
        case .cancelled:
            return String(localized: "Cancelled.", bundle: .main)
        case .unknown:
            return String(localized: "Check Tailscale connectivity and try again.", bundle: .main)
        }
    }

    public var isAuthFailure: Bool {
        self == .invalidToken || self == .wrongPassword
    }

    public var isConnectivityFailure: Bool {
        switch self {
        case .tailscaleInactiveOrUnreachable, .atsOrTlsMismatch, .companionRestarting, .hostHeaderRejected, .originRejected:
            return true
        default:
            return false
        }
    }
}

public struct CompanionAPIError: LocalizedError, Sendable {
    public let kind: TailscaleErrorKind
    public let statusCode: Int?
    public let serverMessage: String?
    /// The `NSURLErrorDomain` code of a transport failure; nil for HTTP replies and errors raised here.
    public let transportCode: Int?

    public init(kind: TailscaleErrorKind, statusCode: Int? = nil, serverMessage: String? = nil, transportCode: Int? = nil) {
        self.kind = kind
        self.statusCode = statusCode
        self.serverMessage = serverMessage
        self.transportCode = transportCode
    }

    /// The request certainly never reached the companion, so sending it again cannot repeat it: no connection was made
    /// (refused, no route or network, DNS, a failed TLS handshake), or the companion's Host/Origin gate turned it away
    /// before reading it. A timeout or a connection lost mid-request is not: the PC may have acted on it.
    public var definitelyNotDelivered: Bool {
        switch kind {
        case .atsOrTlsMismatch, .hostHeaderRejected, .originRejected:
            return true
        case .tailscaleInactiveOrUnreachable:
            guard let transportCode else { return false }
            return [NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed, NSURLErrorNotConnectedToInternet]
                .contains(transportCode)
        default:
            return false
        }
    }

    public var errorDescription: String? {
        if let serverMessage, !serverMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return serverMessage
        }
        return kind.title
    }
}

public enum TailscaleDiagnostic {
    public static func classifyHTTP(status: Int, message: String?, url: String? = nil) -> CompanionAPIError {
        let msg = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lower = msg.lowercased()

        switch status {
        case 401:
            if lower.contains("password") {
                return CompanionAPIError(kind: .wrongPassword, statusCode: 401, serverMessage: msg.isEmpty ? String(localized: "Wrong password.", bundle: .main) : msg)
            }
            return CompanionAPIError(kind: .invalidToken, statusCode: 401, serverMessage: msg.isEmpty ? String(localized: "Invalid connection token.", bundle: .main) : msg)
        case 403:
            if lower.contains("origin") {
                return CompanionAPIError(kind: .originRejected, statusCode: 403, serverMessage: msg.isEmpty ? String(localized: "Origin not allowed.", bundle: .main) : msg)
            }
            return CompanionAPIError(kind: .hostHeaderRejected, statusCode: 403, serverMessage: msg.isEmpty ? String(localized: "Invalid Host header.", bundle: .main) : msg)
        case 404:
            return CompanionAPIError(kind: .notFound, statusCode: 404, serverMessage: msg.isEmpty ? String(localized: "Route not found.", bundle: .main) : msg)
        case 409:
            return CompanionAPIError(kind: .conflict, statusCode: 409, serverMessage: msg)
        case 413:
            let limit = lower.contains("48 mb") ? "48 MB" : "256 KB"
            return CompanionAPIError(kind: .payloadTooLarge(limitLabel: limit), statusCode: 413, serverMessage: msg)
        case 415:
            return CompanionAPIError(kind: .unsupportedMediaType, statusCode: 415, serverMessage: msg)
        case 429:
            return CompanionAPIError(kind: .rateLimited, statusCode: 429, serverMessage: msg)
        case 503:
            if lower.contains("closing") || lower.contains("restart") {
                return CompanionAPIError(kind: .companionRestarting, statusCode: 503, serverMessage: msg)
            }
            return CompanionAPIError(kind: .serverError(status: 503), statusCode: 503, serverMessage: msg)
        default:
            if status >= 500 {
                return CompanionAPIError(kind: .serverError(status: status), statusCode: status, serverMessage: msg)
            }
            return CompanionAPIError(kind: .unknown, statusCode: status, serverMessage: msg.isEmpty ? "HTTP \(status)" : msg)
        }
    }

    /// A reply that is JSON but not the shape this build expects, naming the endpoint and the field, e.g.
    /// `/api/state → sx.changed[3].status: expected String`, so the mismatch can be found without guessing.
    public static func decodingFailure(_ error: DecodingError, endpoint: String?) -> CompanionAPIError {
        let detail = DecodingDiagnostics.describe(error)
        let location = endpoint.map { "\($0) → \(detail)" } ?? detail
        return CompanionAPIError(kind: .decodingFailed, serverMessage: "Could not decode companion JSON at \(location)")
    }

    public static func classifyTransport(_ error: Error, host: HostProfile?) -> CompanionAPIError {
        if let apiError = error as? CompanionAPIError {
            return apiError
        }
        if let decodingError = error as? DecodingError {
            return decodingFailure(decodingError, endpoint: nil)
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case NSURLErrorCancelled:
                return CompanionAPIError(kind: .cancelled, serverMessage: String(localized: "Cancelled", bundle: .main))
            case NSURLErrorAppTransportSecurityRequiresSecureConnection,
                 NSURLErrorSecureConnectionFailed,
                 NSURLErrorServerCertificateHasBadDate,
                 NSURLErrorServerCertificateUntrusted,
                 NSURLErrorServerCertificateHasUnknownRoot,
                 NSURLErrorServerCertificateNotYetValid,
                 NSURLErrorClientCertificateRejected:
                return CompanionAPIError(kind: .atsOrTlsMismatch, serverMessage: nsError.localizedDescription, transportCode: nsError.code)
            case NSURLErrorTimedOut,
                 NSURLErrorCannotFindHost,
                 NSURLErrorCannotConnectToHost,
                 NSURLErrorDNSLookupFailed,
                 NSURLErrorNotConnectedToInternet,
                 NSURLErrorNetworkConnectionLost:
                let kindLabel = host?.endpointKind.badge ?? "Tailscale"
                let detail = String(localized: "Cannot reach \(host?.hostDisplay ?? "companion") over \(kindLabel): \(nsError.localizedDescription)", bundle: .main)
                return CompanionAPIError(kind: .tailscaleInactiveOrUnreachable, serverMessage: detail, transportCode: nsError.code)
            default:
                break
            }
        }
        return CompanionAPIError(kind: .unknown, serverMessage: error.localizedDescription)
    }
}
