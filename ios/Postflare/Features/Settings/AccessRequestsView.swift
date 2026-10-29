import SwiftUI
import UIKit

// Access requests (instance admins, `instance.users.manage`): people asking for an account on the web (/apply).
// Settings → Access requests lists them by status; the detail approves (an invitation link) or rejects them.

// MARK: - Labels

enum AccessRequestText {
    static func role(_ id: String) -> String {
        switch id {
        case "creator": String(localized: "Creator")
        case "agency": String(localized: "Agency")
        case "startup": String(localized: "Startup / app developer")
        case "brand": String(localized: "Brand / marketing team")
        case "other": String(localized: "Other")
        default: id.capitalized
        }
    }

    static func platform(_ id: String) -> String {
        switch id {
        case "x": "X"
        case "instagram": "Instagram"
        case "tiktok": "TikTok"
        case "youtube": "YouTube"
        case "linkedin": "LinkedIn"
        case "facebook": "Facebook"
        case "threads": "Threads"
        case "bluesky": "Bluesky"
        case "pinterest": "Pinterest"
        case "other": String(localized: "Other")
        default: Platform.name(id)
        }
    }

    /// "1-30" → "1-30 posts/month".
    static func volume(_ id: String) -> String { String(localized: "\(id) posts/month") }

    static func status(_ status: String) -> String {
        switch status {
        case "pending": String(localized: "Pending")
        case "approved": String(localized: "Approved")
        case "rejected": String(localized: "Rejected")
        case "withdrawn": String(localized: "Withdrawn")
        default: status.capitalized
        }
    }

    static func color(_ status: String) -> Color {
        switch status {
        case "pending": .orange
        case "approved": .green
        case "rejected": .red
        default: .gray
        }
    }

    static func country(_ code: String) -> String {
        Locale.current.localizedString(forRegionCode: code) ?? code
    }
}

struct AccessRequestStatusBadge: View {
    var status: String

    var body: some View {
        let color = AccessRequestText.color(status)
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(AccessRequestText.status(status))
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(AccessRequestText.status(status)))
    }
}

/// Initials on a tinted circle.
private struct ApplicantAvatar: View {
    var name: String
    var size: CGFloat = 38

