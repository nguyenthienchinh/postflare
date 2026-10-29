import Foundation

// Mirrors of `shared/types.ts` (docs/ios-api.md). Times are Unix milliseconds (Double), ids prefixed strings.

// MARK: - JSON values (post settings, field defaults)

/// Any JSON value: post `settings`, settings field defaults and `showIf` values.
enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .string(s): try c.encode(s)
        case let .number(n): try c.encode(n)
        case let .bool(b): try c.encode(b)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        case .null: try c.encodeNil()
        }
    }

    var string: String? { if case let .string(s) = self { s } else { nil } }
    var bool: Bool? { if case let .bool(b) = self { b } else { nil } }
    var number: Double? { if case let .number(n) = self { n } else { nil } }

    /// Empty string, null and empty array count as "not set".
    var isEmpty: Bool {
        switch self {
        case let .string(s): s.trimmingCharacters(in: .whitespaces).isEmpty
        case let .array(a): a.isEmpty
        case .null: true
        default: false
        }
    }

    /// Short text for the post detail's settings list.
    var display: String {
        switch self {
        case let .string(s): s
        case let .number(n): n.rounded() == n ? String(Int(n)) : String(n)
        case let .bool(b): b ? String(localized: "Yes") : String(localized: "No")
        case let .array(a): a.map(\.display).joined(separator: ", ")
        case .object: "…"
        case .null: "—"
        }
    }
}

// MARK: - Users, workspaces

struct RoleRef: Codable, Hashable, Sendable {
    var id: String
    var name: String
}

struct User: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var email: String
    var role: RoleRef
    var demo: Bool?
}

/// GET /api/me `workspaces`.
struct Workspace: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var role: RoleRef
    var permissions: [String]
    var viaAdmin: Bool?
    var demo: Bool?

    func can(_ permission: String) -> Bool { permissions.contains(permission) }
}

struct Me: Codable, Sendable {
    var user: User
    var instancePermissions: [String]
    var workspaces: [Workspace]
    var currentWorkspaceId: String?

    func can(_ permission: String) -> Bool { instancePermissions.contains(permission) }
}

/// POST /api/auth/device and POST /api/auth/pair.
struct DeviceTokenResponse: Codable, Sendable {
    var token: String
    var deviceId: String
    var user: User
    var instancePermissions: [String]
    var workspaces: [Workspace]
    var currentWorkspaceId: String?
    var server: String

    var me: Me { Me(user: user, instancePermissions: instancePermissions, workspaces: workspaces, currentWorkspaceId: currentWorkspaceId) }
}

/// GET /api/auth/status (no auth).
struct AuthStatus: Codable, Sendable {
    var setup: Bool
    var authenticated: Bool?
    var demo: Bool?
    var magicLink: Bool?
    var signup: Bool?
    var turnstileSiteKey: String?
    var appLogin: Bool?
    var pushLogin: Bool?
    var appStoreUrl: String?
    /// off | apply ("Request access" on /apply) | open ("Create an account").
    var signupMode: String?
}

/// GET /api/version.
struct ServerVersion: Codable, Sendable {
    var version: String
    var commit: String
    var apiVersion: Int
}

// MARK: - Devices

struct DevicePrefs: Codable, Hashable, Sendable {
    var published = true
    var failed = true
    /// Instance admins (`instance.users.manage`): a new access request arrived.
    var accessRequests = true
    /// Support staff (`instance.support.manage`): a customer wrote in a support chat.
    var support = true
    /// nil = all the user's workspaces.
    var workspaces: [String]?

    init(published: Bool = true, failed: Bool = true, accessRequests: Bool = true, support: Bool = true, workspaces: [String]? = nil) {
        self.published = published
        self.failed = failed
        self.accessRequests = accessRequests
        self.support = support
        self.workspaces = workspaces
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        published = try c.decodeIfPresent(Bool.self, forKey: .published) ?? true
        failed = try c.decodeIfPresent(Bool.self, forKey: .failed) ?? true
        accessRequests = try c.decodeIfPresent(Bool.self, forKey: .accessRequests) ?? true
        support = try c.decodeIfPresent(Bool.self, forKey: .support) ?? true
        workspaces = try c.decodeIfPresent([String].self, forKey: .workspaces)
    }

