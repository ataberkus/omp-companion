import XCTest
@testable import OMPCompanionKit

/// `CompanionClient` against `StubURLProtocol`: what goes on the wire and how replies and errors map back.
final class CompanionClientTests: XCTestCase {
    private var session: URLSession!

    override func setUpWithError() throws {
        try super.setUpWithError()
        StubURLProtocol.reset()
        session = StubURLProtocol.makeSession()
    }

    override func tearDownWithError() throws {
        session.invalidateAndCancel()
        session = nil
        StubURLProtocol.reset()
        try super.tearDownWithError()
    }

    private func makeClient(baseURL: String = "http://100.64.0.9:4545", token: String = "tok_abc") -> CompanionClient {
        CompanionClient(host: HostProfile(name: "PC", baseURL: baseURL), token: token, session: session)
    }

    /// Requests that reached `host`: a background refresh left by another test class may still arrive on other hosts.
    private static func requests(to host: String = "100.64.0.9") -> [URLRequest] {
        StubURLProtocol.requests.filter { $0.url?.host == host }
    }

    private static func queryItems(_ request: URLRequest) -> [URLQueryItem] {
        guard let url = request.url, let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return [] }
        return comps.queryItems ?? []
    }

    private static let pollBody = #"{"sx":{"epoch":"e1","rev":3,"order":["s1"],"changed":[{"id":"s1","title":"One"}]}}"#

    func testFetchStateSendsBearerTokenAndComposesQuery() async throws {
        StubURLProtocol.handler = { request in
            StubURLProtocol.reply(request, body: Self.pollBody)
        }
        let client = makeClient()

        _ = try await client.fetchState(sessionId: "s1", since: "t1.4", storeToken: "e1.2")
        _ = try await client.fetchState(sessionId: nil, since: "ignored", storeToken: nil, orderDelta: false)

        let requests = Self.requests()
        XCTAssertEqual(requests.count, 2)

        let viewed = requests[0]
        XCTAssertEqual(viewed.httpMethod, "GET")
        XCTAssertEqual(viewed.url?.host, "100.64.0.9")
        XCTAssertEqual(viewed.url?.port, 4545)
        XCTAssertEqual(viewed.url?.path, "/api/state")
        XCTAssertEqual(viewed.value(forHTTPHeaderField: "Authorization"), "Bearer tok_abc")
        XCTAssertNil(viewed.value(forHTTPHeaderField: "If-None-Match"))
        XCTAssertEqual(Self.queryItems(viewed), [
            URLQueryItem(name: "session", value: "s1"),
            URLQueryItem(name: "since", value: "t1.4"),
            URLQueryItem(name: "od", value: "1"),
            URLQueryItem(name: "store", value: "e1.2"),
        ])

        // No viewed session: no `since`; orderDelta off: no `od`; a missing store token is sent empty.
        let dashboard = requests[1]
        XCTAssertEqual(dashboard.url?.path, "/api/state")
        XCTAssertEqual(Self.queryItems(dashboard), [
            URLQueryItem(name: "session", value: ""),
            URLQueryItem(name: "store", value: ""),
        ])
    }

    func testFetchStateETagRoundTrip() async throws {
        StubURLProtocol.handler = { request in
            if request.value(forHTTPHeaderField: "If-None-Match") == "\"v1\"" {
                return StubURLProtocol.reply(request, status: 304, headers: ["ETag": "\"v1\""])
            }
            return StubURLProtocol.reply(request, headers: ["ETag": "\"v1\""], body: Self.pollBody)
        }
        let client = makeClient()

        let first = try await client.fetchState(sessionId: nil, since: nil, storeToken: nil)
        guard case .updated(let poll, let etag) = first else {
            return XCTFail("expected .updated, got \(first)")
        }
        XCTAssertEqual(etag, "\"v1\"")
        XCTAssertEqual(poll.sx?.epoch, "e1")
        XCTAssertEqual(poll.sx?.rev, 3)
        XCTAssertEqual(poll.sx?.changed?.map(\.id), ["s1"])

        let second = try await client.fetchState(sessionId: nil, since: nil, storeToken: "e1.3", etag: etag)
        guard case .notModified = second else {
            return XCTFail("expected .notModified, got \(second)")
        }

        let requests = Self.requests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertNil(requests[0].value(forHTTPHeaderField: "If-None-Match"))
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "If-None-Match"), "\"v1\"")
    }

    func testErrorRepliesBecomeClassifiedCompanionAPIErrors() async throws {
        let cases: [(status: Int, body: String, kind: TailscaleErrorKind, message: String)] = [
            (401, #"{"error":"Invalid connection token."}"#, .invalidToken, "Invalid connection token."),
            (401, #"{"error":"Wrong password."}"#, .wrongPassword, "Wrong password."),
            (403, #"{"error":"Origin not allowed."}"#, .originRejected, "Origin not allowed."),
            (503, #"{"error":"Server closing for restart"}"#, .companionRestarting, "Server closing for restart"),
            // Not JSON: the body text itself is the message.
            (500, "boom", .serverError(status: 500), "boom"),
        ]
        let client = makeClient()
        for entry in cases {
            StubURLProtocol.handler = { request in
                StubURLProtocol.reply(request, status: entry.status, body: entry.body)
            }
            do {
                _ = try await client.fetchTailscaleInfo()
                XCTFail("HTTP \(entry.status) must throw")
            } catch let error as CompanionAPIError {
                XCTAssertEqual(error.kind, entry.kind, "HTTP \(entry.status) \(entry.body)")
                XCTAssertEqual(error.statusCode, entry.status)
                XCTAssertEqual(error.serverMessage, entry.message)
                XCTAssertEqual(error.localizedDescription, entry.message)
            }
        }
        XCTAssertEqual(
            Self.requests().map { $0.url?.path },
            [String?](repeating: "/api/tailscale", count: cases.count)
        )
    }

    func testOversizedBodyIsRejectedBeforeAnyRequest() async throws {
        StubURLProtocol.handler = { request in
            StubURLProtocol.reply(request, body: "{}")
        }
        let client = makeClient()
        // `/api/projects` takes the 256 KB cap; the name alone exceeds it once JSON-encoded.
        let name = String(repeating: "x", count: CompanionClient.smallBodyLimit)
        do {
            _ = try await client.addProject(path: "/repo", name: name)
            XCTFail("an oversized body must be refused")
        } catch let error as CompanionAPIError {
            XCTAssertEqual(error.kind, .payloadTooLarge(limitLabel: "256 KB"))
            XCTAssertEqual(error.statusCode, 413)
        }
        XCTAssertTrue(Self.requests().isEmpty, "nothing may be sent for a refused body")

        // The same body fits the 48 MB cap of `/api/draft`, so it is sent (the stub's `{}` reply need not decode).
        _ = try? await client.saveDraft(key: "k", text: name)
        XCTAssertEqual(Self.requests().map { $0.url?.path }, ["/api/draft"])
    }

    func testSessionCommandPostsToEncodedPathWithLeanFlag() async throws {
        StubURLProtocol.handler = { request in
            StubURLProtocol.reply(request, body: #"{"id":"0f8fad5b-d9cb-469f-a165-70867728950e","title":"Renamed"}"#)
        }
        let client = makeClient()
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e"

        let lean = try await client.renameSession(sessionId: id, name: "Renamed")
        XCTAssertEqual(lean.id, id)
        XCTAssertEqual(lean.title, "Renamed")
        let _: SessionSummary = try await client.sessionCommand(sessionId: id, payload: ["type": "noop"])

        let requests = Self.requests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].httpMethod, "POST")
        XCTAssertEqual(requests[0].url?.path, "/api/sessions/\(id)/command")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer tok_abc")
        XCTAssertEqual(Self.queryItems(requests[0]), [URLQueryItem(name: "lean", value: "1")])
        // `lean` defaults to false: no query at all.
        XCTAssertEqual(requests[1].url?.path, "/api/sessions/\(id)/command")
        XCTAssertNil(requests[1].url?.query)
    }

    func testBaseURLPathPrefixIsKept() async throws {
        StubURLProtocol.handler = { request in
            StubURLProtocol.reply(request, body: #"{"tailnetUrls":[],"lanUrls":[]}"#)
        }
        let client = makeClient(baseURL: "https://pc.tail1234.ts.net/companion/")
        let info = try await client.fetchTailscaleInfo()
        XCTAssertEqual(info.tailnetUrls, [])
        XCTAssertEqual(Self.requests(to: "pc.tail1234.ts.net").first?.url?.absoluteString, "https://pc.tail1234.ts.net/companion/api/tailscale")
    }
}
