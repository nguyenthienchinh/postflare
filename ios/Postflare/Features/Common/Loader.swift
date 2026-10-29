import Foundation
import Observation

/// Loads one API response for a screen: shows the cached copy instantly (offline cache), then the fresh one.
@MainActor
@Observable
final class Loader<T: Codable & Sendable> {
    private struct Cached: Codable {
        var value: T
        var at: Date
    }

    private(set) var value: T?
    private(set) var updatedAt: Date?
    private(set) var loading = false
    private(set) var error: String?
    /// The last refresh failed and `value` comes from the cache.
    var offline: Bool { error != nil && value != nil }

    private var key: String?

    init() {}

    /// Switches to another cache entry (e.g. another filter) and shows its cached value at once.
    func use(cacheKey: String) {
        guard cacheKey != key else { return }
        key = cacheKey
        if let cached = ResponseCache.load(Cached.self, key: cacheKey) {
            value = cached.value
            updatedAt = cached.at
        } else {
            value = nil
            updatedAt = nil
        }
        error = nil
    }

    func load(_ fetch: () async throws -> T) async {
        loading = true
        defer { loading = false }
        do {
            let v = try await fetch()
            value = v
            updatedAt = Date()
            error = nil
            if let key { ResponseCache.store(Cached(value: v, at: Date()), key: key) }
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            if let message = AppModel.shared.handle(error) { self.error = message }
        }
    }

    func set(_ v: T) {
        value = v
        if let key { ResponseCache.store(Cached(value: v, at: Date()), key: key) }
    }
}
