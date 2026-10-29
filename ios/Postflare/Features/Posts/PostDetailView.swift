import SwiftUI

/// One post: a preview of how it looks on its platform (switchable between the accounts of its group), its status
/// and the actions it allows (retry, cancel, reschedule, resolve, duplicate, delete), metrics, then the details
/// (settings with their labels, ids, the publishing log).
struct PostDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    /// The post shown; switching to another account of the group changes it in place.
    @State private var postId: String

    init(postId: String) {
        _postId = State(initialValue: postId)
    }

    @State private var post = Loader<Post>()
    @State private var viewer: MediaViewerItem?
    @State private var showLog = false
    /// Labels of dynamic select values (YouTube category, playlist, Pinterest board, ...) by setting key.
    @State private var dynamicLabels: [String: [String: String]] = [:]
    @State private var siblings: [Post] = []
    @State private var metrics: PostMetrics?
    @State private var busy: String?
    @State private var actionError: String?
    @State private var planLimit: PlanLimit?
    @State private var rescheduling = false
    @State private var markingPublished = false
    @State private var publishedURL = ""
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if let p = post.value {
                content(p)
            } else if let error = post.error {
                ContentUnavailableView {
                    Label("Post not available", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") { Task { await load() } }.buttonStyle(.glass)
                }
            } else {
                ProgressView().controlSize(.large)
            }
        }
        .navigationTitle(post.value.map { model.account($0.accountId)?.name ?? $0.status.title } ?? String(localized: "Post"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let p = post.value, model.canWrite {
                ToolbarItem(placement: .primaryAction) { moreMenu(p) }
            }
        }
        .task(id: "\(postId)#\(model.dataVersion)") { await load() }
        .fullScreenCover(item: $viewer) { MediaViewer(item: $0) }
        .refreshable { await load() }
        .sheet(isPresented: $rescheduling) {
            if let p = post.value {
                RescheduleSheet(post: p) { date in await perform("schedule") { try await $0.reschedule(p.id, to: date) } }
            }
        }
        .alert("Mark as published", isPresented: $markingPublished) {
            TextField("https://", text: $publishedURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Mark as published") {
                let url = publishedURL.trimmingCharacters(in: .whitespaces)
                Task { await perform("resolve") { try await $0.resolve(postId, published: true, url: url.isEmpty ? nil : url) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only do this if the post is live on the platform. The link is optional.")
        }
        .confirmationDialog("Delete this post?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text(post.value?.status == .published ? "It is removed from Postflare only, not from the platform." : "This cannot be undone.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
        .planLimitAlert($planLimit)
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ p: Post) -> some View {
        let account = model.account(p.accountId)
        let providerId = account?.provider ?? ""
        let provider = model.provider(providerId)
        List {
            if siblings.count > 1 { accountSwitcher(p) }

            Section {
                PlatformPreview(ctx: PreviewContext(
                    post: p,
                    account: account,
                    provider: provider,
                    providerId: providerId,
                    optionLabel: { key, value in optionLabel(key: key, value: value, provider: provider) },
                    open: { ids, index in openViewer(p, ids: ids, index: index) }
                ))
                .listRowInsets(EdgeInsets())
            } header: {
                HStack(spacing: 6) {
                    PlatformGlyph(provider: providerId, size: 16)
                    Text("Preview on \(model.providerName(providerId))")
                }
            }

            statusSection(p)

            actionsSection(p)

            if p.status == .published { PostPerformanceSections(post: p, providerId: providerId, metrics: $metrics) }

            campaignSection(p)

            settingsSection(p, provider: provider)

            detailsSection(p)

            logSection(p)
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(.compact)
    }

    /// The accounts of the group as chips; tapping one shows its post here.
    private func accountSwitcher(_ p: Post) -> some View {
        Section {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(siblings) { s in
                            let a = model.account(s.accountId)
                            let current = s.id == p.id
                            Button {
                                guard !current else { return }
                                switchTo(s)
                            } label: {
                                HStack(spacing: 7) {
                                    AccountAvatar(account: a, provider: a?.provider ?? "", size: 26)
                                    // The platform tells the posts of a group apart (the accounts often share a name).
                                    Text(a.map { model.providerName($0.provider) } ?? s.accountId)
                                        .font(.subheadline.weight(current ? .semibold : .regular))
                                        .lineLimit(1)
                                    Circle().fill(s.status.color).frame(width: 7, height: 7)
                                }
                                .padding(.leading, 6)
                                .padding(.trailing, 12)
                                .padding(.vertical, 6)
                                .background(current ? Color.accentColor.opacity(0.16) : Color(.secondarySystemGroupedBackground), in: Capsule())
                                .overlay { Capsule().strokeBorder(current ? Color.accentColor.opacity(0.6) : .clear, lineWidth: 1) }
                                .foregroundStyle(.primary)
                            }
                            .buttonStyle(.plain)
                            .id(s.id)
                            .accessibilityLabel(Text("\(a?.name ?? s.accountId), \(a.map { model.providerName($0.provider) } ?? ""), \(s.status.title)"))
                            .accessibilityAddTraits(current ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 2)
                }
                .onAppear { proxy.scrollTo(p.id, anchor: .center) }
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        } footer: {
            Text("Posted together: one post per account.")
        }
    }

    @ViewBuilder
    private func statusSection(_ p: Post) -> some View {
        Section {
            HStack(spacing: 10) {
                Image(systemName: p.status.symbol)
                    .foregroundStyle(p.status == .needsCheck ? Color.orange : p.status.color)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(timeLine(p)).font(.subheadline.weight(.semibold))
                    if p.attempts > 1 {
                        Text("\(p.attempts) attempts").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                StatusBadge(status: p.status)
            }
            .accessibilityElement(children: .combine)
            if p.status != .published, let url = p.externalUrl.flatMap(URL.init(string:)) {
                Button { openURL(url) } label: {
                    HStack {
                        Label("Open the post", systemImage: "arrow.up.right.square")
                        Spacer()
                        Text(url.host() ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            if p.status == .needsCheck {
                VStack(alignment: .leading, spacing: 6) {
                    Label(p.error ?? String(localized: "We couldn't confirm whether the platform accepted the post. Check your profile, then mark it as published or retry."), systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text("It is not retried automatically, so it cannot be posted twice by accident.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else if let error = p.error, p.status == .failed || p.status == .cancelled {
                Label(error, systemImage: "exclamationmark.circle.fill").foregroundStyle(.red).textSelection(.enabled)
            }
        } footer: {
            if !model.canWrite { Text("Your role can view posts but not change them.") }
        }
    }

    @ViewBuilder
    private func settingsSection(_ p: Post, provider: ProviderInfo?) -> some View {
        let rows = settingRows(p, provider: provider)
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.key) { row in
                    if row.long {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.label)
                            ExpandableText(text: row.value, lineLimit: 3, font: row.mono ? .footnote.monospaced() : .subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        LabeledContent(row.label) {
                            Text(row.value).multilineTextAlignment(.trailing).textSelection(.enabled)
                        }
                    }
                }
            } header: {
                Text("\(provider?.name ?? String(localized: "Platform")) settings")
            }
        }
    }

    private func detailsSection(_ p: Post) -> some View {
        Section("Details") {
            idRow("Post ID", p.id)
            if siblings.count > 1 { idRow("Group ID", p.groupId) }
            if let external = p.externalId { idRow("Platform ID", external) }
            LabeledContent("Created", value: Fmt.date(ms: p.createdAt).formatted(date: .abbreviated, time: .shortened))
            LabeledContent("Updated", value: Fmt.date(ms: p.updatedAt).formatted(date: .abbreviated, time: .shortened))
            if let published = p.publishedAt {
                LabeledContent("Published", value: Fmt.date(ms: published).formatted(date: .abbreviated, time: .shortened))
            }
            if p.attempts > 0 { LabeledContent("Attempts", value: Fmt.count(p.attempts)) }
            if let playbook = p.playbookId {
                LabeledContent("Playbook", value: p.playbookVersion.map { "\(playbook) v\($0)" } ?? playbook)
            }
            if let variant = p.variant { LabeledContent("Variant", value: variant) }
        }
    }

    private func idRow(_ title: LocalizedStringKey, _ value: String) -> some View {
        LabeledContent(title) {
            Text(value).font(.caption.monospaced()).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
        }
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = value }
        }
    }

    private func logSection(_ p: Post) -> some View {
        Section {
            let logs = p.logs ?? []
            DisclosureGroup(isExpanded: $showLog) {
                if logs.isEmpty {
                    Text("No activity yet.").foregroundStyle(.secondary)
                } else {
                    ForEach(logs) { log in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .top, spacing: 8) {
                                Circle().fill(log.level == "error" ? Color.red : log.level == "warn" ? Color.orange : Color.secondary)
                                    .frame(width: 7, height: 7)
                                    .padding(.top, 6)
                                Text(log.message)
                                    .font(.subheadline)
                                    .foregroundStyle(log.level == "error" ? Color.red : log.level == "warn" ? Color.orange : Color.primary)
                                    .textSelection(.enabled)
                            }
                            Text(Fmt.date(ms: log.createdAt).formatted(date: .abbreviated, time: .standard))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .padding(.leading, 15)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            } label: {
                HStack {
                    Label("Publishing log", systemImage: "list.bullet.rectangle")
                    Spacer()
                    if !logs.isEmpty {
                        if logs.contains(where: { $0.level == "error" }) {
                            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red).font(.caption)
                        }
                        Text(Fmt.count(logs.count)).font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func actionsSection(_ p: Post) -> some View {
        if model.canWrite && p.status != .published && p.status != .publishing {
            Section {
                switch p.status {
                case .failed, .cancelled:
                    actionButton(p.status == .failed ? "Retry now" : "Publish now", systemImage: "arrow.clockwise", key: "retry") { try await $0.retry(p.id) }
                case .needsCheck:
                    Button {
                        publishedURL = ""
                        markingPublished = true
                    } label: { Label("Mark as published", systemImage: "checkmark.circle") }
                    actionButton("Retry anyway", systemImage: "arrow.clockwise", key: "resolve") { try await $0.resolve(p.id, published: false, url: nil) }
                case .scheduled:
                    actionButton("Cancel", systemImage: "slash.circle", key: "cancel", role: .destructive) { try await $0.cancel(p.id) }
                default:
                    EmptyView()
                }
                if p.status.isEditable {
                    Button { rescheduling = true } label: {
                        Label(p.status == .draft ? "Schedule" : "Change schedule", systemImage: "calendar.badge.clock")
                    }
                }
            }
        }
    }

    private func actionButton(_ title: LocalizedStringKey, systemImage: String, key: String, role: ButtonRole? = nil, _ action: @escaping (APIClient) async throws -> Post) -> some View {
        Button(role: role) {
            Task { await perform(key, action) }
        } label: {
            HStack {
                Label(title, systemImage: systemImage)
                if busy == key { Spacer(); ProgressView() }
            }
        }
        .disabled(busy != nil)
    }

    private func moreMenu(_ p: Post) -> some View {
        Menu {
            Button("Duplicate", systemImage: "plus.square.on.square") { model.compose = ComposeRequest(duplicate: p) }
            if let url = p.externalUrl.flatMap(URL.init(string:)) {
                ShareLink(item: url) { Label("Share link", systemImage: "square.and.arrow.up") }
            }
            if p.status != .publishing {
                Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = true }
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
    }

    /// Tracked App Store link: Postflare's clicks and Apple's numbers for its campaign token.
    @ViewBuilder
    private func campaignSection(_ p: Post) -> some View {
        let results = metrics?.campaign
        if p.campaign?.trackedUrl != nil || results != nil {
            let currency = results?.currency ?? p.campaign?.currency
            Section {
                if let tracked = p.campaign?.trackedUrl {
                    LabeledContent("Link") {
                        Text(tracked).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                    }
                }
                LabeledContent("Link clicks", value: Fmt.compact(results?.clicks ?? Double(p.campaign?.clicks ?? 0)))
                if let d = results?.downloads ?? p.campaign?.downloads.map(Double.init) {
                    LabeledContent("Installs", value: Fmt.compact(d))
                }
                if let r = results?.redownloads, r > 0 { LabeledContent("Redownloads", value: Fmt.compact(r)) }
                if let u = results?.purchases, u > 0 { LabeledContent("Purchases", value: Fmt.compact(u)) }
                if let proceeds = results?.proceeds ?? p.campaign?.proceeds {
                    LabeledContent("Proceeds", value: Fmt.money(proceeds, currency: currency))
                }
            } header: {
                Text("Tracked App Store link")
            } footer: {
                if let day = results?.asOf.flatMap(Fmt.day) {
                    Text("App Store numbers as of \(day.formatted(date: .abbreviated, time: .omitted)).")
                } else if results?.downloads == nil {
                    Text("Installs and proceeds appear once Apple reports them.")
                }
            }
        }
    }

    // MARK: Helpers

    private struct SettingRow {
        var key: String
        var label: String
        var value: String
        /// Long text: shown below the label, collapsible.
        var long: Bool
        /// Code-like text (captions, translations).
        var mono = false
    }

    /// Set settings in the platform's field order, with the field labels and option labels instead of raw values.
    private func settingRows(_ p: Post, provider: ProviderInfo?) -> [SettingRow] {
        let fields = provider?.settingsFields ?? []
        var rows: [SettingRow] = []
        var seen = Set<String>()
        for f in fields {
            seen.insert(f.key)
            guard f.type != "password", let v = p.settings[f.key], !v.isEmpty else { continue }
            if let showIf = f.showIf, let other = p.settings[showIf.key] ?? fields.first(where: { $0.key == showIf.key })?.default, other != showIf.equals { continue }
            let text: String
            switch f.type {
            case "select":
                let raw = v.display
                text = optionLabel(key: f.key, value: raw, provider: provider) ?? raw
            case "datetime":
                if let n = v.number { text = Fmt.when(Fmt.date(ms: n)) }
                else if let s = v.string, let d = try? Date(s, strategy: .iso8601) { text = Fmt.when(d) }
                else { text = v.display }
            default:
                text = v.display
            }
            rows.append(SettingRow(key: f.key, label: f.label, value: text, long: text.count > 32 || text.contains("\n"), mono: f.type == "textarea" && text.contains("\n")))
        }
        for (k, v) in p.settings.sorted(by: { $0.key < $1.key }) where !seen.contains(k) && !v.isEmpty {
            rows.append(SettingRow(key: k, label: k, value: v.display, long: v.display.count > 32))
        }
        return rows
    }

    private func optionLabel(key: String, value: String, provider: ProviderInfo?) -> String? {
        if let label = provider?.settingsFields.first(where: { $0.key == key })?.options?.first(where: { $0.value == value })?.label { return label }
        return dynamicLabels[key]?[value]
    }

    /// Opens the viewer on all media of the post (the post's, then the follow-ups'), at the tapped one.
    private func openViewer(_ p: Post, ids: [String], index: Int) {
        let groups = [p.media] + p.thread.map(\.media)
        let all = groups.flatMap { $0 }
        guard !all.isEmpty else { return }
        var offset = 0
        for g in groups {
            if g == ids { break }
            offset += g.count
        }
        let start = offset + index < all.count ? offset + index : (all.firstIndex(of: ids[safe: index] ?? "") ?? 0)
        viewer = MediaViewerItem(ids: all, index: start)
    }

    private func switchTo(_ s: Post) {
        post.use(cacheKey: ResponseCache.key("post", s.id))
        if post.value == nil { post.set(s) }
        metrics = nil
        dynamicLabels = [:]
        showLog = false
        postId = s.id
    }

    /// Labels of the dynamic select values the post uses (needs posts.write, like the composer).
    private func loadDynamicLabels(_ p: Post) async {
        guard model.canWrite, let client = model.client, let provider = model.account(p.accountId).flatMap({ model.provider($0.provider) }) else { return }
        for f in provider.settingsFields where f.dynamicOptions == true && f.type == "select" {
            guard let v = p.settings[f.key], !v.isEmpty, dynamicLabels[f.key]?[v.display] == nil else { continue }
            if let options = try? await client.options(accountId: p.accountId, key: f.key, settings: p.settings) {
                dynamicLabels[f.key] = Dictionary(options.map { ($0.value, $0.label) }, uniquingKeysWith: { a, _ in a })
            }
        }
    }

    private func timeLine(_ p: Post) -> String {
        switch p.status {
        case .published: String(localized: "Published \(Fmt.when(p.date))")
        case .draft: String(localized: "Draft · created \(Fmt.when(Fmt.date(ms: p.createdAt)))")
        case .scheduled: String(localized: "Scheduled for \(Fmt.when(p.date))")
        default: Fmt.when(p.date)
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        post.use(cacheKey: ResponseCache.key("post", postId))
        let id = postId
        await post.load { try await client.post(id) }
        guard let p = post.value, p.id == postId else { return }
        model.loadMedia(p.media + p.thread.flatMap(\.media))
        var q = APIClient.PostQuery()
        q.groupId = p.groupId
        q.limit = 100
        if let group = try? await client.posts(q) { siblings = group.sorted { (model.account($0.accountId)?.name ?? "") < (model.account($1.accountId)?.name ?? "") } }
        if p.status == .published { metrics = try? await client.postMetrics(p.id) }
        await loadDynamicLabels(p)
    }

    private func perform(_ key: String, _ action: (APIClient) async throws -> Post) async {
        guard let client = model.client else { return }
        busy = key
        defer { busy = nil }
        do {
            let updated = try await action(client)
            var merged = updated
            merged.logs = updated.logs ?? post.value?.logs
            post.set(merged)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            model.dataChanged()
        } catch let APIError.planLimit(limit) {
            planLimit = limit
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            actionError = model.handle(error)
        }
    }

    private func delete() async {
        guard let client = model.client else { return }
        do {
            try await client.deletePost(postId)
            model.dataChanged()
            dismiss()
        } catch {
            actionError = model.handle(error)
        }
    }
}

/// Date picker for a new schedule, or "Save as draft".
struct RescheduleSheet: View {
    @Environment(\.dismiss) private var dismiss
    var post: Post
    var save: (Date?) async -> Void
    @State private var date: Date
    @State private var working = false

    init(post: Post, save: @escaping (Date?) async -> Void) {
        self.post = post
        self.save = save
        let current = post.scheduledAt.map(Fmt.date(ms:)) ?? .now.addingTimeInterval(3600)
        _date = State(initialValue: max(current, .now.addingTimeInterval(5 * 60)))
    }

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Publish at", selection: $date, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                    .datePickerStyle(.graphical)
                if post.status != .draft {
                    Button("Save as draft instead", systemImage: "doc.text") { Task { await run(nil) } }
                }
            }
            .navigationTitle(post.status == .draft ? "Schedule" : "Change schedule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await run(date) } }.disabled(working)
                }
            }
        }
        .presentationDetents([.large])
    }

    private func run(_ d: Date?) async {
        working = true
        await save(d)
        working = false
        dismiss()
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
