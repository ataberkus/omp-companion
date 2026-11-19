import Foundation

// MARK: - Generic JSON Value

public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? container.decode(Int.self) {
            self = .int(i)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .int(let i): try container.encode(i)
        case .double(let d): try container.encode(d)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var doubleValue: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .double(let d): return d
        default: return nil
        }
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    public var displayString: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .int(let i): return String(i)
        case .double(let d): return String(d)
        case .string(let s): return s
        case .array, .object:
            guard let data = try? JSONEncoder.pretty.encode(self),
                  let text = String(data: data, encoding: .utf8) else {
                return "{}"
            }
            return text
        }
    }
}

extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        return enc
    }()
}

// MARK: - Store & Polling Models

public struct StoreSnapshot: Codable, Hashable, Sendable {
    public var projects: [WorkspaceProject]
    public var sessions: [SessionSummary]
    public var archived: [String]
    public var pinned: [String]
    public var ui: SidebarUI?
    public var drafts: [String: Double]?
    public var editor: String?
    public var enhanceMode: String?
    public var accountChoices: [String: String]?
    public var activity: [ActivityItem]?
    public var instance: String?
    public var canRestart: Bool?
    public var autoShutdown: AutoShutdownState?

    public init(
        projects: [WorkspaceProject] = [],
        sessions: [SessionSummary] = [],
        archived: [String] = [],
        pinned: [String] = [],
        ui: SidebarUI? = nil,
        drafts: [String: Double]? = nil,
        editor: String? = nil,
        enhanceMode: String? = nil,
        accountChoices: [String: String]? = nil,
        activity: [ActivityItem]? = nil,
        instance: String? = nil,
        canRestart: Bool? = nil,
        autoShutdown: AutoShutdownState? = nil
    ) {
        self.projects = projects
        self.sessions = sessions
        self.archived = archived
        self.pinned = pinned
        self.ui = ui
        self.drafts = drafts
        self.editor = editor
        self.enhanceMode = enhanceMode
        self.accountChoices = accountChoices
        self.activity = activity
        self.instance = instance
        self.canRestart = canRestart
        self.autoShutdown = autoShutdown
    }
}

public struct StatePollResponse: Codable, Sendable {
    public var sx: StoreDelta?
    public var tx: TranscriptDelta?
    public var btw: [BtwRecord]?
    // Full store fallback (without ?store=)
    public var projects: [WorkspaceProject]?
    public var sessions: [SessionSummary]?
    public var archived: [String]?
    public var pinned: [String]?
    public var ui: SidebarUI?
    public var drafts: [String: Double]?
    public var editor: String?
    public var enhanceMode: String?
    public var accountChoices: [String: String]?
    public var activity: [ActivityItem]?
    public var instance: String?
    public var canRestart: Bool?
    public var autoShutdown: AutoShutdownState?
}

public struct StoreTop: Codable, Hashable, Sendable {
    public var projects: [WorkspaceProject]
    public var archived: [String]
    public var pinned: [String]
    public var ui: SidebarUI?
    public var drafts: [String: Double]?
    public var editor: String?
    public var enhanceMode: String?
    public var accountChoices: [String: String]?
    public var instance: String?
    public var canRestart: Bool?
    public var autoShutdown: AutoShutdownState?
}

public struct StoreDelta: Codable, Sendable {
    public var epoch: String
    public var rev: Int
    public var top: StoreTop?
    public var order: [String]?
    public var changed: [SessionSummary]?
}

public struct TranscriptDelta: Codable, Sendable {
    public var session: String
    public var epoch: String?
    public var rev: Int?
    public var order: [String]?
    public var orderEdit: OrderEdit?
    public var changed: [TranscriptMessage]?
    public var messages: [TranscriptMessage]?
}

public struct OrderEdit: Codable, Hashable, Sendable {
    public var drop: Int
    public var at: Int
    public var del: Int
    public var add: [String]
    public var n: Int
}

public struct SidebarUI: Codable, Hashable, Sendable {
    public var groupOrder: [String]?
    public var collapsed: [String]?
}

public struct WorkspaceProject: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var path: String
    public var description: String?
    public var color: String?
    public var branch: String?
    public var hidden: Bool?
    public var createdAt: String?
    public var updatedAt: String?

    public init(
        id: String,
        name: String,
        path: String,
        description: String? = nil,
        color: String? = nil,
        branch: String? = nil,
        hidden: Bool? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.description = description
        self.color = color
        self.branch = branch
        self.hidden = hidden
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public enum SessionInspectorTab: String, CaseIterable, Identifiable, Sendable {
    case chat
    case changes
    case todos
    case subagents
    case screen

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .chat: return "Chat"
        case .changes: return "Changes"
        case .todos: return "Todos"
        case .subagents: return "Agents"
        case .screen: return "Screen"
        }
    }

    public var systemImage: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .changes: return "doc.text.magnifyingglass"
        case .todos: return "checklist"
        case .subagents: return "cpu"
        case .screen: return "terminal"
        }
    }
}

public struct VibeModeState: Codable, Hashable, Sendable {
    public var enabled: Bool?

    public init(enabled: Bool? = nil) {
        self.enabled = enabled
    }
}

public enum SessionStatus: String, Codable, Hashable, Sendable {
    case running
    case queued
    case review
    case paused
    case done
    case error

    public var label: String {
        switch self {
        case .running: return "Working"
        case .queued: return "Queued"
        case .review: return "Ready"
        case .paused: return "Paused"
        case .done: return "Done"
        case .error: return "Error"
        }
    }
}

