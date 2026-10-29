import SwiftUI

/// What a preview needs: the post, its account and platform, labels of setting values and the media opener.
struct PreviewContext {
    var post: Post
    var account: Account?
    var provider: ProviderInfo?
    var providerId: String
    /// Label of a select value (static options, or the dynamic options the detail loaded).
    var optionLabel: (_ key: String, _ value: String) -> String?
    var open: (_ ids: [String], _ index: Int) -> Void

    var name: String { account?.name ?? String(localized: "Unknown account") }
    var handle: String { account?.handle ?? Platform.name(providerId) }
    var username: String { account?.username.map { $0.hasPrefix("@") ? String($0.dropFirst()) : $0 } ?? name }

    func string(_ key: String) -> String? {
        guard let v = post.settings[key], !v.isEmpty else { return nil }
        if case let .array(a) = v { return a.map(\.display).joined(separator: ", ") }
        return v.display
    }

    func bool(_ key: String) -> Bool { post.settings[key]?.bool == true }

    func tags(_ key: String) -> [String] {
        switch post.settings[key] {
        case let .array(a): a.compactMap { $0.string?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        case let .string(s): s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        default: []
        }
    }

    /// Short time like the platforms show it: "2h" for published posts, the schedule otherwise.
    var time: String {
        switch post.status {
        case .published:
            post.date.formatted(.relative(presentation: .numeric, unitsStyle: .narrow))
        case .draft:
            String(localized: "Draft")
        default:
            Fmt.when(post.date)
        }
    }

    var maxLength: Int { provider?.capabilities.maxLength ?? 0 }
    var threadLabel: String { provider?.capabilities.threadLabel ?? String(localized: "Follow-ups") }

    /// Offset of the first character over the limit (X: weighted length), nil when it fits.
    func overflow(_ text: String) -> Int? {
        if providerId == "x" { return XText.overflowOffset(text, limit: bool("premium") ? 25_000 : 280) }
        guard maxLength > 0 else { return nil }
        return text.count > maxLength ? maxLength : nil
    }
}

/// How the post will look on its platform, same layouts as the web previews (src/components/posts/PlatformPreview.tsx).
/// Letter glyphs and system symbols only, no platform logos.
struct PlatformPreview: View {
    var ctx: PreviewContext
    @Environment(AppModel.self) private var model

    var body: some View {
        let media = ctx.post.media.compactMap { model.media[$0] }
        let singleVideo = ctx.post.media.count == 1 && media.first?.isVideo == true
        switch ctx.providerId {
        case "youtube":
            YouTubePreview(ctx: ctx)
        case "tiktok", "tiktok_business":
            ShortVideoPreview(ctx: ctx, style: .tiktok)
        case "instagram", "instagram_standalone":
            if ctx.string("post_type") == "story" {
                StoryPreview(ctx: ctx)
            } else if singleVideo {
                ShortVideoPreview(ctx: ctx, style: .reel)
            } else {
                InstagramPreview(ctx: ctx)
            }
        case "kick" where singleVideo:
            ShortVideoPreview(ctx: ctx, style: .reel)
        case "linkedin", "linkedin_page", "facebook":
            FeedPreview(ctx: ctx)
        case "pinterest":
            PinPreview(ctx: ctx)
        case "reddit", "lemmy":
            RedditPreview(ctx: ctx)
        default:
            switch ctx.provider?.category {
            case "blog", "newsletter": ArticlePreview(ctx: ctx)
            case "video": YouTubePreview(ctx: ctx)
            default: SocialPreview(ctx: ctx)
            }
        }
    }
}

// MARK: - Shared pieces

private struct Avatar: View {
    var ctx: PreviewContext
    var size: CGFloat = 40
    var body: some View { AccountAvatar(account: ctx.account, provider: ctx.providerId, size: size, badge: false) }
}

/// Decorative action icons (like, comment, ...).
private struct ActionIcons: View {
    var symbols: [String]
    var trailing: [String] = []
    var spacing: CGFloat = 22

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(Array(symbols.enumerated()), id: \.offset) { i, symbol in
                // spacing 0: spread evenly over the width (X style).
                if spacing == 0 && i > 0 { Spacer(minLength: 8) }
                Image(systemName: symbol)
            }
            if !trailing.isEmpty {
                Spacer(minLength: 8)
                ForEach(trailing, id: \.self) { Image(systemName: $0) }
            }
        }
        .font(.body)
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
}