    /// `workspaces: null` must be sent explicitly (it means "all").
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(published, forKey: .published)
        try c.encode(failed, forKey: .failed)
        try c.encode(accessRequests, forKey: .accessRequests)
        try c.encode(support, forKey: .support)
        try c.encode(workspaces, forKey: .workspaces)
    }

    private enum CodingKeys: String, CodingKey { case published, failed, accessRequests, support, workspaces }
}

struct Device: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String?
    var push: Bool
    var environment: String
    var prefs: DevicePrefs
    var createdAt: Double
    var lastSeenAt: Double?
    var lastPushAt: Double?
    var current: Bool?

    var isCurrent: Bool { current == true }
}

struct DeviceList: Codable, Sendable {
    var items: [Device]
    /// APNs is configured on the server.
    var push: Bool
}

/// POST /api/auth/app-login/:id/inspect: what the approval sheet shows.
struct WebLoginInfo: Codable, Hashable, Sendable {
    /// "qr" | "push"
    var kind: String
    var ip: String?
    var city: String?
    var country: String?
    var browser: String
    var os: String
    var server: String?
    var createdAt: Double
    var expiresAt: Double
    /// Push requests: three numbers, one of them shown in the browser.
    var numbers: [Int]?

    var isPush: Bool { kind == "push" }
    var place: String? {
        let parts = [city, country].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

// MARK: - Access requests

/// GET /api/access-requests[/:id] (instance.users.manage): someone asking for an account on /apply.
struct AccessRequest: Codable, Hashable, Identifiable, Sendable {
    struct Reviewer: Codable, Hashable, Sendable {
        var id: String
        var name: String
    }

    var id: String
    var name: String
    var email: String
    var company: String?
    var url: String
    /// creator | agency | startup | brand | other
    var role: String
    /// x | instagram | tiktok | youtube | linkedin | facebook | threads | bluesky | pinterest | other
    var platforms: [String]
    var accounts: Int?
    /// 1-30 | 31-100 | 101-300 | 301-1000 | 1000+
    var volume: String?
    var useCase: String
    var referral: String?
    /// pending | approved | rejected | withdrawn
    var status: String
    var ip: String?
    /// Two-letter country code.
    var country: String?
    var userAgent: String?
    var createdAt: Double
    var updatedAt: Double
    var reviewedBy: Reviewer?
    var reviewedAt: Double?
    var reviewNote: String?
    var invitationId: String?
    /// The applicant signed up with the invitation.
    var invitationAccepted: Bool
    /// An account with this email exists on the instance.
    var existingUser: Bool

    var isPending: Bool { status == "pending" }
    var isApproved: Bool { status == "approved" }
    var isRejected: Bool { status == "rejected" }
    var website: URL? { URL(string: url).flatMap { $0.host() == nil ? nil : $0 } }
    /// The company, else the website's host.
    var organization: String {
        if let company, !company.trimmingCharacters(in: .whitespaces).isEmpty { return company }
        return website?.host().map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 } ?? url
    }
}

struct AccessRequestCounts: Codable, Hashable, Sendable {
    var pending = 0
    var approved = 0
    var rejected = 0
    var withdrawn = 0

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pending = try c.decodeIfPresent(Int.self, forKey: .pending) ?? 0
        approved = try c.decodeIfPresent(Int.self, forKey: .approved) ?? 0
        rejected = try c.decodeIfPresent(Int.self, forKey: .rejected) ?? 0
        withdrawn = try c.decodeIfPresent(Int.self, forKey: .withdrawn) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case pending, approved, rejected, withdrawn }
}

/// GET /api/access-requests
struct AccessRequestList: Codable, Sendable {
    var items: [AccessRequest]
    var counts: AccessRequestCounts
    /// `before` of the next page; nil = no more.
    var nextBefore: Double?
}

/// GET /api/access-requests/count
struct AccessRequestPendingCount: Codable, Sendable {
    var pending: Int
}

struct CreatedInvitation: Codable, Hashable, Sendable {
    var id: String
    var url: String
    var expiresAt: Double
}

/// PATCH /api/access-requests/:id
struct AccessRequestReview: Codable, Hashable, Sendable {
    var request: AccessRequest
    /// Approved: the invitation link. Absent when the email already has an account.
    var invitation: CreatedInvitation?
    /// Approved, but the email already has an account: only marked approved.
    var existingUser: Bool?
    /// An email went to the applicant.
    var emailed: Bool
}

