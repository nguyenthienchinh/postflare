import Foundation

enum APIError: LocalizedError, Equatable {
    case notSignedIn
    /// 401 with a device token: the token is gone (`device_signed_out`), back to the sign-in screen.
    case unauthorized
    /// 402 `{ code: "plan_limit" }`: the workspace's plan does not allow it (hosted mode).
    case planLimit(PlanLimit)
    /// Any other 4xx/5xx: the server's message, and its list of validation errors when it sent one.
    case server(status: Int, message: String, errors: [String] = [], captchaRequired: Bool = false)
    case invalidResponse
    case network(String)

    var errorDescription: String? {
        switch self {
        case .notSignedIn: String(localized: "You are not signed in.")
        case .unauthorized: String(localized: "This device was signed out. Please sign in again.")
        case let .planLimit(limit): limit.error
        case let .server(_, message, _, _): message
        case .invalidResponse: String(localized: "The server sent an unexpected response.")
        case let .network(message): message
        }
    }

    var status: Int? {
        switch self {
        case let .server(status, _, _, _): status
        case .planLimit: 402
        case .unauthorized: 401
        default: nil
        }
    }
}

/// Talks to `<server>/api` with the device token (`Authorization: Bearer pfd_...`) and the workspace
/// (`X-Workspace-Id`). Used by the app and the widgets.
struct APIClient: Sendable {
    var server: URL
    var token: String?
    var workspaceId: String?

    /// The API version this app speaks (`GET /api/version` → `apiVersion`, shared/version.ts API_VERSION).
    static let supportedAPIVersions = 1...1

    /// The signed-in client (keychain + shared settings), or nil.
    static func current() -> APIClient? {
        guard let creds = Keychain.load() else { return nil }
        return APIClient(server: creds.server, token: creds.token, workspaceId: SharedSettings.workspaceId)
    }

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        return URLSession(configuration: config)
    }()

    static let decoder = JSONDecoder()
    static let encoder = JSONEncoder()

    /// `{ "error": "...", "code": "...", "errors": [...], "captchaRequired": true }`
    private struct ErrorBody: Decodable {
        var error: String?
        var code: String?
        var errors: [String]?
        var captchaRequired: Bool?
    }

    /// Normalizes what the user typed ("postflare.example.com" → https://postflare.example.com).
    static func normalizeServer(_ text: String) -> URL? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if s.isEmpty { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        guard let url = URL(string: s), url.host() != nil else { return nil }
        return url
    }

    func url(_ path: String, query: [String: String?] = [:]) -> URL {
        var comps = URLComponents(url: server.appending(path: "api" + path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }.sorted { $0.name < $1.name }
        if !items.isEmpty { comps.queryItems = items }
        return comps.url!
    }

    /// A request with the auth and workspace headers.
    func request(_ method: String, _ path: String, query: [String: String?] = [:]) -> URLRequest {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let workspaceId { request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id") }
        return request
    }

    func send<T: Decodable>(_ method: String = "GET", _ path: String, query: [String: String?] = [:], body: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        var request = request(method, path, query: query)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.encoder.encode(body)
        }
        let (data, response) = try await perform { try await Self.session.data(for: request) }
        return try decode(data, response, path: path)
    }

    /// Runs a URLSession call, mapping cancellation and transport errors.
    func perform(_ call: () async throws -> (Data, URLResponse)) async throws -> (Data, URLResponse) {
        do {
            return try await call()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.network(error.localizedDescription)
        }
    }

    /// Checks the status and decodes the body (`IgnoredResponse` accepts anything).
    func decode<T: Decodable>(_ data: Data, _ response: URLResponse, path: String, as type: T.Type = T.self) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? Self.decoder.decode(ErrorBody.self, from: data)
            let message = body?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            if http.statusCode == 401, token != nil { throw APIError.unauthorized }
            if http.statusCode == 402, body?.code == "plan_limit", let limit = try? Self.decoder.decode(PlanLimit.self, from: data) {
                throw APIError.planLimit(limit)
            }
            throw APIError.server(status: http.statusCode, message: message, errors: body?.errors ?? [], captchaRequired: body?.captchaRequired == true)
        }
        if T.self == IgnoredResponse.self, let ignored = IgnoredResponse() as? T { return ignored }
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            #if DEBUG
            print("Decoding \(T.self) from \(path) failed: \(error)")
            #endif
            throw APIError.invalidResponse
        }
    }

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], as type: T.Type = T.self) async throws -> T {
        try await send("GET", path, query: query, as: type)
    }
}