/// Character count against the platform limit (X: weighted).
private struct LimitCounter: View {
    var ctx: PreviewContext
    var text: String

    var body: some View {
        let limit = ctx.providerId == "x" ? (ctx.bool("premium") ? 25_000 : 280) : ctx.maxLength
        let used = ctx.providerId == "x" ? XText.weightedLength(text) : text.count
        if limit > 0 {
            let over = used > limit
            Text("\(used)/\(limit)")
                .font(.caption2.weight(over ? .bold : .regular))
                .monospacedDigit()
                .foregroundStyle(over ? Color.red : Color.secondary)
                .accessibilityLabel(Text(over ? "\(used) of \(limit) characters, too long" : "\(used) of \(limit) characters"))
        }
    }
}

private struct NoText: View {
    var body: some View {
        Text("No text").font(.subheadline).italic().foregroundStyle(.secondary)
    }
}

/// One media cell: fills its frame, opens the viewer on tap. Hero cells (`full`, by default the only media) load the
/// full image, grid cells the thumbnail.
private struct MediaCell: View {
    var ids: [String]
    var index: Int
    var open: ([String], Int) -> Void
    var badge = true
    var full: Bool?

    var body: some View {
        Color.clear
            .overlay { MediaContent(mediaId: ids[index], badge: badge, full: full ?? (ids.count == 1)) }
            .clipped()
            .contentShape(Rectangle())
            .onTapGesture { open(ids, index) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(Text("Opens the media full screen"))
    }
}

/// Aspect ratio (width / height) of a media id, clamped to what feeds show.
@MainActor
private func aspect(_ model: AppModel, _ id: String?, range: ClosedRange<CGFloat> = 0.8...1.91, fallback: CGFloat = 1) -> CGFloat {
    guard let id, let m = model.media[id], let w = m.width, let h = m.height, w > 0, h > 0 else { return fallback }
    return min(max(CGFloat(w / h), range.lowerBound), range.upperBound)
}

/// 1-4 media in the X / Facebook style grid (+N on the fourth).
struct PreviewMediaGrid: View {
    @Environment(AppModel.self) private var model
    var ids: [String]
    var open: ([String], Int) -> Void
    var corner: CGFloat = 14