// MARK: - Support chat

/// docs/support-spec.md: open | pending (waiting on the customer) | closed.
enum SupportStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case open, pending, closed
}

/// One message of a support conversation. `note`: internal, never shown to the customer.
struct SupportMessage: Codable, Hashable, Identifiable, Sendable {
    enum Author: String, Codable, Hashable, Sendable { case customer, staff, note }

    var id: String
    var author: Author
    /// Staff: the user's name; customer: their name or nil.
    var authorName: String?
    var body: String
    var createdAt: Double
}

/// GET /api/admin/support/conversations[/:id] (instance.support.manage): a conversation as staff see it.
struct SupportTicket: Codable, Hashable, Identifiable, Sendable {
    struct UserRef: Codable, Hashable, Sendable {
        var id: String
        var name: String
        var email: String
    }

    struct NamedRef: Codable, Hashable, Sendable {
        var id: String
        var name: String
    }

    var id: String
    var number: Int
    var status: SupportStatus
    var subject: String?
    var name: String?
    var email: String?
    /// Staff replies the customer has not seen.
    var unread: Int
    var lastMessageAt: Double
    var lastMessagePreview: String?
    /// customer | staff
    var lastAuthor: String?
    var createdAt: Double
    /// Customer messages no staff member has opened yet.
    var staffUnread: Int
    /// widget | app
    var source: String
    var pageUrl: String?
    var userAgent: String?
    /// Two-letter country code.
    var country: String?
    var ip: String?
    var user: UserRef?
    var workspace: NamedRef?
    var assignee: NamedRef?
    var customerSeenAt: Double?
    var closedAt: Double?
    var updatedAt: Double

    var isUnread: Bool { staffUnread > 0 }
    /// The name, else the email, else "Visitor".
    var displayName: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        if let email, !email.isEmpty { return email }
        return String(localized: "Visitor")
    }
}

struct SupportCounts: Codable, Hashable, Sendable {
    var open = 0
    var pending = 0
    var closed = 0
    var unread = 0
}

/// GET /api/admin/support/conversations
struct SupportTicketList: Codable, Sendable {
    var items: [SupportTicket]
    var counts: SupportCounts
    /// `before` of the next page; nil = no more.
    var nextBefore: Double?
}

/// GET /api/admin/support/conversations/:id (marks it read).
struct SupportThread: Codable, Hashable, Sendable {
    var conversation: SupportTicket
    var messages: [SupportMessage]
}

/// POST /api/admin/support/conversations/:id/messages
struct SupportReply: Codable, Sendable {
    var message: SupportMessage
    var conversation: SupportTicket
}

/// GET /api/admin/support/staff: users who answer support chats (assignee picker).
struct SupportStaff: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var email: String
}

/// GET /api/admin/support/count (badges).
struct SupportBadgeCount: Codable, Sendable {
    var unread: Int
    var open: Int
}

// MARK: - Posts

enum PostStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case draft, scheduled, publishing, published, failed, cancelled
    case needsCheck = "needs_check"

    /// Statuses the server lets `PATCH /posts/:id` change.
    var isEditable: Bool { [.draft, .scheduled, .failed, .cancelled].contains(self) }
}

struct ThreadItem: Codable, Hashable, Sendable {
    var content: String
    var media: [String]
}

struct PostLog: Codable, Hashable, Identifiable, Sendable {
    var id: Int
    /// info | warn | error
    var level: String
    var message: String
    var createdAt: Double
}

/// Tracked App Store link of a post (only what the app shows).
struct CampaignLink: Codable, Hashable, Sendable {
    var trackedUrl: String?
    var clicks: Int?
    var downloads: Int?
    var proceeds: Double?
    var currency: String?
}

