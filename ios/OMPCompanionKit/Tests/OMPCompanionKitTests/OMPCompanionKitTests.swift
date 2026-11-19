import XCTest
@testable import OMPCompanionKit

final class OMPCompanionKitTests: XCTestCase {

    // MARK: - Tailscale URL Normalization, Classification & Pairing Payloads

    func testHostProfileNormalizesTailscaleEndpoints() {
        XCTAssertEqual(
            HostProfile.normalizeBaseURL("workstation.tail1234.ts.net"),
            "http://workstation.tail1234.ts.net:4545"
        )
        XCTAssertEqual(
            HostProfile.normalizeBaseURL("https://workstation.tail1234.ts.net/"),
            "https://workstation.tail1234.ts.net"
        )
        XCTAssertEqual(
            HostProfile.normalizeBaseURL("100.114.117.34:4545/#token=secret123"),
            "http://100.114.117.34:4545"
        )
        XCTAssertEqual(
            HostProfile.normalizeBaseURL("fd7a:115c:a1e0::1234"),
            "http://[fd7a:115c:a1e0::1234]:4545"
        )
    }

    func testHostProfileClassifiesTailscaleRanges() {
        XCTAssertTrue(HostProfile.isTailscaleIPv4("100.64.0.1"))
        XCTAssertTrue(HostProfile.isTailscaleIPv4("100.127.255.254"))
        XCTAssertFalse(HostProfile.isTailscaleIPv4("100.63.255.254"))
        XCTAssertFalse(HostProfile.isTailscaleIPv4("192.168.1.10"))

        XCTAssertTrue(HostProfile.isTailscaleIPv6("fd7a:115c:a1e0::42"))
        XCTAssertFalse(HostProfile.isTailscaleIPv6("fe80::1"))

        XCTAssertTrue(HostProfile.isMagicDNS("desktop.tail99f.ts.net"))
        XCTAssertFalse(HostProfile.isMagicDNS("ts.net"))

        XCTAssertEqual(HostProfile.classifyURL("https://desktop.tail99f.ts.net"), .tailscaleServeHTTPS)
        XCTAssertEqual(HostProfile.classifyURL("http://desktop.tail99f.ts.net:4545"), .tailscaleMagicDNS)
        XCTAssertEqual(HostProfile.classifyURL("http://100.101.102.103:4545"), .tailscaleIPv4)
        XCTAssertEqual(HostProfile.classifyURL("http://[fd7a:115c:a1e0::1]:4545"), .tailscaleIPv6)
        XCTAssertEqual(HostProfile.classifyURL("http://127.0.0.1:4545"), .loopback)
    }