public struct SessionSummary: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var projectId: String?
    public var title: String
    public var cwd: String
    public var status: SessionStatus
    public var branch: String?
    public var isolated: Bool?
    public var baseSha: String?
    public var worktreeRemoved: Bool?
    public var native: Bool?
    public var sessionFile: String?
    public var modelSelector: String?
    public var thinkingChoice: String?
    public var provider: String?
    public var model: String?
    public var thinking: String?
    public var tokens: Int?
    public var cost: Double?
    public var contextPercent: Double?
    public var contextTokens: Int?
    public var contextWindow: Int?
    public var tps: Double?
    public var autoApprove: Bool?
    public var autoTitle: Bool?
    public var renamed: Bool?
    public var draft: Bool?
    public var promptTrimmed: Bool?
    public var error: String?
    public var createdAt: String?
    public var updatedAt: String
    public var lastActivityAt: String?
    public var workStartedAt: String?
    public var workFinishedAt: String?
    public var hidden: Bool?

    public var fast: FastModeState?
    public var autoCompaction: Bool?
    public var modes: SessionModes?
    public var prefs: SessionPrefs?
    public var launch: SessionLaunchOptions?
    public var planMode: PlanModeState?
    public var goal: GoalState?
    public var advisor: AdvisorState?
    public var todos: [TodoPhase]?
    public var subagents: Int?
    public var subagentList: [SubagentInfo]?
    public var vibeMode: VibeModeState?
    public var queuedMessages: [QueuedMessage]?
    public var messages: [TranscriptMessage]?

    // Ephemeral runtime fields from companion
    public var uiRequests: [UIRequest]?
    public var _overlaps: [SessionOverlap]?
    public var _status: [String: String]?
    public var _widgets: [String: [String]]?
    public var _commandRuns: [String: String]?
    public var _notices: [SessionNotice]?
    public var _retry: RetryState?
    public var _openUrl: OpenUrlPrompt?
    public var _editorText: EditorTextPrompt?
    public var _rateLimit: RateLimitHint?
    public var _connectionLost: Bool?
    public var _planReview: PlanProposal?
    public var _planSupported: Bool?
    public var _goalSupported: Bool?
    public var _goalAvailable: Bool?
    public var _unhosted: [String]?
    public var _thinkingLevels: [String]?
    public var _slow: SlowModeState?
    public var _cacheWarming: String?
    public var _loop: LoopState?
    public var _task: String?
    public var _bash: String?
    public var rateLimitResume: AutoResumeWindow?
    public var connectionResume: ConnectionResumeWindow?
    public var _compacting: Bool?
    public var _btw: [BtwRecord]?

    public init(
        id: String,
        projectId: String? = nil,
        title: String,
        cwd: String,
        status: SessionStatus = .paused,
        branch: String? = nil,
        isolated: Bool? = nil,
        baseSha: String? = nil,
        worktreeRemoved: Bool? = nil,
        native: Bool? = nil,
        sessionFile: String? = nil,
        modelSelector: String? = nil,
        thinkingChoice: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        thinking: String? = nil,
        tokens: Int? = nil,
        cost: Double? = nil,
        contextPercent: Double? = nil,
        contextTokens: Int? = nil,
        contextWindow: Int? = nil,
        tps: Double? = nil,
        autoApprove: Bool? = nil,
        autoTitle: Bool? = nil,
        renamed: Bool? = nil,
        draft: Bool? = nil,
        promptTrimmed: Bool? = nil,
        error: String? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil,
        lastActivityAt: String? = nil,
        workStartedAt: String? = nil,
        workFinishedAt: String? = nil,
        hidden: Bool? = nil,
        fast: FastModeState? = nil,
        autoCompaction: Bool? = nil,
        modes: SessionModes? = nil,
        prefs: SessionPrefs? = nil,
        launch: SessionLaunchOptions? = nil,
        planMode: PlanModeState? = nil,
        goal: GoalState? = nil,
        advisor: AdvisorState? = nil,
        todos: [TodoPhase]? = nil,
        subagents: Int? = nil,
        subagentList: [SubagentInfo]? = nil,
        vibeMode: VibeModeState? = nil,
        queuedMessages: [QueuedMessage]? = nil,
        messages: [TranscriptMessage]? = nil,
        uiRequests: [UIRequest]? = nil,
        _overlaps: [SessionOverlap]? = nil,
        _status: [String: String]? = nil,
        _widgets: [String: [String]]? = nil,
        _commandRuns: [String: String]? = nil,
        _notices: [SessionNotice]? = nil,
        _retry: RetryState? = nil,
        _openUrl: OpenUrlPrompt? = nil,
        _editorText: EditorTextPrompt? = nil,
        _rateLimit: RateLimitHint? = nil,
        _connectionLost: Bool? = nil,
        _planReview: PlanProposal? = nil,
        _planSupported: Bool? = nil,
        _goalSupported: Bool? = nil,
        _goalAvailable: Bool? = nil,
        _unhosted: [String]? = nil,
        _thinkingLevels: [String]? = nil,
        _slow: SlowModeState? = nil,
        _cacheWarming: String? = nil,
        _loop: LoopState? = nil,
        _task: String? = nil,
        _bash: String? = nil,
        rateLimitResume: AutoResumeWindow? = nil,
        connectionResume: ConnectionResumeWindow? = nil,
        _compacting: Bool? = nil,
        _btw: [BtwRecord]? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.title = title
        self.cwd = cwd
        self.status = status
        self.branch = branch
        self.isolated = isolated
        self.baseSha = baseSha
        self.worktreeRemoved = worktreeRemoved
        self.native = native
        self.sessionFile = sessionFile
        self.modelSelector = modelSelector
        self.thinkingChoice = thinkingChoice
        self.provider = provider
        self.model = model
        self.thinking = thinking
        self.tokens = tokens
        self.cost = cost
        self.contextPercent = contextPercent
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.tps = tps
        self.autoApprove = autoApprove
        self.autoTitle = autoTitle
        self.renamed = renamed
        self.draft = draft
        self.promptTrimmed = promptTrimmed
        self.error = error
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? ""
        self.lastActivityAt = lastActivityAt
        self.workStartedAt = workStartedAt
        self.workFinishedAt = workFinishedAt
        self.hidden = hidden
        self.fast = fast
        self.autoCompaction = autoCompaction
        self.modes = modes
        self.prefs = prefs
        self.launch = launch
        self.planMode = planMode
        self.goal = goal
        self.advisor = advisor
        self.todos = todos
        self.subagents = subagents
        self.subagentList = subagentList
        self.vibeMode = vibeMode
        self.queuedMessages = queuedMessages
        self.messages = messages
        self.uiRequests = uiRequests
        self._overlaps = _overlaps
        self._status = _status
        self._widgets = _widgets
        self._commandRuns = _commandRuns
        self._notices = _notices
        self._retry = _retry
        self._openUrl = _openUrl
        self._editorText = _editorText
        self._rateLimit = _rateLimit
        self._connectionLost = _connectionLost
        self._planReview = _planReview
        self._planSupported = _planSupported
        self._goalSupported = _goalSupported
        self._goalAvailable = _goalAvailable
        self._unhosted = _unhosted
        self._thinkingLevels = _thinkingLevels
        self._slow = _slow
        self._cacheWarming = _cacheWarming
        self._loop = _loop
        self._task = _task
        self._bash = _bash
        self.rateLimitResume = rateLimitResume
        self.connectionResume = connectionResume
        self._compacting = _compacting
        self._btw = _btw
    }

    public var isWorking: Bool {
        status == .running || status == .queued
    }

    public var isVibeActive: Bool {
        vibeMode?.enabled == true || (_status?["vibe"]?.isEmpty == false)
    }

    public var isPauseGateActive: Bool {
        !(_widgets?["pause"]?.isEmpty ?? true)
    }

    public var hasPlanReviewPending: Bool {
        _planReview != nil || planMode?.reviewPending == true
    }

    public var activeSubagentCount: Int {
        subagentList?.filter(\.isActive).count ?? 0
    }

    public var resolvedSubagentCount: Int {
        let live = activeSubagentCount
        return live > 0 ? live : (subagents ?? 0)
    }

    public var needsAttention: Bool {
        if hidden == true { return false }
        if !(uiRequests?.isEmpty ?? true) { return true }
        if _planReview != nil || planMode?.reviewPending == true { return true }
        return status == .review || status == .error
    }

    public var effectiveModelSelector: String? {
        if let modelSelector, !modelSelector.isEmpty { return modelSelector }
        if let provider, let model, !provider.isEmpty, !model.isEmpty, model != "OMP default" {
            return "\(provider)/\(model)"
        }
        return nil
    }

    public var panelKey: String { "s:\(id)" }
    public var draftKey: String { "session:\(id)" }
}