    var body: some View {
        let initials = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
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

struct AccessRequestRow: View {
    var request: AccessRequest

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ApplicantAvatar(name: request.name)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(request.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Fmt.relative(ms: request.createdAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text("\(request.organization) · \(AccessRequestText.role(request.role))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                AccessRequestStatusBadge(status: request.status)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - List

/// `GET /access-requests`: a status filter (pending first), search and pages of 50 (`nextBefore`).
struct AccessRequestsView: View {
    @Environment(AppModel.self) private var model

    enum Filter: String, CaseIterable, Identifiable {
        case pending, all, approved, rejected
        var id: String { rawValue }

        var title: String {
            switch self {
            case .pending: String(localized: "Pending")
            case .all: String(localized: "All")
            case .approved: String(localized: "Approved")
            case .rejected: String(localized: "Rejected")
            }
        }
    }

    @State private var filter: Filter = .pending
    @State private var search = ""
    @State private var items: [AccessRequest] = []
    @State private var counts: AccessRequestCounts?
    @State private var nextBefore: Double?
    @State private var loaded = false
    @State private var loading = false
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
                    ForEach(items) { r in
                        NavigationLink(value: Route.accessRequest(id: r.id)) { AccessRequestRow(request: r) }
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
                    ContentUnavailableView("No access requests", systemImage: "person.crop.circle.badge.questionmark",
                                           description: Text(filter == .pending ? "New requests from the web show up here." : "Try another status."))
                }
            }
        }
        .navigationTitle("Access requests")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: Text("Name, email, company or website"))
        .refreshable { await reload() }
        .task(id: "\(filter.rawValue)#\(query)#\(model.dataVersion)") {
            if !query.isEmpty {
                try? await Task.sleep(for: .milliseconds(350))
                if Task.isCancelled { return }
            }
            await reload()
        }
    }

    private func label(_ f: Filter) -> String {
        guard let counts else { return f.title }
        let n: Int? = switch f {
        case .pending: counts.pending
        case .approved: counts.approved
        case .rejected: counts.rejected
        case .all: nil
        }
        guard let n, n > 0 else { return f.title }
        return String(localized: "\(f.title) \(n)")
    }

    private func reload() async {
        guard let client = model.client else { return }
        generation += 1
        let gen = generation
        let status = filter.rawValue, q = query
        loading = true
        defer { if gen == generation { loading = false } }
        do {
            let page = try await client.accessRequests(status: status, query: q)
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
            let page = try await client.accessRequests(status: filter.rawValue, query: query, before: before)
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
}

// MARK: - Detail

/// One request with every field it was sent with, its review, and Approve / Reject / New invite link.
struct AccessRequestDetailView: View {
    @Environment(AppModel.self) private var model
    var requestId: String

    @State private var request = Loader<AccessRequest>()
    /// The last approve / reject answer (invitation link, emailed).
    @State private var result: AccessRequestReview?
    @State private var working = false
    @State private var confirmApprove = false
    @State private var confirmNewLink = false
    @State private var rejecting = false
    @State private var actionError: String?
    @State private var copied = false

    var body: some View {
        Group {
            if let r = request.value {
                content(r)
            } else if let error = request.error {
                ContentUnavailableView {
                    Label("Request not available", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") { Task { await load() } }.buttonStyle(.glass)
                }
            } else {
                ProgressView().controlSize(.large)
            }
        }
        .navigationTitle(request.value?.name ?? String(localized: "Access request"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(requestId)#\(model.dataVersion)") { await load() }
        .refreshable { await load() }
        .confirmationDialog(Text("Approve \(request.value?.name ?? "")?"), isPresented: $confirmApprove, titleVisibility: .visible) {
            Button("Approve") { Task { await approve() } }
        } message: {
            Text("They get an invitation link to create an account.")
        }
        .confirmationDialog("Make a new invite link?", isPresented: $confirmNewLink, titleVisibility: .visible) {
            Button("New invite link") { Task { await approve() } }
        } message: {
            Text("The previous link stops working.")
        }
        .sheet(isPresented: $rejecting) {
            if let r = request.value {
                RejectAccessRequestSheet(request: r) { note, notify in
                    await review(approve: false, note: note, notify: notify)
                }
            }
        }
        .alert("Something went wrong", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    @ViewBuilder
    private func content(_ r: AccessRequest) -> some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    ApplicantAvatar(name: r.name, size: 48)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.name).font(.headline)
                        Text("\(r.organization) · \(AccessRequestText.role(r.role))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        AccessRequestStatusBadge(status: r.status)
                    }
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
                if r.existingUser {
                    Label("Has an account already", systemImage: "person.crop.circle.badge.checkmark")
                        .font(.subheadline)
                        .foregroundStyle(.blue)
                }
            }

            if let result { resultSection(result) }

            actionsSection(r)

            Section("Contact") {
                LabeledContent("Email") {
                    if let mail = URL(string: "mailto:\(r.email)") {
                        Link(r.email, destination: mail).lineLimit(1)
                    } else {
                        Text(r.email)
                    }
                }
                .contextMenu { copyButton(r.email) }
                if let company = r.company, !company.isEmpty { LabeledContent("Company", value: company) }
                LabeledContent("Website") {
                    if let url = r.website {
                        Link(destination: url) {
                            Text(r.url).lineLimit(1).truncationMode(.middle)
                        }
                    } else {
                        Text(r.url).lineLimit(1).truncationMode(.middle)
                    }
                }
                .contextMenu { copyButton(r.url) }
            }

            Section("About") {
                LabeledContent("Role", value: AccessRequestText.role(r.role))
                if !r.platforms.isEmpty {
                    LabeledContent("Platforms", value: r.platforms.map(AccessRequestText.platform).formatted(.list(type: .and, width: .narrow)))
                }
                if let accounts = r.accounts { LabeledContent("Accounts", value: Fmt.count(accounts)) }
                if let volume = r.volume { LabeledContent("Volume", value: AccessRequestText.volume(volume)) }
                if let referral = r.referral, !referral.isEmpty { LabeledContent("Heard about us", value: referral) }
                if let country = r.country, !country.isEmpty { LabeledContent("Country", value: AccessRequestText.country(country)) }
            }

            Section("Use case") {
                Text(r.useCase)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Section("Review") {
                LabeledContent("Status") { AccessRequestStatusBadge(status: r.status) }
                if let by = r.reviewedBy { LabeledContent("Reviewed by", value: by.name) }
                if let at = r.reviewedAt { LabeledContent("Reviewed", value: Fmt.date(ms: at).formatted(date: .abbreviated, time: .shortened)) }
                if let note = r.reviewNote, !note.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Note").font(.subheadline).foregroundStyle(.secondary)
                        Text(note).textSelection(.enabled)
                    }
                }
                if r.invitationId != nil {
                    LabeledContent("Invitation", value: r.invitationAccepted ? String(localized: "Accepted") : String(localized: "Not accepted yet"))
                }
            }

            Section("Details") {
                LabeledContent("Created", value: Fmt.date(ms: r.createdAt).formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Updated", value: Fmt.date(ms: r.updatedAt).formatted(date: .abbreviated, time: .shortened))
                if let ip = r.ip { LabeledContent("IP address") { Text(ip).font(.caption.monospaced()).textSelection(.enabled) } }
                if let ua = r.userAgent, !ua.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Browser").font(.subheadline).foregroundStyle(.secondary)
                        Text(ua).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func actionsSection(_ r: AccessRequest) -> some View {
        let canApprove = r.isPending || r.isRejected
        let canReject = r.isPending
        let canRelink = r.isApproved && !r.invitationAccepted && !r.existingUser
        if canApprove || canReject || canRelink {
            Section {
                if canApprove {
                    Button {
                        confirmApprove = true
                    } label: {
                        Label("Approve", systemImage: "checkmark.circle")
                    }
                }
                if canReject {
                    Button(role: .destructive) {
                        rejecting = true
                    } label: {
                        Label("Reject", systemImage: "xmark.circle")
                    }
                }
                if canRelink {
                    Button {
                        confirmNewLink = true
                    } label: {
                        Label("New invite link", systemImage: "link.badge.plus")
                    }
                }
                if working {
                    HStack {
                        ProgressView()
                        Text("Saving…").foregroundStyle(.secondary)
                    }
                }
            } footer: {
                if canRelink { Text("The invitation has not been used yet. A new link replaces the old one.") }
            }
            .disabled(working)
        }
    }

    @ViewBuilder
    private func resultSection(_ result: AccessRequestReview) -> some View {
        Section {
            if let invitation = result.invitation, let url = URL(string: invitation.url) {
                Text(invitation.url)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .lineLimit(3)
                Button {
                    UIPasteboard.general.string = invitation.url
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                ShareLink(item: url, subject: Text("Your Postflare invitation")) {
                    Label("Share link", systemImage: "square.and.arrow.up")
                }
            } else if result.existingUser == true {
                Label("This email already has an account; marked approved.", systemImage: "person.crop.circle.badge.checkmark")
            } else if result.request.isRejected {
                Label(result.emailed ? "Rejected. The applicant was emailed." : "Rejected.", systemImage: "xmark.circle")
            } else {
                Label("Approved.", systemImage: "checkmark.circle")
            }
        } header: {
            Text(result.invitation != nil ? "Invite link" : "Done")
        } footer: {
            if let invitation = result.invitation {
                let expires = Fmt.date(ms: invitation.expiresAt).formatted(date: .abbreviated, time: .shortened)
                Text(result.emailed ? "It was emailed to \(result.request.email). Expires \(expires)." : "It was not emailed: send it yourself. Expires \(expires).")
            }
        }
    }

    private func copyButton(_ value: String) -> some View {
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = value }
    }

    private func load() async {
        guard let client = model.client else { return }
        await request.load { try await client.accessRequest(requestId) }
    }

    private func approve() async {
        if let message = await review(approve: true) { actionError = message }
    }

    /// PATCH; returns the error to show, nil when it worked.
    private func review(approve: Bool, note: String? = nil, notify: Bool = true) async -> String? {
        guard let client = model.client else { return nil }
        working = true
        defer { working = false }
        do {
            let r = try await client.reviewAccessRequest(requestId, approve: approve, note: note, notify: notify)
            request.set(r.request)
            result = r
            copied = false
            model.dataChanged()
            return nil
        } catch {
            return model.handle(error)
        }
    }
}

// MARK: - Reject

/// Reject with an optional note (≤ 1000 characters; part of the email when the applicant is emailed).
struct RejectAccessRequestSheet: View {
    @Environment(\.dismiss) private var dismiss
    var request: AccessRequest
    /// Returns the error to show, nil when it worked.
    var reject: (_ note: String?, _ notify: Bool) async -> String?

    @State private var note = ""
    @State private var notify = true
    @State private var working = false
    @State private var error: String?

    private static let maxNote = 1000
    private var trimmed: String { note.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $note)
                        .frame(minHeight: 140)
                        .accessibilityLabel(Text("Note"))
                } header: {
                    Text("Note (optional)")
                } footer: {
                    HStack(alignment: .top) {
                        Text(notify ? "Included in the email to the applicant. Admins see it too." : "Only admins see it.")
                        Spacer()
                        Text("\(note.count)/\(Self.maxNote)")
                            .monospacedDigit()
                            .foregroundStyle(note.count > Self.maxNote ? .red : .secondary)
                    }
                }
                Section {
                    Toggle("Email the applicant", isOn: $notify)
                } footer: {
                    Text("Only when this server can send email.")
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle(Text("Reject \(request.name)?"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("Reject", role: .destructive) {
                            Task {
                                working = true
                                defer { working = false }
                                if let message = await reject(trimmed.isEmpty ? nil : trimmed, notify) {
                                    error = message
                                } else {
                                    dismiss()
                                }
                            }
                        }
                        .disabled(note.count > Self.maxNote)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(working)
    }
}
