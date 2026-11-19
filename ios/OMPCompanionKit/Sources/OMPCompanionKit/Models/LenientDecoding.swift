import Foundation

// Companion replies are read leniently: an optional field that is missing, null or of an unexpected shape reads as nil,
// and one malformed element is skipped instead of failing the whole list (one bad session must not empty the dashboard).
// Only fields a model cannot exist without (a session's id, a transcript message's id) still fail an element.

/// Consumes one element of an unkeyed container without reading it, so a lossy list can step over an element that failed.
struct SkippedElement: Decodable {
    init(from decoder: Decoder) throws {}
}

extension KeyedDecodingContainer {
    /// An optional field: missing, null or the wrong type all read as nil.
    func lenient<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
        try? decodeIfPresent(type, forKey: key)
    }

    /// An integer field that also accepts a JSON number with a fraction (rounded).
    func lenient(_ type: Int.Type, forKey key: Key) -> Int? {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key), value.isFinite, abs(value) < 9e15 {
            return Int(value.rounded())
        }
        return nil
    }

    /// A flag the companion may send as a boolean or as the time it was set (e.g. `worktreeRemoved`): a non-empty
    /// string or a non-zero number is true.
    func lenientFlag(forKey key: Key) -> Bool? {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(String.self, forKey: key) { return !value.isEmpty }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value != 0 }
        return nil
    }

    /// A list whose malformed elements are skipped; nil when the key is missing, null or not an array.
    func lossyArray<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T]? {
        guard contains(key), (try? decodeNil(forKey: key)) != true,
              var container = try? nestedUnkeyedContainer(forKey: key) else {
            return nil
        }
        return container.decodeLossyElements(type)
    }
}

extension UnkeyedDecodingContainer {
    /// Decodes every element that decodes as `T`, stepping over the rest.
    mutating func decodeLossyElements<T: Decodable>(_ type: T.Type) -> [T] {
        var out: [T] = []
        if let count { out.reserveCapacity(count) }
        while !isAtEnd {
            if let value = try? decode(type) {
                out.append(value)
            } else if (try? decode(SkippedElement.self)) == nil {
                break
            }
        }
        return out
    }
}

/// Turns a `DecodingError` into the field it failed on, e.g. `sx.changed[3].status: expected String`.
public enum DecodingDiagnostics {
    public static func describe(_ error: DecodingError) -> String {
        switch error {
        case .typeMismatch(let type, let context):
            return "\(path(context.codingPath)): expected \(type) (\(context.debugDescription))"
        case .valueNotFound(let type, let context):
            return "\(path(context.codingPath)): expected \(type), found null"
        case .keyNotFound(let key, let context):
            return "\(path(context.codingPath + [key])): required field missing"
        case .dataCorrupted(let context):
            return "\(path(context.codingPath)): \(context.debugDescription)"
        @unknown default:
            return error.localizedDescription
        }
    }

    public static func path(_ codingPath: [CodingKey]) -> String {
        var out = ""
        for key in codingPath {
            if let index = key.intValue, key.stringValue.hasPrefix("Index") || key.stringValue == String(index) {
                out += "[\(index)]"
            } else {
                out += out.isEmpty ? key.stringValue : ".\(key.stringValue)"
            }
        }
        return out.isEmpty ? "(root)" : out
    }
}