public struct TranscriptMessage: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var role: MessageRole
    public var text: String
    public var at: String?
    public var startedAt: String?
    public var model: String?
    public var from: String?
    public var adv: String?
    public var hasImage: Bool?
    public var imagePreview: [String]?
    public var steer: SteerState?
    public var entryId: String?
    public var ompAt: Double?
    public var tool: ToolRecord?
    public var notes: [AdvisorNote]?
    public var sourceTimestamp: Double?

    enum CodingKeys: String, CodingKey {
        case id, role, text, at, startedAt, model, from, adv, hasImage, imagePreview, steer, entryId, ompAt, tool, notes, sourceTimestamp
    }

    public init(
        id: String,
        role: MessageRole,
        text: String,
        at: String? = nil,
        startedAt: String? = nil,
        model: String? = nil,
        from: String? = nil,
        adv: String? = nil,
        hasImage: Bool? = nil,
        imagePreview: [String]? = nil,
        steer: SteerState? = nil,
        entryId: String? = nil,
        ompAt: Double? = nil,
        tool: ToolRecord? = nil,
        notes: [AdvisorNote]? = nil,
        sourceTimestamp: Double? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
        self.startedAt = startedAt
        self.model = model
        self.from = from
        self.adv = adv
        self.hasImage = hasImage
        self.imagePreview = imagePreview
        self.steer = steer
        self.entryId = entryId
        self.ompAt = ompAt
        self.tool = tool
        self.notes = notes
        self.sourceTimestamp = sourceTimestamp
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = try c.decodeIfPresent(MessageRole.self, forKey: .role) ?? .system
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        at = try c.decodeIfPresent(String.self, forKey: .at)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        from = try c.decodeIfPresent(String.self, forKey: .from)
        adv = try c.decodeIfPresent(String.self, forKey: .adv)
        hasImage = try c.decodeIfPresent(Bool.self, forKey: .hasImage)
        // imagePreview on companion can be either a single String or [String]
        if let arr = try? c.decodeIfPresent([String].self, forKey: .imagePreview) {
            imagePreview = arr
        } else if let single = try? c.decodeIfPresent(String.self, forKey: .imagePreview) {
            imagePreview = [single]
        } else {
            imagePreview = nil
        }
        steer = try c.decodeIfPresent(SteerState.self, forKey: .steer)
        entryId = try c.decodeIfPresent(String.self, forKey: .entryId)
        ompAt = try c.decodeIfPresent(Double.self, forKey: .ompAt)
        tool = try c.decodeIfPresent(ToolRecord.self, forKey: .tool)
        notes = try c.decodeIfPresent([AdvisorNote].self, forKey: .notes)
        sourceTimestamp = try c.decodeIfPresent(Double.self, forKey: .sourceTimestamp)
    }
}

public enum MessageRole: String, Codable, Hashable, Sendable {
    case user
    case assistant
    case system
    case thinking
    case tool
    case advisor
    case advisorUpdate = "advisor-update"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MessageRole(rawValue: raw) ?? .system
    }
}

public enum SteerState: String, Codable, Hashable, Sendable {
    case pending
    case received
    case dropped
}

public struct ToolRecord: Codable, Hashable, Sendable {
    public var name: String
    public var intent: String?
    public var args: String?
    public var status: String // running | done | error
    public var result: String?
    public var ms: Int?
    public var images: [ToolImageRef]?
    public var files: [ToolFileDiff]?
    public var tasks: [ToolTaskItem]?
    public var command: String?
    public var exitCode: Int?

    public init(
        name: String,
        intent: String? = nil,
        args: String? = nil,
        status: String = "done",
        result: String? = nil,
        ms: Int? = nil,
        images: [ToolImageRef]? = nil,
        files: [ToolFileDiff]? = nil,
        tasks: [ToolTaskItem]? = nil,
        command: String? = nil,
        exitCode: Int? = nil
    ) {
        self.name = name
        self.intent = intent
        self.args = args
        self.status = status
        self.result = result
        self.ms = ms
        self.images = images
        self.files = files
        self.tasks = tasks
        self.command = command
        self.exitCode = exitCode
    }
}

public struct ToolTaskItem: Codable, Hashable, Sendable {
    public var id: String?
    public var name: String?
    public var description: String?
    public var assignment: String?
}

public struct ToolImageRef: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var mimeType: String?
}

public struct ToolFileDiff: Codable, Hashable, Identifiable, Sendable {
    public var id: String { "\(path):\(op ?? "")" }
    public var path: String
    public var op: String? // create | modify | delete | rename
    public var diff: String?
}

public struct AdvisorNote: Codable, Hashable, Identifiable, Sendable {
    public var id: String { "\(advisor ?? ""):\(severity):\(note.prefix(32))" }
    public var note: String
    public var severity: String // nit | concern | blocker
    public var advisor: String?
}

public struct QueuedMessage: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var text: String
    public var hasImage: Bool?
    public var imagePreview: [String]?
    public var at: String?

    enum CodingKeys: String, CodingKey {
        case id, text, hasImage, imagePreview, at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        hasImage = try c.decodeIfPresent(Bool.self, forKey: .hasImage)
        if let arr = try? c.decodeIfPresent([String].self, forKey: .imagePreview) {
            imagePreview = arr
        } else if let single = try? c.decodeIfPresent(String.self, forKey: .imagePreview) {
            imagePreview = [single]
        } else {
            imagePreview = nil
        }
        at = try c.decodeIfPresent(String.self, forKey: .at)
    }
}

// MARK: - Interactive UI Requests & Modes

public struct UIRequest: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var method: String // ask | select | confirm | input | editor | custom
    public var title: String?
    public var message: String?
    public var placeholder: String?
    public var secret: Bool?
    public var prefill: String?
    public var options: [String]?
    public var optionDetails: [OptionDetail]?
    public var checked: [Int]?
    public var questions: [AskQuestion]?
    public var lines: [String]?

    public init(
        id: String,
        method: String,
        title: String? = nil,
        message: String? = nil,
        placeholder: String? = nil,
        secret: Bool? = nil,
        prefill: String? = nil,
        options: [String]? = nil,
        optionDetails: [OptionDetail]? = nil,
        checked: [Int]? = nil,
        questions: [AskQuestion]? = nil,
        lines: [String]? = nil
    ) {
        self.id = id
        self.method = method
        self.title = title
        self.message = message
        self.placeholder = placeholder
        self.secret = secret
        self.prefill = prefill
        self.options = options
        self.optionDetails = optionDetails
        self.checked = checked
        self.questions = questions
        self.lines = lines
    }
}

public struct OptionDetail: Codable, Hashable, Sendable {
    public var description: String?

    public init(description: String? = nil) {
        self.description = description
    }
}

public struct AskQuestion: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var question: String
    public var multi: Bool?
    public var header: String?
    public var recommended: Int?
    public var options: [AskOption]

    public init(id: String, question: String, multi: Bool? = nil, header: String? = nil, recommended: Int? = nil, options: [AskOption]) {
        self.id = id
        self.question = question
        self.multi = multi
        self.header = header
        self.recommended = recommended
        self.options = options
    }
}

public struct AskOption: Codable, Hashable, Identifiable, Sendable {
    public var id: String { label }
    public var label: String
    public var description: String?
    public var preview: String?

    public init(label: String, description: String? = nil, preview: String? = nil) {
        self.label = label
        self.description = description
        self.preview = preview
    }
}

public struct FastModeState: Codable, Hashable, Sendable {
    public var enabled: Bool?
    public var active: Bool?
}

public struct SlowModeState: Codable, Hashable, Sendable {
    public var supported: Bool?
    public var enabled: Bool?
    public var scope: String?
}

