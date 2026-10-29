import AVFoundation
import Foundation
import UIKit
import UniformTypeIdentifiers

/// A file ready for `POST /media`: on disk, with its type and (for the platforms' checks) size and duration.
struct UploadFile: Sendable {
    var url: URL
    var filename: String
    var mime: String
    var size: Int64
    var width: Int?
    var height: Int?
    var duration: Double?
}

/// Upload progress of one task (bytes sent), reported by URLSession.
private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let onSent: @Sendable (Int64) -> Void
    init(_ onSent: @escaping @Sendable (Int64) -> Void) { self.onSent = onSent }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        onSent(totalBytesSent)
    }
}

/// Thread-safe byte counter for parallel part uploads.
private final class SentBytes: @unchecked Sendable {
    private let lock = NSLock()
    private var parts: [Int: Int64] = [:]
    func set(_ part: Int, _ bytes: Int64) -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        parts[part] = bytes
        return parts.values.reduce(0, +)
    }
}

extension APIClient {
    /// Single-request uploads up to 90 MB; larger files use the multipart flow (docs/ios-api.md "Media").
    static let singleUploadLimit: Int64 = 90 * 1024 * 1024

    private static let uploadSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 6 * 3600
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        return URLSession(configuration: config)
    }()

    /// Uploads `file` and returns the stored media. `progress` gets 0...1.
    func upload(_ file: UploadFile, progress: @escaping @Sendable (Double) -> Void) async throws -> Media {
        // Keep going for a while when the app is sent to the background mid-upload.
        let task = await UIApplication.shared.beginBackgroundTask(withName: "Postflare upload", expirationHandler: nil)
        defer { Task { @MainActor in UIApplication.shared.endBackgroundTask(task) } }
        if file.size <= Self.singleUploadLimit {
            return try await uploadSingle(file, progress: progress)
        }
        return try await uploadMultipart(file, progress: progress)
    }

    private func metaHeaders(_ r: inout URLRequest, _ file: UploadFile) {
        if let w = file.width { r.setValue(String(w), forHTTPHeaderField: "X-Width") }
        if let h = file.height { r.setValue(String(h), forHTTPHeaderField: "X-Height") }
        if let d = file.duration { r.setValue(String(format: "%.3f", d), forHTTPHeaderField: "X-Duration") }
    }

    private func uploadSingle(_ file: UploadFile, progress: @escaping @Sendable (Double) -> Void) async throws -> Media {
        var r = request("POST", "/media")
        r.setValue(file.mime, forHTTPHeaderField: "Content-Type")
        r.setValue(file.filename.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? "upload", forHTTPHeaderField: "X-Filename")
        metaHeaders(&r, file)
        let total = Double(max(file.size, 1))
        let delegate = UploadProgress { progress(min(0.99, Double($0) / total)) }
        let req = r
        let (data, response) = try await perform { try await Self.uploadSession.upload(for: req, fromFile: file.url, delegate: delegate) }
        let media: Media = try decode(data, response, path: "/media")
        progress(1)
        return media
    }

    private struct MultipartInit: Encodable {
        var filename: String
        var mime: String
        var size: Int64
        var width: Int?
        var height: Int?
        var duration: Double?
    }

    private struct MultipartComplete: Encodable { var parts: [MultipartPart] }

    /// `POST /media/multipart`, then the parts (3 at a time, each retried up to 3 times), then `complete`.
    private func uploadMultipart(_ file: UploadFile, progress: @escaping @Sendable (Double) -> Void) async throws -> Media {
        let start: MultipartStart = try await send("POST", "/media/multipart", body: MultipartInit(
            filename: file.filename, mime: file.mime, size: file.size, width: file.width, height: file.height, duration: file.duration))
        let total = Double(max(file.size, 1))
        let sent = SentBytes()
        do {
            var done: [MultipartPart] = []
            try await withThrowingTaskGroup(of: MultipartPart.self) { group in
                var next = 1
                func add() {
                    let part = next
                    next += 1
                    group.addTask {
                        try await uploadPart(file, start: start, part: part) { bytes in
                            progress(min(0.99, Double(sent.set(part, bytes)) / total))
                        }
                    }
                }
                for _ in 0..<min(3, start.parts) { add() }
                while let part = try await group.next() {
                    done.append(part)
                    if next <= start.parts { add() }
                }
            }
            let media: Media = try await send("POST", "/media/multipart/\(start.id)/complete", body: MultipartComplete(parts: done.sorted { $0.partNumber < $1.partNumber }))
            progress(1)
            return media
        } catch {
            // Abandoned uploads are removed by the server's daily media sweep too; this frees the space at once.
            try? await deleteMedia(start.id)
            throw error
        }
    }

    private func uploadPart(_ file: UploadFile, start: MultipartStart, part: Int, onSent: @escaping @Sendable (Int64) -> Void) async throws -> MultipartPart {
        let slice = try Self.writeSlice(of: file.url, offset: Int64(part - 1) * Int64(start.partSize), length: start.partSize)
        defer { try? FileManager.default.removeItem(at: slice) }
        var lastError: Error = APIError.invalidResponse
        for attempt in 0..<3 {
            try Task.checkCancellation()
            if attempt > 0 { try await Task.sleep(for: .seconds(Double(attempt) * 2)) }
            do {
                var r = request("PUT", "/media/multipart/\(start.id)/\(part)")
                r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                let req = r
                let delegate = UploadProgress(onSent)
                let (data, response) = try await perform { try await Self.uploadSession.upload(for: req, fromFile: slice, delegate: delegate) }
                return try decode(data, response, path: "/media/multipart")
            } catch let e as APIError {
                // 4xx (other than a timeout) will not get better by retrying.
                if let status = e.status, (400..<500).contains(status), status != 408 { throw e }
                lastError = e
            }
        }
        throw lastError
    }

    /// Copies `length` bytes at `offset` into a temporary file (in 4 MB chunks, never the whole part in memory).
    private static func writeSlice(of url: URL, offset: Int64, length: Int) throws -> URL {
        let out = FileManager.default.temporaryDirectory.appending(path: "part-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: out.path(), contents: nil)
        let reader = try FileHandle(forReadingFrom: url)
        let writer = try FileHandle(forWritingTo: out)
        defer {
            try? reader.close()
            try? writer.close()
        }
        try reader.seek(toOffset: UInt64(offset))
        var remaining = length
        while remaining > 0 {
            let chunk = try reader.read(upToCount: min(remaining, 4 * 1024 * 1024)) ?? Data()
            if chunk.isEmpty { break }
            try writer.write(contentsOf: chunk)
            remaining -= chunk.count
        }
        return out
    }
}