    var body: some View {
        let shown = Array(ids.prefix(4))
        Group {
            switch shown.count {
            case 0:
                EmptyView()
            case 1:
                Color.clear.aspectRatio(aspect(model, ids[0]), contentMode: .fit)
                    .overlay { MediaCell(ids: ids, index: 0, open: open) }
            case 2:
                HStack(spacing: 2) {
                    MediaCell(ids: ids, index: 0, open: open)
                    MediaCell(ids: ids, index: 1, open: open)
                }
                .aspectRatio(16 / 9, contentMode: .fit)
            case 3:
                HStack(spacing: 2) {
                    MediaCell(ids: ids, index: 0, open: open)
                    VStack(spacing: 2) {
                        MediaCell(ids: ids, index: 1, open: open)
                        MediaCell(ids: ids, index: 2, open: open)
                    }
                }
                .aspectRatio(16 / 9, contentMode: .fit)
            default:
                Grid(horizontalSpacing: 2, verticalSpacing: 2) {
                    GridRow {
                        MediaCell(ids: ids, index: 0, open: open)
                        MediaCell(ids: ids, index: 1, open: open)
                    }
                    GridRow {
                        MediaCell(ids: ids, index: 2, open: open)
                        MediaCell(ids: ids, index: 3, open: open)
                            .overlay {
                                if ids.count > 4 {
                                    Text("+\(ids.count - 4)")
                                        .font(.title3.weight(.semibold))
                                        .foregroundStyle(.white)
                                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                                        .background(.black.opacity(0.5))
                                        .allowsHitTesting(false)
                                }
                            }
                    }
                }
                .aspectRatio(16 / 9, contentMode: .fit)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .overlay {
            if !shown.isEmpty {
                RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(Color(.separator).opacity(0.6), lineWidth: 0.5)
            }
        }
    }
}

/// Swipeable media (Instagram carousel, TikTok photo posts) with a page counter and dots.
private struct PreviewCarousel: View {
    var ids: [String]
    var aspect: CGFloat
    var open: ([String], Int) -> Void
    var dots = true
    @State private var page = 0

    var body: some View {
        VStack(spacing: 8) {
            TabView(selection: $page) {
                ForEach(ids.indices, id: \.self) { i in
                    MediaCell(ids: ids, index: i, open: open, full: true).tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .aspectRatio(aspect, contentMode: .fit)
            .overlay(alignment: .topTrailing) {
                if ids.count > 1 {
                    Text("\(page + 1)/\(ids.count)")
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(.black.opacity(0.6), in: Capsule())
                        .padding(10)
                        .accessibilityHidden(true)
                }
            }
            if dots && ids.count > 1 {
                HStack(spacing: 4) {
                    ForEach(ids.indices, id: \.self) { i in
                        Circle()
                            .fill(i == page ? Color.accentColor : Color.secondary.opacity(0.4))
                            .frame(width: 6, height: 6)
                    }
                }
                .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityValue(Text("\(page + 1) of \(ids.count)"))
    }
}

/// Follow-up items as comments / replies under the post.
private struct CommentList: View {
    var ctx: PreviewContext
    var items: [ThreadItem]
    var avatar: CGFloat = 28

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(ctx.threadLabel)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 10) {
                    Avatar(ctx: ctx, size: avatar)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(ctx.username).font(.caption.weight(.semibold))
                        if item.content.isEmpty {
                            Text("Media only").font(.footnote).italic().foregroundStyle(.secondary)
                        } else {
                            ExpandableText(text: item.content, font: .footnote, overflowAt: ctx.overflow(item.content))
                        }
                        if !item.media.isEmpty { PreviewMediaGrid(ids: item.media, open: ctx.open, corner: 10) }
                    }
                }
            }
        }
    }
}

// MARK: - YouTube (and other video platforms)

private struct YouTubePreview: View {
    var ctx: PreviewContext
    @Environment(AppModel.self) private var model

    var body: some View {
        let first = ctx.post.media.first
        let vertical = (first.flatMap { model.media[$0] }).map { ($0.height ?? 0) > ($0.width ?? 0) } ?? false
        let short = ctx.bool("shorts") || vertical
        VStack(alignment: .leading, spacing: 0) {
            player(first, short: short)
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    let title = ctx.string("title") ?? ""
                    if title.isEmpty {
                        Text("No title").font(.headline).italic().foregroundStyle(.secondary)
                    } else {
                        Text(title + (ctx.bool("shorts") && !title.localizedCaseInsensitiveContains("#shorts") ? " #Shorts" : ""))
                            .font(.headline)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    meta
                }
                channel
                description
                if !ctx.post.thread.isEmpty {
                    Divider()
                    CommentList(ctx: ctx, items: ctx.post.thread)
                }
            }
            .padding(14)
        }
    }

