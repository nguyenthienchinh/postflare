import Foundation

/// What the widgets show: built from `GET /overview` (and the account names from `GET /accounts`), cached so a widget
/// still renders the last numbers offline.
struct WidgetSnapshot: Codable, Sendable {
    struct UpcomingPost: Codable, Hashable, Identifiable, Sendable {
        var id: String
        var provider: String
        var accountName: String
        var excerpt: String
        var at: Date?
        var publishing: Bool
    }

    var workspaceName: String?
    var today: [String: Int]
    var week: [String: Int]
    var upcoming: [UpcomingPost]
    var attention: Int
    var asOf: Date

    func today(_ s: PostStatus) -> Int { today[s.rawValue] ?? 0 }
    func week(_ s: PostStatus) -> Int { week[s.rawValue] ?? 0 }
    var todayFailed: Int { today(.failed) + today(.needsCheck) }

    init(_ o: OverviewData, accounts: [Account], workspaceName: String?) {
        let byId = Dictionary(accounts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        self.workspaceName = workspaceName
        today = o.periods.today
        week = o.periods.week
        upcoming = o.upcoming.prefix(6).map { p in
            let a = byId[p.accountId]
            return UpcomingPost(id: p.id, provider: a?.provider ?? "", accountName: a?.name ?? "", excerpt: p.excerpt,
                                at: p.scheduledAt.map(Fmt.date(ms:)), publishing: p.status == .publishing)
        }
        attention = (o.counts[PostStatus.failed.rawValue] ?? 0) + (o.counts[PostStatus.needsCheck.rawValue] ?? 0)
        asOf = .now
    }

    init(workspaceName: String?, today: [String: Int], week: [String: Int], upcoming: [UpcomingPost], attention: Int, asOf: Date) {
        self.workspaceName = workspaceName
        self.today = today
        self.week = week
        self.upcoming = upcoming
        self.attention = attention
        self.asOf = asOf
    }

    static let preview = WidgetSnapshot(
        workspaceName: "Acme Studio",
        today: ["published": 3, "scheduled": 2],
        week: ["published": 14, "scheduled": 6, "failed": 1],
        upcoming: [
            .init(id: "1", provider: "instagram", accountName: "Acme", excerpt: "Behind the scenes of our new release", at: .now.addingTimeInterval(3600), publishing: false),
            .init(id: "2", provider: "x", accountName: "acme", excerpt: "Version 2.0 is live: dark mode, widgets and more", at: .now.addingTimeInterval(4 * 3600), publishing: false),
            .init(id: "3", provider: "tiktok", accountName: "Acme Games", excerpt: "60 seconds of level 12", at: .now.addingTimeInterval(26 * 3600), publishing: false),
        ],
        attention: 1,
        asOf: .now
    )
}

enum WidgetData {
    private static var cacheKey: String { ResponseCache.key("widget") }

    /// Fresh snapshot from the server, else the cached one (offline), else nil (signed out).
    static func load() async -> WidgetSnapshot? {
        guard let client = APIClient.current() else { return nil }
        do {
            async let overview = client.overview(todayStart: Periods.todayStart(), weekStart: Periods.weekStart())
            async let accounts = client.accounts()
            let snap = WidgetSnapshot(try await overview, accounts: (try? await accounts) ?? [], workspaceName: SharedSettings.workspaceName)
            ResponseCache.store(snap, key: cacheKey)
            return snap
        } catch {
            return ResponseCache.load(WidgetSnapshot.self, key: cacheKey)
        }
    }

}
