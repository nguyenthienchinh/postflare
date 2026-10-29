import AVKit
import SwiftUI
import UIKit

/// What the fullscreen viewer shows: the media of a post and where to start.
struct MediaViewerItem: Identifiable, Hashable {
    var ids: [String]
    var index: Int
    var id: String { "\(ids.joined(separator: ","))#\(index)" }
}

/// Fullscreen media viewer: pages through the media of a post. Images zoom (pinch, double tap), videos play streaming
/// from the public media URL (CDN or signed `/m/` link, no auth header). Swipe down or the close button dismisses.
struct MediaViewer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var item: MediaViewerItem

    @State private var selection: Int
    @State private var zoomed = false
    @State private var chrome = true
    @State private var drag: CGFloat = 0
    @State private var images: [String: UIImage] = [:]

    init(item: MediaViewerItem) {
        self.item = item
        _selection = State(initialValue: min(max(item.index, 0), max(item.ids.count - 1, 0)))
    }

    private var dragProgress: CGFloat { min(abs(drag) / 300, 1) }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black.opacity(1 - dragProgress * 0.8).ignoresSafeArea()
                pager(insets: geo.safeAreaInsets)
            }
        }
        .overlay(alignment: .top) { if chrome { topBar.transition(.opacity) } }
        .statusBarHidden(!chrome)
        .preferredColorScheme(.dark)
        .onChange(of: selection) { zoomed = false }
        .onAppear { model.loadMedia(item.ids) }
    }

    private func pager(insets: EdgeInsets) -> some View {
            TabView(selection: $selection) {
                ForEach(Array(item.ids.enumerated()), id: \.offset) { i, id in
                    page(id, active: i == selection, insets: insets)
                        .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: item.ids.count > 1 && chrome ? .always : .never))
            .ignoresSafeArea()
            .offset(y: drag)
            .scaleEffect(1 - dragProgress * 0.15)
            .simultaneousGesture(dismissDrag)
    }

    @ViewBuilder
    private func page(_ id: String, active: Bool, insets: EdgeInsets) -> some View {
        if let media = model.media[id], let url = URL(string: media.url) {
            if media.isVideo {
                // Below the close button and above the home indicator, so the player's own controls stay free.
                VideoPage(url: url, active: active)
                    .padding(.top, insets.top + 56)
                    .padding(.bottom, insets.bottom)
            } else {
                ZoomableImage(url: url, zoomed: $zoomed, loaded: { images[id] = $0 }) {
                    withAnimation(.easeInOut(duration: 0.2)) { chrome.toggle() }
                }
                .accessibilityLabel(Text(media.alt ?? String(localized: "Image")))
            }
        } else {
            ProgressView().tint(.white)
        }
    }

    private var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.body.weight(.semibold)).frame(width: 44, height: 44)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel(Text("Close"))
            Spacer()
            if item.ids.count > 1 {
                Text("\(selection + 1) of \(item.ids.count)")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .glassEffect()
            }
            Spacer()
            shareButton.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .foregroundStyle(.white)
    }

    @ViewBuilder
    private var shareButton: some View {
        let id = item.ids.indices.contains(selection) ? item.ids[selection] : nil
        if let id, let image = images[id] {
            let media = model.media[id]
            ShareLink(item: Image(uiImage: image), preview: SharePreview(media?.alt ?? media?.filename ?? String(localized: "Image"), image: Image(uiImage: image))) {
                Image(systemName: "square.and.arrow.up").font(.body.weight(.semibold)).frame(width: 44, height: 44)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel(Text("Share"))
        }
    }

    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 20)
            .onChanged { v in
                guard !zoomed, abs(v.translation.height) > abs(v.translation.width) * 1.4 || drag != 0 else { return }
                drag = v.translation.height
            }
            .onEnded { v in
                guard drag != 0 else { return }
                if abs(v.predictedEndTranslation.height) > 220 || abs(drag) > 140 {
                    dismiss()
                } else {
                    withAnimation(.snappy) { drag = 0 }
                }
            }
    }
}

/// A video page: plays while it is the visible page.
private struct VideoPage: View {
    var url: URL
    var active: Bool
    @State private var player: AVPlayer?

    var body: some View {
        ZStack {
            if let player {
                VideoPlayer(player: player)
            } else {
                ProgressView().tint(.white)
            }
        }
        .onAppear {
            if player == nil { player = AVPlayer(url: url) }
            if active { player?.play() }
        }
        .onChange(of: active) { _, isActive in
            if isActive { player?.play() } else { player?.pause() }
        }
        .onDisappear { player?.pause() }
    }
}

