import SwiftUI
import WidgetKit

/// Today / this week by status, what is next, what needs attention (`GET /overview`), plus the plan banner.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var overview = Loader<OverviewData>()
    @State private var billing: Billing?
    @State private var period: Period = .today

    private enum Period: String, CaseIterable, Identifiable {
        case today, week
        var id: String { rawValue }
        var title: LocalizedStringKey { self == .today ? "Today" : "This week" }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                if let billing, let banner = BillingBanner(billing: billing, server: model.serverURL) { banner }
                if let error = overview.error { ErrorBanner(message: error) { Task { await load() } } }
                if let o = overview.value {
                    if o.accounts.reconnect > 0 { reconnectCard(o.accounts.reconnect) }
                    countsCard(o)
                    section("Up next", systemImage: "clock", posts: o.upcoming, empty: "Nothing scheduled. Tap New post to plan one.", showDay: true)
                    if !o.failures.isEmpty {
                        section("Needs attention", systemImage: "exclamationmark.triangle", posts: o.failures, empty: "", showDay: true)
                    }
                    section("Recent results", systemImage: "checkmark.circle", posts: Array(o.recent.filter { $0.status == .published }.prefix(5)), empty: "No posts published yet.", showDay: true)
                    UpdatedLabel(date: overview.updatedAt, offline: overview.offline)
                        .padding(.top, 4)
                } else if overview.loading {
                    ProgressView().controlSize(.large).padding(.top, 80)
                } else if overview.error == nil {
                    ContentUnavailableView("No data yet", systemImage: "calendar", description: Text("Pull to refresh."))
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Home")
        .navigationSubtitle(model.workspace?.name ?? "")
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { WorkspaceMenu() }
        }
        .composeButton()
        .refreshable { await load() }
        .task(id: model.dataVersion) { await load() }
    }

    private func load() async {
        overview.use(cacheKey: ResponseCache.key("overview"))
        guard let client = model.client, model.can("posts.read") else { return }
        async let b = try? client.billing()
        await overview.load { try await client.overview(todayStart: Periods.todayStart(), weekStart: Periods.weekStart()) }
        billing = await b
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: Sections

    private func countsCard(_ o: OverviewData) -> some View {
        let counts = period == .today ? o.periods.today : o.periods.week
        func n(_ s: PostStatus...) -> Int { s.reduce(0) { $0 + (counts[$1.rawValue] ?? 0) } }
        let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: typeSize.isAccessibilitySize ? 2 : 4)
        return VStack(alignment: .leading, spacing: 12) {
            Picker("Period", selection: $period) {
                ForEach(Period.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            LazyVGrid(columns: columns, spacing: 10) {
                CountTile(value: n(.published), title: "Published", systemImage: PostStatus.published.symbol, color: .green)
                CountTile(value: n(.scheduled, .publishing), title: "Scheduled", systemImage: PostStatus.scheduled.symbol, color: .blue)
                CountTile(value: n(.failed, .needsCheck), title: "Failed", systemImage: PostStatus.failed.symbol, color: .red)
                CountTile(value: n(.draft), title: "Drafts", systemImage: PostStatus.draft.symbol, color: .gray)
            }
        }
        .card()
        .animation(.smooth, value: period)
    }

    private func section(_ title: LocalizedStringKey, systemImage: String, posts: [Post], empty: LocalizedStringKey, showDay: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, systemImage: systemImage)
            VStack(spacing: 0) {
                if posts.isEmpty {
                    Text(empty)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                } else {
                    ForEach(Array(posts.enumerated()), id: \.element.id) { i, post in
                        NavigationLink(value: Route.post(id: post.id)) {
                            PostRow(post: post, showDay: showDay)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if i < posts.count - 1 { Divider().padding(.leading, 66) }
                    }
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    private func reconnectCard(_ n: Int) -> some View {
        Button {
            model.tab = .accounts
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "link.badge.plus")
                    .font(.title3)
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(n) accounts need reconnecting").font(.subheadline.weight(.semibold))
                    Text("Their posts fail until you reconnect them on the web.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .card(padding: 14)
        }
        .buttonStyle(.plain)
    }
}

/// Workspace switcher (toolbar): the workspaces of `GET /me`, sent as `X-Workspace-Id`.
struct WorkspaceMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let me = model.me, me.workspaces.count > 1 {
            Menu {
                Picker("Workspace", selection: Binding(get: { model.workspace?.id ?? "" }, set: { id in
                    if let ws = me.workspaces.first(where: { $0.id == id }) { Task { await model.switchWorkspace(ws) } }
                })) {
                    ForEach(me.workspaces) { ws in
                        Label(ws.name, systemImage: ws.demo == true ? "theatermasks" : "building.2").tag(ws.id)
                    }
                }
            } label: {
                Image(systemName: "building.2")
            }
            .accessibilityLabel(Text("Switch workspace"))
        }
    }
}

/// Hosted mode: trial, locked or past-due notice with a link to the web billing page (no in-app purchases).
struct BillingBanner: View {
    var billing: Billing
    var server: URL?

    init?(billing: Billing, server: URL?) {
        guard billing.enabled, !billing.exempt else { return nil }
        guard billing.state == "trial" || billing.state == "locked" || billing.status == "past_due" else { return nil }
        self.billing = billing
        self.server = server
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.title3).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if billing.canManage, let server {
                    Link(destination: server.appending(path: "workspace").appending(queryItems: [URLQueryItem(name: "tab", value: "billing")])) {
                        Text("Manage billing on the web").font(.caption.weight(.semibold))
                    }
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var color: Color { billing.state == "trial" ? .blue : .red }
    private var icon: String { billing.state == "trial" ? "hourglass" : "lock.fill" }

    private var title: String {
        if billing.state == "locked" { return String(localized: "This workspace is locked") }
        if billing.status == "past_due" { return String(localized: "Payment failed") }
        if let end = billing.trialEndsAt {
            let days = max(0, Int(ceil((end / 1000 - Date().timeIntervalSince1970) / 86400)))
            return String(localized: "Trial: \(days) days left")
        }
        return String(localized: "Trial")
    }

    private var message: String {
        if billing.state == "locked" { return String(localized: "Nothing new can be scheduled or published until a plan is active.") }
        if billing.status == "past_due" { return String(localized: "Update the payment method to keep publishing.") }
        return String(localized: "\(billing.plan?.name ?? "Your plan") is free to try. Choose a plan on the web before the trial ends.")
    }
}
