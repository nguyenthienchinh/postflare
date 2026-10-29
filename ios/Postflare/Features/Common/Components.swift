import SwiftUI

/// The Postflare mark: a calendar page crossed by the flare, cream on Cloudflare orange (same as the app icon).
struct BrandMark: View {
    var size: CGFloat = 56

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
            .fill(Color(red: 1, green: 0.314, blue: 0.039))
            .frame(width: size, height: size)
            .overlay { Image("BrandGlyph").resizable().scaledToFit() }
            .clipShape(RoundedRectangle(cornerRadius: size * 0.25, style: .continuous))
            .shadow(color: .black.opacity(0.15), radius: size * 0.08, y: size * 0.04)
            .accessibilityHidden(true)
    }
}

/// Grouped card background used across the app.
struct CardModifier: ViewModifier {
    var padding: CGFloat = 16
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

extension View {
    func card(padding: CGFloat = 16) -> some View { modifier(CardModifier(padding: padding)) }
}

struct SectionHeader: View {
    var title: LocalizedStringKey
    var systemImage: String?

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage { Image(systemName: systemImage).foregroundStyle(.secondary) }
            Text(title)
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    }
}

struct ChangePill: View {
    var change: Double?

    var body: some View {
        if let change {
            HStack(spacing: 2) {
                Image(systemName: change >= 0 ? "arrow.up.right" : "arrow.down.right")
                    .font(.caption2.weight(.bold))
                Text(Fmt.change(change))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
            }
            .foregroundStyle(changeColor(change))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(changeColor(change).opacity(0.12), in: Capsule())
            .accessibilityLabel(Text("Change \(Fmt.change(change))"))
        }
    }
}

struct ErrorBanner: View {
    var message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry).font(.footnote.weight(.semibold))
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// "Updated 2 min ago" / offline hint.
struct UpdatedLabel: View {
    var date: Date?
    var offline: Bool