    @ViewBuilder
    private func player(_ first: String?, short: Bool) -> some View {
        ZStack {
            Color.black
            if first != nil {
                if short {
                    Color.clear.aspectRatio(9 / 16, contentMode: .fit)
                        .overlay { MediaCell(ids: ctx.post.media, index: 0, open: ctx.open, full: true) }
                } else {
                    MediaCell(ids: ctx.post.media, index: 0, open: ctx.open, full: true)
                }
            } else {
                Label("No video", systemImage: "video.slash").foregroundStyle(.white.opacity(0.7))
            }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .frame(maxWidth: .infinity)
    }

    private var meta: some View {
        HStack(spacing: 8) {
            if let privacy = ctx.string("privacy") {
                HStack(spacing: 4) {
                    Image(systemName: privacy == "public" ? "globe" : privacy == "unlisted" ? "link" : "lock.fill")
                        .foregroundStyle(.secondary)
                    Text(ctx.optionLabel("privacy", privacy) ?? privacy.capitalized)
                }
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color(.tertiarySystemFill), in: Capsule())
            }
            if ctx.bool("shorts") {
                Text("Short").font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color(.tertiarySystemFill), in: Capsule())
            }
            Text(ctx.time).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private var channel: some View {
        HStack(spacing: 10) {
            Avatar(ctx: ctx, size: 36)
            VStack(alignment: .leading, spacing: 1) {
                Text(ctx.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(ctx.handle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            Text("Subscribe")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color(.systemBackground))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(Color.primary, in: Capsule())
                .accessibilityHidden(true)
        }
    }

    private var description: some View {
        VStack(alignment: .leading, spacing: 6) {
            let tags = ctx.tags("tags")
            if !tags.isEmpty {
                Text(tags.prefix(6).map { "#" + $0.replacingOccurrences(of: " ", with: "") }.joined(separator: " "))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(uiColor: .link))
                    .lineLimit(1)
            }
            if ctx.post.content.isEmpty {
                NoText()
            } else {
                ExpandableText(text: ctx.post.content, lineLimit: 3, font: .footnote, overflowAt: ctx.overflow(ctx.post.content))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - TikTok, Reels

private struct ShortVideoPreview: View {
    enum Style { case tiktok, reel }
    var ctx: PreviewContext
    var style: Style
    @Environment(AppModel.self) private var model

    var body: some View {
        let ids = ctx.post.media
        let video = ids.first.flatMap { model.media[$0] }?.isVideo == true
        // TikTok's title setting is for photo posts only.
        let title = style == .tiktok && !video ? ctx.string("title") : nil
        ZStack(alignment: .bottom) {
            Color.black
            if ids.count > 1 {
                PreviewCarousel(ids: ids, aspect: 9 / 16, open: ctx.open, dots: false)
            } else if !ids.isEmpty {
                MediaCell(ids: ids, index: 0, open: ctx.open, badge: false)
                    .overlay {
                        if video {
                            Image(systemName: "play.fill")
                                .font(.largeTitle)
                                .foregroundStyle(.white.opacity(0.85))
                                .shadow(radius: 4)
                                .allowsHitTesting(false)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        if let d = model.media[ids[0]]?.duration, video, d > 0 {
                            Text(Fmt.duration(d))
                                .font(.caption2.weight(.semibold))
                                .monospacedDigit()
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.black.opacity(0.55), in: Capsule())
                                .padding(10)
                                .allowsHitTesting(false)
                        }
                    }
            } else {
                Label("No video", systemImage: "video.slash").foregroundStyle(.white.opacity(0.7))
                    .frame(maxHeight: .infinity)
            }
            LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black.opacity(0.55), location: 0.4), .init(color: .black.opacity(0.85), location: 1)], startPoint: .top, endPoint: .bottom)
                .frame(maxHeight: .infinity)
                .frame(height: 340)
                .allowsHitTesting(false)
            HStack(alignment: .bottom, spacing: 12) {
                ViewThatFits(in: .vertical) {
                    caption(title)
                    ScrollView(showsIndicators: false) { caption(title) }.defaultScrollAnchor(.bottom)
                }
                .frame(maxHeight: 300, alignment: .bottom)
                rail
            }
            .padding(12)
        }
        .aspectRatio(9 / 16, contentMode: .fit)
        .frame(maxWidth: 300)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .environment(\.colorScheme, .dark)
        .foregroundStyle(.white)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
    }

    private func caption(_ title: String?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if style == .reel {
                HStack(spacing: 8) {
                    Avatar(ctx: ctx, size: 26)
                    Text(ctx.username).font(.footnote.weight(.semibold))
                }
            } else {
                Text("@\(ctx.username)").font(.footnote.weight(.semibold))
            }
            if let title { Text(title).font(.footnote.weight(.bold)) }
            if ctx.post.content.isEmpty {
                Text("No text").font(.footnote).italic().foregroundStyle(.white.opacity(0.7))
            } else {
                ExpandableText(text: ctx.post.content, lineLimit: 2, font: .footnote, linkColor: .white, selectable: false, overflowAt: ctx.overflow(ctx.post.content))
                    .fontWeight(.medium)
            }
            HStack(spacing: 5) {
                Image(systemName: "music.note")
                Text(style == .tiktok ? String(localized: "Original sound · \(ctx.name)") : ctx.name)
            }
            .font(.caption2)
            .lineLimit(1)
            .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .shadow(color: .black.opacity(0.4), radius: 2)
    }

    private var rail: some View {
        VStack(spacing: 18) {
            if style == .tiktok {
                Avatar(ctx: ctx, size: 38)
                    .overlay { Circle().strokeBorder(.white, lineWidth: 1.5) }
            }
            ForEach(style == .tiktok ? ["heart.fill", "ellipsis.bubble.fill", "bookmark.fill", "arrowshape.turn.up.right.fill"] : ["heart", "bubble.right", "paperplane", "ellipsis"], id: \.self) {
                Image(systemName: $0).font(.title3)
            }
        }
        .shadow(color: .black.opacity(0.4), radius: 2)
        .accessibilityHidden(true)
    }
}

// MARK: - Instagram

private struct InstagramPreview: View {
    var ctx: PreviewContext
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Avatar(ctx: ctx, size: 34)
                    .padding(2)
                    .overlay { Circle().strokeBorder(AngularGradient(colors: [.yellow, .orange, .pink, .purple, .yellow], center: .center), lineWidth: 2) }
                VStack(alignment: .leading, spacing: 0) {
                    Text(ctx.username).font(.subheadline.weight(.semibold)).lineLimit(1)
                    let collaborators = ctx.tags("collaborators")
                    if !collaborators.isEmpty {
                        Text("with \(collaborators.map { $0.hasPrefix("@") ? $0 : "@" + $0 }.formatted(.list(type: .and)))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: "ellipsis").foregroundStyle(.secondary).accessibilityHidden(true)
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)
            if ctx.post.media.isEmpty {
                Label("Instagram needs a photo or video.", systemImage: "photo")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 160)
                    .background(Color(.tertiarySystemFill))
            } else {
                PreviewCarousel(ids: ctx.post.media, aspect: aspect(model, ctx.post.media.first), open: ctx.open)
            }
            VStack(alignment: .leading, spacing: 8) {
                ActionIcons(symbols: ["heart", "bubble.right", "paperplane"], trailing: ["bookmark"], spacing: 16)
                    .font(.title3)
                if ctx.post.content.isEmpty {
                    NoText()
                } else {
                    ExpandableText(text: ctx.post.content, lineLimit: 3, font: .subheadline, lead: ctx.username, overflowAt: ctx.overflow(ctx.post.content))
                }
                if !ctx.post.thread.isEmpty {
                    CommentList(ctx: ctx, items: ctx.post.thread, avatar: 24).padding(.top, 4)
                }
                Text(ctx.time).font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
    }
}

private struct StoryPreview: View {
    var ctx: PreviewContext
    @State private var page = 0

    var body: some View {
        let ids = ctx.post.media
        ZStack(alignment: .top) {
            Color.black
            if ids.isEmpty {
                Label("No media", systemImage: "photo").foregroundStyle(.white.opacity(0.7)).frame(maxHeight: .infinity)
            } else {
                TabView(selection: $page) {
                    ForEach(ids.indices, id: \.self) { i in MediaCell(ids: ids, index: i, open: ctx.open, full: true).tag(i) }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
            }
            VStack(spacing: 10) {
                HStack(spacing: 3) {
                    ForEach(ids.indices, id: \.self) { i in
                        Capsule().fill(.white.opacity(i <= page ? 0.95 : 0.35)).frame(height: 2.5)
                    }
                }
                HStack(spacing: 8) {
                    Avatar(ctx: ctx, size: 28)
                    Text(ctx.username).font(.footnote.weight(.semibold))
                    Text(ctx.time).font(.footnote).opacity(0.7)
                    Spacer()
                }
            }
            .padding(10)
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.4), radius: 2)
            .allowsHitTesting(false)
        }
        .aspectRatio(9 / 16, contentMode: .fit)
        .frame(maxWidth: 300)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .bottom) {
            Text("Stories don't show the caption.").font(.caption2).foregroundStyle(.secondary).padding(.bottom, 2)
        }
    }
}

// MARK: - X, Threads, Bluesky, Mastodon ...

private struct SocialPreview: View {
    var ctx: PreviewContext

    var body: some View {
        let items = [ThreadItem(content: ctx.post.content, media: ctx.post.media)] + ctx.post.thread
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                entry(item, first: i == 0, last: i == items.count - 1)
            }
        }
        .padding(14)
    }

