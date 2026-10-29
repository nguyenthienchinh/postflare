import Charts
import SwiftUI

/// Analytics of the posts published in a range (`GET /analytics/summary`, `GET /analytics/posts`), for everything,
/// one platform or one account: KPIs with the change against the previous period, a daily chart, followers per
/// account, platforms and accounts, and the top posts (sortable, paged).
struct AnalyticsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @AppStorage("analytics.range") private var rangeDays = Range.days30.rawValue
    @AppStorage("analytics.filter") private var filterRaw = ""
    @State private var metric: DailyMetric = .views
    @State private var sort: APIClient.AnalyticsSort = .views
    @State private var summary = Loader<AnalyticsSummary>()
    @State private var top = Loader<[AnalyticsPost]>()
    /// Pages after the first ("Show more").
    @State private var more: [AnalyticsPost] = []
    @State private var hasMore = false
    @State private var loadingMore = false
    @State private var moreError: String?
    @State private var selectedDay: Date?
    @State private var choosingFilter = false

    private static let pageSize = 20

    enum Range: Int, CaseIterable, Identifiable {
        case days7 = 7, days30 = 30, days90 = 90, year = 365
        var id: Int { rawValue }
        var title: LocalizedStringKey {
            switch self {
            case .days7: "7 days"
            case .days30: "30 days"
            case .days90: "90 days"
            case .year: "1 year"
            }
        }
    }

    enum DailyMetric: String, CaseIterable, Identifiable {
        case views, engagements, likes, comments, shares, posts
        var id: String { rawValue }
        var title: LocalizedStringKey {
            switch self {
            case .views: "Views"
            case .engagements: "Engagements"
            case .likes: "Likes"
            case .comments: "Comments"
            case .shares: "Shares"
            case .posts: "Posts"
            }
        }

        /// nil when the server does not send the metric per day (older servers).
        func value(_ d: AnalyticsDay) -> Double? {
            switch self {
            case .views: d.views
            case .engagements: d.engagements
            case .likes: d.likes
            case .comments: d.comments
            case .shares: d.shares
            case .posts: d.posts
            }
        }
    }

    private var range: Range { Range(rawValue: rangeDays) ?? .days30 }

    /// The stored filter, or all when its platform / account is no longer in the workspace.
    private var filter: AnalyticsFilter {
        let f = AnalyticsFilter(raw: filterRaw)
        guard !model.accounts.isEmpty else { return f }
        switch f {
        case .all: return .all
        case let .provider(p): return model.accounts.contains { $0.provider == p } ? f : .all
        case let .account(id): return model.account(id) == nil ? .all : f
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                VStack(spacing: 10) {
                    Picker("Range", selection: Binding(get: { range }, set: { rangeDays = $0.rawValue })) {
                        ForEach(Range.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    AnalyticsFilterChip(filter: filter, choose: { choosingFilter = true }, clear: { apply(.all) })
                }

                if let error = summary.error { ErrorBanner(message: error) { Task { await loadAll() } } }

                if let s = summary.value {
                    kpis(s)
                    chartCard(s)
                    if !s.followers.isEmpty { followers(s) }
                    if filter == .all, !s.byProvider.isEmpty {
                        breakdown(title: "By platform", systemImage: "square.grid.2x2", rows: s.byProvider, accounts: false)
                    }
                    if !isAccountFilter, !s.byAccount.isEmpty {
                        breakdown(title: "By account", systemImage: "person.crop.circle", rows: s.byAccount, accounts: true)
                    }
                    topPosts(s)
                    UpdatedLabel(date: summary.updatedAt, offline: summary.offline)
                } else if summary.loading {
                    ProgressView().controlSize(.large).padding(.top, 80)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Analytics")
        .toolbarTitleDisplayMode(.inlineLarge)
        .refreshable { await loadAll() }
        .task(id: SummaryKey(range: range, filter: filter, version: model.dataVersion)) { await loadSummary() }
        .task(id: TopKey(range: range, filter: filter, sort: effectiveSort, version: model.dataVersion)) { await loadTop() }
        .sheet(isPresented: $choosingFilter) {
            AnalyticsFilterSheet(selection: filter) { apply($0) }
        }
    }

    private struct SummaryKey: Hashable { var range: Range; var filter: AnalyticsFilter; var version: Int }
    private struct TopKey: Hashable { var range: Range; var filter: AnalyticsFilter; var sort: APIClient.AnalyticsSort; var version: Int }

    private var isAccountFilter: Bool { if case .account = filter { true } else { false } }

    private func apply(_ f: AnalyticsFilter) {
        selectedDay = nil
        withAnimation(.snappy) { filterRaw = f.raw }
    }

    // MARK: Loading

    private var interval: (Date, Date) {
        let to = Date.now
        let from = Calendar.current.date(byAdding: .day, value: -range.rawValue, to: Calendar.current.startOfDay(for: to).addingTimeInterval(86400)) ?? to
        return (from, to)
    }

    /// Cache entry per range and filter (file-name safe).
    private var cacheFilter: String { filter.raw.replacingOccurrences(of: ":", with: "-") }

    private func loadAll() async {
        async let a: Void = loadSummary()
        async let b: Void = loadTop()
        _ = await (a, b)
    }

    private func loadSummary() async {
        guard let client = model.client else { return }
        let (from, to) = interval
        let scope = filter.scope
        summary.use(cacheKey: ResponseCache.key("analytics", String(range.rawValue), cacheFilter))
        await summary.load { try await client.analyticsSummary(from: from, to: to, scope: scope) }
    }

    private func loadTop() async {
        guard let client = model.client else { return }
        let (from, to) = interval
        let scope = filter.scope, sort = effectiveSort
        top.use(cacheKey: ResponseCache.key("top", String(range.rawValue), cacheFilter, sort.rawValue))
        more = []
        moreError = nil
        hasMore = false
        await top.load { try await client.topPosts(from: from, to: to, scope: scope, sort: sort, limit: Self.pageSize) }
        hasMore = (top.value?.count ?? 0) >= Self.pageSize
    }

    private func loadMore() async {
        guard let client = model.client, !loadingMore else { return }
        let (from, to) = interval
        let scope = filter.scope, sort = effectiveSort
        let shown = (top.value ?? []) + more
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.topPosts(from: from, to: to, scope: scope, sort: sort, limit: Self.pageSize, offset: shown.count)
            let known = Set(shown.map(\.id))
            more += page.filter { !known.contains($0.id) }
            hasMore = page.count >= Self.pageSize
            moreError = nil
        } catch is CancellationError {
        } catch {
            moreError = model.handle(error)
        }
    }

    // MARK: What the scope reports

    /// Platforms in the current scope.
    private func scopeProviders(_ s: AnalyticsSummary) -> Set<String> {
        switch filter {
        case let .provider(p): return [p]
        case let .account(id): return Set([model.account(id)?.provider].compactMap { $0 })
        case .all: return Set(model.accounts.map(\.provider)).union(s.byProvider.map(\.provider))
        }
    }

    /// Whether a platform in scope reports the metric (true when the platform list does not say).
    private func reports(_ keys: String..., in s: AnalyticsSummary) -> Bool {
        let providers = scopeProviders(s)
        if providers.isEmpty { return true }
        return providers.contains { p in
            guard let metrics = model.provider(p)?.analytics?.metrics else { return true }
            return keys.contains(where: metrics.contains)
        }
    }

    private var hasCampaigns: Bool { (summary.value?.totals.campaignPosts ?? 0) > 0 }

    // MARK: KPIs

    private func kpis(_ s: AnalyticsSummary) -> some View {
        let t = s.totals, p = s.previous
        let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: typeSize.isAccessibilitySize ? 1 : 2)
        return LazyVGrid(columns: columns, spacing: 10) {
            KPITile(title: "Views", value: Fmt.compact(t.views), change: relativeChange(t.views, p.views), systemImage: "eye")
            KPITile(title: "Engagement rate", value: t.engagementRate.map(Fmt.percent) ?? "—", change: relativeChange(t.engagementRate, p.engagementRate), systemImage: "percent")
            KPITile(title: "Engagements", value: Fmt.compact(t.engagements), change: relativeChange(t.engagements, p.engagements), systemImage: "hand.thumbsup")
            if t.likes > 0 || reports("likes", in: s) {
                KPITile(title: "Likes", value: Fmt.compact(t.likes), change: relativeChange(t.likes, p.likes), systemImage: "heart")
            }
            if t.comments > 0 || reports("comments", "replies", in: s) {
                KPITile(title: "Comments", value: Fmt.compact(t.comments), change: relativeChange(t.comments, p.comments), systemImage: "bubble.left")
            }
            if t.shares > 0 || reports("shares", in: s) {
                KPITile(title: "Shares", value: Fmt.compact(t.shares), change: relativeChange(t.shares, p.shares), systemImage: "arrowshape.turn.up.right")
            }
            if t.saves > 0 || reports("saves", in: s) {
                KPITile(title: "Saves", value: Fmt.compact(t.saves), change: relativeChange(t.saves, p.saves), systemImage: "bookmark")
            }
            if t.watchTimeMinutes > 0 {
                KPITile(title: "Watch time", value: Fmt.minutes(t.watchTimeMinutes), change: relativeChange(t.watchTimeMinutes, p.watchTimeMinutes), systemImage: "clock")
            }
            if t.impressions > 0 {
                KPITile(title: "Impressions", value: Fmt.compact(t.impressions), change: relativeChange(t.impressions, p.impressions), systemImage: "rectangle.stack")
            }
            if t.reach > 0 {
                KPITile(title: "Reach", value: Fmt.compact(t.reach), change: relativeChange(t.reach, p.reach), systemImage: "person.3")
            }
            if let followers = t.followers {
                KPITile(title: "Followers", value: Fmt.compact(followers), change: nil, systemImage: "person.2",
                        detail: t.followersChange.map { String(localized: "\(Fmt.signed($0)) in this period") })
            }
            KPITile(title: "Posts published", value: Fmt.compact(t.posts), change: relativeChange(t.posts, p.posts), systemImage: "paperplane")
            if let perPost = t.viewsPerPost {
                KPITile(title: "Avg. views per post", value: Fmt.compact(perPost), change: relativeChange(perPost, p.viewsPerPost), systemImage: "chart.bar")
            }
            if t.campaignPosts > 0 {
                KPITile(title: "Link clicks", value: Fmt.compact(t.clicks), change: relativeChange(t.clicks, p.clicks), systemImage: "cursorarrow.click")
                KPITile(title: "Installs", value: Fmt.compact(t.downloads), change: relativeChange(t.downloads, p.downloads), systemImage: "arrow.down.app",
                        detail: t.redownloads > 0 ? String(localized: "\(Fmt.compact(t.redownloads)) redownloads") : nil)
                KPITile(title: "Proceeds", value: Fmt.money(t.proceeds, currency: s.currency), change: relativeChange(t.proceeds, p.proceeds), systemImage: "banknote")
            }
        }
    }

    // MARK: Daily chart

    /// Metrics the server sends per day (likes / comments / shares only from newer servers).
    private func dailyMetrics(_ s: AnalyticsSummary) -> [DailyMetric] {
        DailyMetric.allCases.filter { m in s.daily.contains { m.value($0) != nil } || m == .views }
    }

    private func chartCard(_ s: AnalyticsSummary) -> some View {
        let options = dailyMetrics(s)
        let metric = options.contains(self.metric) ? self.metric : .views
        let days = s.daily.compactMap { d in Fmt.day(d.day).map { (date: $0, value: metric.value(d) ?? 0) } }
        let selected = selectedDay.flatMap { sel in days.first { Calendar.current.isDate($0.date, inSameDayAs: sel) } }
        let total = days.reduce(0) { $0 + $1.value }
        let peak = days.max { $0.value < $1.value }
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Per day").font(.headline)
                Spacer()
                Picker("Metric", selection: $metric) {
                    ForEach(options) { Text($0.title).tag($0) }
                }
                .pickerStyle(.menu)
            }
            if days.isEmpty || days.allSatisfy({ $0.value == 0 }) {
                Text("No published posts with numbers in this period.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                Chart {
                    ForEach(days, id: \.date) { d in
                        BarMark(x: .value("Day", d.date, unit: .day), y: .value("Value", d.value), width: .ratio(0.7))
                            .foregroundStyle(Color.chart.opacity(selected == nil || selected?.date == d.date ? 1 : 0.35))
                            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 4, topTrailingRadius: 4))
                    }
                    if let selected {
                        RuleMark(x: .value("Day", selected.date, unit: .day))
                            .foregroundStyle(.secondary.opacity(0.4))
                            .zIndex(-1)
                            .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                                VStack(spacing: 2) {
                                    Text(selected.date.formatted(.dateTime.day().month(.abbreviated))).font(.caption2).foregroundStyle(.secondary)
                                    Text(Fmt.compact(selected.value)).font(.caption.weight(.bold)).monospacedDigit()
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                            }
                    }
                }
                .chartXSelection(value: $selectedDay)
                .chartYAxis {
                    AxisMarks(position: .leading) { v in
                        AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                        AxisValueLabel { if let n = v.as(Double.self) { Text(Fmt.compact(n)) } }
                    }
                }
                .chartXAxis {
                    // About four labels, none at the very end (they would be cut off at the edge).
                    let step = max(1, days.count / 4)
                    let ticks = days.enumerated().filter { $0.offset % step == 0 && $0.offset <= days.count - 1 - step / 2 }.map(\.element.date)
                    AxisMarks(values: ticks) { _ in
                        AxisValueLabel(format: range == .year ? .dateTime.month(.abbreviated) : .dateTime.day().month(.abbreviated))
                    }
                }
                .frame(height: 190)
                .accessibilityLabel(Text("\(Text(metric.title)) per day"))
                .accessibilityValue(Text(peak.map { String(localized: "\(Fmt.compact(total)) in total, most on \($0.date.formatted(.dateTime.day().month(.wide)))") } ?? ""))
                Text("Numbers count for the day a post was published.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .card()
    }

    // MARK: Followers

    private func followers(_ s: AnalyticsSummary) -> some View {
        let series = s.followers.sorted { ($0.points.last?.followers ?? 0) > ($1.points.last?.followers ?? 0) }
        return VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Followers", systemImage: "person.2")
            VStack(spacing: 0) {
                ForEach(Array(series.enumerated()), id: \.element.id) { i, f in
                    followerRow(f, change: s.byAccount.first { $0.key == f.accountId }?.followersChange)
                    if i < series.count - 1 { Divider().padding(.leading, 58) }
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    private func followerRow(_ f: FollowerSeries, change: Double?) -> some View {
        let points = f.points.compactMap { p in Fmt.day(p.day).map { (date: $0, value: p.followers) } }
        let current = points.last?.value
        let growth = change ?? (points.count > 1 ? (points.last!.value - points.first!.value) : nil)
        let account = model.account(f.accountId)
        let low = points.map(\.value).min() ?? 0, high = points.map(\.value).max() ?? 0
        let pad = max(1, (high - low) * 0.15)
        return HStack(spacing: 12) {
            AccountAvatar(account: account, provider: f.provider, size: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(account?.name ?? f.name).font(.subheadline.weight(.medium)).lineLimit(1)
                Text(model.providerName(f.provider)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if points.count > 1 {
                Chart(points, id: \.date) { p in
                    AreaMark(x: .value("Day", p.date), yStart: .value("Low", low - pad), yEnd: .value("Followers", p.value))
                        .foregroundStyle(LinearGradient(colors: [Color.chart.opacity(0.25), Color.chart.opacity(0)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Day", p.date), y: .value("Followers", p.value))
                        .foregroundStyle(Color.chart)
                        .lineStyle(StrokeStyle(lineWidth: 1.75))
                        .interpolationMethod(.monotone)
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .chartYScale(domain: (low - pad)...(high + pad))
                .frame(width: 84, height: 34)
                .accessibilityHidden(true)
            }
            VStack(alignment: .trailing, spacing: 1) {
                Text(current.map(Fmt.compact) ?? "—").font(.subheadline.weight(.semibold)).monospacedDigit()
                if let growth {
                    Text(Fmt.signed(growth)).font(.caption.weight(.medium)).monospacedDigit().foregroundStyle(changeColor(growth))
                }
            }
            .frame(minWidth: 52, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(account?.name ?? f.name), \(model.providerName(f.provider))"))
        .accessibilityValue(Text(followerSummary(current: current, growth: growth)))
    }

    private func followerSummary(current: Double?, growth: Double?) -> String {
        let count = String(localized: "\(current.map(Fmt.compact) ?? "—") followers")
        guard let growth else { return count }
        return count + ", " + String(localized: "\(Fmt.signed(growth)) in this period")
    }

    // MARK: Platforms and accounts

    private func breakdown(title: LocalizedStringKey, systemImage: String, rows: [AnalyticsBreakdown], accounts: Bool) -> some View {
        let sorted = rows.sorted { ($0.views, $0.posts) > ($1.views, $1.posts) }
        return VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, systemImage: systemImage)
            VStack(spacing: 0) {
                ForEach(Array(sorted.enumerated()), id: \.element.id) { i, b in
                    Button {
                        apply(accounts ? .account(b.accountId ?? b.key) : .provider(b.provider))
                    } label: {
                        breakdownRow(b, account: accounts)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text(accounts ? "Shows only this account" : "Shows only this platform"))
                    if i < sorted.count - 1 { Divider().padding(.leading, 58) }
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    private func breakdownRow(_ b: AnalyticsBreakdown, account isAccount: Bool) -> some View {
        let account = isAccount ? model.account(b.accountId ?? b.key) : nil
        var details = [String(localized: "\(Fmt.compact(b.posts)) posts")]
        if let r = b.engagementRate { details.append(String(localized: "\(Fmt.percent(r)) engagement")) }
        return HStack(spacing: 12) {
            if isAccount {
                AccountAvatar(account: account, provider: b.provider, size: 30)
            } else {
                PlatformGlyph(provider: b.provider, size: 30)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(isAccount ? (account?.name ?? b.name) : model.providerName(b.provider))
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(details.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(Fmt.compact(b.views)) views").font(.subheadline).monospacedDigit()
                if let f = b.followers {
                    HStack(spacing: 4) {
                        Text("\(Fmt.compact(f)) followers").foregroundStyle(.secondary)
                        if let c = b.followersChange, c != 0 {
                            Text(Fmt.signed(c)).foregroundStyle(changeColor(c))
                        }
                    }
                    .font(.caption)
                    .monospacedDigit()
                }
            }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    // MARK: Top posts

    private var sortOptions: [APIClient.AnalyticsSort] {
        hasCampaigns ? [.views, .engagements, .engagementRate, .publishedAt, .clicks, .downloads] : [.views, .engagements, .engagementRate, .publishedAt]
    }

    /// The chosen sort, views when it needs tracked links and there are none.
    private var effectiveSort: APIClient.AnalyticsSort {
        guard summary.value != nil else { return sort }
        return sortOptions.contains(sort) ? sort : .views
    }

    private func sortTitle(_ s: APIClient.AnalyticsSort) -> LocalizedStringKey {
        switch s {
        case .views: "Most viewed"
        case .engagements: "Most engagements"
        case .engagementRate: "Best engagement rate"
        case .publishedAt: "Newest"
        case .clicks: "Most link clicks"
        case .downloads: "Most installs"
        case .proceeds: "Most proceeds"
        }
    }

    private func topPosts(_ s: AnalyticsSummary) -> some View {
        let posts = (top.value ?? []) + more
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionHeader(title: effectiveSort == .publishedAt ? "Posts" : "Top posts", systemImage: "trophy")
                Menu {
                    Picker("Sort", selection: Binding(get: { effectiveSort }, set: { sort = $0 })) {
                        ForEach(sortOptions, id: \.self) { Text(sortTitle($0)).tag($0) }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(sortTitle(effectiveSort))
                        Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.semibold))
                    }
                    .font(.subheadline.weight(.medium))
                }
                .fixedSize()
                .accessibilityLabel(Text("Sort posts"))
                .accessibilityValue(Text(sortTitle(effectiveSort)))
            }
            VStack(spacing: 0) {
                if posts.isEmpty {
                    Text(top.loading ? "Loading…" : "No published posts in this period.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
                ForEach(Array(posts.enumerated()), id: \.element.id) { i, p in
                    NavigationLink(value: Route.post(id: p.id)) {
                        TopPostRow(rank: i + 1, post: p, currency: s.currency)
                    }
                    .buttonStyle(.plain)
                    if i < posts.count - 1 || hasMore { Divider().padding(.leading, 16) }
                }
                if hasMore, !posts.isEmpty {
                    Button {
                        Task { await loadMore() }
                    } label: {
                        HStack {
                            Spacer()
                            if loadingMore { ProgressView() } else { Text("Show more").font(.subheadline.weight(.semibold)) }
                            Spacer()
                        }
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .disabled(loadingMore)
                }
                if let moreError {
                    Text(moreError).font(.caption).foregroundStyle(.red).padding([.horizontal, .bottom], 16)
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }
}

/// A post in the top posts list: rank, thumbnail, account, text and its key numbers.
struct TopPostRow: View {
    var rank: Int
    var post: AnalyticsPost
    var currency: String?

    var body: some View {
        let m = post.metrics
        HStack(alignment: .top, spacing: 12) {
            Text("\(rank)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 20)
                .monospacedDigit()
            if let first = post.media.first {
                MediaThumb(mediaId: first, size: 52)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    PlatformGlyph(provider: post.provider, size: 16)
                    Text(post.accountName).font(.caption.weight(.semibold)).lineLimit(1)
                    Spacer()
                    Text(Fmt.date(ms: post.publishedAt).formatted(.dateTime.day().month(.abbreviated))).font(.caption).foregroundStyle(.secondary)
                }
                Text(post.excerpt.isEmpty ? String(localized: "No text") : post.excerpt).font(.subheadline).lineLimit(2)
                Group {
                    if m == nil {
                        Text(post.metricsNextAt.map { String(localized: "First numbers \(Fmt.relative(ms: $0)).") } ?? String(localized: "No numbers yet."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        HStack(spacing: 12) {
                            Label(Fmt.compact(m?.exposure ?? 0), systemImage: "eye")
                                .accessibilityLabel(Text("\(Fmt.compact(m?.exposure ?? 0)) views"))
                            if let likes = m?.likes { Label(Fmt.compact(likes), systemImage: "heart").accessibilityLabel(Text("\(Fmt.compact(likes)) likes")) }
                            if let comments = m?.comments { Label(Fmt.compact(comments), systemImage: "bubble.left").accessibilityLabel(Text("\(Fmt.compact(comments)) comments")) }
                            if let shares = m?.shares ?? m?.reposts { Label(Fmt.compact(shares), systemImage: "arrowshape.turn.up.right").accessibilityLabel(Text("\(Fmt.compact(shares)) shares")) }
                        }
                        let second = secondLine
                        if !second.isEmpty {
                            HStack(spacing: 12) {
                                ForEach(second, id: \.symbol) { item in
                                    Label(item.text, systemImage: item.symbol).accessibilityLabel(Text(item.accessibility))
                                }
                            }
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .labelStyle(CompactLabelStyle())
                .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private struct Item { var symbol: String; var text: String; var accessibility: String }

    /// Engagement rate, watch time and tracked link results.
    private var secondLine: [Item] {
        var out: [Item] = []
        if let r = post.engagementRate {
            out.append(Item(symbol: "percent", text: Fmt.percent(r), accessibility: String(localized: "\(Fmt.percent(r)) engagement")))
        }
        if let w = post.metrics?.watchTimeMinutes, w > 0 {
            out.append(Item(symbol: "clock", text: Fmt.minutes(w), accessibility: String(localized: "Watch time \(Fmt.minutes(w))")))
        }
        if let c = post.campaign {
            out.append(Item(symbol: "cursorarrow.click", text: Fmt.compact(c.clicks), accessibility: String(localized: "\(Fmt.compact(c.clicks)) link clicks")))
            if let d = c.downloads {
                out.append(Item(symbol: "arrow.down.app", text: Fmt.compact(d), accessibility: String(localized: "\(Fmt.compact(d)) installs")))
            }
            if let p = c.proceeds, p > 0 {
                out.append(Item(symbol: "banknote", text: Fmt.money(p, currency: c.currency ?? currency), accessibility: Fmt.money(p, currency: c.currency ?? currency)))
            }
        }
        return out
    }
}

struct KPITile: View {
    var title: LocalizedStringKey
    var value: String
    var change: Double?
    var systemImage: String
    var detail: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(value)
                .font(.system(.title2, design: .rounded).weight(.bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let change {
                HStack(spacing: 4) {
                    ChangePill(change: change)
                    Text("vs previous").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            } else if let detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            } else {
                Text(" ").font(.caption2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

extension Color {
    /// Chart marks: the brand orange, a step darker in dark mode (validated against both surfaces).
    static let chart = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.949, green: 0.298, blue: 0.039, alpha: 1) : UIColor(red: 1, green: 0.314, blue: 0.039, alpha: 1) })
}