    var body: some View {
        if let date {
            HStack(spacing: 4) {
                if offline { Image(systemName: "icloud.slash") }
                Text("Updated \(date, style: .relative) ago")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Posts

struct StatusBadge: View {
    var status: PostStatus

    var body: some View {
        HStack(spacing: 4) {
            if status == .publishing {
                ProgressView().controlSize(.mini)
            } else {
                Circle().fill(status.color).frame(width: 6, height: 6)
            }
            Text(status.title)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(status == .needsCheck ? Color.orange : status.color)
        .background(status.color.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(status.title))
    }
}

/// A platform as a letter glyph on its brand colour (no logos).
struct PlatformGlyph: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var scheme
    var provider: String
    var size: CGFloat = 28

    var body: some View {
        let color = Platform.color(provider, hex: model.provider(provider)?.color)
        Circle()
            .fill(color.gradient)
            .overlay {
                Text(Platform.glyph(provider))
                    .font(.system(size: size * (Platform.glyph(provider).count > 2 ? 0.34 : 0.42), weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .minimumScaleFactor(0.5)
            }
            .overlay { Circle().strokeBorder(.white.opacity(scheme == .dark ? 0.25 : 0), lineWidth: 0.75) }
            .frame(width: size, height: size)
            .accessibilityLabel(Text(model.providerName(provider)))
    }
}

/// Account avatar (remote image) with the platform glyph as a badge; letter fallback.
struct AccountAvatar: View {
    @Environment(AppModel.self) private var model
    var account: Account?
    var provider: String
    var size: CGFloat = 36
    /// The platform glyph in the corner.
    var badge = true

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let url = account?.avatarUrl.flatMap(URL.init(string:)) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() } else { fallback }
                    }
                } else {
                    fallback
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            if badge {
                PlatformGlyph(provider: provider, size: size * 0.48)
                    .overlay { Circle().strokeBorder(Color(.systemBackground), lineWidth: 1.5) }
                    .offset(x: size * 0.08, y: size * 0.08)
            }
        }
        .accessibilityHidden(true)
    }

    private var fallback: some View {
        ZStack {
            Circle().fill(Color(.tertiarySystemFill))
            Text(String((account?.name ?? "?").prefix(1)).uppercased())
                .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
        }
    }
}

/// One post in a list: account, time, status, text, media count.
struct PostRow: View {
    @Environment(AppModel.self) private var model
    var post: Post
    var showDay = false

    var body: some View {
        let account = model.account(post.accountId)
        HStack(alignment: .top, spacing: 12) {
            AccountAvatar(account: account, provider: account?.provider ?? "", size: 38)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(account?.name ?? String(localized: "Unknown account"))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(timeText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Text(post.excerpt)
                    .font(.subheadline)
                    .foregroundStyle(post.content.isEmpty ? .secondary : .primary)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    StatusBadge(status: post.status)
                    if !post.media.isEmpty {
                        Label("\(post.media.count)", systemImage: "photo.on.rectangle")
                            .labelStyle(CompactLabelStyle())
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(Text("\(post.media.count) media"))
                    }
                    if !post.thread.isEmpty {
                        Label("\(post.thread.count)", systemImage: "text.bubble")
                            .labelStyle(CompactLabelStyle())
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(Text("\(post.thread.count) follow-ups"))
                    }
                }
                if let error = post.error, post.status == .failed || post.status == .needsCheck {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(post.status == .failed ? .red : .orange)
                        .lineLimit(2)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var timeText: String {
        if showDay { return Fmt.when(post.date) }
        return post.date.formatted(date: .omitted, time: .shortened)
    }
}

// MARK: - Media

/// Square thumbnail of a media id (image, or the first frame of a video with a play badge and its duration).
struct MediaThumb: View {
    @Environment(AppModel.self) private var model
    var mediaId: String
    var size: CGFloat? = nil

    var body: some View {
        Rectangle()
            .fill(Color(.tertiarySystemFill))
            .aspectRatio(1, contentMode: .fit)
            .frame(width: size, height: size)
            .overlay { MediaContent(mediaId: mediaId) }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// A media id filling its frame (scaled to fill): image, or a video's first frame with a play badge and duration.
/// Images use the server thumbnail unless `full` (hero previews), falling back to the full media.
struct MediaContent: View {
    @Environment(AppModel.self) private var model
    var mediaId: String
    var badge = true
    var contentMode: ContentMode = .fill
    var full = false

    var body: some View {
        let media = model.media[mediaId]
        ZStack {
            Color(.tertiarySystemFill)
            if let media, let url = media.fullURL {
                if media.isVideo {
                    VideoFrame(mediaId: media.id, url: url, contentMode: contentMode)
                } else {
                    let thumb = media.thumbnailURL ?? url
                    let urls = full ? [url, thumb] : [thumb, url]
                    CachedImage(urls: thumb == url ? [url] : urls,
                                maxPixel: full ? ImageLoader.fullPixels : ImageLoader.thumbPixels,
                                contentMode: contentMode,
                                placeholder: full && thumb != url ? thumb : nil)
                }
            } else {
                Image(systemName: "photo").foregroundStyle(.secondary)
            }
        }
        .overlay {
            if badge, media?.isVideo == true {
                Image(systemName: "play.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.black.opacity(0.4), in: Circle())
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if badge, let d = media?.duration, media?.isVideo == true, d > 0 {
                Text(Fmt.duration(d))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                    .padding(6)
            }
        }
        .clipped()
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(media?.alt ?? (media?.isVideo == true ? String(localized: "Video") : String(localized: "Image"))))
        .onAppear { model.loadMedia([mediaId]) }
    }
}

/// First frame of a remote video, generated once per install (`VideoPosters`).
struct VideoFrame: View {
    var mediaId: String
    var url: URL
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image = image ?? VideoPosters.cached(mediaId) {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                Color.black.opacity(0.75)
            }
        }
        .task(id: mediaId) {
            image = await VideoPosters.load(id: mediaId, url: url)
        }
    }
}

/// A count with a label, used by Home and the widgets' style.
struct CountTile: View {
    var value: Int
    var title: LocalizedStringKey
    var systemImage: String
    var color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
            Text(Fmt.count(value))
                .font(.system(.title2, design: .rounded).weight(.bold))
                .monospacedDigit()
                .contentTransition(.numericText(value: Double(value)))
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityValue(Text(Fmt.count(value)))
    }
}

/// Plan-limit (402) alert content: the server's message and the web billing page.
struct PlanLimitAlert: ViewModifier {
    @Binding var limit: PlanLimit?
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content.alert("Upgrade needed", isPresented: Binding(get: { limit != nil }, set: { if !$0 { limit = nil } }), presenting: limit) { l in
            if let url = l.upgradeUrl.flatMap(URL.init(string:)) {
                Button("Open billing") { openURL(url) }
            }
            Button("OK", role: .cancel) {}
        } message: { l in
            Text(l.error)
        }
    }
}

extension View {
    func planLimitAlert(_ limit: Binding<PlanLimit?>) -> some View { modifier(PlanLimitAlert(limit: limit)) }
}

/// Icon and value close together (counts in rows).
struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon
            configuration.title.monospacedDigit()
        }
    }
}
