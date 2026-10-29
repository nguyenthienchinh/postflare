import Foundation
import SwiftUI

/// Number and date formatting.
enum Fmt {
    /// 950, 1.2K, 3.4M.
    static func compact(_ value: Double) -> String {
        if abs(value) < 1000 { return value.formatted(.number.precision(.fractionLength(0))) }
        return value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
    }

    static func count(_ value: Int) -> String { value.formatted(.number) }

    /// 0.0423 → "4.2%".
    static func percent(_ fraction: Double) -> String {
        fraction.formatted(.percent.precision(.fractionLength(0...1)))
    }

    /// "+12%" / "−3%" for a ratio change (0.12).
    static func change(_ change: Double) -> String {
        let pct = change * 100
        let text = abs(pct) >= 10 ? String(format: "%.0f%%", abs(pct)) : String(format: "%.1f%%", abs(pct))
        return (change >= 0 ? "+" : "−") + text
    }

    /// +12, −3 (true minus sign), compact.
    static func signed(_ value: Double) -> String {
        (value > 0 ? "+" : value < 0 ? "−" : "") + compact(abs(value))
    }

    static func date(ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    /// "Today 14:30", "Tomorrow 09:00", "Mon 20 Oct, 18:00", with the year when it is not this year.
    static func when(_ date: Date, now: Date = .now) -> String {
        let cal = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if cal.isDateInToday(date) { return String(localized: "Today \(time)") }
        if cal.isDateInTomorrow(date) { return String(localized: "Tomorrow \(time)") }
        if cal.isDateInYesterday(date) { return String(localized: "Yesterday \(time)") }
        var style = Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).hour().minute()
        if !cal.isDate(date, equalTo: now, toGranularity: .year) { style = style.year() }
        return date.formatted(style)
    }