    private func entry(_ item: ThreadItem, first: Bool, last: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 4) {
                Avatar(ctx: ctx, size: 40)
                if !last {
                    Capsule().fill(Color(.separator)).frame(width: 2).frame(maxHeight: .infinity)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    Text(ctx.name).font(.subheadline.weight(.bold)).lineLimit(1).layoutPriority(1)
                    Text(ctx.handle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    Text("· \(ctx.time)").font(.subheadline).foregroundStyle(.secondary).lineLimit(1).fixedSize()
                    Spacer(minLength: 0)
                }
                if item.content.isEmpty {
                    if item.media.isEmpty || first && ctx.provider?.capabilities.text == "required" { NoText() }
                } else {
                    ExpandableText(text: item.content, font: .subheadline, overflowAt: ctx.overflow(item.content))
                }
                if !item.media.isEmpty { PreviewMediaGrid(ids: item.media, open: ctx.open) }
                HStack {
                    ActionIcons(symbols: ["bubble.left", "arrow.2.squarepath", "heart", "chart.bar"], trailing: ["square.and.arrow.up"], spacing: 0)
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                    if !item.content.isEmpty {
                        LimitCounter(ctx: ctx, text: item.content).padding(.leading, 10)
                    }
                }
                .padding(.top, 2)
            }
            .padding(.bottom, last ? 0 : 16)
        }
    }
}

