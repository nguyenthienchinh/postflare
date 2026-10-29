import SwiftUI
import UIKit

// Support chat (users with `instance.support.manage`, docs/support-spec.md): the chats people start in the bubble on
// the instance's pages or another website. Settings → Support lists them by status; the conversation answers them.

// MARK: - Labels

enum SupportText {
    static func status(_ status: SupportStatus) -> String {
        switch status {
        case .open: String(localized: "Open")
        case .pending: String(localized: "Waiting")
        case .closed: String(localized: "Closed")
        }
    }

    static func color(_ status: SupportStatus) -> Color {
        switch status {
        case .open: .green
        case .pending: .orange
        case .closed: .gray
        }
    }

    static func source(_ source: String) -> String {
        switch source {
        case "widget": String(localized: "Chat bubble")
        case "app": String(localized: "Web app")
        default: source.capitalized
        }
    }

    /// The list's last line: "You: …" when staff wrote last.
    static func preview(_ ticket: SupportTicket) -> String {
        let text = ticket.lastMessagePreview ?? ""
        return ticket.lastAuthor == "staff" ? String(localized: "You: \(text)") : text
    }
}

struct SupportStatusBadge: View {
    var status: SupportStatus

    var body: some View {
        let color = SupportText.color(status)
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(SupportText.status(status))
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(SupportText.status(status)))
    }
}

/// Initials on a tinted circle (an email: its first letter).
private struct SupportAvatar: View {
    var name: String
    var size: CGFloat = 38

