import Foundation
import Observation
import SwiftUI
import UIKit
import WidgetKit

enum AppTab: String, Hashable { case home, posts, accounts, analytics, settings }

enum Route: Hashable {
    case post(id: String)
    case notifications
    case devices
    case accessRequests
    case accessRequest(id: String)
    case support
    case supportConversation(id: String)
}

/// What the composer opens with: empty, or a copy of a post (Duplicate).
struct ComposeRequest: Identifiable, Equatable {
    var id = UUID()
    var duplicate: Post?
}

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    enum Phase: Equatable { case signedOut, signedIn }

    private(set) var phase: Phase
    private(set) var client: APIClient?
    private(set) var me: Me?

    var tab: AppTab = .home
    var homePath: [Route] = []
    var postsPath: [Route] = []
    var accountsPath: [Route] = []
    var analyticsPath: [Route] = []
    var settingsPath: [Route] = []
    var compose: ComposeRequest?

    /// Bumped when the workspace changes, a post changes or a push says there is news: screens reload.
    private(set) var dataVersion = 0

    // Workspace catalog: accounts, groups and the platform list (names, limits, settings fields).
    private(set) var accounts: [Account] = []
    private(set) var groups: [AccountGroup] = []
    private(set) var providers: [ProviderInfo] = []
    /// Media of the workspace by id (thumbnails); filled page by page from `GET /media`.
    private(set) var media: [String: Media] = [:]
    private var mediaComplete = false
    private var mediaLoading: Task<Void, Never>?

    private init() {
        // Keychain items outlive the app: a reinstall starts signed out.
        if !UserDefaults.standard.bool(forKey: "launchedBefore") {
            UserDefaults.standard.set(true, forKey: "launchedBefore")
            Keychain.delete()
            SharedSettings.reset()
        }
        let creds = Keychain.load()
        phase = creds == nil ? .signedOut : .signedIn
        client = creds.map { APIClient(server: $0.server, token: $0.token, workspaceId: SharedSettings.workspaceId) }
        me = ResponseCache.load(Me.self, key: "me")
        loadCachedCatalog()
    }

    var serverURL: URL? { client?.server }
    var workspace: Workspace? {
        guard let me else { return nil }
        let id = client?.workspaceId ?? me.currentWorkspaceId
        return me.workspaces.first { $0.id == id } ?? me.workspaces.first
    }

    func can(_ permission: String) -> Bool { workspace?.can(permission) ?? false }
    var canWrite: Bool { can("posts.write") }
    /// Instance admin: reviews access requests (`instance.users.manage`).
    var canManageUsers: Bool { me?.can("instance.users.manage") ?? false }
    /// Answers support chats (`instance.support.manage`).
    var canAnswerSupport: Bool { me?.can("instance.support.manage") ?? false }

    func account(_ id: String) -> Account? { accounts.first { $0.id == id } }
    func provider(_ id: String) -> ProviderInfo? { providers.first { $0.id == id } }
    func providerName(_ id: String) -> String { provider(id)?.name ?? Platform.name(id) }
    func group(_ id: String?) -> AccountGroup? { id.flatMap { id in groups.first { $0.id == id } } }

    /// Accounts by group (groups in their order, then the ungrouped ones).
    var groupedAccounts: [(group: AccountGroup?, accounts: [Account])] {
        let sorted = accounts.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        var out: [(AccountGroup?, [Account])] = groups.sorted { $0.position < $1.position }.compactMap { g in
            let list = sorted.filter { $0.groupId == g.id }
            return list.isEmpty ? nil : (g, list)
        }
        let known = Set(groups.map(\.id))
        let rest = sorted.filter { $0.groupId == nil || !known.contains($0.groupId!) }
        if !rest.isEmpty { out.append((nil, rest)) }
        return out
    }

    // MARK: Session

    func signIn(server: URL, email: String, password: String) async throws {
        try await checkServer(server)
        let r = try await APIClient(server: server).signIn(email: email, password: password, deviceName: Self.deviceName)
        completeSignIn(server: server, response: r)
    }

    func pair(server: URL, code: String) async throws {
        try await checkServer(server)
        let r = try await APIClient(server: server).pair(code: code, deviceName: Self.deviceName)
        completeSignIn(server: server, response: r)
    }

    /// Refuses servers whose REST API version this app does not speak.
    private func checkServer(_ server: URL) async throws {
        let api = APIClient(server: server)
        guard let v = try? await api.version() else { return }
        if !APIClient.supportedAPIVersions.contains(v.apiVersion) {
            throw APIError.server(status: 400, message: String(localized: "This server runs Postflare \(v.version), which this app does not support yet. Update the app or the server."))
        }
    }

    private func completeSignIn(server: URL, response r: DeviceTokenResponse) {
        // Keep the address that just worked (the server-reported public URL may not be reachable from here).
        Keychain.save(StoredCredentials(server: server, token: r.token, userEmail: r.user.email))
        let ws = r.currentWorkspaceId ?? r.workspaces.first?.id
        SharedSettings.workspaceId = ws
        SharedSettings.workspaceName = r.workspaces.first { $0.id == ws }?.name
        SharedSettings.deviceId = r.deviceId
        client = APIClient(server: server, token: r.token, workspaceId: ws)
        me = r.me
        ResponseCache.store(r.me, key: "me")
        phase = .signedIn
        tab = .home
        dataVersion += 1
        Task {
            await refreshCatalog()
            await PushManager.shared.requestAuthorizationAndRegister()
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    func signOut() async {
        try? await client?.signOut()
        signOutLocally()
    }

    func signOutLocally() {
        Keychain.delete()
        SharedSettings.reset()
        ResponseCache.clear()
        PushManager.shared.forget()
        client = nil
        me = nil
        accounts = []; groups = []; providers = []; media = [:]; mediaComplete = false
        phase = .signedOut
        homePath = []; postsPath = []; accountsPath = []; analyticsPath = []; settingsPath = []
        compose = nil
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// A 401 ends the session. Returns the message to show, or nil when there is nothing to show.
    func handle(_ error: Error) -> String? {
        if error is CancellationError { return nil }
        if let e = error as? APIError, e == .unauthorized {
            signOutLocally()
            return nil
        }
        return error.localizedDescription
    }

    func refreshMe() async {
        guard let client else { return }
        do {
            let me = try await client.me()
            self.me = me
            ResponseCache.store(me, key: "me")
            // The remembered workspace may be gone (removed from it): fall back to the server's choice.
            if let id = client.workspaceId, !me.workspaces.contains(where: { $0.id == id }) {
                if let ws = me.workspaces.first(where: { $0.id == me.currentWorkspaceId }) ?? me.workspaces.first { await switchWorkspace(ws) }
            } else if let ws = workspace {
                SharedSettings.workspaceName = ws.name
            }
        } catch {
            _ = handle(error)
        }
    }

    func switchWorkspace(_ ws: Workspace) async {
        guard var client else { return }
        let changed = client.workspaceId != ws.id
        client.workspaceId = ws.id
        self.client = client
        SharedSettings.workspaceId = ws.id
        SharedSettings.workspaceName = ws.name
        guard changed else { return }
        homePath = []; postsPath = []; accountsPath = []; analyticsPath = []
        media = [:]; mediaComplete = false
        loadCachedCatalog()
        dataVersion += 1
        try? await client.rememberWorkspace(ws.id)
        await refreshCatalog()
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: Catalog

    private struct Catalog: Codable {
        var accounts: [Account]
        var groups: [AccountGroup]
        var providers: [ProviderInfo]
    }

    private func loadCachedCatalog() {
        let c = ResponseCache.load(Catalog.self, key: ResponseCache.key("catalog"))
        accounts = c?.accounts ?? []
        groups = c?.groups ?? []
        providers = c?.providers ?? providers
    }

    func refreshCatalog() async {
        guard let client else { return }
        async let a = client.accounts()
        async let g = client.accountGroups()
        async let p = client.providers()
        do {
            let accounts = try await a
            let groups = (try? await g) ?? []
            let providers = (try? await p) ?? self.providers
            self.accounts = accounts
            self.groups = groups
            self.providers = providers
            ResponseCache.store(Catalog(accounts: accounts, groups: groups, providers: providers), key: ResponseCache.key("catalog"))
        } catch {
            _ = handle(error)
        }
    }

    // MARK: Media lookup

    /// Loads media pages until every id in `ids` is known (or the list ends).
    func loadMedia(_ ids: [String]) {
        guard !mediaComplete, ids.contains(where: { media[$0] == nil }), mediaLoading == nil, let client else { return }
        mediaLoading = Task {
            defer { mediaLoading = nil }
            var before: Double? = media.values.map(\.createdAt).min()
            for _ in 0..<10 {
                guard let page = try? await client.media(limit: 200, before: before) else { return }
                for m in page { media[m.id] = m }
                if page.count < 200 { mediaComplete = true; return }
                before = page.last?.createdAt
                if !ids.contains(where: { media[$0] == nil }) { return }
            }
        }
    }

    func remember(_ m: Media) { media[m.id] = m }

    // MARK: Data signals

    func dataChanged() { dataVersion += 1 }

    // MARK: Deep links

    func open(_ url: URL) {
        guard url.scheme == "postflare" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host() ?? "" {
        case "pair":
            pendingPair = PairRequest(url: url)
        case "web-login":
            pendingWebLogin = WebLoginRequest(url: url)
        case "home", "today", "overview":
            tab = .home
        case "posts", "calendar":
            tab = .posts
            postsPath = []
            if url.host() == "calendar" || parts.first == "calendar" { UserDefaults.standard.set("calendar", forKey: "postsMode") }
            else if parts.first == "list" { UserDefaults.standard.set("list", forKey: "postsMode") }
        case "post":
            if let id = parts.first { openPost(id) }
        case "compose", "new":
            guard phase == .signedIn, canWrite else { return }
            // postflare://compose?duplicate=<post id> opens a copy of that post.
            if let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "duplicate" })?.value, let client {
                Task { if let p = try? await client.post(id) { compose = ComposeRequest(duplicate: p) } }
            } else {
                compose = ComposeRequest()
            }
        case "accounts":
            tab = .accounts
        case "analytics":
            tab = .analytics
        case "settings":
            tab = .settings
            switch parts.first {
            case "notifications": settingsPath = [.notifications]
            case "devices": settingsPath = [.devices]
            case "access-requests" where canManageUsers:
                settingsPath = [.accessRequests] + (parts.dropFirst().first.map { [.accessRequest(id: $0)] } ?? [])
            case "support" where canAnswerSupport:
                settingsPath = [.support] + (parts.dropFirst().first.map { [.supportConversation(id: $0)] } ?? [])
            default: settingsPath = []
            }
        case "notifications":
            tab = .settings
            settingsPath = [.notifications]
        default:
            break
        }
    }

    /// Settings → Access requests → the request.
    func openAccessRequest(_ id: String) {
        tab = .settings
        settingsPath = [.accessRequests, .accessRequest(id: id)]
    }

    /// Settings → Support → the conversation.
    func openSupportConversation(_ id: String) {
        tab = .settings
        settingsPath = [.support, .supportConversation(id: id)]
    }

    /// The support conversation is on screen (a push for it needs no banner).
    func isShowingSupportConversation(_ id: String) -> Bool {
        tab == .settings && settingsPath.last == .supportConversation(id: id)
    }

    func openPost(_ id: String) {
        tab = .posts
        postsPath = [.post(id: id)]
    }

    /// A `postflare://pair?s=<server>&c=<code>` link waiting to be used (onboarding signs in with it).
    struct PairRequest: Equatable {
        var server: URL
        var code: String

        init?(url: URL) {
            guard url.scheme == "postflare", url.host() == "pair" else { return nil }
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func value(_ names: String...) -> String? {
                items.first(where: { names.contains($0.name) })?.value.flatMap { $0.isEmpty ? nil : $0 }
            }
            guard let code = value("c", "code"), let server = value("s", "server").flatMap(APIClient.normalizeServer) else { return nil }
            self.server = server
            self.code = code
        }
    }

    var pendingPair: PairRequest?

    /// A browser asking to be signed in by this device: from a `postflare://web-login?s=<server>&r=<id>&k=<nonce>` QR
    /// code (scanner or camera) or a `WEB_LOGIN` push (`id` only; it comes from the signed-in server).
    struct WebLoginRequest: Identifiable, Equatable {
        var id: String
        var nonce: String?
        /// The server named in the QR code; must be the one this app is signed in to.
        var server: URL?

        init(id: String, nonce: String? = nil, server: URL? = nil) {
            self.id = id
            self.nonce = nonce
            self.server = server
        }

        init?(url: URL) {
            guard url.scheme == "postflare", url.host() == "web-login" else { return nil }
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value.flatMap { $0.isEmpty ? nil : $0 } }
            guard let id = value("r"), id.hasPrefix("wl_"), let nonce = value("k"),
                  let server = value("s").flatMap(APIClient.normalizeServer)
            else { return nil }
            self.init(id: id, nonce: nonce, server: server)
        }
    }

    var pendingWebLogin: WebLoginRequest?

    /// Same scheme, host and port (a QR code's server against the configured one).
    static func sameServer(_ a: URL, _ b: URL) -> Bool {
        func port(_ u: URL) -> Int? { u.port ?? (u.scheme?.lowercased() == "https" ? 443 : u.scheme?.lowercased() == "http" ? 80 : nil) }
        return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host()?.lowercased() == b.host()?.lowercased() && port(a) == port(b)
    }

    /// A scanned code (Settings → Sign in on a computer): web sign-in requests and pairing codes. Returns an error to show.
    func handleScanned(_ code: String) -> String? {
        guard let url = URL(string: code) else { return String(localized: "This is not a Postflare sign-in code.") }
        if let request = WebLoginRequest(url: url) {
            pendingWebLogin = request
            return nil
        }
        if let pair = PairRequest(url: url) {
            pendingPair = pair
            return nil
        }
        return String(localized: "This is not a Postflare sign-in code.")
    }

    // MARK: Notifications

    /// Notification tap: `type` (post_published | post_failed | post_needs_check | web_login | access_request |
    /// support_message | test), `postId`,
    /// `workspaceId`, `id` from the payload.
    func openNotification(_ info: [String: String]) async {
        switch info["type"] {
        case "web_login":
            if let id = info["id"], id.hasPrefix("wl_") { pendingWebLogin = WebLoginRequest(id: id) }
        case "access_request":
            guard phase == .signedIn, let id = info["id"] else { return }
            openAccessRequest(id)
            dataChanged()
        case "support_message":
            guard phase == .signedIn, let id = info["id"] else { return }
            openSupportConversation(id)
            dataChanged()
        case "post_published", "post_failed", "post_needs_check":
            guard phase == .signedIn, let postId = info["postId"] else { return }
            if let wsId = info["workspaceId"], wsId != client?.workspaceId {
                if me?.workspaces.contains(where: { $0.id == wsId }) != true { await refreshMe() }
                if let ws = me?.workspaces.first(where: { $0.id == wsId }) { await switchWorkspace(ws) }
            }
            openPost(postId)
            dataChanged()
        default:
            break
        }
    }

    static var deviceName: String {
        let model = UIDevice.current.model
        let name = UIDevice.current.name
        return String((name == model ? "Postflare · \(model)" : name).prefix(100))
    }
}