struct Post: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var groupId: String
    var accountId: String
    var status: PostStatus
    var scheduledAt: Double?
    var content: String
    var media: [String]
    var settings: [String: JSONValue]
    var thread: [ThreadItem]
    var externalId: String?
    var externalUrl: String?
    var error: String?
    var attempts: Int
    var createdAt: Double
    var updatedAt: Double
    var publishedAt: Double?
    var playbookId: String?
    var playbookVersion: Int?
    var variant: String?
    var appId: String?
    var autoLink: Bool?
    /// GET /api/posts/:id only.
    var logs: [PostLog]?
    var campaign: CampaignLink?

    /// The time the post is about: published, else scheduled, else created (drafts).
    var time: Double { publishedAt ?? scheduledAt ?? createdAt }
    var date: Date { Date(timeIntervalSince1970: time / 1000) }
    var excerpt: String {
        let t = content.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? String(localized: "No text") : t
    }
}

struct OverviewData: Codable, Sendable {
    struct Periods: Codable, Sendable {
        var today: [String: Int]
        var week: [String: Int]
        var todayStart: Double
        var weekStart: Double
    }

    struct AccountCounts: Codable, Sendable {
        var total: Int
        var reconnect: Int
    }

    var counts: [String: Int]
    var periods: Periods
    var upcoming: [Post]
    var recent: [Post]
    var failures: [Post]
    var accounts: AccountCounts
}

/// POST /posts and PATCH /posts/:id bodies.
struct CreatePostsInput: Encodable, Sendable {
    struct Item: Encodable, Sendable {
        var accountId: String
        var content: String
        var media: [String]
        var settings: [String: JSONValue]
        var thread: [ThreadItem]
    }

    /// "now", a ms timestamp, or nil for drafts.
    enum Schedule: Sendable { case now, at(Date), draft }

    var scheduledAt: Schedule
    var posts: [Item]

    private enum CodingKeys: String, CodingKey { case scheduledAt, posts }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch scheduledAt {
        case .now: try c.encode("now", forKey: .scheduledAt)
        case let .at(date): try c.encode((date.timeIntervalSince1970 * 1000).rounded(), forKey: .scheduledAt)
        case .draft: try c.encodeNil(forKey: .scheduledAt)
        }
        try c.encode(posts, forKey: .posts)
    }
}

struct ValidationResult: Codable, Sendable {
    var errors: [String]
}

// MARK: - Accounts

struct MetricValues: Codable, Hashable, Sendable {
    var impressions: Double?
    var reach: Double?
    var views: Double?
    var likes: Double?
    var comments: Double?
    var shares: Double?
    var saves: Double?
    var clicks: Double?
    var replies: Double?
    var reposts: Double?
    var quotes: Double?
    var followers: Double?
    var following: Double?
    var posts: Double?
    /// Minutes watched in total (YouTube, Instagram reels).
    var watchTimeMinutes: Double?
    /// Average length of a view in seconds. Not additive.
    var avgViewDurationSeconds: Double?
    /// Average share of the video watched per view, 0-100 (YouTube). Not additive.
    var avgViewPercentage: Double?
    /// Platform-specific numbers (profile_visits, subscribers_gained, upvote_ratio, ...).
    var extra: [String: Double]?

    init() {}

    /// Lenient: a key of the wrong type or a non-number in `extra` is skipped instead of failing the response.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        impressions = c.lenient(.impressions)
        reach = c.lenient(.reach)
        views = c.lenient(.views)
        likes = c.lenient(.likes)
        comments = c.lenient(.comments)
        shares = c.lenient(.shares)
        saves = c.lenient(.saves)
        clicks = c.lenient(.clicks)
        replies = c.lenient(.replies)
        reposts = c.lenient(.reposts)
        quotes = c.lenient(.quotes)
        followers = c.lenient(.followers)
        following = c.lenient(.following)
        posts = c.lenient(.posts)
        watchTimeMinutes = c.lenient(.watchTimeMinutes)
        avgViewDurationSeconds = c.lenient(.avgViewDurationSeconds)
        avgViewPercentage = c.lenient(.avgViewPercentage)
        if let raw: [String: JSONValue] = c.lenient(.extra) {
            let numbers = raw.compactMapValues(\.number)
            extra = numbers.isEmpty ? nil : numbers
        }
    }

    private enum CodingKeys: String, CodingKey {
        case impressions, reach, views, likes, comments, shares, saves, clicks, replies, reposts, quotes, followers, following, posts
        case watchTimeMinutes, avgViewDurationSeconds, avgViewPercentage, extra
    }

    /// likes + comments + shares + saves + replies + reposts + quotes + clicks (shared/types.ts `engagements`).
    var engagements: Double {
        [likes, comments, shares, saves, replies, reposts, quotes, clicks].compactMap { $0 }.reduce(0, +)
    }

    /// views, else impressions, else reach.
    var exposure: Double? { views ?? impressions ?? reach }

    /// engagements / exposure, nil without an exposure.
    var engagementRate: Double? { exposure.flatMap { $0 > 0 ? engagements / $0 : nil } }

    /// A numeric key by name (`MetricKey`), else an `extra` value.
    subscript(key: String) -> Double? {
        switch key {
        case "impressions": impressions
        case "reach": reach
        case "views": views
        case "likes": likes
        case "comments": comments
        case "shares": shares
        case "saves": saves
        case "clicks": clicks
        case "replies": replies
        case "reposts": reposts
        case "quotes": quotes
        case "followers": followers
        case "following": following
        case "posts": posts
        case "watchTimeMinutes": watchTimeMinutes
        case "avgViewDurationSeconds": avgViewDurationSeconds
        case "avgViewPercentage": avgViewPercentage
        default: extra?[key]
        }
    }
}