// MARK: - Preparing picked files

enum UploadPreparation {
    /// An image from the photo library: HEIC/HEIF and other camera formats become JPEG (what every platform takes);
    /// JPEG, PNG, GIF and WebP stay as they are.
    static func image(_ data: Data, type: UTType?) throws -> (UploadFile, UIImage?) {
        let keep: [UTType] = [.jpeg, .png, .gif, .webP]
        let preview = UIImage(data: data)
        var bytes = data
        var mime = type?.preferredMIMEType ?? "image/jpeg"
        var ext = type?.preferredFilenameExtension ?? "jpg"
        if !keep.contains(where: { type?.conforms(to: $0) == true }) {
            guard let image = preview, let jpeg = image.jpegData(compressionQuality: 0.9) else { throw APIError.network(String(localized: "This image could not be read.")) }
            bytes = jpeg
            mime = "image/jpeg"
            ext = "jpg"
        }
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).\(ext)")
        try bytes.write(to: url)
        let px = preview.map { (Int($0.size.width * $0.scale), Int($0.size.height * $0.scale)) }
        let file = UploadFile(url: url, filename: "photo-\(Self.stamp()).\(ext)", mime: mime, size: Int64(bytes.count), width: px?.0, height: px?.1)
        return (file, preview?.preparingThumbnail(of: CGSize(width: 240, height: 240)))
    }

    /// A video file (copied out of the photo library): type, size, duration and pixel size for the platforms' checks.
    static func video(_ url: URL) async throws -> (UploadFile, UIImage?) {
        let type = UTType(filenameExtension: url.pathExtension)
        let mime = type?.preferredMIMEType ?? "video/quicktime"
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path())[.size] as? NSNumber)?.int64Value ?? 0
        let asset = AVURLAsset(url: url)
        let duration = try? await asset.load(.duration).seconds
        var width: Int?
        var height: Int?
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) {
            let rect = CGRect(origin: .zero, size: natural).applying(transform)
            width = Int(abs(rect.width))
            height = Int(abs(rect.height))
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 240, height: 240)
        let thumb = (try? await generator.image(at: .zero)).map { UIImage(cgImage: $0.image) }
        let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension.lowercased()
        let file = UploadFile(url: url, filename: "video-\(Self.stamp()).\(ext)", mime: mime, size: size, width: width, height: height,
                              duration: duration.flatMap { $0.isFinite ? $0 : nil })
        return (file, thumb)
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: .now)
    }
}
