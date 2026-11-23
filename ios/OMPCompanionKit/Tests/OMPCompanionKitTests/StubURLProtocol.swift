import Foundation

/// Answers every request of a session built by `StubURLProtocol.makeSession()` from `handler`, without the network,
/// and records each request in arrival order. State is static (URLSession instantiates the protocol itself): call
/// `reset()` in setUp and tearDown.
final class StubURLProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var handler: Handler?
        var requests: [URLRequest] = []
    }

    private static let state = State()

    static var handler: Handler? {
        get { state.lock.withLock { state.handler } }
        set { state.lock.withLock { state.handler = newValue } }
    }

    /// Every request that reached the stub, in order.
    static var requests: [URLRequest] {
        state.lock.withLock { state.requests }
    }

    static func reset() {
        state.lock.withLock {
            state.handler = nil
            state.requests = []
        }
    }

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }

    /// A reply with `status`, the given header fields and a body.
    static func reply(
        _ request: URLRequest,
        status: Int = 200,
        headers: [String: String] = [:],
        body: String = ""
    ) -> (HTTPURLResponse, Data) {
        var fields = headers
        if !body.isEmpty, fields["Content-Type"] == nil {
            fields["Content-Type"] = "application/json"
        }
        let url = request.url ?? URL(string: "http://stub.invalid")!
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields)!
        return (response, Data(body.utf8))
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let handler = Self.state.lock.withLock { () -> Handler? in
            Self.state.requests.append(request)
            return Self.state.handler
        }
        do {
            guard let handler else { throw URLError(.resourceUnavailable) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !data.isEmpty {
                client?.urlProtocol(self, didLoad: data)
            }
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