extension KeyedDecodingContainer {
    /// The value, or nil when the key is missing, null or of another type.
    func lenient<T: Decodable>(_ key: Key) -> T? { (try? decodeIfPresent(T.self, forKey: key)) ?? nil }

    /// A number, 0 when missing or invalid.
    func number(_ key: Key) -> Double { lenient(key) ?? 0 }

    /// The array's valid elements (invalid ones are skipped); empty when missing.
    func lossy<T: Decodable>(_ key: Key) -> [T] {
        guard var list = try? nestedUnkeyedContainer(forKey: key) else { return [] }
        return list.lossyElements()
    }
}

extension UnkeyedDecodingContainer {
    mutating func lossyElements<T: Decodable>() -> [T] {
        var out: [T] = []
        while !isAtEnd {
            if let v = try? decode(T.self) { out.append(v) }
            else if (try? decode(JSONValue.self)) == nil { break }
        }
        return out
    }
}

/// A JSON array whose invalid elements are skipped (list endpoints).
struct LossyList<T: Decodable>: Decodable {
    var items: [T]
    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        items = c.lossyElements()
    }
}

struct AccountMetricsStatus: Codable, Hashable, Sendable {
    var status: String
    var message: String?
    var checkedAt: Double?
    var metrics: MetricValues?
}

struct Account: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var provider: String
    var name: String
    var username: String?
    var avatarUrl: String?
    var profileUrl: String?
    /// active | disabled | reconnect
    var status: String
    var statusMessage: String?
    var expiresAt: Double?
    var createdAt: Double
    var metricsStatus: AccountMetricsStatus?
    var groupId: String?

    var handle: String? { username.map { $0.hasPrefix("@") ? $0 : "@\($0)" } }
    var needsReconnect: Bool { status == "reconnect" }
}

struct AccountGroup: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var color: String
    var position: Int
    var accountCount: Int
}

// MARK: - Platforms

struct FieldOption: Codable, Hashable, Sendable {
    var value: String
    var label: String
}

struct FieldDef: Codable, Hashable, Sendable {
    struct ShowIf: Codable, Hashable, Sendable {
        var key: String
        var equals: JSONValue
    }

    var key: String
    var label: String
    /// text | textarea | password | number | select | checkbox | url | tags | datetime
    var type: String
    var required: Bool?
    var placeholder: String?
    var help: String?
    var options: [FieldOption]?
    var dynamicOptions: Bool?
    var `default`: JSONValue?
    var maxLength: Int?
    var showIf: ShowIf?

    var isRequired: Bool { required == true }
}

struct ProviderInfo: Codable, Hashable, Identifiable, Sendable {
    struct Capabilities: Codable, Hashable, Sendable {
        struct Media: Codable, Hashable, Sendable {
            var images: Int
            var videos: Int
            var mixed: Bool
            var required: Bool
        }

        var maxLength: Int
        /// required | optional | none
        var text: String
        var media: Media
        var thread: Bool
        var threadLabel: String?
        var mediaNote: String?
    }

    struct Analytics: Codable, Hashable, Sendable {
        var post: Bool
        var account: Bool
        /// Metric keys the platform reports (post and account); nil from older servers.
        var metrics: [String]?
    }

