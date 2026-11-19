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

    /// The companion marks a session whose worktree was removed with the ISO time (`s.worktreeRemoved=now()` in
    /// companion/workspaces.mjs); a strict `Bool?` failed the whole `/api/state` reply and emptied the dashboard.
    func testStorePollDecodesWorktreeRemovedTimestampAndSkipsBrokenSessions() throws {
        let json = """
        {
          "sx": {
            "epoch": "e1", "rev": 7,
            "top": { "projects": [], "archived": ["f:/a.jsonl"], "pinned": [], "autoShutdown": {"on": false, "since": null, "firing": false, "error": null} },
            "order": ["s1", "s2", "s3"],
            "changed": [
              { "id": "s1", "title": "Done", "cwd": "/w", "status": "done", "updatedAt": "2026-11-19T10:00:00Z",
                "isolated": true, "worktreeRemoved": "2026-11-19T10:28:17.045Z", "fileSeen": {"a": 1} },
              { "title": "No id, skipped" },
              { "id": "s3", "title": "Future", "cwd": "/w", "status": "hibernating", "tokens": 12.0,
                "todos": [{ "name": "P", "tasks": [{ "content": "x", "status": "someday" }, { "status": "pending" }] }] }
            ]
          }
        }
        """
        let poll = try JSONDecoder().decode(StatePollResponse.self, from: Data(json.utf8))
        let changed = try XCTUnwrap(poll.sx?.changed)
        XCTAssertEqual(changed.map(\.id), ["s1", "s3"])
        XCTAssertEqual(changed[0].worktreeRemoved, true)
        XCTAssertEqual(changed[1].status, .paused)
        XCTAssertEqual(changed[1].tokens, 12)
        XCTAssertEqual(changed[1].updatedAt, "")
        XCTAssertEqual(changed[1].todos?.first?.tasks.map(\.status), [.pending])

        let reducer = SyncDeltaReducer()
        let result = reducer.apply(poll: poll, viewedSessionId: nil, currentSnapshot: StoreSnapshot())
        XCTAssertEqual(result.snapshot.sessions.map(\.id), ["s1", "s3"])
        XCTAssertEqual(result.snapshot.archived, ["f:/a.jsonl"])
        XCTAssertEqual(reducer.storeToken, "e1.7")
    }

    func testDecodingFailureNamesEndpointAndField() {
        let json = #"{"sx":{"epoch":"e1","rev":"seven"}}"#
        do {
            _ = try JSONDecoder().decode(StatePollResponse.self, from: Data(json.utf8))
            XCTFail("rev must be a number")
        } catch let error as DecodingError {
            let apiError = TailscaleDiagnostic.decodingFailure(error, endpoint: "/api/state")
            XCTAssertEqual(apiError.kind, .decodingFailed)
            let message = apiError.localizedDescription
            XCTAssertTrue(message.contains("/api/state → sx.rev: expected Int"), message)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testNativeHistoryAndPreviewDecodeLeniently() throws {
        let list = """
        {"dir": "/s", "sessions": [
          {"file": "/s/a.jsonl", "title": "A", "id": "u1", "updatedAt": "2026-11-19T10:00:00Z", "size": 1024.0},
          {"title": "no file"},
          {"file": "/s/b.jsonl", "named": "yes", "updatedAt": null}
        ]}
        """
        let res = try JSONDecoder().decode(NativeSessionsResponse.self, from: Data(list.utf8))
        XCTAssertEqual(res.sessions.map(\.file), ["/s/a.jsonl", "/s/b.jsonl"])
        XCTAssertEqual(res.sessions[0].size, 1024)
        XCTAssertEqual(res.sessions[1].named, true)

        let preview = """
        {"file": "/s/a.jsonl", "reasoning": "high", "contextTokens": 1200, "messages": [
          {"id": "t1", "role": "tool", "text": "Done · bash  {}", "tool": {"name": "bash", "args": {"command": "ls"}, "status": "done", "ms": 812.4}},
          {"role": "user", "text": "no id"}
        ]}
        """
        let pv = try JSONDecoder().decode(NativeSessionPreview.self, from: Data(preview.utf8))
        XCTAssertEqual(pv.messages.map(\.id), ["t1"])
        XCTAssertEqual(pv.messages[0].tool?.ms, 812)
        XCTAssertEqual(ToolCallSummary(tool: try XCTUnwrap(pv.messages[0].tool)).primary, "ls")
    }

    func testToolCallSummaryReadsCommandsPathsAndClippedArguments() {
        let bash = ToolCallSummary(tool: ToolRecord(
            name: "bash",
            args: "{\n \"command\": \"cd ios && grep -rn \\\"decodingFailed\\\" .\",\n \"timeout\": 30\n}",
            status: "done",
            ms: 4200
        ))
        XCTAssertEqual(bash.kind, .command)
        XCTAssertEqual(bash.primary, #"cd ios && grep -rn "decodingFailed" ."#)
        XCTAssertEqual(bash.arguments.map(\.key), ["timeout"])
        XCTAssertEqual(bash.durationLabel, "4.2 s")
        XCTAssertEqual(bash.accessibilityLabel, #"bash command: cd ios && grep -rn "decodingFailed" ., Done, 4.2 s"#)

        let read = ToolCallSummary(tool: ToolRecord(
            name: "read",
            args: #"{"path": "ios/OMPCompanionKit/Sources/OMPCompanionKit/Networking/CompanionClient.swift"}"#,
            status: "running"
        ))
        XCTAssertEqual(read.kind, .path)
        XCTAssertEqual(read.primaryShort, "…/OMPCompanionKit/Networking/CompanionClient.swift")
        XCTAssertEqual(read.status, .running)

        // Clipped at 6,000 chars by the companion: invalid JSON, the command is still recovered.
        let clipped = ToolCallSummary(tool: ToolRecord(name: "bash", args: "{\n \"command\": \"echo \\\"hi\\\" && cat lo", status: "error"))
        XCTAssertEqual(clipped.primary, #"echo "hi" && cat lo"#)
        XCTAssertEqual(clipped.status, .error)
    }

    func testSyncReducerToleratesRepeatedSessionIDs() throws {
        let json = """
        {"sx": {"epoch": "e", "rev": 1, "order": ["s1", "s1", "s2"],
          "changed": [{"id": "s1", "title": "a"}, {"id": "s1", "title": "b"}, {"id": "s2", "title": "c"}]}}
        """
        let poll = try JSONDecoder().decode(StatePollResponse.self, from: Data(json.utf8))
        let reducer = SyncDeltaReducer()
        let first = reducer.apply(poll: poll, viewedSessionId: nil, currentSnapshot: StoreSnapshot())
        XCTAssertEqual(first.snapshot.sessions.map(\.title), ["b", "c"])
        let second = reducer.apply(poll: poll, viewedSessionId: nil, currentSnapshot: first.snapshot)
        XCTAssertEqual(second.snapshot.sessions.map(\.id), ["s1", "s2"])
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
        let (text, math) = MarkdownParser.extractInlineMath(in: "Value $x^2 + \\alpha$ costs $5 and $10")
        XCTAssertEqual(math, ["x² + α"])
        XCTAssertTrue(text.hasSuffix("costs $5 and $10"))
    }

    func testTeXUnicodeDoesNotSplitCommandNames() {
        // `\left` must not be read as `\le` + "ft" (the reported iOS bug).
        XCTAssertEqual(
            TeXUnicode.convert(#"\mathcal L^{-1}\left\{\dfrac{1}{s(s^2+4)}\right\}=\tfrac14-\tfrac14\cos 2t"#),
            "ℒ⁻¹{1/(s(s²+4))} = ¼ − ¼ cos 2t"
        )
        XCTAssertEqual(TeXUnicode.convert(#"y(\pi^-)=1\ \text{and}\ t\ge\pi"#), "y(π⁻) = 1 and t ≥ π")
        XCTAssertEqual(
            TeXUnicode.convert(#"\begin{cases}1, & t<\pi\\ 0, & t\ge\pi\end{cases}"#),
            "⎧ 1,\u{2003}t < π\n⎩ 0,\u{2003}t ≥ π"
        )
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
    // MARK: - Sidebar Layout, Search Scope, Usage Formatting & Session Attention

    func testSidebarPathNormalizationAndCollapsedMatching() {
        XCTAssertEqual(
            SidebarLayoutHelper.normalizePathKey("C:/Users/Valo/Repo"),
            "c:\\users\\valo\\repo"
        )
        XCTAssertTrue(SidebarLayoutHelper.isCollapsedMatch("@attention", groupKey: "@attention"))
        XCTAssertFalse(SidebarLayoutHelper.isCollapsedMatch("@attention", groupKey: "/repo"))
        XCTAssertTrue(SidebarLayoutHelper.isCollapsedMatch("c:\\Users\\Valo\\Repo", groupKey: "C:/users/valo/repo"))
        XCTAssertTrue(SidebarLayoutHelper.isCollapsedMatch("proj-uuid-1", groupKey: "C:\\Repo", legacyProjectID: "proj-uuid-1"))
    }

    func testSidebarReconcileGroupOrderAndMoveGroup() {
        let p1 = WorkspaceProject(id: "id-1", name: "Alpha", path: "C:\\Work\\Alpha")
        let p2 = WorkspaceProject(id: "id-2", name: "Beta", path: "C:\\Work\\Beta")
        let p3 = WorkspaceProject(id: "id-3", name: "Gamma", path: "C:\\Work\\Gamma")

        let reconciled = SidebarLayoutHelper.reconcileGroupOrder(
            saved: ["id-2", "C:\\Work\\Dead"],
            visibleKeys: [p1.path, p2.path, p3.path],
            presentNormalizedKeys: [
                SidebarLayoutHelper.normalizePathKey(p1.path),
                SidebarLayoutHelper.normalizePathKey(p2.path),
                SidebarLayoutHelper.normalizePathKey(p3.path)
            ],
            projects: [p1, p2, p3],
            allowPrune: true
        )
        XCTAssertTrue(reconciled.didChange)
        XCTAssertEqual(reconciled.order, [p1.path, p3.path, p2.path])

        let ordered = SidebarLayoutHelper.orderedProjects(projects: [p1, p2, p3], groupOrder: reconciled.order)
        XCTAssertEqual(ordered.map(\.id), ["id-1", "id-3", "id-2"])

        let movedBottom = SidebarLayoutHelper.moveGroup(
            key: p1.path,
            beforeKey: nil,
            currentOrder: reconciled.order,
            visibleKeys: [p1.path, p2.path, p3.path]
        )
        XCTAssertEqual(movedBottom, [p3.path, p2.path, p1.path])

        let movedBefore = SidebarLayoutHelper.moveGroup(
            key: p1.path,
            beforeKey: p2.path,
            currentOrder: movedBottom,
            visibleKeys: [p1.path, p2.path, p3.path]
        )
        XCTAssertEqual(movedBefore, [p3.path, p1.path, p2.path])
    }

    func testParsedSidebarSearchWithInScope() {
        let parsed = ParsedSidebarSearch(query: "in:companion usage")
        XCTAssertEqual(parsed.scopes, ["companion"])
        XCTAssertEqual(parsed.terms, ["usage"])
        XCTAssertTrue(parsed.matches(title: "Add usage %", cwd: "C:\\src\\omp-companion", folderName: "omp-companion"))
        XCTAssertFalse(parsed.matches(title: "Add usage %", cwd: "C:\\src\\other", folderName: "other"))
    }

    func testUsageFormattingMatchesWebRules() {
        XCTAssertEqual(UsageFormatting.percentage(fraction: 0.424), 42)
        XCTAssertEqual(UsageFormatting.percentage(fraction: -0.15), 0)
        XCTAssertEqual(UsageFormatting.percentage(fraction: 1.05), 105)
        XCTAssertNil(UsageFormatting.percentage(fraction: nil))

        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(UsageFormatting.resetLabel(resetsAtMs: (now.timeIntervalSince1970 - 5) * 1000, fallback: nil, now: now), "resetting")
        XCTAssertEqual(UsageFormatting.resetLabel(resetsAtMs: (now.timeIntervalSince1970 + 192 * 60) * 1000, fallback: nil, now: now), "resets in 3h 12m")
        XCTAssertEqual(UsageFormatting.resetLabel(resetsAtMs: (now.timeIntervalSince1970 + 15 * 60) * 1000, fallback: nil, now: now), "resets in 15m")
        let futureDay = UsageFormatting.resetLabel(resetsAtMs: (now.timeIntervalSince1970 + 36 * 3600) * 1000, fallback: nil, now: now)
        XCTAssertTrue(futureDay?.hasPrefix("Resets ") == true)
        XCTAssertEqual(UsageFormatting.unavailableMessage("Quota fetch timed out"), "Remaining quota unavailable: Quota fetch timed out.")
    }

    func testSessionSummaryTaskAndAttentionFlags() throws {
        let json = """
        {
          "id": "s_task",
          "title": "Compact",
          "cwd": "/w",
          "status": "paused",
          "updatedAt": "2026-11-19T10:00:00Z",
          "_task": "Compacting context…"
        }
        """
        let s = try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
        XCTAssertTrue(s.isWorking)
        XCTAssertFalse(s.needsAttention)

        let reviewJson = """
        {
          "id": "s_rev",
          "title": "Ready",
          "cwd": "/w",
          "status": "review",
          "updatedAt": "2026-11-19T10:00:00Z"
        }
        """
        let rev = try JSONDecoder().decode(SessionSummary.self, from: Data(reviewJson.utf8))
        XCTAssertFalse(rev.isWorking)
        XCTAssertTrue(rev.needsAttention)
    }

    // MARK: - KaTeX Math Rendering, Formula Fences, Edge Cases & Math Scale

    func testMarkdownParserMathFencesAndStreamingGuards() {
        let md = """
        ```math
        \\int_0^\\infty e^{-st} dt = \\frac{1}{s}
        ```

        ```latex
        \\documentclass{article}
        \\begin{document}
        Hello
        \\end{document}
        ```

        ```latex
        \\boxed{y(t) = 1 - \\cos t}
        ```

        $$   $$

        $$
        unclosed while streaming
        """
        let blocks = MarkdownParser.parse(md)
        XCTAssertTrue(blocks.contains(where: {
            if case .mathBlock(_, let tex) = $0 { return tex.contains("\\int_0^\\infty") }
            return false
        }))
        XCTAssertTrue(blocks.contains(where: {
            if case .codeBlock(_, "latex", let code) = $0 { return code.contains("\\documentclass") }
            return false
        }))
        XCTAssertTrue(blocks.contains(where: {
            if case .mathBlock(_, let tex) = $0 { return tex == "\\boxed{y(t) = 1 - \\cos t}" }
            return false
        }))
        // Empty `$$   $$` must not emit a mathBlock, and unclosed `$$` must remain a paragraph while streaming
        XCTAssertFalse(blocks.contains(where: {
            if case .mathBlock(_, let tex) = $0 { return tex.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            return false
        }))
        XCTAssertTrue(blocks.contains(where: {
            if case .paragraph(_, let text) = $0 { return text.contains("unclosed while streaming") }
            return false
        }))
    }

    func testMarkdownParserUnclosedFenceStaysCodeBlock() {
        let streaming = """
        ```math
        f(t) = t^2
        """
        let blocks = MarkdownParser.parse(streaming)
        XCTAssertEqual(blocks.count, 1)
        if case .codeBlock(_, "math", let code) = blocks[0] {
            XCTAssertEqual(code, "f(t) = t^2")
        } else {
            XCTFail("Expected unclosed math fence to remain a codeBlock during streaming")
        }
    }

    func testMarkdownTablePreservesPipesInsideInlineMath() {
        let table = """
        | Expr | Value |
        | --- | --- |
        | $|x| + \\alpha | \\beta$ | $1$ |
        """
        let blocks = MarkdownParser.parse(table)
        guard case .table(_, let headers, let rows) = blocks.first else {
            return XCTFail("Expected table block")
        }
        XCTAssertEqual(headers, ["Expr", "Value"])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].count, 2)
        XCTAssertEqual(rows[0][0], "$|x| + \\alpha | \\beta$")
        XCTAssertEqual(rows[0][1], "$1$")
    }

    func testContainsMathAndRenderInlineHTMLEdgeCases() {
        XCTAssertFalse(MarkdownParser.containsMath("This costs $5 and $10 today"))
        XCTAssertFalse(MarkdownParser.containsMath("Escaped \\$5 stays prose"))
        XCTAssertFalse(MarkdownParser.containsMath("Code span `$x^2$` stays code"))
        XCTAssertFalse(MarkdownParser.containsMath("Empty $$ $$ is ignored"))
        XCTAssertTrue(MarkdownParser.containsMath("Let $u = s + 1$ and \\(G = \\frac{1}{s}\\)"))

        let html = MarkdownParser.renderInlineHTML("Let $u = s + 1$ with **bold** and `$code$` and \\$5 & <tag>")
        XCTAssertTrue(html.contains("<span class=\"omp-math\" data-display=\"0\" data-tex=\"u = s + 1\"></span>"))
        XCTAssertTrue(html.contains("<strong>bold</strong>"))
        XCTAssertTrue(html.contains("<code class=\"omp-code\">$code$</code>"))
        XCTAssertTrue(html.contains("$5 &amp; &lt;tag&gt;"))
    }

    func testKaTeXMathScaleClampingAndRounding() {
        XCTAssertEqual(KaTeXMathScale.clampAndRound(50), 80)
        XCTAssertEqual(KaTeXMathScale.clampAndRound(250), 200)
        XCTAssertEqual(KaTeXMathScale.clampAndRound(112.4), 110)
        XCTAssertEqual(KaTeXMathScale.clampAndRound(113.0), 115)
        XCTAssertEqual(KaTeXMathScale.factor(percent: 150), 1.5, accuracy: 0.0001)
    }

    func testKaTeXValidatorFormulaFencesAndLimits() {
        XCTAssertTrue(KaTeXValidator.isFormula(code: #"\frac{1}{s}"#, language: "math"))
        XCTAssertTrue(KaTeXValidator.isFormula(code: #"y = x^2"#, language: "TeX"))
        XCTAssertFalse(KaTeXValidator.isFormula(code: #"\documentclass{article}"#, language: "latex"))
        XCTAssertFalse(KaTeXValidator.isFormula(code: #"\usepackage{amsmath}"#, language: "tex"))
        XCTAssertFalse(KaTeXValidator.isFormula(code: #"\begin{document}hi\end{document}"#, language: "latex"))
        XCTAssertFalse(KaTeXValidator.isFormula(code: "   \n  ", language: "math"))
        XCTAssertFalse(KaTeXValidator.isFormula(code: "let x = 1", language: "swift"))
        XCTAssertFalse(KaTeXValidator.isFormula(code: String(repeating: "x", count: 20_001), language: "latex"))
    }

    func testRenderInlineHTMLDisplayMathLinksAndColors() {
        let html = MarkdownParser.renderInlineHTML(#"See [proof $x^2$](https://example.com) and \[\frac{a}{b}\] and $$c+d$$"#)
        XCTAssertTrue(html.contains("<a href=\"https://example.com\">proof <span class=\"omp-math\" data-display=\"0\" data-tex=\"x^2\"></span></a>"))
        XCTAssertTrue(html.contains("<span class=\"omp-math\" data-display=\"1\" data-tex=\"\\frac{a}{b}\"></span>"))
        XCTAssertTrue(html.contains("<span class=\"omp-math\" data-display=\"1\" data-tex=\"c+d\"></span>"))

        let rgba = Color.white.opacity(0.6).cssRGBAString
        XCTAssertFalse(rgba.contains("0,6"))
        XCTAssertTrue(rgba.hasPrefix("rgba("))
    }
}