public struct SessionModes: Codable, Hashable, Sendable {
    public var steering: String?
    public var followUp: String?
    public var interrupt: String?
}

public struct SessionPrefs: Codable, Hashable, Sendable {
    public var fast: Bool?
    public var autoCompaction: Bool?
    public var autoRetry: Bool?
    public var steeringMode: String?
    public var followUpMode: String?
    public var interruptMode: String?
    public var slowMode: Bool?
    public var cacheWarming: String?
}

public struct SessionLaunchOptions: Codable, Hashable, Sendable {
    public var approvalMode: String?
    public var prewalk: Bool?
    public var planYolo: Bool?
    public var noTools: Bool?
    public var noLsp: Bool?
    public var noPty: Bool?
    public var noSkills: Bool?
    public var noRules: Bool?
    public var noExtensions: Bool?
    public var noTitle: Bool?
    public var smol: String?
    public var slow: String?
    public var plan: String?
    public var prewalkInto: String?
    public var planYoloInto: String?
    public var tools: [String]?
    public var skills: [String]?
    public var maxTime: String?
    public var addDirs: [String]?
    public var systemPrompt: String?
    public var appendSystemPrompt: String?

    public init() {}

    public var activeCount: Int {
        var count = 0
        if approvalMode != nil { count += 1 }
        for b in [prewalk, planYolo, noTools, noLsp, noPty, noSkills, noRules, noExtensions, noTitle] where b == true { count += 1 }
        for s in [smol, slow, plan, prewalkInto, planYoloInto, maxTime, systemPrompt, appendSystemPrompt] where !(s ?? "").isEmpty { count += 1 }
        if !(tools ?? []).isEmpty { count += 1 }
        if !(skills ?? []).isEmpty { count += 1 }
        if !(addDirs ?? []).isEmpty { count += 1 }
        return count
    }

    public func toDictionary() -> [String: Any]? {
        var out: [String: Any] = [:]
        if let approvalMode, !approvalMode.isEmpty { out["approvalMode"] = approvalMode }
        if prewalk == true { out["prewalk"] = true }
        if planYolo == true { out["planYolo"] = true }
        if noTools == true { out["noTools"] = true }
        if noLsp == true { out["noLsp"] = true }
        if noPty == true { out["noPty"] = true }
        if noSkills == true { out["noSkills"] = true }
        if noRules == true { out["noRules"] = true }
        if noExtensions == true { out["noExtensions"] = true }
        if noTitle == true { out["noTitle"] = true }
        if let smol, !smol.isEmpty { out["smol"] = smol }
        if let slow, !slow.isEmpty { out["slow"] = slow }
        if let plan, !plan.isEmpty { out["plan"] = plan }
        if let prewalkInto, !prewalkInto.isEmpty { out["prewalkInto"] = prewalkInto }
        if let planYoloInto, !planYoloInto.isEmpty { out["planYoloInto"] = planYoloInto }
        if let tools, !tools.isEmpty { out["tools"] = tools }
        if let skills, !skills.isEmpty { out["skills"] = skills }
        if let maxTime, !maxTime.isEmpty { out["maxTime"] = maxTime }
        if let addDirs, !addDirs.isEmpty { out["addDirs"] = addDirs }
        if let systemPrompt, !systemPrompt.isEmpty { out["systemPrompt"] = systemPrompt }
        if let appendSystemPrompt, !appendSystemPrompt.isEmpty { out["appendSystemPrompt"] = appendSystemPrompt }
        return out.isEmpty ? nil : out
    }
}

public struct PlanModeState: Codable, Hashable, Sendable {
    public var enabled: Bool?
    public var paused: Bool?
    public var workflow: String?
    public var available: Bool?
    public var reviewPending: Bool?
    public var planFilePath: String?

    public init(
        enabled: Bool? = nil,
        paused: Bool? = nil,
        workflow: String? = nil,
        available: Bool? = nil,
        reviewPending: Bool? = nil,
        planFilePath: String? = nil
    ) {
        self.enabled = enabled
        self.paused = paused
        self.workflow = workflow
        self.available = available
        self.reviewPending = reviewPending
        self.planFilePath = planFilePath
    }
}

public struct PlanProposal: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String?
    public var content: String?
    public var planFilePath: String?
    public var plan: String?
    public var summary: String?
    public var filePath: String?
    public var workflow: String?
    public var executionModel: String?

    public init(
        id: String,
        title: String? = nil,
        content: String? = nil,
        planFilePath: String? = nil,
        plan: String? = nil,
        summary: String? = nil,
        filePath: String? = nil,
        workflow: String? = nil,
        executionModel: String? = nil
    ) {
        self.id = id
        self.title = title
        self.content = content
        self.planFilePath = planFilePath
        self.plan = plan
        self.summary = summary
        self.filePath = filePath
        self.workflow = workflow
        self.executionModel = executionModel
    }

    public var markdownContent: String {
        content ?? plan ?? summary ?? ""
    }

    public var resolvedFilePath: String? {
        planFilePath ?? filePath
    }
}

public struct GoalState: Codable, Hashable, Sendable {
    public var objective: String?
    public var status: String?
    public var tokensUsed: Int?
    public var tokenBudget: Int?
}

public struct LoopState: Codable, Hashable, Sendable {
    public var state: String // running | waiting | paused
    public var description: String?
    public var prompt: String?
}

public struct AdvisorState: Codable, Hashable, Sendable {
    public var enabled: Bool?
    public var noModel: Bool?
    public var model: String?
    public var count: Int?
    public var contextTokens: Int?
    public var contextWindow: Int?
    public var cost: Double?
    public var name: String?
    public var state: String?
    public var at: String?
}

public struct SessionOverlap: Codable, Hashable, Identifiable, Sendable {
    public var id: String { "\(sessionId ?? ""):\(title ?? "")" }
    public var sessionId: String?
    public var title: String?
    public var files: [String]?
    public var count: Int?

    enum CodingKeys: String, CodingKey {
        case sessionId = "id"
        case title, files, count
    }
}

public struct SessionNotice: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var level: String // info | warning | error
    public var text: String
    public var at: String?
}

public struct RetryState: Codable, Hashable, Sendable {
    public var attempt: Int?
    public var maxAttempts: Int?
    public var delayMs: Int?
    public var error: String?
    public var at: String?
}

public struct OpenUrlPrompt: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var url: String
    public var title: String?
    public var instructions: String?
}

public struct AutoResumeWindow: Codable, Hashable, Sendable {
    public var at: String
}

public struct ConnectionResumeWindow: Codable, Hashable, Sendable {
    public var at: String
    public var attempt: Int?
}

public struct EditorTextPrompt: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var text: String
}

public struct RateLimitHint: Codable, Hashable, Sendable {
    public var waitMs: Int?
    public var until: String?
    public var provider: String?
    public var reason: String?
    public var remaining: Int?
}

public struct TodoPhase: Codable, Hashable, Identifiable, Sendable {
    public var id: String { name }
    public var name: String
    public var tasks: [TodoItem]

    public init(name: String, tasks: [TodoItem]) {
        self.name = name
        self.tasks = tasks
    }
}

public enum TodoStatus: String, Codable, Hashable, CaseIterable, Sendable {
    case pending
    case inProgress = "in_progress"
    case completed
    case abandoned
    case blocked