    var id: String
    var name: String
    /// Brand hex without '#'.
    var color: String
    var category: String
    var settingsFields: [FieldDef]
    var capabilities: Capabilities
    var analytics: Analytics?
    var status: String?
    var composerNotice: String?
}

// MARK: - Media

struct Media: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var filename: String
    var mime: String
    var size: Double
    /// image | video
    var kind: String
    var width: Double?
    var height: Double?
    var duration: Double?
    var alt: String?
    /// Public media URL (CDN or signed `/m/` link), no auth header.
    var url: String
    /// Small WebP thumbnail of an image (max 480 px); nil for videos and older images.
    var thumbUrl: String?
    var createdAt: Double

    var isVideo: Bool { kind == "video" }
    var fullURL: URL? { URL(string: url) }
    /// The thumbnail, else the full media.
    var thumbnailURL: URL? { thumbUrl.flatMap(URL.init(string:)) ?? fullURL }
}

struct MultipartStart: Codable, Sendable {
    var id: String
    var partSize: Int
    var parts: Int
}

struct MultipartPart: Codable, Hashable, Sendable {
    var partNumber: Int
    var etag: String
}

// MARK: - Analytics

/// Totals over a range of published posts (missing keys from older servers count as 0).
struct AnalyticsTotals: Codable, Hashable, Sendable {
    var posts: Double = 0
    var postsWithMetrics: Double = 0
    var views: Double = 0
    var impressions: Double = 0
    var reach: Double = 0
    var engagements: Double = 0
    var likes: Double = 0
    var comments: Double = 0
    var shares: Double = 0
    var saves: Double = 0
    var watchTimeMinutes: Double = 0
    var engagementRate: Double?
    var followers: Double?
    var followersChange: Double?
    var campaignPosts: Double = 0
    var clicks: Double = 0
    var downloads: Double = 0
    var redownloads: Double = 0
    var proceeds: Double = 0

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        posts = c.number(.posts)
        postsWithMetrics = c.number(.postsWithMetrics)
        views = c.number(.views)
        impressions = c.number(.impressions)
        reach = c.number(.reach)
        engagements = c.number(.engagements)
        likes = c.number(.likes)
        comments = c.number(.comments)
        shares = c.number(.shares)
        saves = c.number(.saves)
        watchTimeMinutes = c.number(.watchTimeMinutes)
        engagementRate = c.lenient(.engagementRate)
        followers = c.lenient(.followers)
        followersChange = c.lenient(.followersChange)
        campaignPosts = c.number(.campaignPosts)
        clicks = c.number(.clicks)
        downloads = c.number(.downloads)
        redownloads = c.number(.redownloads)
        proceeds = c.number(.proceeds)
    }

    private enum CodingKeys: String, CodingKey {
        case posts, postsWithMetrics, views, impressions, reach, engagements, likes, comments, shares, saves, watchTimeMinutes
        case engagementRate, followers, followersChange, campaignPosts, clicks, downloads, redownloads, proceeds
    }

    /// Average exposure per post with metrics, nil without any.
    var viewsPerPost: Double? { postsWithMetrics > 0 ? views / postsWithMetrics : nil }
}

/// Totals of one platform (`key` = provider id) or one account (`key` = account id).
@dynamicMemberLookup
struct AnalyticsBreakdown: Codable, Hashable, Identifiable, Sendable {
    var key: String
    var provider: String
    var accountId: String?
    var name: String
    var username: String?
    var totals: AnalyticsTotals

    var id: String { key }

    subscript<V>(dynamicMember path: KeyPath<AnalyticsTotals, V>) -> V { totals[keyPath: path] }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        provider = c.lenient(.provider) ?? ""
        accountId = c.lenient(.accountId)
        name = c.lenient(.name) ?? key
        username = c.lenient(.username)
        totals = try AnalyticsTotals(from: decoder)
    }

    func encode(to encoder: Encoder) throws {
        try totals.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        try c.encode(provider, forKey: .provider)
        try c.encodeIfPresent(accountId, forKey: .accountId)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(username, forKey: .username)
    }

    private enum CodingKeys: String, CodingKey { case key, provider, accountId, name, username }
}

