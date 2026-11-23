import XCTest
@testable import OMPCompanionKit

private let stateBody = #"{"sx":{"epoch":"e1","rev":1,"order":["s1","s2"],"changed":[{"id":"s1","title":"First"},{"id":"s2","title":"Second"}]}}"#
private let notFoundBody = #"{"error":"Route not found."}"#
private let tailscaleBody = """
{"port":4545,"tailscale":{"name":"pc.tail1234.ts.net","ips":["100.64.0.1"]},\
"tailnetUrls":["http://100.64.0.2:4545"],"lanUrls":["http://192.168.1.5:4545"]}
"""

/// `AppStore.pollOnce` against `StubURLProtocol`: connection status, ETag reuse, offline fallback and fail-over to the
/// addresses the companion reported. Each test has its own UserDefaults suite, offline-cache folder and credential store.
final class AppStorePollingTests: XCTestCase {
    private var session: URLSession!
    private var suiteName: String!
    private var defaults: UserDefaults!
    private var cacheDirectory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        StubURLProtocol.reset()
        session = StubURLProtocol.makeSession()
        suiteName = "omp.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        cacheDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("omp-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        // Not invalidated: a store's background refresh (started by its first live reply) may still send on it.
        // Those requests only reach /api/tailscale and /api/omp-sessions on this class's hosts, which no
        // assertion here or in CompanionClientTests counts.
        session = nil
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        try? FileManager.default.removeItem(at: cacheDirectory)
        StubURLProtocol.reset()
        try super.tearDownWithError()
    }

    /// A store whose one saved host (active, token `tok_abc`) is `baseURL`. Seeding UserDefaults rather than calling
    /// `saveHost` keeps the store from starting its poll loop, so each test drives `pollOnce` itself.
    @MainActor
    private func makeStore(baseURL: String) throws -> (AppStore, HostProfile) {
        let host = HostProfile(name: "PC", baseURL: baseURL)
        defaults.set(try JSONEncoder().encode([host]), forKey: AppStore.hostsDefaultsKey)
        defaults.set(host.id.uuidString, forKey: AppStore.activeHostDefaultsKey)
        let store = AppStore(
            credentialStore: InMemoryCredentialStore(initial: [host.id: "tok_abc"]),
            offlineCache: OfflineCache(directory: cacheDirectory),
            urlSession: session,
            defaults: defaults
        )
        XCTAssertEqual(store.activeHost?.id, host.id)
        return (store, host)
    }

    /// `/api/state` requests only: a first live snapshot also starts background refreshes of other endpoints.
    private static func stateRequests(host: String? = nil) -> [URLRequest] {
        StubURLProtocol.requests.filter {
            $0.url?.path == "/api/state" && (host == nil || $0.url?.host == host)
        }
    }

    private static func queryValue(_ name: String, in request: URLRequest) -> String? {
        guard let url = request.url, let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        return comps.queryItems?.first(where: { $0.name == name })?.value
    }

    /// Answers `/api/state` with `stateBody` (ETag `"r1"`, or 304 when the request carries it) and 404 elsewhere.
    private static let liveCompanion: StubURLProtocol.Handler = { request in
        guard request.url?.path == "/api/state" else {
            return StubURLProtocol.reply(request, status: 404, body: notFoundBody)
        }
        if request.value(forHTTPHeaderField: "If-None-Match") == "\"r1\"" {
            return StubURLProtocol.reply(request, status: 304, headers: ["ETag": "\"r1\""])
        }
        return StubURLProtocol.reply(request, headers: ["ETag": "\"r1\""], body: stateBody)
    }

    private static let unreachable: StubURLProtocol.Handler = { _ in
        throw URLError(.cannotConnectToHost)
    }

    @MainActor
    func testSuccessfulPollConnectsAndAppliesSessions() async throws {
        let (store, host) = try makeStore(baseURL: "http://100.64.0.1:4545")
        StubURLProtocol.handler = Self.liveCompanion

        await store.pollOnce()

        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertTrue(store.hasReceivedLiveSnapshotForHost)
        XCTAssertFalse(store.isInitialLoading)
        XCTAssertEqual(store.snapshot.sessions.map(\.id), ["s1", "s2"])
        XCTAssertEqual(store.snapshot.sessions.map(\.title), ["First", "Second"])
        XCTAssertEqual(store.reachabilityByHost[host.id], .reachable(latencyMs: 15))

        let polls = Self.stateRequests()
        XCTAssertEqual(polls.count, 1)
        XCTAssertEqual(polls.first?.url?.host, "100.64.0.1")
        XCTAssertEqual(polls.first?.value(forHTTPHeaderField: "Authorization"), "Bearer tok_abc")
        XCTAssertNil(polls.first?.value(forHTTPHeaderField: "If-None-Match"), "no ETag before a reply was applied")
    }

    @MainActor
    func testNotModifiedKeepsSnapshotAndStaysConnected() async throws {
        let (store, _) = try makeStore(baseURL: "http://100.64.0.1:4545")
        StubURLProtocol.handler = Self.liveCompanion

        await store.pollOnce()
        let applied = store.snapshot
        XCTAssertEqual(applied.sessions.map(\.id), ["s1", "s2"])

        await store.pollOnce()

        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertEqual(store.snapshot, applied)
        let polls = Self.stateRequests()
        XCTAssertEqual(polls.count, 2)
        XCTAssertEqual(polls[1].value(forHTTPHeaderField: "If-None-Match"), "\"r1\"")
        XCTAssertEqual(Self.queryValue("store", in: polls[1]), "e1.1", "the store cursor of the applied reply")
    }

    @MainActor
    func testTransportFailureWithoutSnapshotIsAnError() async throws {
        let (store, host) = try makeStore(baseURL: "http://100.64.0.1:4545")
        StubURLProtocol.handler = Self.unreachable

        await store.pollOnce()

        guard case .error(_, let kind) = store.connectionStatus else {
            return XCTFail("expected .error, got \(store.connectionStatus)")
        }
        XCTAssertEqual(kind, .tailscaleInactiveOrUnreachable)
        XCTAssertFalse(store.hasReceivedLiveSnapshotForHost)
        XCTAssertTrue(store.snapshot.sessions.isEmpty)
        guard case .unreachable = store.reachabilityByHost[host.id] else {
            return XCTFail("expected .unreachable, got \(String(describing: store.reachabilityByHost[host.id]))")
        }
        XCTAssertEqual(Self.stateRequests().count, 1)
    }

    @MainActor
    func testTransportFailureAfterLiveSnapshotGoesOffline() async throws {
        let (store, _) = try makeStore(baseURL: "http://100.64.0.1:4545")
        StubURLProtocol.handler = Self.liveCompanion
        await store.pollOnce()
        XCTAssertEqual(store.connectionStatus, .connected)

        StubURLProtocol.handler = Self.unreachable
        await store.pollOnce()

        guard case .offline(let cachedAt, _, let kind) = store.connectionStatus else {
            return XCTFail("expected .offline, got \(store.connectionStatus)")
        }
        XCTAssertEqual(kind, .tailscaleInactiveOrUnreachable)
        XCTAssertNotNil(cachedAt, "the first live reply was written to the offline cache")
        XCTAssertTrue(store.isOfflineReadOnly)
        XCTAssertFalse(store.canPerformMutatingActions)
        XCTAssertEqual(store.snapshot.sessions.map(\.id), ["s1", "s2"], "the last live snapshot stays on screen")
    }

    @MainActor
    func testFailOverMovesToTailnetAlternateAndNeverTriesPlainHTTPLAN() async throws {
        let (store, host) = try makeStore(baseURL: "http://100.64.0.1:4545")

        // The companion, reachable on its paired address, reports where else it answers.
        StubURLProtocol.handler = { request in
            if request.url?.host == "100.64.0.1", request.url?.path == "/api/tailscale" {
                return StubURLProtocol.reply(request, body: tailscaleBody)
            }
            return StubURLProtocol.reply(request, status: 404, body: notFoundBody)
        }
        await store.refreshModelsAndActivity()
        XCTAssertEqual(store.activeHost?.alternateURLs, ["http://100.64.0.2:4545", "http://192.168.1.5:4545"])
        XCTAssertEqual(store.lastTailscaleInfo?.lanUrls, ["http://192.168.1.5:4545"])

        // Then the paired address stops answering; the tailnet alternate (and the LAN one) still would.
        StubURLProtocol.handler = { request in
            switch (request.url?.host, request.url?.path) {
            case ("100.64.0.1"?, _):
                throw URLError(.cannotConnectToHost)
            case (_, "/api/tailscale"?):
                return StubURLProtocol.reply(request, body: tailscaleBody)
            case (_, "/api/state"?):
                return StubURLProtocol.reply(request, headers: ["ETag": "\"r1\""], body: stateBody)
            default:
                return StubURLProtocol.reply(request, status: 404, body: notFoundBody)
            }
        }
        await store.pollOnce()

        XCTAssertEqual(store.activeHost?.id, host.id)
        XCTAssertEqual(store.activeHost?.baseURL, "http://100.64.0.2:4545")
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertEqual(store.snapshot.sessions.map(\.id), ["s1", "s2"])

        let saved = try JSONDecoder().decode(
            [HostProfile].self,
            from: try XCTUnwrap(defaults.data(forKey: AppStore.hostsDefaultsKey))
        )
        XCTAssertEqual(saved.first?.baseURL, "http://100.64.0.2:4545", "the move is persisted")

        let requests = StubURLProtocol.requests
        XCTAssertEqual(Self.stateRequests(host: "100.64.0.1").count, 1, "the paired address was polled first")
        XCTAssertTrue(
            requests.contains { $0.url?.host == "100.64.0.2" && $0.url?.path == "/api/tailscale" },
            "the tailnet alternate was probed"
        )
        XCTAssertEqual(Self.stateRequests(host: "100.64.0.2").count, 1, "the poll was retried on the new address")
        XCTAssertFalse(
            requests.contains { $0.url?.host == "192.168.1.5" },
            "the credential must never be sent over plain HTTP to the LAN address"
        )
    }
}
