import Foundation
import Security

public protocol CredentialStore: Sendable {
    func saveSecret(_ secret: String, for hostID: UUID) throws
    func loadSecret(for hostID: UUID) throws -> String?
    func deleteSecret(for hostID: UUID) throws
}

public enum KeychainError: LocalizedError, Sendable {
    case unexpectedStatus(OSStatus)
    case encodingFailed

    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            if let message = SecCopyErrorMessageString(status, nil) as String? {
                return "Keychain error (\(status)): \(message)"
            }
            return "Keychain error (\(status))"
        case .encodingFailed:
            return "Failed to encode credential for Keychain storage."
        }
    }
}

public final class KeychainStore: CredentialStore, @unchecked Sendable {
    private let service: String

    public init(service: String = "dev.omp.companion.credentials") {
        self.service = service
    }

    public func saveSecret(_ secret: String, for hostID: UUID) throws {
        guard let data = secret.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }
        let account = hostID.uuidString
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus != errSecItemNotFound {
            throw KeychainError.unexpectedStatus(updateStatus)
        }

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unexpectedStatus(addStatus)
        }
    }

    public func loadSecret(for hostID: UUID) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: hostID.uuidString,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        return value
    }

    public func deleteSecret(for hostID: UUID) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: hostID.uuidString,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecItemNotFound || status == errSecSuccess {
            return
        }
        throw KeychainError.unexpectedStatus(status)
    }
}

/// Ephemeral in-memory credential store for unit tests and SwiftUI previews.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var secrets: [UUID: String] = [:]

    public init(initial: [UUID: String] = [:]) {
        self.secrets = initial
    }

    public func saveSecret(_ secret: String, for hostID: UUID) throws {
        lock.withLock { secrets[hostID] = secret }
    }

    public func loadSecret(for hostID: UUID) throws -> String? {
        lock.withLock { secrets[hostID] }
    }

    public func deleteSecret(for hostID: UUID) throws {
        _ = lock.withLock { secrets.removeValue(forKey: hostID) }
    }
}