    public var label: String {
        switch self {
        case .pending: return "Pending"
        case .inProgress: return "In Progress"
        case .completed: return "Completed"
        case .abandoned: return "Abandoned"
        case .blocked: return "Blocked"
        }
    }
}

public struct TodoItem: Codable, Hashable, Identifiable, Sendable {
    public var id: String { "\(content):\(status.rawValue)" }
    public var content: String
    public var status: TodoStatus
    public var blocker: String?
    public var details: String?
    public var notes: [String]?

    public init(content: String, status: TodoStatus, blocker: String? = nil, details: String? = nil, notes: [String]? = nil) {
        self.content = content
        self.status = status
        self.blocker = blocker
        self.details = details
        self.notes = notes
    }
}

public struct ActivityItem: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var projectId: String?
    public var sessionId: String?
    public var text: String
    public var type: String // update | review | error | done | paused
    public var at: String
}

public struct AutoShutdownError: Codable, Hashable, Sendable {
    public var message: String
    public var at: String?

    public init(message: String, at: String? = nil) {
        self.message = message
        self.at = at
    }
}

public struct AutoShutdownState: Codable, Hashable, Sendable {
    public var on: Bool
    public var firing: Bool?
    public var since: String?
    public var error: AutoShutdownError?
    public var busyCount: Int?

    enum CodingKeys: String, CodingKey {
        case on, firing, since, error, busyCount
    }

    public init(on: Bool, firing: Bool? = nil, since: String? = nil, error: AutoShutdownError? = nil, busyCount: Int? = nil) {
        self.on = on
        self.firing = firing
        self.since = since
        self.error = error
        self.busyCount = busyCount
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        on = try c.decode(Bool.self, forKey: .on)
        firing = try c.decodeIfPresent(Bool.self, forKey: .firing)
        since = try c.decodeIfPresent(String.self, forKey: .since)
        busyCount = try c.decodeIfPresent(Int.self, forKey: .busyCount)
        if let obj = try? c.decodeIfPresent(AutoShutdownError.self, forKey: .error) {
            error = obj
        } else if let str = try? c.decodeIfPresent(String.self, forKey: .error), !str.isEmpty {
            error = AutoShutdownError(message: str, at: nil)
        } else {
            error = nil
        }
    }
}

public struct BtwRecord: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var question: String
    public var answer: String
    public var status: String // running | complete | cancelled | error | interrupted
    public var error: String?
    public var createdAt: Double
    public var followUps: [BtwTurn]?
}

public struct BtwTurn: Codable, Hashable, Identifiable, Sendable {
    public var id: String { "\(createdAt):\(question.prefix(24))" }
    public var question: String
    public var answer: String
    public var status: String
    public var error: String?
    public var createdAt: Double
}

// MARK: - Workspaces, History, Subagents & Files

public struct BrowseListing: Codable, Hashable, Sendable {
    public var path: String
    public var parent: String?
    public var isGit: Bool?
    public var project: String?
    public var roots: [BrowseRoot]?
    public var recent: [BrowseRecent]?
    public var dirs: [BrowseEntry]
    public var files: [BrowseEntry]?
}

public struct BrowseRoot: Codable, Hashable, Identifiable, Sendable {
    public var id: String { path }
    public var path: String
    public var name: String
}

public struct BrowseRecent: Codable, Hashable, Identifiable, Sendable {
    public var id: String { path }
    public var path: String
    public var name: String
    public var lastUsed: String?
    public var project: String?
}

public struct BrowseEntry: Codable, Hashable, Identifiable, Sendable {
    public var id: String { path }
    public var name: String
    public var path: String
}

public struct FileSearchResponse: Codable, Hashable, Sendable {
    public var path: String
    public var files: [FileMatch]
    public var truncated: Bool?
}

public struct FileMatch: Codable, Hashable, Identifiable, Sendable {
    public var id: String { path }
    public var name: String
    public var rel: String
    public var path: String
}

public struct NativeSessionsResponse: Codable, Hashable, Sendable {
    public var dir: String?
    public var sessions: [NativeSessionSummary]
}

public struct NativeSessionSummary: Codable, Identifiable, Hashable, Sendable {
    public var id: String { file }
    public var file: String
    public var title: String?
    public var named: Bool?
    public var cwd: String?
    public var sessionUUID: String?
    public var preview: String?
    public var model: String?
    public var thinking: String?
    public var updatedAt: String
    public var createdAt: String?
    public var parent: String?
    public var parentTitle: String?
    public var managedId: String?
    public var size: Int?

    enum CodingKeys: String, CodingKey {
        case file, title, named, cwd, sessionUUID = "id", preview, model, thinking, updatedAt, createdAt, parent, parentTitle, managedId, size
    }

    public var panelKey: String { "f:\(file)" }
}

public struct NativeSessionPreview: Codable, Hashable, Sendable {
    public var file: String
    public var title: String?
    public var cwd: String?
    public var id: String?
    public var createdAt: String?
    public var updatedAt: String?
    public var preview: String?
    public var model: String?
    public var thinking: String?
    public var contextTokens: Int?
    public var messages: [TranscriptMessage]
}

public struct SubagentInfo: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var agent: String?
    public var description: String?
    public var status: String
    public var sessionFile: String?
    public var remote: Bool?
    public var parentToolCallId: String?
    public var lastUpdate: Double?
    public var progress: [String: JSONValue]?
    public var thinking: String?
    public var startedAt: String?
    public var model: String?
    public var thinkingLevel: String?
    public var cost: Double?
    public var result: String?

    public init(
        id: String,
        agent: String? = nil,
        description: String? = nil,
        status: String,
        sessionFile: String? = nil,
        remote: Bool? = nil,
        parentToolCallId: String? = nil,
        lastUpdate: Double? = nil,
        progress: [String: JSONValue]? = nil,
        thinking: String? = nil,
        startedAt: String? = nil,
        model: String? = nil,
        thinkingLevel: String? = nil,
        cost: Double? = nil,
        result: String? = nil
    ) {
        self.id = id
        self.agent = agent
        self.description = description
        self.status = status
        self.sessionFile = sessionFile
        self.remote = remote
        self.parentToolCallId = parentToolCallId
        self.lastUpdate = lastUpdate
        self.progress = progress
        self.thinking = thinking
        self.startedAt = startedAt
        self.model = model
        self.thinkingLevel = thinkingLevel
        self.cost = cost
        self.result = result
    }

    public var isActive: Bool {
        let lower = status.lowercased()
        return lower.contains("run") || lower.contains("pend") || lower.contains("start") || lower.contains("queue")
    }
}

public struct BackgroundTask: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var order: Int?
    public var type: String?
    public var agent: String?
    public var title: String?
    public var task: String?
    public var intent: String?
    public var toolCallId: String?
    public var command: String?
    public var startedAt: String?
    public var finishedAt: String?
    public var durationMs: Int?
    public var status: String?
    public var output: String?
    public var transcript: String?
    public var model: String?
    public var thinking: String?
    public var summary: String?
    public var cost: Double?
    public var updatedAt: String?

    public init(
        id: String,
        order: Int? = nil,
        type: String? = nil,
        agent: String? = nil,
        title: String? = nil,
        task: String? = nil,
        intent: String? = nil,
        toolCallId: String? = nil,
        command: String? = nil,
        startedAt: String? = nil,
        finishedAt: String? = nil,
        durationMs: Int? = nil,
        status: String? = nil,
        output: String? = nil,
        transcript: String? = nil,
        model: String? = nil,
        thinking: String? = nil,
        summary: String? = nil,
        cost: Double? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.order = order
        self.type = type
        self.agent = agent
        self.title = title
        self.task = task
        self.intent = intent
        self.toolCallId = toolCallId
        self.command = command
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.durationMs = durationMs
        self.status = status
        self.output = output
        self.transcript = transcript
        self.model = model
        self.thinking = thinking
        self.summary = summary
        self.cost = cost
        self.updatedAt = updatedAt
    }
}

