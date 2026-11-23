import Foundation

public enum PollResult<Value: Sendable>: Sendable {
    case notModified
    case updated(Value, etag: String?)
}

public struct CompanionClient: Sendable {
    public static let smallBodyLimit = 256 * 1024
    public static let largeBodyLimit = 48 * 1024 * 1024

    public let host: HostProfile
    private let token: String
    public let session: URLSession
    private let decoder: JSONDecoder

    public init(host: HostProfile, token: String, session: URLSession? = nil) {
        self.host = host
        self.token = token
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.waitsForConnectivity = false
            config.httpShouldSetCookies = false
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 180
            self.session = URLSession(configuration: config)
        }
        self.decoder = JSONDecoder()
    }

    public static func defaultURLSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 180
        return URLSession(configuration: config)
    }

    // MARK: - Core Request Transport

    private func makeURL(path: String, query: [URLQueryItem] = []) throws -> URL {
        let base = HostProfile.normalizeBaseURL(host.baseURL)
        guard !base.isEmpty, var comps = URLComponents(string: base) else {
            throw CompanionAPIError(kind: .invalidURL)
        }
        let basePath = comps.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let cleanPath = path.hasPrefix("/") ? path : "/\(path)"
        comps.path = basePath.isEmpty ? cleanPath : "/\(basePath)\(cleanPath)"
        if !query.isEmpty {
            comps.queryItems = query
        }
        guard let url = comps.url else {
            throw CompanionAPIError(kind: .invalidURL)
        }
        return url
    }

    private static func isLargeUploadPath(_ path: String) -> Bool {
        if path == "/api/quick-start" || path == "/api/omp-sessions/resume" || path == "/api/enhance" || path == "/api/draft" {
            return true
        }
        if path.hasPrefix("/api/sessions/") && path.hasSuffix("/command") {
            return true
        }
        return false
    }

    private func buildRequest(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        bodyData: Data? = nil,
        etag: String? = nil,
        timeout: TimeInterval = 30
    ) throws -> URLRequest {
        let url = try makeURL(path: path, query: query)
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("gzip, deflate", forHTTPHeaderField: "Accept-Encoding")
        req.setValue(nil, forHTTPHeaderField: "Origin")
        if let etag, !etag.isEmpty {
            req.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        if let bodyData {
            let cap = Self.isLargeUploadPath(path) ? Self.largeBodyLimit : Self.smallBodyLimit
            if bodyData.count > cap {
                let label = cap > Self.smallBodyLimit ? "48 MB" : "256 KB"
                throw CompanionAPIError(
                    kind: .payloadTooLarge(limitLabel: label),
                    statusCode: 413,
                    serverMessage: cap > Self.smallBodyLimit
                        ? "This message is too large to upload: text and attachments together must stay under 48 MB. Remove some images or PDFs and try again."
                        : "Request body exceeds the \(label) limit."
                )
            }
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = bodyData
        }
        return req
    }

    private func sendRaw(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        bodyData: Data? = nil,
        etag: String? = nil,
        timeout: TimeInterval = 30
    ) async throws -> (Data, HTTPURLResponse) {
        let req = try buildRequest(method: method, path: path, query: query, bodyData: bodyData, etag: etag, timeout: timeout)
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else {
                throw CompanionAPIError(kind: .unknown, serverMessage: "Non-HTTP response.")
            }
            if http.statusCode == 304 {
                return (Data(), http)
            }
            guard (200...299).contains(http.statusCode) else {
                let errMsg = (try? decoder.decode(APIErrorBody.self, from: data).error)
                    ?? String(data: data, encoding: .utf8)
                throw TailscaleDiagnostic.classifyHTTP(status: http.statusCode, message: errMsg, url: req.url?.absoluteString)
            }
            return (data, http)
        } catch {
            throw TailscaleDiagnostic.classifyTransport(error, host: host)
        }
    }

    /// Decodes a reply, naming the endpoint and failing field when the JSON does not match the wire model.
    private func decode<T: Decodable>(_ type: T.Type, from data: Data, path: String) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch let error as DecodingError {
            throw TailscaleDiagnostic.decodingFailure(error, endpoint: path)
        } catch {
            throw TailscaleDiagnostic.classifyTransport(error, host: host)
        }
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval = 30) async throws -> T {
        let (data, _) = try await sendRaw(method: "GET", path: path, query: query, timeout: timeout)
        return try decode(T.self, from: data, path: path)
    }

    private func getTagged<T: Decodable & Sendable>(
        _ path: String,
        query: [URLQueryItem] = [],
        etag: String? = nil,
        timeout: TimeInterval = 30
    ) async throws -> PollResult<T> {
        let (data, http) = try await sendRaw(method: "GET", path: path, query: query, etag: etag, timeout: timeout)
        if http.statusCode == 304 {
            return .notModified
        }
        let nextEtag = http.value(forHTTPHeaderField: "ETag")
        return .updated(try decode(T.self, from: data, path: path), etag: nextEtag)
    }

    private func post<T: Decodable>(_ path: String, jsonObject: [String: Any], query: [URLQueryItem] = [], timeout: TimeInterval = 45) async throws -> T {
        let bodyData = try JSONSerialization.data(withJSONObject: jsonObject, options: [])
        let (data, _) = try await sendRaw(method: "POST", path: path, query: query, bodyData: bodyData, timeout: timeout)
        return try decode(T.self, from: data, path: path)
    }

    private func postRaw(_ path: String, jsonObject: [String: Any], query: [URLQueryItem] = [], timeout: TimeInterval = 45) async throws -> Data {
        let bodyData = try JSONSerialization.data(withJSONObject: jsonObject, options: [])
        let (data, _) = try await sendRaw(method: "POST", path: path, query: query, bodyData: bodyData, timeout: timeout)
        return data
    }

    /// Uploads a video file as raw bytes (`POST /api/video?name=`), streamed from disk with progress (0...1). The host
    /// stores it under its data folder and answers the line that names it for the agent (`ref`), which the composer adds.
    /// Own session: a large video over a slow link outlasts the shared session's 180 s resource timeout.
    public func uploadVideo(
        fileURL: URL,
        name: String,
        mimeType: String,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> VideoUploadResponse {
        let path = "/api/video"
        var req = try buildRequest(method: "POST", path: path, query: [URLQueryItem(name: "name", value: name)], timeout: 120)
        req.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 3600
        let uploader = URLSession(configuration: config)
        defer { uploader.finishTasksAndInvalidate() }
        do {
            let (data, response) = try await uploader.upload(for: req, fromFile: fileURL, delegate: UploadProgressDelegate(progress))
            guard let http = response as? HTTPURLResponse else {
                throw CompanionAPIError(kind: .unknown, serverMessage: "Non-HTTP response.")
            }
            guard (200...299).contains(http.statusCode) else {
                let errMsg = (try? decoder.decode(APIErrorBody.self, from: data).error)
                    ?? String(data: data, encoding: .utf8)
                throw TailscaleDiagnostic.classifyHTTP(status: http.statusCode, message: errMsg, url: req.url?.absoluteString)
            }
            return try decode(VideoUploadResponse.self, from: data, path: path)
        } catch {
            throw TailscaleDiagnostic.classifyTransport(error, host: host)
        }
    }

    // MARK: - State, Polling & Tailscale Diagnostics

    /// The host's activity log alone (`GET /api/state` without `?session` would also send every transcript).
    public func fetchActivity() async throws -> ActivityResponse {
        try await get("/api/activity", timeout: 20)
    }

    public func fetchState(
        sessionId: String?,
        since: String?,
        storeToken: String?,
        orderDelta: Bool = true,
        etag: String? = nil
    ) async throws -> PollResult<StatePollResponse> {
        var items: [URLQueryItem] = [
            URLQueryItem(name: "session", value: sessionId ?? ""),
        ]
        if let sessionId, !sessionId.isEmpty {
            items.append(URLQueryItem(name: "since", value: since ?? ""))
        }
        if orderDelta {
            items.append(URLQueryItem(name: "od", value: "1"))
        }
        items.append(URLQueryItem(name: "store", value: storeToken ?? ""))
        return try await getTagged("/api/state", query: items, etag: etag, timeout: 25)
    }

    public func fetchTailscaleInfo() async throws -> TailscaleInfoResponse {
        try await get("/api/tailscale", timeout: 10)
    }

    public func probeReachability() async throws -> Int {
        let start = CFAbsoluteTimeGetCurrent()
        let _: TailscaleInfoResponse = try await get("/api/tailscale", timeout: 8)
        return max(1, Int((CFAbsoluteTimeGetCurrent() - start) * 1000))
    }

    // MARK: - Models, Commands, Usage & Drafts

    public func fetchModels() async throws -> ModelsResponse {
        try await get("/api/models", timeout: 65)
    }

    public func fetchCommands(sessionId: String) async throws -> CommandsResponse {
        try await get("/api/commands", query: [URLQueryItem(name: "session", value: sessionId)], timeout: 45)
    }

    public func fetchCommands(path: String) async throws -> CommandsResponse {
        try await get("/api/commands", query: [URLQueryItem(name: "path", value: path)], timeout: 45)
    }

    public func fetchUsage(sessionId: String) async throws -> ProviderUsageResponse {
        try await get("/api/usage", query: [URLQueryItem(name: "session", value: sessionId)], timeout: 45)
    }

    public func fetchDraft(key: String, haveNames: [String] = []) async throws -> DraftReadResponse {
        var items = [URLQueryItem(name: "key", value: key)]
        for name in haveNames {
            items.append(URLQueryItem(name: "have", value: name))
        }
        return try await get("/api/draft", query: items)
    }

    /// `images` / `pdfs`, when given, replace the draft's attached images / PDFs (`[]` removes them); left out, they stay.
    public func saveDraft(key: String, text: String, images: [[String: Any]]? = nil, pdfs: [[String: Any]]? = nil) async throws -> DraftSaveResponse {
        var body: [String: Any] = ["key": key, "text": text]
        if let images {
            body["images"] = images
        }
        if let pdfs {
            body["pdfs"] = pdfs
        }
        return try await post("/api/draft", jsonObject: body)
    }

    // MARK: - Workspaces, Files & Editor Actions

    public func browse(path: String = "", includeFiles: Bool = false) async throws -> BrowseListing {
        var items: [URLQueryItem] = []
        if !path.isEmpty {
            items.append(URLQueryItem(name: "path", value: path))
        }
        if includeFiles {
            items.append(URLQueryItem(name: "files", value: "1"))
        }
        return try await get("/api/browse", query: items)
    }

    public func searchFiles(path: String, query: String, limit: Int = 200) async throws -> FileSearchResponse {
        do {
            return try await get(
                "/api/files",
                query: [
                    URLQueryItem(name: "path", value: path),
                    URLQueryItem(name: "q", value: query),
                    URLQueryItem(name: "limit", value: String(limit)),
                ]
            )
        } catch let error as CompanionAPIError where error.kind == .notFound {
            // Graceful fallback for older companion builds without /api/files
            let listing = try await browse(path: path, includeFiles: true)
            let terms = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
            let matches = (listing.files ?? []).compactMap { entry -> FileMatch? in
                let lower = entry.name.lowercased()
                guard terms.isEmpty || terms.allSatisfy({ lower.contains($0) }) else { return nil }
                return FileMatch(name: entry.name, rel: entry.name, path: entry.path)
            }
            return FileSearchResponse(path: listing.path, files: Array(matches.prefix(limit)), truncated: matches.count > limit)
        }
    }

    public func addProject(path: String, name: String = "", description: String = "") async throws -> WorkspaceProject {
        try await post("/api/projects", jsonObject: ["path": path, "name": name, "description": description])
    }

    public func updateProject(
        id: String? = nil,
        path: String? = nil,
        name: String? = nil,
        color: String? = nil,
        hidden: Bool? = nil,
        refreshBranch: Bool? = nil
    ) async throws -> WorkspaceProject {
        var body: [String: Any] = [:]
        if let id { body["id"] = id }
        if let path { body["path"] = path }
        if let name { body["name"] = name }
        if let color { body["color"] = color }
        if let hidden { body["hidden"] = hidden }
        if let refreshBranch { body["refreshBranch"] = refreshBranch }
        return try await post("/api/projects/update", jsonObject: body)
    }

    public func saveUI(groupOrder: [String]? = nil, collapsed: [String]? = nil) async throws -> SidebarUI {
        var body: [String: Any] = [:]
        if let groupOrder { body["groupOrder"] = groupOrder }
        if let collapsed { body["collapsed"] = collapsed }
        return try await post("/api/ui", jsonObject: body)
    }

    public func openTerminal(path: String) async throws -> OpenTerminalResponse {
        try await post("/api/terminal", jsonObject: ["path": path])
    }

    public func setEditor(_ editor: String) async throws -> String {
        struct Resp: Decodable { let editor: String }
        let res: Resp = try await post("/api/editor", jsonObject: ["editor": editor])
        return res.editor
    }

    public func openFile(path: String, cwd: String? = nil, line: Int? = nil) async throws -> OpenFileResponse {
        var body: [String: Any] = ["path": path]
        if let cwd { body["cwd"] = cwd }
        if let line, line > 0 { body["line"] = line }
        return try await post("/api/open-file", jsonObject: body)
    }

    // MARK: - Session Creation, Pin/Archive & Lifecycle

    public func createSession(
        projectId: String,
        title: String,
        prompt: String,
        isolate: Bool = true,
        model: String? = nil,
        provider: String? = nil
    ) async throws -> SessionSummary {
        var body: [String: Any] = [
            "projectId": projectId,
            "title": title,
            "prompt": prompt,
            "isolate": isolate,
        ]
        if let model { body["model"] = model }
        if let provider { body["provider"] = provider }
        return try await post("/api/sessions", jsonObject: body, timeout: 120)
    }

    public func quickStart(
        path: String,
        title: String? = nil,
        prompt: String = "",
        images: [[String: Any]] = [],
        preview: [String]? = nil,
        isolate: Bool = false,
        model: String? = nil,
        thinking: String? = nil,
        autoApprove: Bool? = nil,
        fast: Bool? = nil,
        advisor: Bool? = nil,
        draft: Bool = false,
        launch: [String: Any]? = nil
    ) async throws -> SessionSummary {
        var body: [String: Any] = [
            "path": path,
            "prompt": prompt,
            "isolate": isolate,
            "draft": draft,
        ]
        if let title, !title.isEmpty { body["title"] = title }
        if !images.isEmpty { body["images"] = images }
        if let preview, !preview.isEmpty { body["preview"] = preview }
        if let model, !model.isEmpty { body["model"] = model }
        if let thinking, !thinking.isEmpty { body["thinking"] = thinking }
        if let autoApprove { body["autoApprove"] = autoApprove }
        if let fast { body["fast"] = fast }
        if let advisor { body["advisor"] = advisor }
        if let launch, !launch.isEmpty { body["launch"] = launch }
        return try await post("/api/quick-start", jsonObject: body, timeout: 120)
    }

    public func resumeOmpSession(
        file: String,
        message: String = "",
        images: [[String: Any]]? = nil,
        preview: [String]? = nil,
        model: String? = nil,
        thinking: String? = nil,
        advisor: Bool? = nil,
        launch: [String: Any]? = nil
    ) async throws -> SessionSummary {
        var body: [String: Any] = ["file": file]
        if !message.isEmpty { body["message"] = message }
        if let images { body["images"] = images }
        if let preview, !preview.isEmpty { body["preview"] = preview }
        if let model, !model.isEmpty { body["model"] = model }
        if let thinking, !thinking.isEmpty { body["thinking"] = thinking }
        if let advisor { body["advisor"] = advisor }
        if let launch, !launch.isEmpty { body["launch"] = launch }
        return try await post("/api/omp-sessions/resume", jsonObject: body, timeout: 120)
    }

    public func setPinned(key: String, pinned: Bool) async throws -> (archived: [String], pinned: [String]) {
        struct Resp: Decodable { let archived: [String]; let pinned: [String] }
        let res: Resp = try await post("/api/pin", jsonObject: ["key": key, "pinned": pinned])
        return (res.archived, res.pinned)
    }

    public func setArchived(key: String, archived: Bool) async throws -> (archived: [String], pinned: [String]) {
        struct Resp: Decodable { let archived: [String]; let pinned: [String] }
        let res: Resp = try await post("/api/archive", jsonObject: ["key": key, "archived": archived])
        return (res.archived, res.pinned)
    }

    // MARK: - Session Commands

    public func sessionCommand<T: Decodable>(
        sessionId: String,
        payload: [String: Any],
        lean: Bool = false,
        timeout: TimeInterval = 60
    ) async throws -> T {
        let encodedId = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
        let query = lean ? [URLQueryItem(name: "lean", value: "1")] : []
        return try await post("/api/sessions/\(encodedId)/command", jsonObject: payload, query: query, timeout: timeout)
    }

    public func sendSessionPrompt(
        sessionId: String,
        type: String, // "prompt" | "steer" | "follow_up" | "interrupt"
        message: String,
        images: [[String: Any]] = [],
        preview: [String]? = nil,
        pdfs: [[String: Any]] = [],
        lean: Bool = true
    ) async throws -> SessionSummary {
        var payload: [String: Any] = ["type": type, "message": message]
        if !images.isEmpty { payload["images"] = images }
        if let preview, !preview.isEmpty { payload["preview"] = preview }
        // `[{data: base64, name}]`; the host stores each and adds the line naming it to the message.
        if !pdfs.isEmpty { payload["pdfs"] = pdfs }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: lean, timeout: 60)
    }

    public func editFollowUp(sessionId: String, itemId: String, message: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "edit_follow_up", "id": itemId, "message": message], lean: true)
    }

    public func cancelFollowUp(sessionId: String, itemId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "cancel_follow_up", "id": itemId], lean: true)
    }

    public func sendFollowUpNow(sessionId: String, itemId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "send_follow_up", "id": itemId], lean: true)
    }

    public func cancelSteer(sessionId: String, messageId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "cancel_steer", "id": messageId], lean: true)
    }

    public func editSteer(sessionId: String, messageId: String, message: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "edit_steer", "id": messageId, "message": message], lean: true)
    }

    public func answerUIRequest(sessionId: String, requestId: String, payloadFields: [String: Any]) async throws -> SessionSummary {
        var payload = payloadFields
        payload["type"] = "answer"
        payload["id"] = requestId
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func sendCustomPanelInput(sessionId: String, requestId: String, input: [String]) async throws -> SessionSummary {
        try await answerUIRequest(sessionId: sessionId, requestId: requestId, payloadFields: ["input": input])
    }

    public func resizeCustomPanel(sessionId: String, requestId: String, columns: Int, rows: Int) async throws -> SessionSummary {
        try await answerUIRequest(sessionId: sessionId, requestId: requestId, payloadFields: ["resize": ["columns": columns, "rows": rows]])
    }

    public func cancelCustomPanel(sessionId: String, requestId: String) async throws -> SessionSummary {
        try await answerUIRequest(sessionId: sessionId, requestId: requestId, payloadFields: ["cancelled": true])
    }

    public func setAutoApprove(sessionId: String, enabled: Bool) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "auto_approve", "enabled": enabled], lean: true)
    }

    public func abortSession(sessionId: String, abortRetry: Bool = false) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": abortRetry ? "abort_retry" : "abort"], lean: true)
    }

    public func abortBash(sessionId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "abort_bash"], lean: true)
    }

    public func stopCommands(sessionId: String, runKey: String? = nil) async throws -> SessionSummary {
        var payload: [String: Any] = ["type": "stop_commands"]
        if let runKey { payload["run"] = runKey }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func completeSession(sessionId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "complete"], lean: true)
    }

    public func hideSession(sessionId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "hide"], lean: true)
    }

    public func renameSession(sessionId: String, name: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "rename", "name": name], lean: true)
    }

    public func setModel(sessionId: String, model: String?, thinking: String?) async throws -> SessionSummary {
        var payload: [String: Any] = ["type": "set_model"]
        if let model, !model.isEmpty { payload["model"] = model }
        if let thinking, !thinking.isEmpty { payload["thinking"] = thinking }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func setPref(sessionId: String, key: String, value: Any) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "pref", "key": key, "value": value], lean: true)
    }

    public func setPlanMode(sessionId: String, enabled: Bool, workflow: String? = nil) async throws -> SessionSummary {
        var payload: [String: Any] = ["type": "plan_mode", "enabled": enabled]
        if let workflow { payload["workflow"] = workflow }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func reviewPlan(sessionId: String) async throws -> PlanProposal? {
        struct Resp: Decodable { let proposal: PlanProposal? }
        let r: Resp = try await sessionCommand(sessionId: sessionId, payload: ["type": "plan_review"], lean: false)
        return r.proposal
    }

    public func approvePlan(
        sessionId: String,
        proposalId: String,
        action: String,
        feedback: String? = nil,
        executionModel: String? = nil,
        savePath: String? = nil
    ) async throws -> SessionSummary {
        var payload: [String: Any] = [
            "type": "plan_approve",
            "proposalId": proposalId,
            "action": action,
        ]
        if let feedback, !feedback.isEmpty { payload["feedback"] = feedback }
        if let executionModel, !executionModel.isEmpty { payload["executionModel"] = executionModel }
        if let savePath, !savePath.isEmpty { payload["savePath"] = savePath }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func setAdvisor(sessionId: String, action: String, model: String? = nil) async throws -> SessionSummary {
        var payload: [String: Any] = ["type": "advisor", "action": action]
        if let model { payload["model"] = model }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func setAdvisorModel(sessionId: String, model: String) async throws -> SessionSummary {
        try await setAdvisor(sessionId: sessionId, action: "model", model: model)
    }

    public func fetchLastReply(sessionId: String) async throws -> String {
        struct Resp: Decodable { let text: String }
        let res: Resp = try await sessionCommand(sessionId: sessionId, payload: ["type": "last_reply"])
        return res.text
    }

    public func toggleVibeMode(sessionId: String, args: String = "") async throws -> SessionSummary {
        let trimmed = args.trimmingCharacters(in: .whitespacesAndNewlines)
        let msg = trimmed.isEmpty ? "/vibe" : "/vibe \(trimmed)"
        return try await sendSessionPrompt(sessionId: sessionId, type: "prompt", message: msg)
    }

    public func startGuidedGoal(sessionId: String, initial: String = "") async throws -> SessionSummary {
        let trimmed = initial.trimmingCharacters(in: .whitespacesAndNewlines)
        let msg = trimmed.isEmpty ? "/guided-goal" : "/guided-goal \(trimmed)"
        return try await sendSessionPrompt(sessionId: sessionId, type: "prompt", message: msg)
    }

    public func runGoalCommand(sessionId: String, args: String = "") async throws -> SessionSummary {
        let trimmed = args.trimmingCharacters(in: .whitespacesAndNewlines)
        let msg = trimmed.isEmpty ? "/goal" : "/goal \(trimmed)"
        return try await sendSessionPrompt(sessionId: sessionId, type: "prompt", message: msg)
    }

    public func runLoopCommand(sessionId: String, args: String = "") async throws -> SessionSummary {
        let trimmed = args.trimmingCharacters(in: .whitespacesAndNewlines)
        let msg = trimmed.isEmpty ? "/loop" : "/loop \(trimmed)"
        return try await sendSessionPrompt(sessionId: sessionId, type: "prompt", message: msg)
    }

    public func togglePauseMode(sessionId: String) async throws -> SessionSummary {
        try await sendSessionPrompt(sessionId: sessionId, type: "prompt", message: "/pause")
    }

    public func compactSession(sessionId: String, instructions: String? = nil) async throws -> SessionSummary {
        var payload: [String: Any] = ["type": "compact"]
        if let instructions, !instructions.isEmpty { payload["instructions"] = instructions }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func handoffSession(sessionId: String, instructions: String? = nil) async throws -> SessionSummary {
        var payload: [String: Any] = ["type": "handoff"]
        if let instructions, !instructions.isEmpty { payload["instructions"] = instructions }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func startFreshSession(sessionId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "new_session"], lean: true)
    }

    public func switchSession(sessionId: String, file: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "switch_session", "file": file], lean: true)
    }

    public func cycleModel(sessionId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "cycle_model"], lean: true)
    }

    public func cycleThinking(sessionId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "cycle_thinking"], lean: true)
    }

    public func setTodos(sessionId: String, phases: [TodoPhase]) async throws -> SessionSummary {
        let encoded = try JSONEncoder().encode(phases)
        let jsonArray = try JSONSerialization.jsonObject(with: encoded)
        return try await sessionCommand(sessionId: sessionId, payload: ["type": "todos", "phases": jsonArray], lean: true)
    }

    public func updateLaunchOptions(sessionId: String, launch: [String: Any]?) async throws -> SessionSummary {
        var payload: [String: Any] = ["type": "launch"]
        if let launch { payload["launch"] = launch }
        return try await sessionCommand(sessionId: sessionId, payload: payload, lean: true)
    }

    public func runBash(sessionId: String, command: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "bash", "command": command], lean: true)
    }

    public func fetchTree(sessionId: String) async throws -> TreeViewResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "tree"])
    }

    public func fetchBranchMessages(sessionId: String) async throws -> BranchMessagesResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "branch_messages"])
    }

    public func branchSession(sessionId: String, entryId: String) async throws -> BranchResultResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "branch", "entryId": entryId])
    }

    public func editLastMessage(sessionId: String) async throws -> BranchResultResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "edit_last"])
    }

    public func regenerateLastMessage(sessionId: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "regenerate"], lean: true)
    }

    public func fetchSessionStats(sessionId: String) async throws -> SessionStatsResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "stats"])
    }

    public func exportSessionHtml(sessionId: String) async throws -> ExportHtmlResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "export"])
    }

    public func fetchLoginProviders(sessionId: String) async throws -> LoginProvidersResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "login_providers"])
    }

    public func startLogin(sessionId: String, provider: String) async throws -> SessionSummary {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "login", "provider": provider], lean: true)
    }

    public func discardDraftSession(sessionId: String) async throws -> Bool {
        struct Resp: Decodable { let discarded: Bool }
        let res: Resp = try await sessionCommand(sessionId: sessionId, payload: ["type": "discard"])
        return res.discarded
    }

    public func predictWord(sessionId: String, text: String, cursor: Int) async throws -> PredictWordResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "predict_word", "text": text, "cursor": cursor], timeout: 12)
    }

    public func predictWordFeedback(sessionId: String, text: String, cursor: Int, suggestion: String, accepted: Bool) async throws {
        let _: OkResponse = try await sessionCommand(
            sessionId: sessionId,
            payload: ["type": "predict_word_feedback", "text": text, "cursor": cursor, "suggestion": suggestion, "accepted": accepted]
        )
    }

    public func sendBtw(sessionId: String, question: String, recordId: String? = nil) async throws -> BtwResultResponse {
        var payload: [String: Any] = ["type": "btw", "question": question]
        if let recordId { payload["recordId"] = recordId }
        return try await sessionCommand(sessionId: sessionId, payload: payload, timeout: 90)
    }

    public func cancelBtw(sessionId: String, recordId: String? = nil) async throws -> Bool {
        struct Resp: Decodable { let cancelled: Bool }
        var payload: [String: Any] = ["type": "btw_cancel"]
        if let recordId { payload["recordId"] = recordId }
        let r: Resp = try await sessionCommand(sessionId: sessionId, payload: payload)
        return r.cancelled
    }

    public func fetchBtwHistory(sessionId: String) async throws -> BtwHistoryResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "btw_history"])
    }

    public func cancelSubagent(sessionId: String, subagentId: String) async throws -> Bool {
        struct Resp: Decodable { let cancelled: Bool }
        let r: Resp = try await sessionCommand(sessionId: sessionId, payload: ["type": "subagent_cancel", "id": subagentId])
        return r.cancelled
    }

    public func steerSubagent(sessionId: String, subagentId: String, message: String) async throws -> Bool {
        struct Resp: Decodable { let steered: Bool }
        let r: Resp = try await sessionCommand(sessionId: sessionId, payload: ["type": "subagent_steer", "id": subagentId, "message": message])
        return r.steered
    }

    public func messageSubagent(sessionId: String, file: String, message: String) async throws -> Bool {
        struct Resp: Decodable { let sent: Bool }
        let r: Resp = try await sessionCommand(sessionId: sessionId, payload: ["type": "subagent_message", "file": file, "message": message])
        return r.sent
    }

    public func acknowledgeEditorText(sessionId: String, id: String) async throws {
        let _: [String: JSONValue] = try await sessionCommand(sessionId: sessionId, payload: ["type": "editor_text_applied", "id": id])
    }

    public func fetchChangesWorktree(sessionId: String, base: String = "start") async throws -> ChangesWorktreeResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "changes_worktree", "base": base], timeout: 60)
    }

    public func fetchGitLog(sessionId: String) async throws -> GitLogResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "git_log"], timeout: 30)
    }

    public func fetchGitCommit(sessionId: String, sha: String) async throws -> GitCommitResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "git_commit", "sha": sha], timeout: 30)
    }

    public func fetchWorktreeStatus(sessionId: String) async throws -> WorktreeStatusResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "worktree_status"], timeout: 30)
    }

    public func finishWorktree(sessionId: String, action: String, commit: Bool = false) async throws -> WorktreeFinishResponse {
        try await sessionCommand(sessionId: sessionId, payload: ["type": "worktree_finish", "action": action, "commit": commit], timeout: 150)
    }

    // MARK: - History, Subagent Transcripts, Logs & Tool Images

    public func fetchOmpSessions(etag: String? = nil) async throws -> PollResult<NativeSessionsResponse> {
        try await getTagged("/api/omp-sessions", etag: etag, timeout: 30)
    }

    public func previewOmpSession(file: String) async throws -> NativeSessionPreview {
        try await get("/api/omp-sessions/preview", query: [URLQueryItem(name: "file", value: file)], timeout: 30)
    }

    public func fetchBackground(file: String, etag: String? = nil) async throws -> PollResult<BackgroundViewResponse> {
        try await getTagged("/api/background", query: [URLQueryItem(name: "file", value: file)], etag: etag)
    }

    public func fetchSubagentTranscript(file: String, etag: String? = nil) async throws -> PollResult<SubagentTranscriptResponse> {
        try await getTagged("/api/transcript", query: [URLQueryItem(name: "file", value: file)], etag: etag)
    }

    public func fetchLog(file: String) async throws -> LogResponse {
        try await get("/api/log", query: [URLQueryItem(name: "file", value: file)])
    }

    public func fetchToolImage(id: String) async throws -> Data {
        let (data, _) = try await sendRaw(method: "GET", path: "/api/tool-image", query: [URLQueryItem(name: "id", value: id)], timeout: 30)
        return data
    }

    /// A stored PDF a message carries (`GET /api/attachment`), as raw bytes. 404: the host no longer stores it.
    public func fetchAttachment(id: String, name: String) async throws -> Data {
        let (data, _) = try await sendRaw(
            method: "GET",
            path: "/api/attachment",
            query: [URLQueryItem(name: "id", value: id), URLQueryItem(name: "name", value: name)],
            timeout: 60
        )
        return data
    }

    // MARK: - Enhance Prompt

    public func startEnhance(
        text: String,
        mode: String? = nil,
        sessionId: String? = nil,
        path: String? = nil,
        model: String? = nil,
        thinking: String? = nil,
        images: [[String: Any]] = []
    ) async throws -> EnhanceStartResponse {
        var body: [String: Any] = ["text": text]
        if let mode { body["mode"] = mode }
        // The server takes exactly one: a session (its folder, model and thinking) or a folder for a new one.
        if let sessionId { body["session"] = sessionId } else if let path { body["path"] = path }
        if let model { body["model"] = model }
        if let thinking { body["thinking"] = thinking }
        if !images.isEmpty { body["images"] = images }
        return try await post("/api/enhance", jsonObject: body)
    }

    public func pollEnhance(id: String) async throws -> EnhanceStatusResponse {
        try await get("/api/enhance", query: [URLQueryItem(name: "id", value: id)])
    }

    public func stopEnhance(id: String) async throws -> String {
        struct Resp: Decodable { let status: String }
        let res: Resp = try await post("/api/enhance/stop", jsonObject: ["id": id])
        return res.status
    }

    public func setEnhanceMode(_ mode: String) async throws -> String {
        struct Resp: Decodable { let mode: String }
        let res: Resp = try await post("/api/enhance-mode", jsonObject: ["mode": mode])
        return res.mode
    }

    // MARK: - Settings, Plugins, MCP, Accounts, Spend, CLI, Storage & System

    public func fetchSettings() async throws -> SettingsResponse {
        try await get("/api/settings", timeout: 45)
    }

    public func setSetting(key: String, value: Any) async throws -> SettingsResponse {
        try await post("/api/settings", jsonObject: ["key": key, "value": value], timeout: 45)
    }

    public func resetSetting(key: String) async throws -> SettingsResponse {
        try await post("/api/settings/reset", jsonObject: ["key": key], timeout: 45)
    }

    public func fetchAdvisorConfig() async throws -> AdvisorConfigResponse {
        try await get("/api/advisor")
    }

    public func fetchPlugins() async throws -> PluginsResponse {
        try await get("/api/plugins", timeout: 45)
    }

    public func pluginAction(action: String, id: String, scope: String? = nil) async throws -> PluginsResponse {
        var body: [String: Any] = ["action": action, "id": id]
        if let scope { body["scope"] = scope }
        return try await post("/api/plugins", jsonObject: body, timeout: 180)
    }

    public func fetchMcp() async throws -> McpResponse {
        try await get("/api/mcp", timeout: 45)
    }

    public func mcpAction(action: String, name: String, projectId: String? = nil) async throws -> McpResponse {
        var body: [String: Any] = ["action": action, "name": name]
        if let projectId { body["project"] = projectId }
        return try await post("/api/mcp", jsonObject: body, timeout: 45)
    }

    public func fetchAccounts() async throws -> AccountsResponse {
        try await get("/api/accounts")
    }

    public func selectAccount(provider: String, account: String) async throws {
        struct Resp: Decodable { let provider: String; let account: String }
        let _: Resp = try await post("/api/accounts", jsonObject: ["provider": provider, "account": account])
    }

    public func fetchUpdateState() async throws -> UpdateStateResponse {
        try await get("/api/omp-update")
    }

    public func startOmpUpdate() async throws -> UpdateStateResponse {
        try await post("/api/omp-update", jsonObject: [:])
    }

    public func fetchSpend(sync: Bool = false) async throws -> SpendResponse {
        let query = sync ? [URLQueryItem(name: "sync", value: "1")] : []
        return try await get("/api/spend", query: query, timeout: sync ? 90 : 30)
    }

    public func fetchCli(revs: Bool = false, have: [String] = [], includeCatalog: Bool = true) async throws -> CliPollResponse {
        var items: [URLQueryItem] = []
        if revs {
            items.append(URLQueryItem(name: "revs", value: "1"))
            if !have.isEmpty {
                items.append(URLQueryItem(name: "have", value: have.joined(separator: ",")))
            }
            if !includeCatalog {
                items.append(URLQueryItem(name: "catalog", value: "0"))
            }
        }
        return try await get("/api/cli", query: items)
    }

    public func runCli(tool: String, action: String, values: [String: Any], cwd: String? = nil) async throws -> CliJob {
        var body: [String: Any] = ["tool": tool, "action": action, "values": values]
        if let cwd, !cwd.isEmpty { body["cwd"] = cwd }
        return try await post("/api/cli", jsonObject: body)
    }

    public func stopCli(id: String) async throws -> CliJob {
        try await post("/api/cli/stop", jsonObject: ["id": id])
    }

    public func fetchStorage() async throws -> StorageResponse {
        try await get("/api/storage")
    }

    public func scanStorage() async throws -> StorageResponse {
        try await post("/api/storage/scan", jsonObject: [:])
    }

    public func removeWorktrees(sessions: [String] = [], orphans: [String] = [], archived: Bool = false, confirm: Bool = false) async throws -> StorageResponse {
        var body: [String: Any] = ["confirm": confirm]
        if !sessions.isEmpty { body["sessions"] = sessions }
        if !orphans.isEmpty { body["orphans"] = orphans }
        if archived { body["archived"] = true }
        return try await post("/api/storage/remove", jsonObject: body)
    }

    public func cleanWorktrees(sessions: [String]) async throws -> StorageResponse {
        try await post("/api/storage/clean", jsonObject: ["sessions": sessions])
    }

    public func fetchScreenInfo() async throws -> ScreenInfoResponse {
        try await get("/api/screen")
    }

    public func requestScreenTicket() async throws -> ScreenTicketResponse {
        try await post("/api/screen/ticket", jsonObject: [:])
    }

    public func setAutoShutdown(on: Bool) async throws -> AutoShutdownState {
        try await post("/api/shutdown/auto", jsonObject: ["on": on])
    }

    public func shutdownHost() async throws -> OkResponse {
        try await post("/api/shutdown", jsonObject: [:])
    }

    public func restartHost() async throws -> OkResponse {
        try await post("/api/restart", jsonObject: [:])
    }

    public func fetchInstance() async throws -> InstanceResponse {
        try await get("/api/instance", timeout: 5)
    }

    /// The desktop app checks for its own update and, when it finds one, downloads, installs and restarts without
    /// asking; the check can take a while (the web waits 90 s too).
    public func startAppUpdate() async throws -> AppUpdateResponse {
        try await post("/api/app-update", jsonObject: [:], timeout: 90)
    }

    public func clearAttachments() async throws -> StorageResponse {
        try await post("/api/storage/clear-attachments", jsonObject: [:])
    }

    // MARK: - Apple Push

    /// Registers this phone's APNs device token with the host, which then pushes "needs input" and "plan ready" while
    /// the app is not running (when it has an APNs key: `configured`). `hostRef` comes back in each push as `hostID`, so
    /// a tap opens the session on the right host; `redact` keeps session titles off the lock screen.
    @discardableResult
    public func registerPush(token: String, environment: String, hostRef: String, redact: Bool, name: String?) async throws -> PushRegisterResponse {
        var body: [String: Any] = ["token": token, "environment": environment, "hostRef": hostRef, "redact": redact]
        if let name, !name.isEmpty { body["name"] = name }
        return try await post("/api/push/register", jsonObject: body, timeout: 15)
    }

    /// Stops the host's pushes to this phone.
    @discardableResult
    public func unregisterPush(token: String) async throws -> PushRegisterResponse {
        try await post("/api/push/register", jsonObject: ["token": token, "remove": true], timeout: 15)
    }
}

public struct PushRegisterResponse: Decodable, Sendable {
    public let ok: Bool?
    /// The host has an APNs key; without one it keeps the registration but cannot push.
    public let configured: Bool?
}

public struct VideoUploadResponse: Decodable, Sendable {
    public let id: String
    public let name: String
    public let bytes: Int
    public let path: String
    public let ref: String
}

/// Reports an upload's sent fraction; URLSession calls it on its delegate queue.
private final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let onProgress: @Sendable (Double) -> Void

    init(_ onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}
