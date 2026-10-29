import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PushManager.self) private var push
    @State private var confirmSignOut = false
    @State private var scanning = false
    @State private var scanned: String?
    @State private var scanError: String?
    @State private var serverVersion: String?
    @State private var pendingRequests: Int?
    @State private var unreadSupport: Int?

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    BrandMark(size: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.me?.user.name ?? "—").font(.headline)
                        Text(model.me?.user.email ?? Keychain.load()?.userEmail ?? "").font(.subheadline).foregroundStyle(.secondary)
                        if let role = model.me?.user.role.name { Text(role).font(.caption).foregroundStyle(.tertiary) }
                    }
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
            }

            Section {
                if let me = model.me, me.workspaces.count > 1 {
                    Picker(selection: Binding(get: { model.workspace?.id ?? "" }, set: { id in
                        guard let ws = me.workspaces.first(where: { $0.id == id }) else { return }
                        Task { await model.switchWorkspace(ws) }
                    })) {
                        ForEach(me.workspaces) { ws in Text(ws.name).tag(ws.id) }
                    } label: {
                        Label("Workspace", systemImage: "building.2")
                    }
                } else {
                    LabeledContent {
                        Text(model.workspace?.name ?? "—")
                    } label: {
                        Label("Workspace", systemImage: "building.2")
                    }
                }
                if let ws = model.workspace {
                    LabeledContent {
                        Text(ws.role.name)
                    } label: {
                        Label("Role", systemImage: "person.badge.key")
                    }
                }
            } header: {
                Text("Workspace")
            } footer: {
                if model.workspace?.demo == true {
                    Text("The demo workspace is sandboxed: publishing is simulated and nothing is sent to the platforms.")
                }
            }

            Section("Notifications") {
                NavigationLink(value: Route.notifications) {
                    HStack {
                        Label("Notifications", systemImage: "bell.badge")
                        Spacer()
                        Text(pushStatus).foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                Button {
                    scanError = nil
                    scanning = true
                } label: {
                    Label("Sign in on a computer", systemImage: "qrcode.viewfinder")
                }
                if let scanError { Text(scanError).font(.footnote).foregroundStyle(.red) }
                NavigationLink(value: Route.devices) {
                    Label("Devices", systemImage: "iphone")
                }
            } header: {
                Text("Security")
            } footer: {
                Text("On the Postflare sign-in page, choose Sign in with the iPhone app and scan the code.")
            }

            if model.canManageUsers || model.canAnswerSupport {
                Section {
                    if model.canAnswerSupport {
                        NavigationLink(value: Route.support) {
                            Label("Support", systemImage: "bubble.left.and.bubble.right")
                        }
                        .badge(unreadSupport ?? 0)
                    }
                    if model.canManageUsers {
                        NavigationLink(value: Route.accessRequests) {
                            Label("Access requests", systemImage: "person.crop.circle.badge.questionmark")
                        }
                        .badge(pendingRequests ?? 0)
                    }
                } header: {
                    Text("Instance")
                } footer: {
                    if model.canManageUsers && model.canAnswerSupport {
                        Text("Support chats from your website, and people who asked for an account on the web.")
                    } else if model.canManageUsers {
                        Text("People who asked for an account on the web.")
                    } else {
                        Text("Support chats from your website.")
                    }
                }
            }

            Section("Server") {
                LabeledContent {
                    Text(model.serverURL?.host() ?? "—")
                } label: {
                    Label("Server", systemImage: "server.rack")
                }
                if let serverVersion { LabeledContent("Server version", value: serverVersion) }
                LabeledContent("App version", value: Self.appVersion)
                if let url = model.serverURL {
                    Link(destination: url) {
                        Label("Open the web app", systemImage: "safari")
                    }
                }
            }

            // The server's own pages: they carry its operator's details (Admin → Settings → Legal & contact).
            if let url = model.serverURL {
                Section("About") {
                    Link(destination: url.appending(path: "privacy/")) {
                        Label("Privacy Policy", systemImage: "hand.raised")
                    }
                    Link(destination: url.appending(path: "terms/")) {
                        Label("Terms of Service", systemImage: "doc.text")
                    }
                    Link(destination: url.appending(path: "data-deletion/")) {
                        Label("Data Deletion", systemImage: "trash")
                    }
                }
            }

            Section {
                Button(role: .destructive) {
                    confirmSignOut = true
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .navigationTitle("Settings")
        .toolbarTitleDisplayMode(.inlineLarge)
        .sheet(isPresented: $scanning, onDismiss: {
            // After the scanner is gone: the approval (or pairing) sheet is presented from the root.
            if let code = scanned {
                scanned = nil
                scanError = model.handleScanned(code)
            }
        }) {
            QRScannerSheet(hint: "Point the camera at the QR code on the Postflare sign-in page.") { code in
                scanned = code
                scanning = false
            }
        }
        .confirmationDialog("Sign out of Postflare?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
        } message: {
            Text("This device stops receiving notifications.")
        }
        .task {
            await push.refreshAuthorization()
            if serverVersion == nil, let v = try? await model.client?.version() { serverVersion = v.version }
        }
        .task(id: "\(model.canManageUsers)#\(model.dataVersion)") {
            guard model.canManageUsers, let client = model.client else { return }
            if let n = try? await client.pendingAccessRequests() { pendingRequests = n }
        }
        .task(id: "\(model.canAnswerSupport)#\(model.dataVersion)") {
            guard model.canAnswerSupport, let client = model.client else { return }
            if let n = try? await client.supportCount() { unreadSupport = n.unread }
        }
        .refreshable { await model.refreshMe() }
    }

    private var pushStatus: String {
        switch push.authorization {
        case .authorized, .provisional, .ephemeral: push.device?.push == true ? String(localized: "On") : String(localized: "Registering…")
        case .denied: String(localized: "Off")
        default: String(localized: "Not set up")
        }
    }

    static var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }
}

/// Push permission, what to be notified about (`PATCH /devices/me/prefs`) and a test push.
struct NotificationSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PushManager.self) private var push
    @State private var prefs = DevicePrefs()
    @State private var loaded = false
    @State private var testing = false
    @State private var testResult: String?
    @State private var saveTask: Task<Void, Never>?
    @State private var serverPush: Bool?

    var body: some View {
        Form {
            switch push.authorization {
            case .denied:
                Section {
                    Label("Notifications are turned off for Postflare.", systemImage: "bell.slash")
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            case .notDetermined:
                Section {
                    Button {
                        Task { await push.requestAuthorizationAndRegister() }
                    } label: {
                        Label("Turn on notifications", systemImage: "bell.badge")
                    }
                } footer: {
                    Text("Get a push when a post is published, fails or needs a check, and approve sign-ins on your computer.")
                }
            default:
                EmptyView()
            }

            if serverPush == false {
                Section {
                    Label("This server has no push notifications set up (APNs). Ask its admin to configure them.", systemImage: "info.circle")
                        .font(.footnote)
                }
            }

            if push.isAuthorized && push.device?.push != true {
                Section {
                    HStack {
                        ProgressView()
                        Text("Registering this device…").foregroundStyle(.secondary)
                    }
                    if let error = push.lastError { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }

            Section {
                Toggle(isOn: $prefs.published) { Label("Published posts", systemImage: "checkmark.circle") }
                Toggle(isOn: $prefs.failed) { Label("Failed posts and checks", systemImage: "exclamationmark.triangle") }
                if model.canManageUsers {
                    Toggle(isOn: $prefs.accessRequests) { Label("Access requests", systemImage: "person.crop.circle.badge.questionmark") }
                }
                if model.canAnswerSupport {
                    Toggle(isOn: $prefs.support) { Label("Support messages", systemImage: "bubble.left.and.bubble.right") }
                }
            } header: {
                Text("Notify me about")
            } footer: {
                Text("Demo workspaces never send notifications.")
            }

            if let workspaces = model.me?.workspaces, workspaces.count > 1 {
                Section {
                    Toggle(isOn: Binding(get: { prefs.workspaces == nil }, set: { all in
                        prefs.workspaces = all ? nil : workspaces.map(\.id)
                    })) {
                        Label("All workspaces", systemImage: "building.2")
                    }
                    if let chosen = prefs.workspaces {
                        ForEach(workspaces) { ws in
                            Toggle(ws.name, isOn: Binding(get: { chosen.contains(ws.id) }, set: { on in
                                var list = Set(prefs.workspaces ?? [])
                                if on { list.insert(ws.id) } else { list.remove(ws.id) }
                                prefs.workspaces = workspaces.map(\.id).filter(list.contains)
                            }))
                        }
                    }
                } header: {
                    Text("Workspaces")
                }
            }

            Section {
                Button {
                    Task {
                        testing = true
                        defer { testing = false }
                        do {
                            try await push.sendTest()
                            testResult = String(localized: "Sent. It should arrive in a few seconds.")
                        } catch {
                            testResult = model.handle(error)
                        }
                    }
                } label: {
                    HStack {
                        Label("Send a test notification", systemImage: "paperplane")
                        if testing { Spacer(); ProgressView() }
                    }
                }
                .disabled(testing || push.device?.push != true)
                if let testResult { Text(testResult).font(.footnote).foregroundStyle(.secondary) }
            } footer: {
                if let d = push.device {
                    Text("\(d.name ?? AppModel.deviceName) · \(d.environment)")
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: push.device?.id, initial: true) {
            if let d = push.device, !loaded {
                prefs = d.prefs
                loaded = true
            }
        }
        .onChange(of: prefs) { _, new in
            guard loaded, new != push.device?.prefs else { return }
            saveTask?.cancel()
            saveTask = Task {
                try? await Task.sleep(for: .milliseconds(500))
                guard !Task.isCancelled else { return }
                await push.update(new)
            }
        }
        .task {
            await push.refreshAuthorization()
            await push.refreshDevice()
            if let d = push.device, !loaded {
                prefs = d.prefs
                loaded = true
            }
            serverPush = try? await model.client?.devices().push
        }
    }
}

/// The user's signed-in app installs (`GET /devices`); signing one out ends its token at once.
struct DevicesView: View {
    @Environment(AppModel.self) private var model
    @State private var devices = Loader<DeviceList>()
    @State private var confirm: Device?
    @State private var error: String?

    var body: some View {
        List {
            if let error { ErrorBanner(message: error).listRowBackground(Color.clear) }
            ForEach(devices.value?.items ?? []) { d in
                HStack(spacing: 12) {
                    Image(systemName: "iphone").font(.title2).foregroundStyle(d.isCurrent ? Color.brand : .secondary).frame(width: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(d.name ?? String(localized: "iPhone")).font(.body.weight(.medium))
                            if d.isCurrent { Text("This device").font(.caption2.weight(.semibold)).foregroundStyle(Color.brand) }
                        }
                        Text(d.push ? String(localized: "Notifications on") : String(localized: "Notifications off"))
                            .font(.caption).foregroundStyle(.secondary)
                        if let seen = d.lastSeenAt {
                            Text("Last used \(Fmt.relative(ms: seen))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                .swipeActions {
                    if !d.isCurrent {
                        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirm = d }
                    }
                }
            }
        }
        .overlay {
            if devices.value == nil && devices.loading { ProgressView() }
        }
        .navigationTitle("Devices")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("Sign this device out?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible, presenting: confirm) { d in
            Button("Sign out \(d.name ?? "")", role: .destructive) {
                Task {
                    do {
                        try await model.client?.deleteDevice(d.id)
                        await load()
                    } catch {
                        self.error = model.handle(error)
                    }
                }
            }
        } message: { _ in
            Text("It has to sign in again to use Postflare.")
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        devices.use(cacheKey: "devices")
        await devices.load { try await client.devices() }
    }
}