public struct BackgroundSubagentItem: Codable, Identifiable, Hashable, Sendable {
    public var id: String { file }
    public var name: String
    public var file: String
    public var size: Int?
    public var startedAt: String?
    public var updatedAt: String?
    public var model: String?
    public var thinking: String?
    public var preview: String?
    public var result: String?
    public var cost: Double?
    public var advisor: Bool?
}

public struct BackgroundLogFile: Codable, Identifiable, Hashable, Sendable {
    public var id: String { file }
    public var name: String
    public var file: String
    public var size: Int?
    public var updatedAt: String?
}

public struct BackgroundJob: Identifiable, Hashable, Sendable {
    public var id: String
    public var type: String
    public var agent: String?
    public var title: String
    public var task: String?
    public var intent: String?
    public var command: String?
    public var status: String // running | done | error | stale | cancelled
    public var transcript: String?
    public var logFile: String?
    public var model: String?
    public var thinking: String?
    public var cost: Double?
    public var durationMs: Int?
    public var output: String?
    public var summary: String?
    public var startedAt: String?
    public var finishedAt: String?
    public var liveAgent: SubagentInfo?

    public var isRunning: Bool { status == "running" }
}

public struct BackgroundViewResponse: Codable, Hashable, Sendable {
    public var dir: String?
    public var live: Bool?
    public var tasks: [BackgroundTask]?
    public var agents: [SubagentInfo]?
    public var subagents: [BackgroundSubagentItem]?
    public var jobs: [BackgroundLogFile]?

    public init(
        dir: String? = nil,
        live: Bool? = nil,
        tasks: [BackgroundTask]? = nil,
        agents: [SubagentInfo]? = nil,
        subagents: [BackgroundSubagentItem]? = nil,
        jobs: [BackgroundLogFile]? = nil
    ) {
        self.dir = dir
        self.live = live
        self.tasks = tasks
        self.agents = agents
        self.subagents = subagents
        self.jobs = jobs
    }

    public func resolvedJobs(session: SessionSummary?) -> [BackgroundJob] {
        let isLive = live ?? (session != nil && session?.status != .paused && session?.status != .done)
        var mergedAgents = agents ?? []
        for reg in session?.subagentList ?? [] where !reg.id.isEmpty {
            if let idx = mergedAgents.firstIndex(where: { $0.id == reg.id }) {
                mergedAgents[idx].status = reg.status
                mergedAgents[idx].description = reg.description ?? mergedAgents[idx].description
                mergedAgents[idx].progress = reg.progress ?? mergedAgents[idx].progress
                mergedAgents[idx].thinking = reg.thinking ?? mergedAgents[idx].thinking
                if let file = reg.sessionFile, !file.isEmpty { mergedAgents[idx].sessionFile = file }
            } else {
                mergedAgents.append(reg)
            }
        }

        var result: [BackgroundJob] = (tasks ?? []).map { t in
            BackgroundJob(
                id: t.id,
                type: t.type ?? "task",
                agent: t.agent,
                title: t.title ?? t.id,
                task: t.task,
                intent: t.intent,
                command: t.command,
                status: t.status ?? "done",
                transcript: t.transcript?.isEmpty == false ? t.transcript : nil,
                logFile: nil,
                model: t.model?.isEmpty == false ? t.model : nil,
                thinking: t.thinking?.isEmpty == false ? t.thinking : nil,
                cost: t.cost,
                durationMs: t.durationMs,
                output: t.output,
                summary: t.summary,
                startedAt: t.startedAt,
                finishedAt: t.finishedAt,
                liveAgent: nil
            )
        }

        for a in mergedAgents {
            let low = a.status.lowercased()
            let mappedStatus: String
            if low.contains("run") || low.contains("pend") || low.contains("start") || low.contains("queue") {
                mappedStatus = "running"
            } else if low.contains("fail") || low.contains("error") || low.contains("abort") {
                mappedStatus = "error"
            } else if !a.status.isEmpty {
                mappedStatus = "done"
            } else {
                mappedStatus = "running"
            }

            if let idx = result.firstIndex(where: { $0.id == a.id }) {
                if mappedStatus == "running" && isLive { result[idx].status = "running" }
                result[idx].liveAgent = a
                if result[idx].transcript == nil, let sf = a.sessionFile, !sf.isEmpty { result[idx].transcript = sf }
                if result[idx].model == nil, let m = a.model, !m.isEmpty { result[idx].model = m }
                if result[idx].thinking == nil, let th = a.thinkingLevel, !th.isEmpty { result[idx].thinking = th }
            } else {
                result.append(BackgroundJob(
                    id: a.id,
                    type: "task",
                    agent: a.agent,
                    title: (a.description?.isEmpty == false ? a.description : nil) ?? a.id,
                    task: nil,
                    intent: nil,
                    command: nil,
                    status: isLive ? mappedStatus : "stale",
                    transcript: a.sessionFile?.isEmpty == false ? a.sessionFile : nil,
                    logFile: nil,
                    model: a.model?.isEmpty == false ? a.model : nil,
                    thinking: a.thinkingLevel?.isEmpty == false ? a.thinkingLevel : nil,
                    cost: a.cost,
                    durationMs: nil,
                    output: nil,
                    summary: a.result,
                    startedAt: a.startedAt,
                    finishedAt: nil,
                    liveAgent: a
                ))
            }
        }

        for sub in subagents ?? [] where sub.advisor != true && !result.contains(where: { $0.id == sub.name }) {
            result.append(BackgroundJob(
                id: sub.name,
                type: "task",
                agent: "subagent",
                title: sub.name,
                task: nil,
                intent: nil,
                command: nil,
                status: "done",
                transcript: sub.file,
                logFile: nil,
                model: sub.model?.isEmpty == false ? sub.model : nil,
                thinking: sub.thinking?.isEmpty == false ? sub.thinking : nil,
                cost: sub.cost,
                durationMs: nil,
                output: nil,
                summary: sub.result,
                startedAt: sub.startedAt ?? sub.updatedAt,
                finishedAt: sub.updatedAt,
                liveAgent: nil
            ))
        }

        let logs = jobs ?? []
        for idx in result.indices {
            if let log = logs.first(where: { $0.name.hasPrefix(result[idx].id + ".") || $0.name == result[idx].id + ".async.log" }) {
                result[idx].logFile = log.file
            }
        }

        return result
    }
}

public struct SubagentTranscriptResponse: Codable, Hashable, Sendable {
    public var title: String?
    public var cwd: String?
    public var model: String?
    public var thinking: String?
    public var file: String
    public var result: String?
    public var active: Bool?
    public var updatedAt: String?
    public var messages: [TranscriptMessage]
}