    var body: some View {
        let words = name.contains("@") ? [Substring(name)] : name.split(separator: " ")
        let initials = words.prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        Circle()
            .fill(Color.brand.opacity(0.15))
            .overlay {
                Text(initials.isEmpty ? "?" : initials)
                    .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.brand)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct SupportTicketRow: View {
    var ticket: SupportTicket
    /// The status badge (the "All" filter).
    var showStatus = false

    var body: some View {
        let unread = ticket.isUnread
        HStack(alignment: .top, spacing: 12) {
            SupportAvatar(name: ticket.displayName)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if unread {
                        Circle().fill(Color.blue).frame(width: 8, height: 8)
                            .accessibilityLabel(Text("Unread"))
                    }
                    Text(ticket.displayName)
                        .font(.subheadline.weight(unread ? .bold : .medium))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Fmt.relative(ms: ticket.lastMessageAt))
                        .font(.caption)
                        .foregroundStyle(unread ? Color.blue : Color.secondary)
                }
                HStack(spacing: 6) {
                    Text("#\(ticket.number)").monospacedDigit()
                    if let subject = ticket.subject, !subject.isEmpty {
                        Text(subject).lineLimit(1)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                Text(SupportText.preview(ticket))
                    .font(.subheadline)
                    .foregroundStyle(unread ? .primary : .secondary)
                    .lineLimit(2)
                if showStatus || ticket.assignee != nil {
                    HStack(spacing: 8) {
                        if showStatus { SupportStatusBadge(status: ticket.status) }
                        if let assignee = ticket.assignee {
                            Label(assignee.name, systemImage: "person")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .padding(.top, 1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Inbox

/// `GET /admin/support/conversations`: Open / Waiting / Closed / All, "Mine", search and pages of 50 (`nextBefore`).
struct SupportInboxView: View {
    @Environment(AppModel.self) private var model

    enum Filter: String, CaseIterable, Identifiable {
        case open, pending, closed, all
        var id: String { rawValue }

        var title: String {
            switch self {
            case .open: String(localized: "Open")
            case .pending: String(localized: "Waiting")
            case .closed: String(localized: "Closed")
            case .all: String(localized: "All")
            }
        }
    }

    @State private var filter: Filter = .open
    @AppStorage("supportMine") private var mine = false
    @State private var search = ""
    @State private var items: [SupportTicket] = []
    @State private var counts: SupportCounts?
    @State private var nextBefore: Double?
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var error: String?
    /// Bumped by every reload so a page that arrives late for an old filter is dropped.
    @State private var generation = 0

    private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        List {
            Section {
                Picker("Status", selection: $filter) {
                    ForEach(Filter.allCases) { f in Text(label(f)).tag(f) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            if let error {
                ErrorBanner(message: error) { Task { await reload() } }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            if !items.isEmpty {
                Section {
                    ForEach(items) { t in
                        NavigationLink(value: Route.supportConversation(id: t.id)) {
                            SupportTicketRow(ticket: t, showStatus: filter == .all)
                        }
                        .swipeActions(edge: .trailing) {
                            if t.status == .closed {
                                Button("Reopen", systemImage: "arrow.uturn.backward") { Task { await setStatus(t, .open) } }
                                    .tint(.green)
                            } else {
                                Button("Close", systemImage: "checkmark") { Task { await setStatus(t, .closed) } }
                                    .tint(.gray)
                            }
                        }
                    }
                    if let nextBefore {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                        .task(id: nextBefore) { await loadMore() }
                    }
                }
            }
        }
        .overlay {
            if items.isEmpty {
                if !loaded {
                    if error == nil { ProgressView().controlSize(.large) }
                } else if !query.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else if error == nil {
                    ContentUnavailableView("No conversations", systemImage: "bubble.left.and.bubble.right",
                                           description: Text(emptyHint))
                }
            }
        }
        .navigationTitle("Support")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Toggle(isOn: $mine) {
                    Label("Mine", systemImage: mine ? "person.crop.circle.fill" : "person.crop.circle")
                }
                .toggleStyle(.button)
                .accessibilityHint(Text("Only conversations assigned to you"))
            }
        }
        .searchable(text: $search, prompt: Text("Name, email, message or #number"))
        .refreshable { await reload() }
        .task(id: "\(filter.rawValue)#\(mine)#\(query)#\(model.dataVersion)") {
            if !query.isEmpty {
                try? await Task.sleep(for: .milliseconds(350))
                if Task.isCancelled { return }
            }
            await reload()
        }
    }

    private var emptyHint: String {
        if mine { return String(localized: "Nothing assigned to you here. Turn off Mine to see everyone's.") }
        switch filter {
        case .open: return String(localized: "New chats from your website show up here.")
        case .pending: return String(localized: "Conversations waiting for the customer's answer show up here.")
        default: return String(localized: "Try another status.")
        }
    }

    private func label(_ f: Filter) -> String {
        guard let counts else { return f.title }
        let n: Int? = switch f {
        case .open: counts.open
        case .pending: counts.pending
        case .closed: counts.closed
        case .all: nil
        }
        guard let n, n > 0 else { return f.title }
        return String(localized: "\(f.title) \(n)")
    }

    private func reload() async {
        guard let client = model.client else { return }
        generation += 1
        let gen = generation
        do {
            let page = try await client.supportConversations(status: filter.rawValue, mine: mine, query: query)
            guard gen == generation else { return }
            items = page.items
            counts = page.counts
            nextBefore = page.nextBefore
            error = nil
            loaded = true
        } catch {
            guard gen == generation, let message = model.handle(error) else { return }
            self.error = message
            loaded = true
        }
    }

    private func loadMore() async {
        guard let client = model.client, let before = nextBefore, !loadingMore else { return }
        let gen = generation
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.supportConversations(status: filter.rawValue, mine: mine, query: query, before: before)
            guard gen == generation else { return }
            let known = Set(items.map(\.id))
            items += page.items.filter { !known.contains($0.id) }
            counts = page.counts
            nextBefore = page.nextBefore
        } catch {
            guard gen == generation, let message = model.handle(error) else { return }
            self.error = message
            nextBefore = nil
        }
    }

    private func setStatus(_ ticket: SupportTicket, _ status: SupportStatus) async {
        guard let client = model.client else { return }
        do {
            _ = try await client.updateSupport(ticket.id, .init(status: status))
            model.dataChanged()
        } catch {
            if let message = model.handle(error) { self.error = message }
        }
    }
}

// MARK: - Conversation

/// The thread (notes included), the customer, status / assignee / delete, and the composer. Refreshes every 5 s while
/// on screen and the app is active (the server has no push to the app for staff replies by others).
struct SupportConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    var conversationId: String

    enum ComposeMode: String, Hashable { case reply, note }

    @State private var ticket: SupportTicket?
    @State private var messages: [SupportMessage] = []
    @State private var loadError: String?
    @State private var staff: [SupportStaff] = []
    @State private var draft = ""
    @State private var mode: ComposeMode = .reply
    @State private var sending = false
    @State private var working = false
    @State private var actionError: String?
    @State private var confirmDelete = false
    @State private var showingCustomer = false
    @State private var sent = 0
    /// Bumped by sends and changes so a refresh that started before them does not overwrite their result.
    @State private var generation = 0
    @FocusState private var composerFocused: Bool

    private static let maxBody = 5000
    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { !trimmed.isEmpty && trimmed.count <= Self.maxBody && !sending && ticket != nil }

    var body: some View {
        Group {
            if let ticket {
                thread(ticket)
            } else if let loadError {
                ContentUnavailableView {
                    Label("Conversation not available", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError)
                } actions: {
                    Button("Retry") { Task { await load() } }.buttonStyle(.glass)
                }
            } else {
                ProgressView().controlSize(.large)
            }
        }
        .navigationTitle(ticket?.displayName ?? String(localized: "Conversation"))
        .navigationSubtitle(ticket.map { Text("#\($0.number) · \(SupportText.status($0.status))") } ?? Text(""))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let ticket {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingCustomer = true
                    } label: {
                        Label("Customer", systemImage: "person.crop.circle")
                    }
                }
                ToolbarItem(placement: .primaryAction) { actionsMenu(ticket) }
            }
        }
        // While on screen and the app is active: now, then every 5 s.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .task { await loadStaff() }
        .sheet(isPresented: $showingCustomer) {
            if let ticket { SupportCustomerSheet(ticket: ticket) }
        }
        .confirmationDialog("Delete this conversation?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text("It is removed with all its messages, also for the customer. Use it for spam.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
        .sensoryFeedback(.success, trigger: sent)
    }

    // MARK: Thread

    @ViewBuilder
    private func thread(_ ticket: SupportTicket) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    header(ticket)
                        .padding(.bottom, 6)
                    ForEach(messages) { m in
                        SupportMessageBubble(message: m, customerName: ticket.displayName)
                            .id(m.id)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.last?.id) { _, last in
                guard let last else { return }
                withAnimation(.snappy) { proxy.scrollTo(last, anchor: .bottom) }
            }
            .onChange(of: composerFocused) { _, focused in
                guard focused, let last = messages.last?.id else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    withAnimation(.snappy) { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer(ticket) }
        }
    }

    /// Who it is, the subject, status and assignee; opens the customer sheet.
    private func header(_ ticket: SupportTicket) -> some View {
        Button {
            showingCustomer = true
        } label: {
            VStack(spacing: 8) {
                SupportAvatar(name: ticket.displayName, size: 52)
                VStack(spacing: 2) {
                    Text(ticket.displayName).font(.headline)
                    if let email = ticket.email, !email.isEmpty, email != ticket.displayName {
                        Text(email).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if let subject = ticket.subject, !subject.isEmpty {
                    Text(subject)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                }
                HStack(spacing: 8) {
                    SupportStatusBadge(status: ticket.status)
                    Label(ticket.assignee?.name ?? String(localized: "Unassigned"), systemImage: "person")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("Shows the customer's details"))
    }

    // MARK: Composer

    private func composer(_ ticket: SupportTicket) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Picker("Message type", selection: $mode) {
                    Text("Reply").tag(ComposeMode.reply)
                    Text("Internal note").tag(ComposeMode.note)
                }
                .pickerStyle(.segmented)
                .fixedSize()
                Spacer(minLength: 0)
                if mode == .reply {
                    Button("Reply & close") { Task { await send(close: true) } }
                        .font(.subheadline.weight(.medium))
                        .disabled(!canSend)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $draft,
                          prompt: Text(mode == .note ? "Note for your team (the customer does not see it)" : "Reply to \(ticket.displayName)"),
                          axis: .vertical)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(mode == .note ? Color.yellow.opacity(0.2) : Color(.secondarySystemBackground),
                                in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                Group {
                    if sending {
                        ProgressView().frame(width: 34, height: 34)
                    } else {
                        Button {
                            Task { await send(close: false) }
                        } label: {
                            Image(systemName: mode == .note ? "lock.circle.fill" : "arrow.up.circle.fill")
                                .font(.system(size: 34))
                                .foregroundStyle(canSend ? (mode == .note ? Color.orange : Color.brand) : Color.secondary.opacity(0.5))
                        }
                        .disabled(!canSend)
                        .accessibilityLabel(Text(mode == .note ? "Add note" : "Send"))
                    }
                }
                .padding(.bottom, 1)
            }
            if draft.count > Self.maxBody - 500 {
                Text("\(draft.count)/\(Self.maxBody)")
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(draft.count > Self.maxBody ? .red : .secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.bar)
    }

    // MARK: Actions

    private func actionsMenu(_ ticket: SupportTicket) -> some View {
        Menu {
            Section {
                if ticket.status == .closed {
                    Button("Reopen", systemImage: "arrow.uturn.backward.circle") { Task { await update(.init(status: .open)) } }
                } else {
                    Button("Close", systemImage: "checkmark.circle") { Task { await update(.init(status: .closed)) } }
                }
                if ticket.status == .pending {
                    Button("Mark open", systemImage: "tray") { Task { await update(.init(status: .open)) } }
                } else {
                    Button("Mark waiting", systemImage: "clock") { Task { await update(.init(status: .pending)) } }
                }
            }
            Section {
                Menu {
                    Picker("Assignee", selection: Binding(get: { ticket.assignee?.id ?? "" }, set: { id in
                        Task { await update(.init(assigneeId: .some(id.isEmpty ? nil : id))) }
                    })) {
                        Label("Unassigned", systemImage: "person.slash").tag("")
                        ForEach(assignees(ticket)) { s in
                            Text(s.name).tag(s.id)
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    Label("Assign", systemImage: "person.badge.plus")
                }
            }
            Section {
                Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = true }
            }
        } label: {
            if working {
                ProgressView()
            } else {
                Label("Actions", systemImage: "ellipsis")
            }
        }
        .disabled(working)
    }

    /// The staff list, plus the current assignee if they no longer answer chats.
    private func assignees(_ ticket: SupportTicket) -> [SupportStaff] {
        var list = staff
        if let a = ticket.assignee, !list.contains(where: { $0.id == a.id }) {
            list.append(SupportStaff(id: a.id, name: a.name, email: ""))
        }
        return list
    }

    // MARK: Loading

    private func load() async {
        guard let client = model.client else { return }
        let gen = generation
        do {
            let t = try await client.supportConversation(conversationId)
            guard gen == generation else { return }
            let first = ticket == nil
            // Customer messages that arrived since the last refresh were just marked read: badges change.
            let known = Set(messages.map(\.id))
            let news = t.messages.contains { !known.contains($0.id) && $0.author == .customer }
            ticket = t.conversation
            messages = t.messages
            loadError = nil
            if first || news { model.dataChanged() }
        } catch {
            guard gen == generation, let message = model.handle(error) else { return }
            if ticket == nil || (error as? APIError)?.status == 404 {
                ticket = nil
                loadError = message
            }
        }
    }

    private func loadStaff() async {
        guard let client = model.client, staff.isEmpty else { return }
        if let list = try? await client.supportStaff() { staff = list }
    }

    private func send(close: Bool) async {
        guard let client = model.client, canSend else { return }
        let text = trimmed
        let note = mode == .note
        sending = true
        generation += 1
        defer { sending = false }
        do {
            let r = try await client.replySupport(conversationId, body: text, note: note && !close, status: close ? .closed : nil)
            generation += 1
            if !messages.contains(where: { $0.id == r.message.id }) { messages.append(r.message) }
            ticket = r.conversation
            draft = ""
            sent += 1
            model.dataChanged()
        } catch {
            actionError = model.handle(error)
        }
    }

    private func update(_ change: APIClient.SupportUpdate) async {
        guard let client = model.client else { return }
        working = true
        generation += 1
        defer { working = false }
        do {
            let t = try await client.updateSupport(conversationId, change)
            generation += 1
            ticket = t
            model.dataChanged()
        } catch {
            actionError = model.handle(error)
        }
    }

    private func delete() async {
        guard let client = model.client else { return }
        working = true
        defer { working = false }
        do {
            try await client.deleteSupport(conversationId)
            model.dataChanged()
            dismiss()
        } catch {
            actionError = model.handle(error)
        }
    }
}

// MARK: - Bubble

/// Customer on the left, staff on the right in the accent colour, internal notes on the right in yellow.
struct SupportMessageBubble: View {
    var message: SupportMessage
    var customerName: String

    private var fromStaff: Bool { message.author != .customer }

    private var author: String {
        if let name = message.authorName, !name.isEmpty { return name }
        return message.author == .customer ? customerName : String(localized: "Staff")
    }

    var body: some View {
        VStack(alignment: fromStaff ? .trailing : .leading, spacing: 4) {
            if message.author == .note {
                Label("Internal note", systemImage: "lock.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(message.body)
                .font(.body)
                .foregroundStyle(message.author == .staff ? Color.white : Color.primary)
                .padding(.horizontal, 13)
                .padding(.vertical, 8)
                .background(background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay {
                    if message.author == .note {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(Color.yellow.opacity(0.6), lineWidth: 1)
                    }
                }
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.body }
                }
            Text("\(author) · \(Fmt.when(Fmt.date(ms: message.createdAt)))")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: fromStaff ? .trailing : .leading)
        .padding(fromStaff ? .leading : .trailing, 44)
        .accessibilityElement(children: .combine)
    }

    private var background: Color {
        switch message.author {
        case .customer: Color(.secondarySystemBackground)
        case .staff: Color.brand
        case .note: Color.yellow.opacity(0.25)
        }
    }
}

// MARK: - Customer

/// Everything known about who wrote: contact, their Postflare user and workspace, the page, country and browser.
struct SupportCustomerSheet: View {
    @Environment(\.dismiss) private var dismiss
    var ticket: SupportTicket

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        SupportAvatar(name: ticket.displayName, size: 48)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(ticket.displayName).font(.headline)
                            SupportStatusBadge(status: ticket.status)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }

                Section("Contact") {
                    if let name = ticket.name, !name.isEmpty { LabeledContent("Name", value: name) }
                    if let email = ticket.email, !email.isEmpty {
                        LabeledContent("Email") {
                            if let mail = URL(string: "mailto:\(email)") {
                                Link(email, destination: mail).lineLimit(1)
                            } else {
                                Text(email)
                            }
                        }
                        .contextMenu { copyButton(email) }
                    } else {
                        LabeledContent("Email", value: String(localized: "Not given"))
                    }
                }

                if ticket.user != nil || ticket.workspace != nil {
                    Section("Postflare account") {
                        if let user = ticket.user {
                            LabeledContent("User") {
                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(user.name)
                                    if !user.email.isEmpty { Text(user.email).font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                            .contextMenu { copyButton(user.email) }
                        }
                        if let ws = ticket.workspace { LabeledContent("Workspace", value: ws.name) }
                    }
                }

                Section("Conversation") {
                    LabeledContent("Ticket", value: "#\(ticket.number)")
                    LabeledContent("Status") { SupportStatusBadge(status: ticket.status) }
                    LabeledContent("Assigned to", value: ticket.assignee?.name ?? String(localized: "Unassigned"))
                    LabeledContent("Started in", value: SupportText.source(ticket.source))
                    LabeledContent("Created", value: Fmt.date(ms: ticket.createdAt).formatted(date: .abbreviated, time: .shortened))
                    if let seen = ticket.customerSeenAt {
                        LabeledContent("Customer last seen", value: Fmt.date(ms: seen).formatted(date: .abbreviated, time: .shortened))
                    }
                    if let closed = ticket.closedAt, ticket.status == .closed {
                        LabeledContent("Closed", value: Fmt.date(ms: closed).formatted(date: .abbreviated, time: .shortened))
                    }
                }

                Section("Visit") {
                    if let page = ticket.pageUrl, !page.isEmpty {
                        LabeledContent("Page") {
                            if let url = URL(string: page), url.host() != nil {
                                Link(destination: url) { Text(page).lineLimit(1).truncationMode(.middle) }
                            } else {
                                Text(page).lineLimit(1).truncationMode(.middle)
                            }
                        }
                        .contextMenu { copyButton(page) }
                    }
                    if let country = ticket.country, !country.isEmpty {
                        LabeledContent("Country", value: AccessRequestText.country(country))
                    }
                    if let ip = ticket.ip { LabeledContent("IP address") { Text(ip).font(.caption.monospaced()).textSelection(.enabled) } }
                    if let ua = ticket.userAgent, !ua.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Browser").font(.subheadline).foregroundStyle(.secondary)
                            Text(ua).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle("Customer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func copyButton(_ value: String) -> some View {
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = value }
    }
}