/// Accepts any JSON body (or none).
struct IgnoredResponse: Decodable {
    init() {}
    init(from decoder: Decoder) throws {}
}

// MARK: - Endpoints

private func ms(_ date: Date) -> String { String(Int64((date.timeIntervalSince1970 * 1000).rounded())) }

extension APIClient {
    // Server
    func authStatus() async throws -> AuthStatus { try await get("/auth/status") }
    func version() async throws -> ServerVersion { try await get("/version") }

    // Auth
    private struct DeviceLogin: Encodable { var email: String; var password: String; var deviceName: String }
    private struct PairLogin: Encodable { var code: String; var deviceName: String }

    func signIn(email: String, password: String, deviceName: String) async throws -> DeviceTokenResponse {
        try await send("POST", "/auth/device", body: DeviceLogin(email: email, password: password, deviceName: deviceName))
    }

    func pair(code: String, deviceName: String) async throws -> DeviceTokenResponse {
        try await send("POST", "/auth/pair", body: PairLogin(code: code, deviceName: deviceName))
    }

    func signOut() async throws { _ = try await send("POST", "/auth/device/logout", as: IgnoredResponse.self) }

    // Profile
    func me() async throws -> Me { try await get("/me") }

    private struct WorkspaceChoice: Encodable { var workspaceId: String }
    func rememberWorkspace(_ id: String) async throws {
        _ = try await send("POST", "/me/workspace", body: WorkspaceChoice(workspaceId: id), as: IgnoredResponse.self)
    }

    func billing() async throws -> Billing { try await get("/billing") }

    // Home
    func overview(todayStart: Date, weekStart: Date) async throws -> OverviewData {
        try await get("/overview", query: ["todayStart": ms(todayStart), "weekStart": ms(weekStart)])
    }

    // Posts
    struct PostQuery: Hashable, Sendable {
        var from: Date?
        var to: Date?
        var statuses: Set<PostStatus> = []
        var accountId: String?
        var accountGroupId: String?
        var groupId: String?
        var ascending = false
        var limit = 200
    }

    func posts(_ q: PostQuery) async throws -> [Post] {
        try await get("/posts", query: [
            "from": q.from.map(ms), "to": q.to.map(ms),
            "status": q.statuses.isEmpty ? nil : q.statuses.map(\.rawValue).sorted().joined(separator: ","),
            "accountId": q.accountId, "accountGroupId": q.accountGroupId, "groupId": q.groupId,
            "order": q.ascending ? "asc" : "desc", "limit": String(q.limit),
        ])
    }

    func post(_ id: String) async throws -> Post { try await get("/posts/\(id)") }

    func createPosts(_ input: CreatePostsInput) async throws -> [Post] { try await send("POST", "/posts", body: input) }

    func validatePosts(_ input: CreatePostsInput) async throws -> [String] {
        let r: ValidationResult = try await send("POST", "/posts/validate", body: input)
        return r.errors
    }