public struct LogResponse: Codable, Hashable, Sendable {
    public var file: String
    public var size: Int
    public var text: String
}

// MARK: - Commands, Models, Usage, Drafts & Enhance

public struct CommandsResponse: Codable, Hashable, Sendable {
    public var commands: [SlashCommandInfo]
}

public struct SlashCommandInfo: Codable, Identifiable, Hashable, Sendable {
    public var id: String { name }
    public var name: String
    public var description: String?
    public var aliases: [String]?
    public var hint: String?
    public var source: String?
    public var subcommands: [SlashSubcommandInfo]?
}

public struct SlashSubcommandInfo: Codable, Identifiable, Hashable, Sendable {
    public var id: String { name }
    public var name: String
    public var description: String?
    public var usage: String?
}

public struct ModelsResponse: Codable, Hashable, Sendable {
    public var models: [ModelEntry]
    public var roles: [String: String]?
    public var defaultThinking: String?
    public var thinkingLevels: [String]?
}

public struct ModelEntry: Codable, Identifiable, Hashable, Sendable {
    public var id: String { selector }
    public var selector: String
    public var provider: String
    public var modelId: String
    public var name: String
    public var reasoning: Bool?
    public var thinking: [String]?
    public var contextWindow: Int?
    public var fast: Bool?

    enum CodingKeys: String, CodingKey {
        case selector, provider, modelId = "id", name, reasoning, thinking, contextWindow, fast
    }
}

public struct ProviderUsageResponse: Codable, Hashable, Sendable {
    public var provider: String
    public var model: String
    public var providers: [ProviderUsageGroup]
    public var updatedAt: String?
}

public struct ProviderUsageGroup: Codable, Identifiable, Hashable, Sendable {
    public var id: String { provider }
    public var provider: String
    public var accounts: [UsageAccount]
    public var unavailable: String?
}

public struct UsageAccount: Codable, Identifiable, Hashable, Sendable {
    public var id: String { name }
    public var name: String
    public var fetchedAt: String?
    public var notes: [String]
    public var limits: [UsageLimit]
    public var unavailable: String?
}

public struct UsageLimit: Codable, Identifiable, Hashable, Sendable {
    public var id: String { "\(label):\(detail ?? "")" }
    public var label: String
    public var detail: String?
    public var fraction: Double?
    public var summary: String
    public var resetsAt: Double?
    public var resetLabel: String?
    public var notes: [String]
}

public struct DraftReadResponse: Codable, Hashable, Sendable {
    public var text: String
    public var at: Double?
    public var images: [DraftImageEntry]
}

public struct DraftImageEntry: Codable, Hashable, Identifiable, Sendable {
    public var id: String { name }
    public var name: String
    public var mimeType: String?
    public var tokens: Int
    public var preview: String?
    public var image: ImagePart?
}

public struct ImagePart: Codable, Hashable, Sendable {
    public var type: String
    public var mimeType: String
    public var data: String
}

public struct DraftSaveResponse: Codable, Hashable, Sendable {
    public var key: String
    public var at: Double?
    public var images: [String]
}

public enum EnhanceMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case full
    case notest
    case fast

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .full: return "Full spec"
        case .notest: return "No tests"
        case .fast: return "Fast"
        }
    }

    public var subtitle: String {
        switch self {
        case .full: return "Full repo grounding and verification spec"
        case .notest: return "Skip new tests and smoke checks"
        case .fast: return "Lean, quick specification"
        }
    }
}

public struct EnhanceStartResponse: Codable, Hashable, Sendable {
    public var id: String
    public var model: String
    public var mode: String
}

public struct EnhanceStatusResponse: Codable, Hashable, Sendable {
    public var id: String
    public var status: String // running | done | error | cancelled
    public var step: String?
    public var model: String?
    public var mode: String?
    public var text: String?
    public var error: String?
}

// MARK: - Git, Worktrees, Tree & Session Command Responses

public struct WorktreeStatusResponse: Codable, Hashable, Sendable {
    public var root: String?
    public var cwd: String?
    public var exists: Bool?
    public var branch: String?
    public var base: String?
    public var ahead: Int?
    public var behind: Int?
    public var commits: [String]?
    public var dirty: Int?
    public var rootDirty: Int?
    public var remote: String?
    public var upstream: String?
    public var problem: String?
}

public struct WorktreeFinishResponse: Codable, Hashable, Sendable {
    public var action: String?
    public var deleted: Bool?
    public var root: String?
    public var cwd: String?
    public var exists: Bool?
    public var branch: String?
    public var base: String?
    public var ahead: Int?
    public var behind: Int?
    public var commits: [String]?
    public var dirty: Int?
    public var rootDirty: Int?
    public var remote: String?
    public var upstream: String?
    public var problem: String?
}

public struct ChangesWorktreeResponse: Codable, Hashable, Sendable {
    public var cwd: String
    public var base: String
    public var baseLabel: String?
    public var untrackedOmitted: Int?
    public var files: [ToolFileDiff]
}

public struct GitLogResponse: Codable, Hashable, Sendable {
    public var cwd: String
    public var top: String
    public var branch: String
    public var head: String
    public var upstream: String
    public var ahead: Int
    public var behind: Int
    public var dirty: Int?
    public var commits: [GitCommitSummary]
    public var limit: Int
}

public struct GitCommitSummary: Codable, Identifiable, Hashable, Sendable {
    public var id: String { sha }
    public var sha: String
    public var short: String
    public var author: String
    public var date: String
    public var merge: Bool?
    public var subject: String
    public var session: Bool?
}

public struct GitCommitResponse: Codable, Hashable, Sendable {
    public var cwd: String
    public var top: String
    public var sha: String
    public var author: String
    public var date: String
    public var message: String
    public var files: [ToolFileDiff]
}

public struct BranchMessagesResponse: Codable, Hashable, Sendable {
    public var messages: [BranchMessageItem]
}

public struct BranchMessageItem: Codable, Identifiable, Hashable, Sendable {
    public var id: String { entryId }
    public var entryId: String
    public var text: String
}

public struct BranchResultResponse: Codable, Sendable {
    public var session: SessionSummary
    public var text: String
    public var images: [ImagePart]?
}

public struct TreeViewResponse: Codable, Hashable, Sendable {
    public var leafId: String?
    public var nodes: [TreeNodeItem]?
    public var truncated: Bool?
}

public struct TreeNodeItem: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var kind: String? // user | assistant | compaction | branch
    public var text: String?
    public var at: String?
    public var label: String?
    public var depth: Int?
    public var forks: Int?
    public var onPath: Bool?
}

public struct SessionStatsResponse: Codable, Hashable, Sendable {
    public var stats: [String: JSONValue]
}

public struct ExportHtmlResponse: Codable, Hashable, Sendable {
    public var name: String
    public var html: String
}

public struct LoginProvidersResponse: Codable, Hashable, Sendable {
    public var providers: [LoginProviderInfo]
}

public struct LoginProviderInfo: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var available: Bool
    public var authenticated: Bool
}

public struct PredictWordResponse: Codable, Hashable, Sendable {
    public var suffix: String?
}

public struct BtwResultResponse: Codable, Hashable, Sendable {
    public var record: BtwRecord?
}

public struct BtwHistoryResponse: Codable, Hashable, Sendable {
    public var records: [BtwRecord]
}

