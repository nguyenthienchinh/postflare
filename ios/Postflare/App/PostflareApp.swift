import SwiftUI
import WidgetKit

@main
struct PostflareApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        ImageLoader.installCache()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(PushManager.shared)
                .onOpenURL { model.open($0) }
                .tint(.brand)
                #if DEBUG
                // Simulator automation: `xcrun simctl launch booted <bundle id> -PFOpenURL postflare://posts`.
                .task {
                    if let s = UserDefaults.standard.string(forKey: "PFOpenURL"), let url = URL(string: s) { model.open(url) }
                }
                #endif
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            SharedSettings.reload()
            if model.phase == .signedIn {
                model.dataChanged()
                Task { await PushManager.shared.refreshAuthorization() }
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            switch model.phase {
            case .signedOut:
                OnboardingView()
                    .transition(.opacity)
            case .signedIn:
                MainTabView()
                    .transition(.opacity)
            }
        }
        .animation(.smooth, value: model.phase)
        .sheet(item: Binding(get: { model.phase == .signedIn ? model.pendingPair.map(PendingPair.init) : nil },
                             set: { if $0 == nil { model.pendingPair = nil } })) { pending in
            SwitchAccountSheet(request: pending.request)
        }
        // A browser asking to be signed in (QR code, camera link or push).
        .sheet(item: Binding(get: { model.phase == .signedIn ? model.pendingWebLogin : nil },
                             set: { if $0 == nil { model.pendingWebLogin = nil } })) { request in
            WebLoginSheet(request: request)
        }
    }
}

private struct PendingPair: Identifiable {
    var request: AppModel.PairRequest
    var id: String { request.code }
}

/// A pairing link opened while signed in: offer to sign in with it (replaces the current session).
private struct SwitchAccountSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var request: AppModel.PairRequest
    @State private var working = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "qrcode.viewfinder").font(.system(size: 48)).foregroundStyle(.tint)
            Text("Sign in with this pairing code?").font(.title3.bold()).multilineTextAlignment(.center)
            Text(request.server.host() ?? request.server.absoluteString).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).font(.footnote).multilineTextAlignment(.center) }
            Button {
                Task {
                    working = true
                    defer { working = false }
                    do {
                        try? await model.client?.signOut()
                        try await model.pair(server: request.server, code: request.code)
                        model.pendingPair = nil
                        dismiss()
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            } label: {
                Text(working ? "Signing in…" : "Sign in").frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(working)
            Button("Cancel", role: .cancel) { model.pendingPair = nil; dismiss() }
        }
        .padding(24)
        .presentationDetents([.medium])
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                NavigationStack(path: $model.homePath) { HomeView().routes() }
            }
            Tab("Posts", systemImage: "calendar", value: AppTab.posts) {
                NavigationStack(path: $model.postsPath) { PostsView().routes() }
            }
            Tab("Accounts", systemImage: "person.2", value: AppTab.accounts) {
                NavigationStack(path: $model.accountsPath) { AccountsView().routes() }
            }
            Tab("Analytics", systemImage: "chart.bar.xaxis", value: AppTab.analytics) {
                NavigationStack(path: $model.analyticsPath) { AnalyticsView().routes() }
            }
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
                NavigationStack(path: $model.settingsPath) { SettingsView().routes() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .sheet(item: $model.compose) { request in
            ComposeView(request: request)
        }
        .task {
            await model.refreshMe()
            await model.refreshCatalog()
        }
    }
}

extension View {
    /// Destinations shared by every tab's navigation stack.
    func routes() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case let .post(id): PostDetailView(postId: id)
            case .notifications: NotificationSettingsView()
            case .devices: DevicesView()
            case .accessRequests: AccessRequestsView()
            case let .accessRequest(id): AccessRequestDetailView(requestId: id)
            case .support: SupportInboxView()
            case let .supportConversation(id): SupportConversationView(conversationId: id)
            }
        }
    }

    /// The "New post" toolbar button (hidden for roles that cannot write posts).
    func composeButton() -> some View { modifier(ComposeButton()) }
}

private struct ComposeButton: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content.toolbar {
            if model.canWrite {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.compose = ComposeRequest()
                    } label: {
                        Label("New post", systemImage: "square.and.pencil")
                    }
                    .buttonStyle(.glassProminent)
                }
            }
        }
    }
}