/// One day (YYYY-MM-DD in the summary's tz); numbers of the posts published that day.
struct AnalyticsDay: Codable, Hashable, Sendable {
    var day: String
    var posts: Double
    var views: Double
    var engagements: Double
    /// Newer servers only.
    var likes: Double?
    var comments: Double?
    var shares: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = try c.decode(String.self, forKey: .day)
        posts = c.number(.posts)
        views = c.number(.views)
        engagements = c.number(.engagements)
        likes = c.lenient(.likes)
        comments = c.lenient(.comments)
        shares = c.lenient(.shares)
    }

    private enum CodingKeys: String, CodingKey { case day, posts, views, engagements, likes, comments, shares }
}

/// Follower counts of one account, one point per collected (UTC) day.
struct FollowerSeries: Codable, Hashable, Identifiable, Sendable {
    struct Point: Codable, Hashable, Sendable {
        var day: String
        var followers: Double
    }

    var accountId: String
    var provider: String
    var name: String
    var points: [Point]

    var id: String { accountId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try c.decode(String.self, forKey: .accountId)
        provider = c.lenient(.provider) ?? ""
        name = c.lenient(.name) ?? accountId
        points = c.lossy(.points)
    }

    private enum CodingKeys: String, CodingKey { case accountId, provider, name, points }
}

struct AnalyticsSummary: Codable, Sendable {
    var from: Double
    var to: Double
    var tz: String
    var totals: AnalyticsTotals
    var previous: AnalyticsTotals
    var byProvider: [AnalyticsBreakdown]
    var byAccount: [AnalyticsBreakdown]
    var daily: [AnalyticsDay]
    var followers: [FollowerSeries]
    /// Currency of `proceeds`.
    var currency: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = c.number(.from)
        to = c.number(.to)
        tz = c.lenient(.tz) ?? TimeZone.current.identifier
        totals = c.lenient(.totals) ?? AnalyticsTotals()
        previous = c.lenient(.previous) ?? AnalyticsTotals()
        byProvider = c.lossy(.byProvider)
        byAccount = c.lossy(.byAccount)
        daily = c.lossy(.daily)
        followers = c.lossy(.followers)
        currency = c.lenient(.currency)
    }

    private enum CodingKeys: String, CodingKey { case from, to, tz, totals, previous, byProvider, byAccount, daily, followers, currency }
}

/// Results of a tracked App Store link: Postflare clicks and Apple's numbers for its campaign token.
struct CampaignResults: Codable, Hashable, Sendable {
    var clicks: Double = 0
    /// First-time downloads; nil until Revflare reported the token.
    var downloads: Double?
    var redownloads: Double?
    var purchases: Double?
    var proceeds: Double?
    var sales: Double?
    var currency: String?
    /// Latest report day (YYYY-MM-DD).
    var asOf: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clicks = c.number(.clicks)
        downloads = c.lenient(.downloads)
        redownloads = c.lenient(.redownloads)
        purchases = c.lenient(.purchases)
        proceeds = c.lenient(.proceeds)
        sales = c.lenient(.sales)
        currency = c.lenient(.currency)
        asOf = c.lenient(.asOf)
    }

    private enum CodingKeys: String, CodingKey { case clicks, downloads, redownloads, purchases, proceeds, sales, currency, asOf }
}

struct AnalyticsPost: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var groupId: String
    var accountId: String
    var provider: String
    var accountName: String
    var accountUsername: String?
    var excerpt: String
    var media: [String]
    var externalId: String?
    var externalUrl: String?
    var publishedAt: Double
    var metrics: MetricValues?
    var metricsAt: Double?
    /// Next scheduled collection, nil when collection stopped.
    var metricsNextAt: Double?
    var engagements: Double
    var engagementRate: Double?
    var campaign: CampaignResults?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        groupId = c.lenient(.groupId) ?? id
        accountId = c.lenient(.accountId) ?? ""
        provider = c.lenient(.provider) ?? ""
        accountName = c.lenient(.accountName) ?? ""
        accountUsername = c.lenient(.accountUsername)
        excerpt = c.lenient(.excerpt) ?? ""
        media = c.lossy(.media)
        externalId = c.lenient(.externalId)
        externalUrl = c.lenient(.externalUrl)
        publishedAt = c.number(.publishedAt)
        metrics = c.lenient(.metrics)
        metricsAt = c.lenient(.metricsAt)
        metricsNextAt = c.lenient(.metricsNextAt)
        engagements = c.lenient(.engagements) ?? metrics?.engagements ?? 0
        engagementRate = c.lenient(.engagementRate)
        campaign = c.lenient(.campaign)
    }

    private enum CodingKeys: String, CodingKey {
        case id, groupId, accountId, provider, accountName, accountUsername, excerpt, media, externalId, externalUrl, publishedAt
        case metrics, metricsAt, metricsNextAt, engagements, engagementRate, campaign
    }
}

