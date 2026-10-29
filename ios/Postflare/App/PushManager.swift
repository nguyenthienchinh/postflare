import Foundation
import Observation
import UIKit
import UserNotifications
import WidgetKit

/// Push permission, APNs registration (`PUT /devices/me`) and notification preferences (`PATCH /devices/me/prefs`).
@MainActor
@Observable
final class PushManager: NSObject {
    static let shared = PushManager()

    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var device: Device? = ResponseCache.load(Device.self, key: "device")
    private(set) var registering = false
    var lastError: String?

    #if DEBUG
    static let environment = "sandbox"
    #else
    static let environment = "production"
    #endif

    var isAuthorized: Bool { [.authorized, .provisional, .ephemeral].contains(authorization) }

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func requestAuthorizationAndRegister() async {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "PFSkipPushPrompt") { return }
        #endif
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge, .providesAppNotificationSettings])
            await refreshAuthorization()
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Called on launch: keeps the registration fresh when permission was already given.
    func registerIfAuthorized() async {
        await refreshAuthorization()
        if isAuthorized { UIApplication.shared.registerForRemoteNotifications() }
    }

    func didRegister(deviceToken: Data) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard let client = AppModel.shared.client else { return }
        registering = true
        defer { registering = false }
        do {
            setDevice(try await client.updateThisDevice(.init(apnsToken: hex, environment: Self.environment, name: AppModel.deviceName)))
            lastError = nil
        } catch {
            lastError = AppModel.shared.handle(error)
        }
    }

    /// The current registration (prefs) without changing the token.
    func refreshDevice() async {
        guard let client = AppModel.shared.client else { return }
        if let list = try? await client.devices(), let d = list.items.first(where: \.isCurrent) { setDevice(d) }
    }

    func update(_ prefs: DevicePrefs) async {
        guard let client = AppModel.shared.client else { return }
        // Optimistic: the toggle stays where the user put it.
        device?.prefs = prefs
        do {
            setDevice(try await client.updatePrefs(prefs))
            lastError = nil
        } catch {
            lastError = AppModel.shared.handle(error)
        }
    }

    func sendTest() async throws {
        guard let client = AppModel.shared.client else { throw APIError.notSignedIn }
        try await client.testPush()
    }

    func setDevice(_ d: Device?) {
        device = d
        if let d {
            SharedSettings.deviceId = d.id
            ResponseCache.store(d, key: "device")
        }
    }

    func forget() {
        device = nil
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let info = Self.payload(notification.request.content.userInfo)
        // A web sign-in request while the app is open: straight to the approval sheet.
        if info["type"] == "web_login" {
            await AppModel.shared.openNotification(info)
            return [.list]
        }
        // A customer writing in the conversation that is open: it refreshes by itself, no banner.
        if info["type"] == "support_message", let id = info["id"],
           await MainActor.run(body: { AppModel.shared.isShowingSupportConversation(id) }) {
            await MainActor.run { AppModel.shared.dataChanged() }
            return [.list]
        }
        await MainActor.run {
            AppModel.shared.dataChanged()
            WidgetCenter.shared.reloadAllTimelines()
        }
        return [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = Self.payload(response.notification.request.content.userInfo)
        await AppModel.shared.openNotification(info)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
        Task { @MainActor in
            AppModel.shared.tab = .settings
            AppModel.shared.settingsPath = [.notifications]
        }
    }

    /// The custom keys next to `aps`.
    nonisolated static func payload(_ info: [AnyHashable: Any]) -> [String: String] {
        ["type": info["type"] as? String, "postId": info["postId"] as? String, "workspaceId": info["workspaceId"] as? String, "id": info["id"] as? String]
            .compactMapValues { $0 }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = PushManager.shared
        // Web sign-in requests: no actions on the notification (approving needs Face ID in the app).
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "WEB_LOGIN", actions: [], intentIdentifiers: [], options: []),
        ])
        Task { @MainActor in
            if AppModel.shared.phase == .signedIn { await PushManager.shared.registerIfAuthorized() }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await PushManager.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushManager.shared.lastError = error.localizedDescription }
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        Task { @MainActor in
            AppModel.shared.dataChanged()
            WidgetCenter.shared.reloadAllTimelines()
        }
        completionHandler(.newData)
    }
}