// MARK: - Zoomable image

/// Image in a UIScrollView: pinch to zoom, double tap zooms in on that point (and out again), single tap toggles the
/// viewer's chrome.
private struct ZoomableImage: UIViewRepresentable {
    var url: URL
    @Binding var zoomed: Bool
    var loaded: (UIImage) -> Void
    var onTap: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ZoomScrollView {
        let view = ZoomScrollView()
        view.delegate = context.coordinator
        view.onZoom = { z in
            if context.coordinator.parent.zoomed != z { context.coordinator.parent.zoomed = z }
        }
        let double = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        double.numberOfTapsRequired = 2
        view.addGestureRecognizer(double)
        let single = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.singleTap))
        single.require(toFail: double)
        view.addGestureRecognizer(single)
        context.coordinator.load(into: view)
        return view
    }

    func updateUIView(_ view: ZoomScrollView, context: Context) {
        context.coordinator.parent = self
    }

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        var parent: ZoomableImage
        init(_ parent: ZoomableImage) { self.parent = parent }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { (scrollView as? ZoomScrollView)?.imageView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            (scrollView as? ZoomScrollView)?.centerImage()
            (scrollView as? ZoomScrollView)?.onZoom?(scrollView.zoomScale > scrollView.minimumZoomScale + 0.01)
        }

        @objc func singleTap() { parent.onTap() }

        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let view = g.view as? ZoomScrollView else { return }
            if view.zoomScale > view.minimumZoomScale + 0.01 {
                view.setZoomScale(view.minimumZoomScale, animated: true)
            } else {
                let point = g.location(in: view.imageView)
                let scale = min(view.maximumZoomScale, 2.5)
                let size = CGSize(width: view.bounds.width / scale, height: view.bounds.height / scale)
                view.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }

        func load(into view: ZoomScrollView) {
            let url = parent.url
            Task { @MainActor in
                guard let image = await RemoteImage.load(url) else { view.showFailure(); return }
                view.set(image)
                parent.loaded(image)
            }
        }
    }
}

final class ZoomScrollView: UIScrollView {
    let imageView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    var onZoom: ((Bool) -> Void)?
    private var lastSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        decelerationRate = .fast
        contentInsetAdjustmentBehavior = .never
        bouncesZoom = true
        minimumZoomScale = 1
        maximumZoomScale = 1
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        addSubview(imageView)
        spinner.color = .white
        spinner.startAnimating()
        addSubview(spinner)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func set(_ image: UIImage) {
        spinner.stopAnimating()
        spinner.isHidden = true
        imageView.image = image
        lastSize = .zero
        setNeedsLayout()
    }

    func showFailure() {
        spinner.stopAnimating()
        spinner.isHidden = true
        imageView.image = UIImage(systemName: "photo")?.withTintColor(.secondaryLabel, renderingMode: .alwaysOriginal)
        imageView.contentMode = .center
        imageView.frame = bounds
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
        guard let image = imageView.image, image.size.width > 0, bounds.width > 0, imageView.contentMode == .scaleAspectFit else { return }
        if bounds.size != lastSize {
            lastSize = bounds.size
            zoomScale = 1
            let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
            imageView.frame = CGRect(origin: .zero, size: CGSize(width: image.size.width * fit, height: image.size.height * fit))
            contentSize = imageView.frame.size
            // Zoom up to the image's pixel size, at least 3x.
            maximumZoomScale = max(3, 1 / fit)
            centerImage()
        }
    }

    func centerImage() {
        let x = max((bounds.width - contentSize.width) / 2, 0)
        let y = max((bounds.height - contentSize.height) / 2, 0)
        contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
    }
}

/// Full-size image loading with a small in-memory cache (the viewer, sharing); the disk cache is `URLCache.shared`.
enum RemoteImage {
    private static let cache: NSCache<NSURL, UIImage> = {
        let c = NSCache<NSURL, UIImage>()
        c.totalCostLimit = 120 * 1024 * 1024
        return c
    }()

    static func load(_ url: URL) async -> UIImage? {
        if let hit = cache.object(forKey: url as NSURL) { return hit }
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
              let image = UIImage(data: data) else { return nil }
        let prepared = await image.byPreparingForDisplay() ?? image
        cache.setObject(prepared, forKey: url as NSURL, cost: data.count)
        return prepared
    }
}
