import AVFoundation
import ImageIO
import SwiftUI
import UIKit

/// Remote images for thumbnails and previews: decoded and downsampled off the main thread, kept display-ready in
/// memory, on top of `URLSession.shared` and its disk `URLCache` (`installCache()`).
@MainActor
enum ImageLoader {
    /// Longest side of grid / list thumbnails, in pixels (server thumbnails are at most 480 px).
    static let thumbPixels = 600
    /// Longest side of hero previews, in pixels (the fullscreen viewer loads the original).
    static let fullPixels = 2048

    private static let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 96 * 1024 * 1024
        return c
    }()
    private static var inFlight: [NSString: Task<UIImage?, Never>] = [:]

    /// A large persistent HTTP cache for `URLSession.shared` (AsyncImage, this loader, the viewer). Call once at launch,
    /// before any image request. The API client has its own session and keeps bypassing the cache.
    nonisolated static func installCache() {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("media", isDirectory: true)
        URLCache.shared = URLCache(memoryCapacity: 64 * 1024 * 1024, diskCapacity: 512 * 1024 * 1024, directory: dir)
    }

    static func cached(_ url: URL, maxPixel: Int) -> UIImage? { cache.object(forKey: key(url, maxPixel)) }

    static func load(_ url: URL, maxPixel: Int) async -> UIImage? {
        let k = key(url, maxPixel)
        if let hit = cache.object(forKey: k) { return hit }
        if let running = inFlight[k] { return await running.value }
        let task = Task<UIImage?, Never> {
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true else { return nil }
            return await Task.detached(priority: .userInitiated) { decode(data, maxPixel: maxPixel) }.value
        }
        inFlight[k] = task
        let image = await task.value
        inFlight[k] = nil
        if let image, let cg = image.cgImage { cache.setObject(image, forKey: k, cost: cg.bytesPerRow * cg.height) }
        return image
    }

    private static func key(_ url: URL, _ maxPixel: Int) -> NSString { "\(maxPixel)|\(url.absoluteString)" as NSString }

    /// Decodes at most `maxPixel` on the longest side (never upscales), orientation applied, already decompressed.
    nonisolated private static func decode(_ data: Data, maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// A remote image filling its frame. Tries `urls` in order (e.g. the thumbnail, then the full media); `placeholder`
/// is shown while loading if it is already in memory (a thumbnail under its full image).
struct CachedImage: View {
    var urls: [URL]
    var maxPixel: Int
    var contentMode: ContentMode = .fill
    var placeholder: URL? = nil

    @State private var loaded: (urls: [URL], image: UIImage)?
    @State private var failed: [URL]?

    var body: some View {
        Group {
            if let image = current {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else if failed == urls {
                Image(systemName: "photo").foregroundStyle(.secondary)
            } else if let placeholder, let image = ImageLoader.cached(placeholder, maxPixel: ImageLoader.thumbPixels) {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                ProgressView()
            }
        }
        .task(id: urls) {
            guard current == nil else { return }
            for url in urls {
                if let image = await ImageLoader.load(url, maxPixel: maxPixel) {
                    loaded = (urls, image)
                    return
                }
                if Task.isCancelled { return }
            }
            failed = urls
        }
    }

    /// The loaded image for the current urls, or the first one already in memory (no flash when scrolling back).
    private var current: UIImage? {
        if let loaded, loaded.urls == urls { return loaded.image }
        return urls.first.flatMap { ImageLoader.cached($0, maxPixel: maxPixel) }
    }
}

/// First frames of videos, generated once per install: memory, then `Caches/video-posters/<media id>.jpg`.
enum VideoPosters {
    private static let memory = NSCache<NSString, UIImage>()
    private static let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("video-posters", isDirectory: true)

    static func cached(_ id: String) -> UIImage? { memory.object(forKey: id as NSString) }

    static func load(id: String, url: URL) async -> UIImage? {
        if let hit = memory.object(forKey: id as NSString) { return hit }
        let file = dir.appendingPathComponent(fileName(id))
        if let image = await Task.detached(priority: .userInitiated, operation: { () -> UIImage? in
            guard let data = try? Data(contentsOf: file), let image = UIImage(data: data) else { return nil }
            return image.preparingForDisplay() ?? image
        }).value {
            memory.setObject(image, forKey: id as NSString)
            return image
        }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 800, height: 800)
        guard let (cg, _) = try? await generator.image(at: CMTime(seconds: 0.1, preferredTimescale: 600)) else { return nil }
        let image = UIImage(cgImage: cg)
        memory.setObject(image, forKey: id as NSString)
        Task.detached(priority: .utility) {
            guard let data = image.jpegData(compressionQuality: 0.8) else { return }
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }
        return image
    }

    /// Media ids as safe file names.
    private static func fileName(_ id: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let safe = String(id.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
        return (safe.isEmpty ? "_" : safe) + ".jpg"
    }
}