// MARK: - Settings, Admin, Spend, Plugins, MCP, Tools, Storage & Screen

public struct SettingsResponse: Codable, Hashable, Sendable {
    public var file: String?
    public var settings: [SettingItem]
    public var changed: String?
}

public struct SettingItem: Codable, Identifiable, Hashable, Sendable {
    public var id: String { key }
    public var key: String
    public var type: String // boolean | number | string | array | record | enum
    public var group: String
    public var options: [String]?
    public var description: String
    public var sensitive: Bool
    public var value: JSONValue?
    public var isSet: Bool
    public var `default`: JSONValue?
    public var modified: Bool
}

public struct AdvisorConfigResponse: Codable, Hashable, Sendable {
    public var model: String
    public var source: String
    public var file: String?
    public var enabled: Bool
}

public struct PluginsResponse: Codable, Hashable, Sendable {
    public var plugins: [PluginItem]
    public var available: [AvailablePlugin]
}

public struct PluginItem: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var version: String?
    public var scope: String?
    public var enabled: Bool
    public var description: String?
}

public struct AvailablePlugin: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var description: String
}

public struct McpResponse: Codable, Hashable, Sendable {
    public var servers: [McpServerItem]
    public var userFile: String?
    public var projectConfig: Bool
    public var warnings: [String]
}

public struct McpServerItem: Codable, Identifiable, Hashable, Sendable {
    public var id: String { "\(project?.id ?? "user")|\(name)" }
    public var name: String
    public var enabled: Bool
    public var state: String // active | disabled | shadowed
    public var reason: String?
    public var transport: String // stdio | http
    public var source: McpSource
    public var writable: Bool
    public var project: McpProjectRef?
    public var command: String?
    public var args: [String]?
    public var cwd: String?
    public var url: String?
    public var env: [String]?
    public var headers: [String]?
    public var timeout: Int?
    public var instructions: Bool?
    public var auth: String?
    public var oauth: Bool?
}

public struct McpSource: Codable, Hashable, Sendable {
    public var provider: String
    public var providerName: String
    public var path: String?
    public var level: String?
}

public struct McpProjectRef: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var path: String?
}

public struct AccountsResponse: Codable, Hashable, Sendable {
    public var providers: [ProviderAccountGroup]
}

public struct ProviderAccountGroup: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var accounts: [String]
    public var selected: String?
}

public struct UpdateStateResponse: Codable, Hashable, Sendable {
    public var status: String // idle | running | done | error
    public var startedAt: String?
    public var finishedAt: String?
    public var result: JSONValue?
    public var output: String?
    public var error: String?
}

public struct SpendResponse: Codable, Hashable, Sendable {
    public var rows: [SpendRow]
    public var syncing: Bool
    public var syncError: String?
}

public struct SpendRow: Codable, Hashable, Identifiable, Sendable {
    public var id: String { "\(at):\(model)" }
    public var at: String
    public var model: String
    public var cost: Double
}

public struct CliPollResponse: Codable, Hashable, Sendable {
    public var tools: [String: CliToolCatalogEntry]?
    public var jobs: [CliJob]
}

public struct CliToolCatalogEntry: Codable, Hashable, Sendable {
    public var title: String
    public var description: String
    public var actions: [String: CliToolAction]
}

public struct CliToolAction: Codable, Hashable, Sendable {
    public var label: String
    public var cwd: String?
    public var confirm: String?
    public var confirmIf: String?
    public var command: String
    public var fields: [CliToolField]
}

public struct CliToolField: Codable, Identifiable, Hashable, Sendable {
    public var id: String { name }
    public var name: String
    public var type: String // bool | text | int | select | model | dir | session | list
    public var label: String
    public var placeholder: String?
    public var pattern: String?
    public var options: [String]?
    public var required: Bool?
    public var `default`: JSONValue?
    public var min: Int?
    public var max: Int?
    public var flag: String?
}

public struct CliJob: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var tool: String?
    public var action: String?
    public var command: String?
    public var cwd: String?
    public var status: String // running | done | error
    public var output: String?
    public var exitCode: Int?
    public var startedAt: String?
    public var finishedAt: String?
    public var stopped: Bool?
    public var rev: Int?
    public var unchanged: Bool?
}

public struct StorageResponse: Codable, Hashable, Sendable {
    public var job: StorageJob?
    public var scannedAt: String?
    public var worktrees: [StorageWorktree]
    public var orphans: [StorageOrphan]
    public var locations: [StorageLocation]
    public var results: [StorageActionResult]
    public var error: String?
}

public struct StorageJob: Codable, Hashable, Sendable {
    public var kind: String?
    public var total: Int?
    public var done: Int?
    public var startedAt: String?
}

public struct StorageWorktree: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String?
    public var project: String?
    public var cwd: String?
    public var branch: String?
    public var status: String?
    public var archived: Bool?
    public var hidden: Bool?
    public var busy: Bool?
    public var exists: Bool?
    public var base: String?
    public var ahead: Int?
    public var behind: Int?
    public var dirty: Int?
    public var problem: String?
    public var error: String?
    public var bytes: Int64?
    public var tracked: Int64?
    public var linked: Int64?
    public var safe: Bool?
}

public struct StorageOrphan: Codable, Identifiable, Hashable, Sendable {
    public var id: String { dir }
    public var dir: String
    public var name: String?
    public var kind: String?
    public var sessionId: String?
    public var title: String?
    public var root: String?
    public var branch: String?
    public var dirty: Int?
    public var bytes: Int64?
    public var tracked: Int64?
    public var linked: Int64?
}

public struct StorageLocation: Codable, Identifiable, Hashable, Sendable {
    public var id: String { key ?? label }
    public var key: String?
    public var label: String
    public var path: String?
    public var group: String?
    public var cap: Int64?
    public var bytes: Int64?
    public var tracked: Int64?
    public var linked: Int64?
    public var missing: Bool?
}

public struct StorageActionResult: Codable, Identifiable, Hashable, Sendable {
    public var id: String { "\(key ?? ""):\(error ?? "")" }
    public var key: String?
    public var ok: Bool?
    public var freed: Int64?
    public var error: String?
}

public struct ScreenInfoResponse: Codable, Hashable, Sendable {
    public var supported: Bool
    public var enabled: Bool
    public var desktop: Bool?
    public var viewer: ScreenViewerInfo?
}

public struct ScreenViewerInfo: Codable, Hashable, Sendable {
    public var address: String?
    public var since: String?
}

public struct ScreenTicketResponse: Codable, Hashable, Sendable {
    public var ticket: String
}

public struct TailscaleInfoResponse: Codable, Hashable, Sendable {
    public var port: Int?
    public var host: String?
    public var tailscale: TailscaleSelfInfo?
    public var tailnetUrls: [String]
    public var lanUrls: [String]
}

public struct TailscaleSelfInfo: Codable, Hashable, Sendable {
    public var name: String?
    public var ips: [String]?
}

public struct APIErrorBody: Codable, Sendable {
    public var error: String?
}

public struct OpenTerminalResponse: Codable, Hashable, Sendable {
    public var path: String
}

public struct OpenFileResponse: Codable, Hashable, Sendable {
    public var path: String
    public var editor: String
}

public struct OkResponse: Codable, Hashable, Sendable {
    public var ok: Bool?
}