/// Structured analytics of a post (YouTube): audience retention and traffic sources.
struct MetricDetails: Codable, Hashable, Sendable {
    struct RetentionPoint: Hashable, Sendable {
        /// Share of the video elapsed, 0...1.
        var progress: Double
        /// Share of the views still watching (can exceed 1 when parts are rewatched).
        var ratio: Double
    }

    struct TrafficSource: Codable, Hashable, Sendable {
        var source: String
        var views: Double

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            source = c.lenient(.source) ?? "UNKNOWN"
            views = c.number(.views)
        }

        private enum CodingKeys: String, CodingKey { case source, views }
    }

    /// `[[progress, ratio], ...]` on the wire.
    var retention: [[Double]]?
    var trafficSources: [TrafficSource]?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let points: [[Double]] = c.lossy(.retention)
        retention = points.isEmpty ? nil : points
        let sources: [TrafficSource] = c.lossy(.trafficSources)
        trafficSources = sources.isEmpty ? nil : sources
    }

    private enum CodingKeys: String, CodingKey { case retention, trafficSources }

    var retentionPoints: [RetentionPoint] {
        (retention ?? []).compactMap { $0.count >= 2 ? RetentionPoint(progress: $0[0], ratio: $0[1]) : nil }.sorted { $0.progress < $1.progress }
    }
}

struct PostMetrics: Codable, Sendable {
    struct Snapshot: Codable, Hashable, Sendable {
        var capturedAt: Double
        var metrics: MetricValues

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            capturedAt = try c.decode(Double.self, forKey: .capturedAt)
            metrics = c.lenient(.metrics) ?? MetricValues()
        }

        private enum CodingKeys: String, CodingKey { case capturedAt, metrics }
    }

    var postId: String
    var publishedAt: Double?
    var metrics: MetricValues?
    var metricsAt: Double?
    var metricsNextAt: Double?
    var snapshots: [Snapshot]
    var details: MetricDetails?
    var detailsAt: Double?
    var campaign: CampaignResults?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        postId = c.lenient(.postId) ?? ""
        publishedAt = c.lenient(.publishedAt)
        metrics = c.lenient(.metrics)
        metricsAt = c.lenient(.metricsAt)
        metricsNextAt = c.lenient(.metricsNextAt)
        snapshots = c.lossy(.snapshots)
        details = c.lenient(.details)
        detailsAt = c.lenient(.detailsAt)
        campaign = c.lenient(.campaign)
    }

    private enum CodingKeys: String, CodingKey { case postId, publishedAt, metrics, metricsAt, metricsNextAt, snapshots, details, detailsAt, campaign }
}

/// Response of POST /analytics/refresh.
struct AnalyticsRefresh: Decodable, Sendable {
    struct AccountState: Decodable, Sendable {
        var id: String
        var metricsStatus: AccountMetricsStatus?
        var postsRefreshed: Int?
    }

    var post: AnalyticsPost?
    var account: AccountState?
}

// MARK: - Billing

struct PlanSummary: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var isFree: Bool?
}

struct Billing: Codable, Sendable {
    var enabled: Bool
    var exempt: Bool
    /// unlimited | plan | trial | free | locked
    var state: String
    var plan: PlanSummary?
    /// none | trialing | active | past_due | canceled | expired
    var status: String
    var trialEndsAt: Double?
    var currentPeriodEnd: Double?
    var graceEndsAt: Double?
    var canManage: Bool
}

/// 402 `{ code: "plan_limit" }` (PlanLimitErrorDTO).
struct PlanLimit: Codable, Hashable, Sendable {
    var error: String
    var limit: String?
    var upgradeUrl: String?
}