// MARK: - LinkedIn, Facebook

private struct FeedPreview: View {
    var ctx: PreviewContext

    var body: some View {
        let facebook = ctx.providerId == "facebook"
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Avatar(ctx: ctx, size: 44)
                VStack(alignment: .leading, spacing: 1) {
                    Text(ctx.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    HStack(spacing: 4) {
                        Text(ctx.time)
                        Text("·")
                        Image(systemName: visibilityIcon)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "ellipsis").foregroundStyle(.secondary).accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            Group {
                if let title = ctx.string(facebook ? "title" : "mediaTitle"), !ctx.post.media.isEmpty {
                    Text(title).font(.subheadline.weight(.semibold))
                }
                if ctx.post.content.isEmpty {
                    NoText()
                } else {
                    ExpandableText(text: ctx.post.content, lineLimit: 3, font: .subheadline, overflowAt: ctx.overflow(ctx.post.content))
                }
            }
            .padding(.horizontal, 14)
            if !ctx.post.media.isEmpty {
                PreviewMediaGrid(ids: ctx.post.media, open: ctx.open, corner: 0)
            } else if facebook, let link = ctx.string("url") {
                LinkCard(url: link).padding(.horizontal, 14)
            }
            Divider().padding(.horizontal, 14)
            HStack {
                reaction("Like", "hand.thumbsup")
                reaction("Comment", "bubble.left")
                if facebook { reaction("Share", "arrowshape.turn.up.right") } else { reaction("Repost", "arrow.2.squarepath") }
            }
            .padding(.horizontal, 14)
            if !ctx.post.thread.isEmpty {
                CommentList(ctx: ctx, items: ctx.post.thread).padding(.horizontal, 14)
            }
            Spacer(minLength: 4)
        }
        .padding(.bottom, 10)
    }

    private var visibilityIcon: String {
        ctx.string("visibility") == "CONNECTIONS" ? "person.2.fill" : "globe"
    }

    private func reaction(_ title: LocalizedStringKey, _ symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
    }
}

private struct LinkCard: View {
    var url: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "link")
                .frame(width: 40, height: 40)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(URL(string: url)?.host() ?? url).font(.footnote.weight(.semibold)).lineLimit(1)
                Text(url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .background(Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Pinterest

private struct PinPreview: View {
    var ctx: PreviewContext
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if ctx.post.media.isEmpty {
                Label("Pinterest needs an image or a video.", systemImage: "photo")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            } else {
                PreviewCarousel(ids: ctx.post.media, aspect: aspect(model, ctx.post.media.first, range: 0.66...1.2), open: ctx.open)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            HStack(spacing: 18) {
                ActionIcons(symbols: ["heart", "bubble.left", "square.and.arrow.up", "ellipsis"], spacing: 18)
                Spacer()
                Text("Save")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color(hex: "BD081C"), in: Capsule())
                    .accessibilityHidden(true)
            }
            if let title = ctx.string("title") {
                Text(title).font(.title3.weight(.bold)).fixedSize(horizontal: false, vertical: true)
            }
            if !ctx.post.content.isEmpty {
                ExpandableText(text: ctx.post.content, lineLimit: 3, font: .subheadline, overflowAt: ctx.overflow(ctx.post.content))
            }
            if let link = ctx.string("link") {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.up.right.square")
                    Text(URL(string: link)?.host() ?? link)
                }
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
            }
            HStack(spacing: 8) {
                Avatar(ctx: ctx, size: 28)
                Text(ctx.name).font(.footnote.weight(.semibold))
                if let board = ctx.string("board") {
                    Text("· \(ctx.optionLabel("board", board) ?? board)").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .padding(14)
    }
}

// MARK: - Reddit, Lemmy

private struct RedditPreview: View {
    var ctx: PreviewContext

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Avatar(ctx: ctx, size: 24)
                if let sub = ctx.string("subreddit") ?? ctx.string("community") {
                    Text(sub.hasPrefix("r/") || ctx.providerId != "reddit" ? sub : "r/\(sub)").font(.footnote.weight(.semibold))
                }
                Text("u/\(ctx.username) · \(ctx.time)").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            if let title = ctx.string("title") {
                Text(title).font(.headline).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                if let flair = ctx.string("flair") { chip(ctx.optionLabel("flair", flair) ?? flair, .secondary) }
                if ctx.bool("nsfw") { chip("NSFW", .red) }
                if ctx.bool("spoiler") { chip(String(localized: "Spoiler"), .secondary) }
            }
            if let url = ctx.string("url") { LinkCard(url: url) }
            if !ctx.post.content.isEmpty {
                ExpandableText(text: ctx.post.content, font: .subheadline, overflowAt: ctx.overflow(ctx.post.content))
            }
            if !ctx.post.media.isEmpty { PreviewMediaGrid(ids: ctx.post.media, open: ctx.open) }
            ActionIcons(symbols: ["arrow.up", "arrow.down", "bubble.left", "square.and.arrow.up"]).font(.footnote).padding(.top, 2)
            if !ctx.post.thread.isEmpty {
                Divider()
                CommentList(ctx: ctx, items: ctx.post.thread, avatar: 24)
            }
        }
        .padding(14)
    }

    @ViewBuilder
    private func chip(_ text: String, _ color: Color) -> some View {
        Text(text).font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
    }
}

// MARK: - Blogs, newsletters

private struct ArticlePreview: View {
    var ctx: PreviewContext

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let first = ctx.post.media.first {
                Color.clear.aspectRatio(1.91, contentMode: .fit)
                    .overlay { MediaCell(ids: ctx.post.media, index: 0, open: ctx.open, full: true) }
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .id(first)
            }
            if let title = ctx.string("title") {
                Text(title).font(.title2.weight(.bold)).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Avatar(ctx: ctx, size: 28)
                Text(ctx.name).font(.footnote.weight(.semibold))
                Text("· \(ctx.time)").font(.footnote).foregroundStyle(.secondary)
            }
            if ctx.post.content.isEmpty {
                NoText()
            } else {
                ExpandableText(text: ctx.post.content, font: .subheadline, overflowAt: ctx.overflow(ctx.post.content))
            }
            let tags = ctx.tags("tags")
            if !tags.isEmpty {
                Text(tags.map { "#\($0)" }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
    }
}

// MARK: - X weighted length

/// X's weighted length (worker/providers/x.ts `xWeightedLength`): URLs count 23, CJK and emoji 2, most Latin text 1.
enum XText {
    private static let light: [ClosedRange<UInt32>] = [0x0000...0x10FF, 0x2000...0x200D, 0x2010...0x201F, 0x2032...0x2037]
    private static let tlds = "com|net|org|io|co|app|dev|ai|me|ly|gg|tv|xyz|info|biz|edu|gov|us|uk|de|fr|es|it|nl|ca|au|in|jp|ru|br|eu|tr|link|site|online|store|blog|news|page|so|sh"
    private static let urlRegex = try? NSRegularExpression(
        pattern: "(?<![@\\w.])(?:https?://[^\\s]+|(?:[a-z0-9-]+\\.)+(?:\(tlds))\\b(?:/[^\\s]*)?)",
        options: [.caseInsensitive]
    )

