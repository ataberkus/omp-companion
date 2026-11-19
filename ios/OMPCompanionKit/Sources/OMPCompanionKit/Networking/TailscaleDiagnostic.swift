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
        case .tailscaleInactiveOrUnreachable: return "Host unreachable over Tailscale"
        case .atsOrTlsMismatch: return "TLS / HTTP transport blocked"
        case .invalidToken: return "Invalid connection token"
        case .wrongPassword: return "Wrong remote password"
        case .hostHeaderRejected: return "Host header rejected (403)"
        case .originRejected: return "Origin rejected (403)"
        case .payloadTooLarge(let limit): return "Upload exceeds \(limit) limit"
        case .unsupportedMediaType: return "Unsupported request type"
        case .conflict: return "Action conflict (409)"
        case .rateLimited: return "Too many requests (429)"
        case .companionRestarting: return "Companion restarting"
        case .notFound: return "Route or item not found"
        case .serverError(let status): return "Companion error (\(status))"
        case .invalidURL: return "Invalid host URL"
        case .decodingFailed: return "Unexpected server response"
        case .cancelled: return "Request cancelled"
        case .unknown: return "Connection error"
        }
    }

    public var remediation: String {
        switch self {
        case .tailscaleInactiveOrUnreachable:
            return "Verify the Tailscale app is connected on this iPhone/iPad and the host PC is online with OMP Control Room listening on its tailnet address."
        case .atsOrTlsMismatch:
            return "Check whether the companion uses plain HTTP on port 4545 or HTTPS via `tailscale serve`, and confirm the port and scheme match."
        case .invalidToken:
            return "Update the bearer token in Host Settings or scan a fresh QR code from the desktop dashboard."
        case .wrongPassword:
            return "Enter the exact remote password configured in OMP_WEB_PASSWORD on the companion host."
        case .hostHeaderRejected:
            return "Companion rejected the HTTP Host header. Connect via its MagicDNS name, tailnet IP, or add the host to OMP_WEB_PUBLIC_HOSTS."
        case .originRejected:
            return "Companion rejected the request Origin. Native iOS requests omit Origin; check proxy headers if using a custom reverse proxy."
        case .payloadTooLarge(let limit):
            return "Reduce text or remove/compress attached images so the request stays under \(limit)."
        case .unsupportedMediaType:
            return "Ensure JSON request content-type headers are intact."
        case .conflict:
            return "Another action or turn is currently active on this session."
        case .rateLimited:
            return "Wait a few seconds before retrying."
        case .companionRestarting:
            return "The companion host is shutting down or restarting; syncing will resume automatically once back up."
        case .notFound:
            return "This resource may have been removed or your companion version may not expose this endpoint."
        case .serverError:
            return "Check the companion console or desktop log on the host machine."
        case .invalidURL:
            return "Enter a valid MagicDNS hostname (e.g. pc.tail.ts.net:4545), tailnet IP, or HTTPS URL."
        case .decodingFailed:
            return "Update OMP Control Room on the host or verify the URL points to the companion server."
        case .cancelled:
            return "Cancelled."
        case .unknown:
            return "Check Tailscale connectivity and try again."
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

    public init(kind: TailscaleErrorKind, statusCode: Int? = nil, serverMessage: String? = nil) {
        self.kind = kind
        self.statusCode = statusCode
        self.serverMessage = serverMessage
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
                return CompanionAPIError(kind: .wrongPassword, statusCode: 401, serverMessage: msg.isEmpty ? "Wrong password." : msg)
            }
            return CompanionAPIError(kind: .invalidToken, statusCode: 401, serverMessage: msg.isEmpty ? "Invalid connection token." : msg)
        case 403:
            if lower.contains("origin") {
                return CompanionAPIError(kind: .originRejected, statusCode: 403, serverMessage: msg.isEmpty ? "Origin not allowed." : msg)
            }
            return CompanionAPIError(kind: .hostHeaderRejected, statusCode: 403, serverMessage: msg.isEmpty ? "Invalid Host header." : msg)
        case 404:
            return CompanionAPIError(kind: .notFound, statusCode: 404, serverMessage: msg.isEmpty ? "Route not found." : msg)
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
                return CompanionAPIError(kind: .cancelled, serverMessage: "Cancelled")
            case NSURLErrorAppTransportSecurityRequiresSecureConnection,
                 NSURLErrorSecureConnectionFailed,
                 NSURLErrorServerCertificateHasBadDate,
                 NSURLErrorServerCertificateUntrusted,
                 NSURLErrorServerCertificateHasUnknownRoot,
                 NSURLErrorServerCertificateNotYetValid,
                 NSURLErrorClientCertificateRejected:
                return CompanionAPIError(kind: .atsOrTlsMismatch, serverMessage: nsError.localizedDescription)
            case NSURLErrorTimedOut,
                 NSURLErrorCannotFindHost,
                 NSURLErrorCannotConnectToHost,
                 NSURLErrorDNSLookupFailed,
                 NSURLErrorNotConnectedToInternet,
                 NSURLErrorNetworkConnectionLost:
                let kindLabel = host?.endpointKind.badge ?? "Tailscale"
                let detail = "Cannot reach \(host?.hostDisplay ?? "companion") over \(kindLabel): \(nsError.localizedDescription)"
                return CompanionAPIError(kind: .tailscaleInactiveOrUnreachable, serverMessage: detail)
            default:
                break
            }
        }
        return CompanionAPIError(kind: .unknown, serverMessage: error.localizedDescription)
    }
}