    /// Moves a post to `date`, or makes it a draft (nil).
    func reschedule(_ id: String, to date: Date?) async throws -> Post {
        struct Body: Encodable {
            var scheduledAt: Double?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(scheduledAt, forKey: .scheduledAt)
            }
            enum CodingKeys: String, CodingKey { case scheduledAt }
        }
        return try await send("PATCH", "/posts/\(id)", body: Body(scheduledAt: date.map { ($0.timeIntervalSince1970 * 1000).rounded() }))
    }

    func retry(_ id: String) async throws -> Post { try await send("POST", "/posts/\(id)/retry") }
    func cancel(_ id: String) async throws -> Post { try await send("POST", "/posts/\(id)/cancel") }
    func deletePost(_ id: String) async throws { _ = try await send("DELETE", "/posts/\(id)", as: IgnoredResponse.self) }

    /// needs_check: "it is live" (with its link) or "publish it again".
    func resolve(_ id: String, published: Bool, url: String?) async throws -> Post {
        struct Body: Encodable { var published: Bool; var url: String? }
        return try await send("POST", "/posts/\(id)/resolve", body: Body(published: published, url: url))
    }

    func postMetrics(_ id: String) async throws -> PostMetrics { try await get("/posts/\(id)/metrics") }

    // Accounts and platforms
    func accounts() async throws -> [Account] { try await get("/accounts") }
    func accountGroups() async throws -> [AccountGroup] { try await get("/account-groups") }
    func providers() async throws -> [ProviderInfo] { try await get("/providers") }

    func options(accountId: String, key: String, settings: [String: JSONValue]? = nil) async throws -> [FieldOption] {
        let json = settings.flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) }
        return try await get("/accounts/\(accountId)/options/\(key)", query: ["settings": json])
    }

    // Media
    func media(limit: Int = 200, before: Double? = nil) async throws -> [Media] {
        try await get("/media", query: ["limit": String(limit), "before": before.map { String(Int64($0)) }])
    }

    func deleteMedia(_ id: String) async throws { _ = try await send("DELETE", "/media/\(id)", as: IgnoredResponse.self) }

    // Analytics
    /// Narrows analytics to one platform or one account (`provider` / `accountId` query).
    struct AnalyticsScope: Hashable, Sendable {
        var provider: String?
        var accountId: String?
        static let all = AnalyticsScope()
    }

    /// Sort keys of `GET /analytics/posts`.
    enum AnalyticsSort: String, CaseIterable, Sendable {
        case views, engagements, engagementRate, publishedAt, clicks, downloads, proceeds
    }

    func analyticsSummary(from: Date, to: Date, scope: AnalyticsScope = .all) async throws -> AnalyticsSummary {
        try await get("/analytics/summary", query: [
            "from": ms(from), "to": ms(to), "tz": TimeZone.current.identifier,
            "provider": scope.provider, "accountId": scope.accountId,
        ])
    }

    func topPosts(from: Date, to: Date, scope: AnalyticsScope = .all, sort: AnalyticsSort = .views, limit: Int = 10, offset: Int = 0) async throws -> [AnalyticsPost] {
        let list: LossyList<AnalyticsPost> = try await get("/analytics/posts", query: [
            "from": ms(from), "to": ms(to), "tz": TimeZone.current.identifier, "sort": sort.rawValue,
            "limit": String(min(max(limit, 1), 200)), "offset": offset > 0 ? String(offset) : nil,
            "provider": scope.provider, "accountId": scope.accountId,
        ])
        return list.items
    }

    /// Collects a post's metrics now (published posts only; the server returns the stored values within a minute).
    func refreshPostMetrics(_ postId: String) async throws -> AnalyticsRefresh {
        struct Body: Encodable { var postId: String }
        return try await send("POST", "/analytics/refresh", body: Body(postId: postId))
    }

    /// Collects an account's metrics (followers) and its posts' now.
    func refreshAccountMetrics(_ accountId: String) async throws -> AnalyticsRefresh {
        struct Body: Encodable { var accountId: String }
        return try await send("POST", "/analytics/refresh", body: Body(accountId: accountId))
    }

    // Devices and push
    struct DeviceUpdate: Encodable {
        var apnsToken: String?
        var environment: String
        var name: String
        var prefs: DevicePrefs?

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            // `apnsToken: null` turns push off, so it is always sent.
            try c.encode(apnsToken, forKey: .apnsToken)
            try c.encode(environment, forKey: .environment)
            try c.encode(name, forKey: .name)
            try c.encodeIfPresent(prefs, forKey: .prefs)
        }

        enum CodingKeys: String, CodingKey { case apnsToken, environment, name, prefs }
    }

    func updateThisDevice(_ update: DeviceUpdate) async throws -> Device { try await send("PUT", "/devices/me", body: update) }
    func updatePrefs(_ prefs: DevicePrefs) async throws -> Device { try await send("PATCH", "/devices/me/prefs", body: prefs) }
    func devices() async throws -> DeviceList { try await get("/devices") }
    func deleteDevice(_ id: String) async throws { _ = try await send("DELETE", "/devices/\(id)", as: IgnoredResponse.self) }
    func testPush() async throws { _ = try await send("POST", "/devices/me/test", as: IgnoredResponse.self) }

    // Access requests (instance.users.manage): people asking for an account on /apply.
    /// `status`: pending | approved | rejected | withdrawn | all.
    func accessRequests(status: String, query: String? = nil, limit: Int = 50, before: Double? = nil) async throws -> AccessRequestList {
        try await get("/access-requests", query: [
            "status": status, "q": query.flatMap { $0.isEmpty ? nil : $0 },
            "limit": String(limit), "before": before.map { String(Int64($0)) },
        ])
    }

    func pendingAccessRequests() async throws -> Int {
        let r: AccessRequestPendingCount = try await get("/access-requests/count")
        return r.pending
    }

    func accessRequest(_ id: String) async throws -> AccessRequest { try await get("/access-requests/\(id)") }

    /// Approves (a new invitation link each time while it is unused) or rejects; `notify` emails the applicant.
    func reviewAccessRequest(_ id: String, approve: Bool, note: String? = nil, notify: Bool = true) async throws -> AccessRequestReview {
        struct Body: Encodable { var status: String; var note: String?; var notify: Bool }
        return try await send("PATCH", "/access-requests/\(id)", body: Body(status: approve ? "approved" : "rejected", note: note, notify: notify))
    }

    // Support chat (instance.support.manage, docs/support-spec.md): the staff inbox.
    /// `status`: open | pending | closed | all; `mine`: assigned to me; `before`: `nextBefore` of the previous page.
    func supportConversations(status: String, mine: Bool = false, query: String? = nil, limit: Int = 50, before: Double? = nil) async throws -> SupportTicketList {
        try await get("/admin/support/conversations", query: [
            "status": status, "mine": mine ? "1" : nil, "q": query.flatMap { $0.isEmpty ? nil : $0 },
            "limit": String(limit), "before": before.map { String(Int64($0)) },
        ])
    }

    /// The conversation with every message (notes included); marks the customer's messages read.
    func supportConversation(_ id: String) async throws -> SupportThread { try await get("/admin/support/conversations/\(id)") }

    /// A reply (sets `status`, by default pending on the server) or an internal note (changes nothing unless `status`).
    func replySupport(_ id: String, body: String, note: Bool = false, status: SupportStatus? = nil) async throws -> SupportReply {
        struct Body: Encodable { var body: String; var note: Bool; var status: SupportStatus? }
        return try await send("POST", "/admin/support/conversations/\(id)/messages", body: Body(body: body, note: note, status: status))
    }

    /// What to change; `assigneeId: .some(nil)` unassigns.
    struct SupportUpdate: Encodable {
        var status: SupportStatus?
        var assigneeId: String??
        var subject: String?

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(status, forKey: .status)
            // `assigneeId: null` unassigns, so a set-but-nil value is sent explicitly.
            if let assigneeId { try c.encode(assigneeId, forKey: .assigneeId) }
            try c.encodeIfPresent(subject, forKey: .subject)
        }

        enum CodingKeys: String, CodingKey { case status, assigneeId, subject }
    }

    func updateSupport(_ id: String, _ update: SupportUpdate) async throws -> SupportTicket {
        struct Response: Decodable { var conversation: SupportTicket }
        let r: Response = try await send("PATCH", "/admin/support/conversations/\(id)", body: update)
        return r.conversation
    }

    func deleteSupport(_ id: String) async throws {
        _ = try await send("DELETE", "/admin/support/conversations/\(id)", as: IgnoredResponse.self)
    }

    func supportStaff() async throws -> [SupportStaff] {
        struct Response: Decodable { var items: [SupportStaff] }
        let r: Response = try await get("/admin/support/staff")
        return r.items
    }

    func supportCount() async throws -> SupportBadgeCount { try await get("/admin/support/count") }

    // Signing a browser in (docs/app-login-spec.md): `nonce` from a QR code, `number` for push requests.
    private struct WebLoginAnswer: Encodable { var nonce: String?; var number: Int? }

    func inspectWebLogin(_ id: String, nonce: String?) async throws -> WebLoginInfo {
        try await send("POST", "/auth/app-login/\(id)/inspect", body: WebLoginAnswer(nonce: nonce))
    }

    func approveWebLogin(_ id: String, nonce: String?, number: Int?) async throws {
        _ = try await send("POST", "/auth/app-login/\(id)/approve", body: WebLoginAnswer(nonce: nonce, number: number), as: IgnoredResponse.self)
    }

    func denyWebLogin(_ id: String, nonce: String?) async throws {
        _ = try await send("POST", "/auth/app-login/\(id)/deny", body: WebLoginAnswer(nonce: nonce), as: IgnoredResponse.self)
    }
}

/// Start of today and of this week (Monday, or the locale's first weekday) in the device's time zone: the
/// `/overview` periods.
enum Periods {
    static func todayStart(_ now: Date = .now) -> Date { Calendar.current.startOfDay(for: now) }

    static func weekStart(_ now: Date = .now) -> Date {
        Calendar.current.dateInterval(of: .weekOfYear, for: now)?.start ?? todayStart(now)
    }
}