    private static func weight(_ c: Character) -> Int {
        let scalars = c.unicodeScalars
        if scalars.contains(where: { $0.properties.isEmojiPresentation || (0x1F1E6...0x1F1FF).contains($0.value) || $0.value == 0xFE0F || $0.value == 0x20E3 || $0.value == 0x200D }) {
            return 2
        }
        return scalars.reduce(0) { sum, s in sum + (light.contains { $0.contains(s.value) } ? 1 : 2) }
    }

    /// Weight per character (offsets into `text` as Characters); a URL weighs 23 on its first character.
    private static func weights(_ text: String) -> [Int] {
        let chars = Array(text)
        var w = chars.map(weight)
        guard let urlRegex else { return w }
        let ns = text as NSString
        for m in urlRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var url = ns.substring(with: m.range)
            while let last = url.last, ".,!?;:'\")]".contains(last) { url.removeLast() }
            guard !url.isEmpty, let r = Range(NSRange(location: m.range.location, length: (url as NSString).length), in: text) else { continue }
            let start = text.distance(from: text.startIndex, to: r.lowerBound)
            let count = text[r].count
            guard start + count <= w.count else { continue }
            for i in start..<(start + count) { w[i] = 0 }
            w[start] = 23
        }
        return w
    }

    static func weightedLength(_ text: String) -> Int { weights(text.precomposedStringWithCanonicalMapping).reduce(0, +) }

    /// Character offset where the text goes over `limit`, nil when it fits.
    static func overflowOffset(_ text: String, limit: Int) -> Int? {
        var total = 0
        for (i, w) in weights(text).enumerated() {
            total += w
            if total > limit { return i }
        }
        return nil
    }
}
