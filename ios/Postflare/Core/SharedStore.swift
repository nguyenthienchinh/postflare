import Foundation

/// Non-secret settings shared by the app and the widgets. Stored as one JSON item in the shared keychain group (see
/// `Keychain`), cached per process; `reload()` picks up changes made by the other process.
enum SharedSettings {
    private struct Values: Codable {
        var workspaceId: String?
        var workspaceName: String?
        var deviceId: String?
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: Values?

    private static func read() -> Values {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        let v = Keychain.data("settings").flatMap { try? JSONDecoder().decode(Values.self, from: $0) } ?? Values()
        cached = v
        return v
    }

    private static func write(_ change: (inout Values) -> Void) {
        var v = read()
        change(&v)
        lock.lock()
        cached = v
        lock.unlock()
        if let data = try? JSONEncoder().encode(v) { Keychain.set(data, for: "settings") }
    }

    /// Drops the in-memory copy (widgets call this before building a timeline).
    static func reload() {
        lock.lock()
        cached = nil
        lock.unlock()
    }

    /// Sent as `X-Workspace-Id` with every workspace-scoped request.
    static var workspaceId: String? {
        get { read().workspaceId }
        set { write { $0.workspaceId = newValue } }
    }
    static var workspaceName: String? {
        get { read().workspaceName }
        set { write { $0.workspaceName = newValue } }
    }
    /// `devices.id` of this install (DeviceTokenDTO.deviceId).
    static var deviceId: String? {
        get { read().deviceId }
        set { write { $0.deviceId = newValue } }
    }

    /// Sign-out: forgets the workspace and device.
    static func reset() {
        write { $0 = Values() }
    }
}

/// JSON files in the process's caches directory: the last response of every screen shows instantly on launch
/// (offline cache). The app and the widget extension each keep their own.
enum ResponseCache {
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    private static var directory: URL {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "api", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private static func fileURL(_ key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }
        return directory.appending(path: String(safe) + ".json")
    }

    /// A cache key scoped to the current workspace.
    static func key(_ parts: String...) -> String {
        ([SharedSettings.workspaceId ?? "default"] + parts).joined(separator: "_")
    }

    static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = try? Data(contentsOf: fileURL(key)) else { return nil }
        return try? decoder.decode(T.self, from: data)
    }

    static func store<T: Encodable>(_ value: T, key: String) {
        guard let data = try? encoder.encode(value) else { return }
        try? data.write(to: fileURL(key), options: .atomic)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: directory)
    }
}