    /// Section title of a day: "Today", "Tomorrow", "Monday, 20 October".
    static func day(_ date: Date, now: Date = .now) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return String(localized: "Today") }
        if cal.isDateInTomorrow(date) { return String(localized: "Tomorrow") }
        if cal.isDateInYesterday(date) { return String(localized: "Yesterday") }
        var style = Date.FormatStyle().weekday(.wide).day().month(.wide)
        if !cal.isDate(date, equalTo: now, toGranularity: .year) { style = style.year() }
        return date.formatted(style)
    }

    static func relative(ms: Double) -> String {
        date(ms: ms).formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    /// Video length: "0:42", "12:05", "1:02:33".
    static func duration(_ seconds: Double) -> String {
        let t = Int(seconds.rounded())
        let h = t / 3600, m = (t % 3600) / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// Watch time: "45m", "12h 5m", "1,204h" (localized unit abbreviations).
    static func minutes(_ minutes: Double) -> String {
        let m = max(0, minutes.rounded())
        if m >= 6000 {
            return Duration.seconds(m * 60).formatted(.units(allowed: [.hours], width: .narrow))
        }
        return Duration.seconds(m * 60).formatted(.units(allowed: [.hours, .minutes], width: .narrow))
    }

    /// Money: "$1,234.50", "€12".
    static func money(_ value: Double, currency: String?) -> String {
        guard let currency, !currency.isEmpty else { return value.formatted(.number.precision(.fractionLength(0...2))) }
        return value.formatted(.currency(code: currency).precision(.fractionLength(abs(value) >= 1000 ? 0 : 2)))
    }

    /// Time since publishing on a chart axis: "3h", "2d" (hours in).
    static func elapsed(hours: Double) -> String {
        let seconds = max(0, hours * 3600)
        if hours < 48 {
            return Duration.seconds(seconds).formatted(.units(allowed: [.hours], width: .narrow, fractionalPart: .hide))
        }
        return Duration.seconds(seconds).formatted(.units(allowed: [.days], width: .narrow, fractionalPart: .hide))
    }

    static func bytes(_ n: Double) -> String {
        Int64(n).formatted(.byteCount(style: .file))
    }

    private static let dayParser: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// "2026-10-16" (a day in the device's time zone, analytics `daily`) → its start.
    static func day(_ s: String) -> Date? { dayParser.date(from: String(s.prefix(10))) }
}

extension Color {
    static let brand = Color("AccentColor")
    static let positive = Color.green
    static let negative = Color.red
}

/// Change pill colour: green when the metric moved the good way.
func changeColor(_ change: Double?) -> Color {
    guard let change, abs(change) >= 0.0005 else { return .secondary }
    return change > 0 ? .positive : .negative
}

/// Relative change of `current` against `previous` (nil when there is nothing to compare with).
func relativeChange(_ current: Double?, _ previous: Double?) -> Double? {
    guard let current, let previous, previous != 0 else { return nil }
    return (current - previous) / abs(previous)
}

// MARK: - Metrics

/// Labels and formatting of metric keys (`MetricKey` and the `extra` keys platforms send).
enum MetricInfo {
    /// Numeric keys in display order for a post's numbers (account-level ones left out).
    static let postKeys = ["views", "reach", "impressions", "likes", "comments", "shares", "saves", "replies", "reposts", "quotes", "clicks",
                           "watchTimeMinutes", "avgViewDurationSeconds", "avgViewPercentage"]

    /// Extras that repeat other numbers and are never shown (Instagram total_interactions = likes + comments + shares + saves).
    static let hiddenExtras: Set<String> = ["total_interactions"]

    /// Known extras in display order.
    static let extraOrder = ["profile_visits", "follows", "subscribers_gained", "favorites", "upvote_ratio", "crossposts", "outbound_clicks", "pin_clicks",
                             "notes", "score", "downvotes", "listed", "total_likes", "channel_views", "monthly_views", "fans"]

    static func title(_ key: String) -> String {
        switch key {
        case "views": String(localized: "Views")
        case "reach": String(localized: "Reach")
        case "impressions": String(localized: "Impressions")
        case "likes": String(localized: "Likes")
        case "comments": String(localized: "Comments")
        case "shares": String(localized: "Shares")
        case "saves": String(localized: "Saves")
        case "replies": String(localized: "Replies")
        case "reposts": String(localized: "Reposts")
        case "quotes": String(localized: "Quotes")
        case "clicks": String(localized: "Clicks")
        case "followers": String(localized: "Followers")
        case "following": String(localized: "Following")
        case "posts": String(localized: "Posts")
        case "watchTimeMinutes": String(localized: "Watch time")
        case "avgViewDurationSeconds": String(localized: "Avg. view duration")
        case "avgViewPercentage": String(localized: "Avg. % viewed")
        case "profile_visits": String(localized: "Profile visits")
        case "follows": String(localized: "Follows")
        case "subscribers_gained": String(localized: "Subscribers gained")
        case "favorites": String(localized: "Favorites")
        case "upvote_ratio": String(localized: "Upvote ratio")
        case "crossposts": String(localized: "Crossposts")
        case "outbound_clicks": String(localized: "Outbound clicks")
        case "pin_clicks": String(localized: "Pin clicks")
        case "notes": String(localized: "Notes")
        case "score": String(localized: "Score")
        case "downvotes": String(localized: "Downvotes")
        case "listed": String(localized: "Listed")
        case "total_likes": String(localized: "Total likes")
        case "channel_views": String(localized: "Channel views")
        case "monthly_views": String(localized: "Monthly views")
        case "fans": String(localized: "Fans")
        default:
            key.replacingOccurrences(of: "_", with: " ").capitalized(with: .current)
        }
    }

    static func symbol(_ key: String) -> String {
        switch key {
        case "views": "eye"
        case "reach": "person.3"
        case "impressions": "rectangle.stack"
        case "likes", "favorites", "total_likes": "heart"
        case "comments", "replies": "bubble.left"
        case "shares", "crossposts": "arrowshape.turn.up.right"
        case "saves": "bookmark"
        case "reposts": "arrow.2.squarepath"
        case "quotes": "quote.bubble"
        case "clicks", "outbound_clicks", "pin_clicks": "cursorarrow.click"
        case "followers", "follows", "subscribers_gained", "fans": "person.badge.plus"
        case "watchTimeMinutes": "clock"
        case "avgViewDurationSeconds": "timer"
        case "avgViewPercentage", "upvote_ratio": "percent"
        case "profile_visits": "person.crop.circle"
        case "notes": "note.text"
        case "score": "arrow.up"
        case "downvotes": "arrow.down"
        default: "number"
        }
    }

    /// The value as shown: compact count, watch time, m:ss, or a percentage.
    static func format(_ key: String, _ value: Double) -> String {
        switch key {
        case "watchTimeMinutes": Fmt.minutes(value)
        case "avgViewDurationSeconds": Fmt.duration(value)
        case "avgViewPercentage": Fmt.percent(value / 100)
        // Reddit sends 0...1; tolerate a percentage.
        case "upvote_ratio": Fmt.percent(value > 1 ? value / 100 : value)
        default: Fmt.compact(value)
        }
    }

    /// Whether the key can be summed / grows over time (growth chart candidates).
    static func isCumulative(_ key: String) -> Bool {
        !["avgViewDurationSeconds", "avgViewPercentage", "upvote_ratio"].contains(key)
    }

    /// The post's keys with a value, in display order: the normalized keys, then the known extras, then the others.
    static func keys(of m: MetricValues) -> [String] {
        let base = postKeys.filter { m[$0] != nil }
        let extras = m.extra ?? [:]
        let known = extraOrder.filter { extras[$0] != nil }
        let others = extras.keys.filter { !extraOrder.contains($0) && !hiddenExtras.contains($0) }.sorted()
        return base + known + others
    }
}

/// YouTube traffic source ids (insightTrafficSourceType) as readable names.
enum TrafficSourceName {
    static func title(_ id: String) -> String {
        switch id {
        case "YT_SEARCH": String(localized: "YouTube search")
        case "SHORTS": String(localized: "Shorts feed")
        case "SUBSCRIBER": String(localized: "Subscriptions")
        case "RELATED_VIDEO": String(localized: "Suggested videos")
        case "BROWSE": String(localized: "Browse features")
        case "EXT_URL": String(localized: "External")
        case "NOTIFICATION": String(localized: "Notifications")
        case "PLAYLIST": String(localized: "Playlists")
        case "YT_CHANNEL": String(localized: "Channel pages")
        case "YT_OTHER_PAGE": String(localized: "Other YouTube pages")
        case "END_SCREEN": String(localized: "End screens")
        case "HASHTAGS": String(localized: "Hashtags")
        case "SOUND_PAGE": String(localized: "Sound pages")
        case "NO_LINK_OTHER": String(localized: "Direct or unknown")
        default: id.replacingOccurrences(of: "_", with: " ").lowercased().capitalized(with: .current)
        }
    }
}

// MARK: - Post status

extension PostStatus {
    var title: String {
        switch self {
        case .draft: String(localized: "Draft")
        case .scheduled: String(localized: "Scheduled")
        case .publishing: String(localized: "Publishing")
        case .published: String(localized: "Published")
        case .failed: String(localized: "Failed")
        case .cancelled: String(localized: "Cancelled")
        case .needsCheck: String(localized: "Needs check")
        }
    }

    var color: Color {
        switch self {
        case .draft: .gray
        case .scheduled: .blue
        case .publishing: .purple
        case .published: .green
        case .failed: .red
        case .cancelled: .orange
        case .needsCheck: .yellow
        }
    }

    var symbol: String {
        switch self {
        case .draft: "doc.text"
        case .scheduled: "clock"
        case .publishing: "arrow.up.circle"
        case .published: "checkmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .cancelled: "slash.circle"
        case .needsCheck: "questionmark.circle.fill"
        }
    }
}

// MARK: - Platforms

/// Names, colours and letter glyphs of the platforms, for places without the `/providers` catalog (widgets) and as
/// fallback. Simple letters on the brand colour, no logos.
enum Platform {
    private static let known: [String: (name: String, color: String, glyph: String)] = [
        "x": ("X", "000000", "X"),
        "bluesky": ("Bluesky", "0085FF", "Bs"),
        "threads": ("Threads", "000000", "Th"),
        "mastodon": ("Mastodon", "6364FF", "M"),
        "instagram": ("Instagram", "E4405F", "Ig"),
        "instagram_standalone": ("Instagram", "E4405F", "Ig"),
        "facebook": ("Facebook", "0866FF", "f"),
        "tiktok": ("TikTok", "000000", "Tk"),
        "tiktok_business": ("TikTok", "000000", "Tk"),
        "youtube": ("YouTube", "FF0000", "Yt"),
        "linkedin": ("LinkedIn", "0A66C2", "in"),
        "linkedin_page": ("LinkedIn Page", "0A66C2", "in"),
        "pinterest": ("Pinterest", "BD081C", "P"),
        "reddit": ("Reddit", "FF4500", "r"),
        "telegram": ("Telegram", "26A5E4", "Tg"),
        "discord": ("Discord", "5865F2", "D"),
        "slack": ("Slack", "4A154B", "S"),
        "tumblr": ("Tumblr", "36465D", "t"),
        "medium": ("Medium", "000000", "M"),
        "devto": ("DEV", "0A0A0A", "dev"),
        "hashnode": ("Hashnode", "2962FF", "H"),
        "wordpress": ("WordPress", "21759B", "W"),
        "lemmy": ("Lemmy", "00BC8C", "L"),
        "nostr": ("Nostr", "8E44AD", "N"),
        "farcaster": ("Farcaster", "855DCD", "Fc"),
        "twitch": ("Twitch", "9146FF", "Tw"),
        "kick": ("Kick", "53FC18", "K"),
        "vk": ("VK", "0077FF", "VK"),
        "gmb": ("Google Business", "4285F4", "G"),
        "dribbble": ("Dribbble", "EA4C89", "Dr"),
        "listmonk": ("Listmonk", "0055D4", "Lm"),
        "webhook": ("Webhook", "6B7280", "Wh"),
    ]

    static func name(_ id: String) -> String { known[id]?.name ?? id.capitalized }

    static func glyph(_ id: String) -> String {
        known[id]?.glyph ?? String(name(id).prefix(1)).uppercased()
    }

    static func color(_ id: String, hex: String? = nil) -> Color {
        Color(hex: hex ?? known[id]?.color ?? "6B7280")
    }
}

extension Color {
    /// "FF500A" (no '#').
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let v = UInt64(s, radix: 16) ?? 0x6B7280
        self.init(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    /// Account group palette keys (shared/accountGroups.ts).
    static func group(_ key: String) -> Color {
        switch key {
        case "red": .red
        case "orange": .orange
        case "amber": .yellow
        case "green": .green
        case "teal": .teal
        case "sky": .cyan
        case "indigo": .indigo
        case "violet": .purple
        case "pink": .pink
        default: .gray
        }
    }
}
