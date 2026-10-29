import SwiftUI

/// Filters of the posts list and calendar (`GET /posts` query).
struct PostFilter: Hashable {
    var statuses: Set<PostStatus> = []
    var groupId: String?
    var accountId: String?

    var isActive: Bool { !statuses.isEmpty || groupId != nil || accountId != nil }
    var cacheKey: String {
        [statuses.map(\.rawValue).sorted().joined(separator: "-"), groupId ?? "", accountId ?? ""].joined(separator: "_")
    }
}

struct PostsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("postsMode") private var mode: Mode = .list
    @State private var filter = PostFilter()
    @State private var list = Loader<[Post]>()
    @State private var calendar = Loader<[Post]>()
    @State private var month = Calendar.current.dateInterval(of: .month, for: .now)?.start ?? .now
    @State private var selectedDay = Calendar.current.startOfDay(for: .now)
    @State private var confirmDelete: Post?
    @State private var actionError: String?

    private enum Mode: String, CaseIterable, Identifiable {
        case list, calendar
        var id: String { rawValue }
        var title: LocalizedStringKey { self == .list ? "List" : "Calendar" }
    }

    var body: some View {
        Group {
            switch mode {
            case .list: listView
            case .calendar: calendarView
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .navigationTitle("Posts")
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { filterMenu }
        }
        .composeButton()
        .task(id: TaskKey(version: model.dataVersion, filter: filter, mode: mode, month: month)) { await load() }
        .confirmationDialog("Delete this post?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible, presenting: confirmDelete) { post in
            Button("Delete", role: .destructive) { Task { await delete(post) } }
        } message: { post in
            Text(post.status == .published ? "It is removed from Postflare only, not from the platform." : "This cannot be undone.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    private struct TaskKey: Hashable {
        var version: Int
        var filter: PostFilter
        var mode: Mode
        var month: Date
    }

    // MARK: Header and filters

    private var header: some View {
        VStack(spacing: 8) {
            Picker("View", selection: $mode) {
                ForEach(Mode.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            if filter.isActive {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(filter.statuses.sorted { $0.rawValue < $1.rawValue }, id: \.self) { s in
                            chip(s.title) { filter.statuses.remove(s) }
                        }
                        if let g = model.group(filter.groupId) { chip(g.name) { filter.groupId = nil } }
                        if let id = filter.accountId { chip(model.account(id)?.name ?? id) { filter.accountId = nil } }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func chip(_ text: String, remove: @escaping () -> Void) -> some View {
        Button(action: remove) {
            HStack(spacing: 4) {
                Text(text)
                Image(systemName: "xmark").font(.caption2.weight(.bold))
            }
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
        }
        .buttonStyle(.glass)
        .accessibilityLabel(Text("Remove filter \(text)"))
    }

    private var filterMenu: some View {
        Menu {
            Section("Status") {
                ForEach(PostStatus.allCases, id: \.self) { s in
                    Toggle(isOn: Binding(get: { filter.statuses.contains(s) }, set: { on in
                        if on { filter.statuses.insert(s) } else { filter.statuses.remove(s) }
                    })) {
                        Label(s.title, systemImage: s.symbol)
                    }
                }
            }
            if !model.groups.isEmpty {
                Picker("Account group", selection: $filter.groupId) {
                    Text("All groups").tag(String?.none)
                    ForEach(model.groups.sorted { $0.position < $1.position }) { g in Text(g.name).tag(Optional(g.id)) }
                }
                .pickerStyle(.menu)
            }
            Picker("Account", selection: $filter.accountId) {
                Text("All accounts").tag(String?.none)
                ForEach(model.accounts.filter { filter.groupId == nil || $0.groupId == filter.groupId }) { a in
                    Text("\(a.name) · \(model.providerName(a.provider))").tag(Optional(a.id))
                }
            }
            .pickerStyle(.menu)
            if filter.isActive {
                Button("Clear filters", systemImage: "xmark.circle", role: .destructive) { filter = PostFilter() }
            }
        } label: {
            Image(systemName: filter.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
        }
        .accessibilityLabel(Text("Filter posts"))
    }

    // MARK: List

    /// Today and the days ahead first (soonest first), then the past (latest first).
    private var days: [(day: Date, posts: [Post])] {
        let today = Calendar.current.startOfDay(for: .now)
        let groups = Dictionary(grouping: list.value ?? []) { Calendar.current.startOfDay(for: $0.date) }
        let ahead = groups.keys.filter { $0 >= today }.sorted(by: <).map { ($0, groups[$0]!.sorted { $0.time < $1.time }) }
        let past = groups.keys.filter { $0 < today }.sorted(by: >).map { ($0, groups[$0]!.sorted { $0.time > $1.time }) }
        return ahead + past
    }

    private var listView: some View {
        List {
            if let error = list.error {
                ErrorBanner(message: error) { Task { await load() } }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
            }
            ForEach(days, id: \.day) { day in
                Section {
                    ForEach(day.posts) { post in row(post) }
                } header: {
                    Text(Fmt.day(day.day)).id(day.day)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if list.value?.isEmpty == true {
                ContentUnavailableView(filter.isActive ? "No matching posts" : "No posts yet", systemImage: "calendar",
                                       description: Text(filter.isActive ? "Try other filters." : "Tap New post to write your first one."))
            } else if list.value == nil && list.loading {
                ProgressView().controlSize(.large)
            }
        }
        .refreshable { await load() }
    }

    private func row(_ post: Post) -> some View {
        NavigationLink(value: Route.post(id: post.id)) {
            PostRow(post: post)
        }
        .swipeActions(edge: .trailing) {
            if model.canWrite && post.status != .publishing {
                Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = post }
            }
            if model.canWrite && post.status == .scheduled {
                Button("Cancel", systemImage: "slash.circle") { Task { await act { try await $0.cancel(post.id) } } }
                    .tint(.orange)
            }
        }
        .swipeActions(edge: .leading) {
            if model.canWrite && (post.status == .failed || post.status == .cancelled) {
                Button(post.status == .failed ? "Retry" : "Publish now", systemImage: "arrow.clockwise") {
                    Task { await act { try await $0.retry(post.id) } }
                }
                .tint(.blue)
            }
            if model.canWrite {
                Button("Duplicate", systemImage: "plus.square.on.square") { model.compose = ComposeRequest(duplicate: post) }
                    .tint(.brand)
            }
        }
    }

    // MARK: Calendar

    private var calendarView: some View {
        List {
            Section {
                MonthGrid(month: $month, selected: $selectedDay, posts: calendar.value ?? [])
                    .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
            }
            if let error = calendar.error {
                ErrorBanner(message: error) { Task { await load() } }
                    .listRowBackground(Color.clear)
            }
            Section(Fmt.day(selectedDay)) {
                let posts = (calendar.value ?? []).filter { Calendar.current.isDate($0.date, inSameDayAs: selectedDay) }.sorted { $0.time < $1.time }
                if posts.isEmpty {
                    Text(calendar.loading && calendar.value == nil ? "Loading…" : "No posts on this day.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(posts) { post in row(post) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, 0, for: .scrollContent)
        .refreshable { await load() }
    }

    // MARK: Loading and actions

    private func baseQuery() -> APIClient.PostQuery {
        APIClient.PostQuery(statuses: filter.statuses, accountId: filter.accountId, accountGroupId: filter.groupId)
    }

    private func load() async {
        guard let client = model.client else { return }
        switch mode {
        case .list:
            list.use(cacheKey: ResponseCache.key("posts", filter.cacheKey))
            var q = baseQuery()
            q.limit = 300
            await list.load { try await client.posts(q) }
        case .calendar:
            let cal = Calendar.current
            let start = cal.date(byAdding: .day, value: -7, to: month) ?? month
            let end = cal.date(byAdding: .day, value: 45, to: month) ?? month
            calendar.use(cacheKey: ResponseCache.key("calendar", filter.cacheKey, String(Int(month.timeIntervalSince1970))))
            var q = baseQuery()
            q.from = start
            q.to = end
            q.ascending = true
            q.limit = 1000
            await calendar.load { try await client.posts(q) }
        }
    }

    private func act(_ action: (APIClient) async throws -> Post) async {
        guard let client = model.client else { return }
        do {
            _ = try await action(client)
            model.dataChanged()
        } catch {
            actionError = model.handle(error)
        }
    }

    private func delete(_ post: Post) async {
        guard let client = model.client else { return }
        do {
            try await client.deletePost(post.id)
            list.set((list.value ?? []).filter { $0.id != post.id })
            model.dataChanged()
        } catch {
            actionError = model.handle(error)
        }
    }
}

/// Month calendar with one dot per status of the day's posts.
struct MonthGrid: View {
    @Binding var month: Date
    @Binding var selected: Date
    var posts: [Post]

    private let cal = Calendar.current

    var body: some View {
        let byDay = Dictionary(grouping: posts) { cal.startOfDay(for: $0.date) }
        VStack(spacing: 10) {
            HStack {
                Text(month.formatted(.dateTime.month(.wide).year()))
                    .font(.headline)
                Spacer()
                Button { shift(-1) } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel(Text("Previous month"))
                Button("Today") {
                    month = cal.dateInterval(of: .month, for: .now)?.start ?? .now
                    selected = cal.startOfDay(for: .now)
                }
                .font(.subheadline)
                Button { shift(1) } label: { Image(systemName: "chevron.right") }
                    .accessibilityLabel(Text("Next month"))
            }
            .buttonStyle(.borderless)
            let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(Array(weekdaySymbols.enumerated()), id: \.offset) { _, s in
                    Text(s).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
                ForEach(Array(cells.enumerated()), id: \.offset) { _, day in
                    if let day {
                        dayCell(day, posts: byDay[day] ?? [])
                    } else {
                        Color.clear.frame(height: 44)
                    }
                }
            }
        }
    }

    private func dayCell(_ day: Date, posts: [Post]) -> some View {
        let isSelected = cal.isDate(day, inSameDayAs: selected)
        let isToday = cal.isDateInToday(day)
        let statuses = Array(Set(posts.map(\.status))).sorted { $0.rawValue < $1.rawValue }.prefix(3)
        return Button {
            selected = day
        } label: {
            VStack(spacing: 3) {
                Text(day.formatted(.dateTime.day()))
                    .font(.callout.weight(isToday || isSelected ? .bold : .regular))
                    .foregroundStyle(isSelected ? Color.white : isToday ? Color.brand : Color.primary)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(isSelected ? Color.brand : Color.clear))
                HStack(spacing: 3) {
                    ForEach(Array(statuses), id: \.self) { s in Circle().fill(s.color).frame(width: 5, height: 5) }
                }
                .frame(height: 5)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("\(day.formatted(date: .complete, time: .omitted)), \(posts.count) posts"))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func shift(_ months: Int) {
        if let m = cal.date(byAdding: .month, value: months, to: month) {
            month = m
            selected = m
        }
    }

    private var weekdaySymbols: [String] {
        let symbols = cal.veryShortStandaloneWeekdaySymbols
        let first = cal.firstWeekday - 1
        return Array(symbols[first...] + symbols[..<first])
    }

    /// Days of the month, padded with nils before the first weekday.
    private var cells: [Date?] {
        guard let range = cal.range(of: .day, in: .month, for: month) else { return [] }
        let weekday = cal.component(.weekday, from: month)
        let lead = (weekday - cal.firstWeekday + 7) % 7
        let days: [Date?] = range.compactMap { cal.date(byAdding: .day, value: $0 - 1, to: month) }
        return Array(repeating: nil, count: lead) + days
    }
}