    func testPairingPayloadParsing() {
        let deepLink = PairingPayload.parse("omp://connect?url=http%3A%2F%2Fpc.tail1234.ts.net%3A4545&name=WorkPC&token=tok_abc123")
        XCTAssertEqual(deepLink?.baseURL, "http://pc.tail1234.ts.net:4545")
        XCTAssertEqual(deepLink?.name, "WorkPC")
        XCTAssertEqual(deepLink?.token, "tok_abc123")
        XCTAssertEqual(deepLink?.authKind, .connectionToken)

        let jsonQR = PairingPayload.parse(#"{"url":"https://macbook.tail1234.ts.net","password":"hunter2","name":"MacBook"}"#)
        XCTAssertEqual(jsonQR?.baseURL, "https://macbook.tail1234.ts.net")
        XCTAssertEqual(jsonQR?.token, "hunter2")
        XCTAssertEqual(jsonQR?.name, "MacBook")
        XCTAssertEqual(jsonQR?.authKind, .remotePassword)

        let hashURL = PairingPayload.parse("http://100.80.10.2:4545/#token=hash_tok_99")
        XCTAssertEqual(hashURL?.baseURL, "http://100.80.10.2:4545")
        XCTAssertEqual(hashURL?.token, "hash_tok_99")
        XCTAssertEqual(hashURL?.authKind, .connectionToken)
    }

    // MARK: - Tailscale & HTTP Diagnostics

    func testTailscaleDiagnosticHTTPClassification() {
        XCTAssertEqual(TailscaleDiagnostic.classifyHTTP(status: 401, message: "Wrong password.").kind, .wrongPassword)
        XCTAssertEqual(TailscaleDiagnostic.classifyHTTP(status: 401, message: "Invalid connection token.").kind, .invalidToken)
        XCTAssertEqual(TailscaleDiagnostic.classifyHTTP(status: 403, message: "Invalid Host header.").kind, .hostHeaderRejected)
        XCTAssertEqual(TailscaleDiagnostic.classifyHTTP(status: 403, message: "Origin not allowed.").kind, .originRejected)
        XCTAssertEqual(
            TailscaleDiagnostic.classifyHTTP(status: 413, message: "Request body too large (48 MB max)").kind,
            .payloadTooLarge(limitLabel: "48 MB")
        )
        XCTAssertEqual(
            TailscaleDiagnostic.classifyHTTP(status: 413, message: "Request body too large.").kind,
            .payloadTooLarge(limitLabel: "256 KB")
        )
        XCTAssertEqual(
            TailscaleDiagnostic.classifyHTTP(status: 503, message: "Server closing for restart").kind,
            .companionRestarting
        )
    }

    func testTailscaleDiagnosticTransportClassification() {
        let host = HostProfile(name: "PC", baseURL: "http://pc.tail1234.ts.net:4545")
        let timeoutErr = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        XCTAssertEqual(
            TailscaleDiagnostic.classifyTransport(timeoutErr, host: host).kind,
            .tailscaleInactiveOrUnreachable
        )

        let tlsErr = NSError(domain: NSURLErrorDomain, code: NSURLErrorAppTransportSecurityRequiresSecureConnection)
        XCTAssertEqual(
            TailscaleDiagnostic.classifyTransport(tlsErr, host: host).kind,
            .atsOrTlsMismatch
        )
    }

    // MARK: - Wire Models & SyncDeltaReducer

    func testWireModelsFlexibleDecoding() throws {
        let json = """
        {
          "id": "s1",
          "title": "Fix Sync",
          "cwd": "/repo",
          "status": "running",
          "updatedAt": "2026-11-19T00:00:00Z",
          "messages": [
            {
              "id": "m1",
              "role": "user",
              "text": "steer me",
              "imagePreview": "data:image/jpeg;base64,AAAA",
              "steer": "dropped"
            }
          ]
        }
        """
        let session = try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
        XCTAssertEqual(session.id, "s1")
        XCTAssertEqual(session.status, .running)
        XCTAssertEqual(session.messages?.first?.steer, .dropped)
        XCTAssertEqual(session.messages?.first?.imagePreview, ["data:image/jpeg;base64,AAAA"])

        let autoShutdownStr = try JSONDecoder().decode(
            AutoShutdownState.self,
            from: Data(#"{"on":true,"error":"Power off blocked"}"#.utf8)
        )
        XCTAssertTrue(autoShutdownStr.on)
        XCTAssertEqual(autoShutdownStr.error?.message, "Power off blocked")
    }

    func testSyncDeltaOrderEditAndIncrementalSync() throws {
        let edited = SyncDeltaReducer.applyOrderEdit(
            currentOrder: ["m0", "m1", "m2", "m3"],
            edit: OrderEdit(drop: 1, at: 1, del: 1, add: ["m2b", "m4"], n: 4)
        )
        XCTAssertEqual(edited, ["m1", "m2b", "m3", "m4"])

        let invalid = SyncDeltaReducer.applyOrderEdit(
            currentOrder: ["m0", "m1"],
            edit: OrderEdit(drop: 0, at: 0, del: 0, add: ["m2"], n: 99)
        )
        XCTAssertNil(invalid)

        let reducer = SyncDeltaReducer()
        let poll1JSON = """
        {
          "sx": {
            "epoch": "e1",
            "rev": 1,
            "top": { "projects": [], "archived": [], "pinned": [] },
            "order": ["s1"],
            "changed": [{
              "id": "s1",
              "title": "Test Session",
              "cwd": "/repo",
              "status": "running",
              "updatedAt": "2026-11-19T00:00:00Z"
            }]
          },
          "tx": {
            "session": "s1",
            "epoch": "t1",
            "rev": 1,
            "messages": [
              { "id": "m1", "role": "user", "text": "hi" },
              { "id": "m2", "role": "assistant", "text": "hello" }
            ]
          }
        }
        """
        let poll1 = try JSONDecoder().decode(StatePollResponse.self, from: Data(poll1JSON.utf8))
        let res1 = reducer.apply(poll: poll1, viewedSessionId: "s1", currentSnapshot: StoreSnapshot())
        XCTAssertFalse(res1.needsFullTranscriptRetry)
        XCTAssertEqual(reducer.storeToken, "e1.1")
        XCTAssertEqual(reducer.sinceToken(for: "s1"), "t1.1")
        XCTAssertEqual(res1.snapshot.sessions.first?.messages?.map(\.text), ["hi", "hello"])

        let poll2JSON = """
        {
          "tx": {
            "session": "s1",
            "epoch": "t1",
            "rev": 2,
            "orderEdit": { "drop": 0, "at": 1, "del": 1, "add": ["m2", "m3"], "n": 3 },
            "changed": [
              { "id": "m2", "role": "assistant", "text": "hello world" },
              { "id": "m3", "role": "system", "text": "notice" }
            ]
          }
        }
        """
        let poll2 = try JSONDecoder().decode(StatePollResponse.self, from: Data(poll2JSON.utf8))
        let res2 = reducer.apply(poll: poll2, viewedSessionId: "s1", currentSnapshot: res1.snapshot)
        XCTAssertFalse(res2.needsFullTranscriptRetry)
        XCTAssertEqual(res2.snapshot.sessions.first?.messages?.map(\.text), ["hi", "hello world", "notice"])
    }

    // MARK: - Rendering, Diffs, SGR, Images & Screen Patches

    func testSGRParserStripsAndParsesColors() {
        let raw = "\u{1B}[1;32mPASS\u{1B}[0m \u{1B}[38;5;196mERR\u{1B}[0m"
        XCTAssertEqual(SGRParser.stripANSI(raw), "PASS ERR")
        let spans = SGRParser.parse(raw)
        XCTAssertTrue(spans.contains(where: { $0.text == "PASS" && $0.bold }))
        XCTAssertTrue(spans.contains(where: { $0.text == "ERR" && $0.foreground != nil }))
    }

    func testDiffParserHandlesOMPNumberedAndUnifiedDiffs() {
        let ompDiff = " 10|let a = 1\n-11|let b = 2\n+11|let b = 3\n+12|let c = 4"
        let rows = DiffParser.parse(ompDiff)
        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(rows[0].kind, .context)
        XCTAssertEqual(rows[1].kind, .delete)
        XCTAssertEqual(rows[2].kind, .add)
        XCTAssertEqual(rows[2].lineNumber, "11")
        XCTAssertEqual(DiffParser.stats(for: ompDiff), DiffStats(additions: 2, deletions: 1))
    }

    func testMarkdownParserBlocksAndInlineMath() {
        let md = """
        # Title

        Inline math $x^2 + \\alpha$ and \\(a/b\\).

        ```swift
        let x = 42
        ```
        """
        let blocks = MarkdownParser.parse(md)
        XCTAssertTrue(blocks.contains(where: {
            if case .heading(_, 1, "Title") = $0 { return true }
            return false
        }))
        XCTAssertTrue(blocks.contains(where: {
            if case .codeBlock(_, "swift", let code) = $0 { return code.contains("let x = 42") }
            return false
        }))
        let mathFormatted = MarkdownParser.replaceInlineMath(in: "Value $x^2 + \\alpha$")
        XCTAssertTrue(mathFormatted.contains("α"))
        XCTAssertTrue(mathFormatted.contains("²"))
    }

    func testImageTokenEstimationMatchesCompanionFormula() {
        XCTAssertEqual(ImageAttachmentProcessor.estimateTokens(width: 1000, height: 1000), 1334)
        XCTAssertEqual(ImageAttachmentProcessor.estimateTokens(width: 4000, height: 3000), 1534)
    }

    func testScreenBinaryPatchHeaderDecoding() {
        var bytes: [UInt8] = [1]
        func appendU16LE(_ v: UInt16) {
            bytes.append(UInt8(v & 0xFF))
            bytes.append(UInt8((v >> 8) & 0xFF))
        }
        appendU16LE(10)
        appendU16LE(20)
        appendU16LE(320)
        appendU16LE(240)
        appendU16LE(1920)
        appendU16LE(1080)
        bytes.append(contentsOf: [0xFF, 0xD8, 0xFF, 0xE0])

        let patch = ScreenSocketClient.decodeBinaryPatch(Data(bytes))
        XCTAssertEqual(patch?.x, 10)
        XCTAssertEqual(patch?.y, 20)
        XCTAssertEqual(patch?.width, 320)
        XCTAssertEqual(patch?.height, 240)
        XCTAssertEqual(patch?.frameWidth, 1920)
        XCTAssertEqual(patch?.frameHeight, 1080)
        XCTAssertEqual(patch?.jpegData, Data([0xFF, 0xD8, 0xFF, 0xE0]))
    }

    func testInMemoryCredentialStoreLifecycle() throws {
        let store = InMemoryCredentialStore()
        let id = UUID()
        XCTAssertNil(try store.loadSecret(for: id))
        try store.saveSecret("tok_secret", for: id)
        XCTAssertEqual(try store.loadSecret(for: id), "tok_secret")
        try store.deleteSecret(for: id)
        XCTAssertNil(try store.loadSecret(for: id))
    }
}
