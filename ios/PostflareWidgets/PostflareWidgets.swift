import SwiftUI
import WidgetKit

@main
struct PostflareWidgetsBundle: WidgetBundle {
    var body: some Widget {
        UpNextWidget()
        TodayWidget()
    }
}

// MARK: - Timeline

struct SnapshotEntry: TimelineEntry {
    var date: Date
    var snapshot: WidgetSnapshot?
    var signedIn = true

    static let preview = SnapshotEntry(date: .now, snapshot: .preview)
}

/// Reads through the shared keychain token (the app's device token and workspace); refreshes every 15 minutes and
/// when the app reloads the timelines (posts changed, pushes, workspace switch).
struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { .preview }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (SnapshotEntry) -> Void) {
        if context.isPreview, Keychain.load() == nil { completion(.preview); return }
        Task { completion(await entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<SnapshotEntry>) -> Void) {
        Task {
            let e = await entry()
            // Refresh sooner when the next post is due before the regular interval.
            var next = Date.now.addingTimeInterval(15 * 60)
            if let due = e.snapshot?.upcoming.compactMap(\.at).filter({ $0 > .now }).min(), due < next { next = due.addingTimeInterval(60) }
            completion(Timeline(entries: [e], policy: .after(next)))
        }
    }

    private func entry() async -> SnapshotEntry {
        SharedSettings.reload()
        let signedIn = Keychain.load() != nil
        return SnapshotEntry(date: .now, snapshot: signedIn ? await WidgetData.load() : nil, signedIn: signedIn)
    }
}

// MARK: - Shared views

struct WidgetTitle: View {
    var title: LocalizedStringKey
    var systemImage: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.accentColor)
            Text(title).font(.caption.weight(.semibold))
            Spacer(minLength: 0)
        }
    }
}

/// No snapshot: signed out, or nothing loaded yet.
struct SignedOutView: View {
    var signedIn: Bool

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: signedIn ? "clock" : "person.crop.circle.badge.questionmark").font(.title2).foregroundStyle(.secondary)
            Text(signedIn ? "Open Postflare to load your posts" : "Open Postflare to sign in")
                .font(.caption).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct WidgetGlyph: View {
    var provider: String
    var size: CGFloat = 16

    var body: some View {
        Circle()
            .fill(Platform.color(provider))
            .overlay {
                Text(Platform.glyph(provider))
                    .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .minimumScaleFactor(0.5)
            }
            .frame(width: size, height: size)
            .widgetAccentable()
    }
}

private func timeText(_ p: WidgetSnapshot.UpcomingPost) -> String {
    if p.publishing { return String(localized: "Publishing") }
    guard let at = p.at else { return "" }
    return Calendar.current.isDateInToday(at) ? at.formatted(date: .omitted, time: .shortened) : at.formatted(.dateTime.weekday(.abbreviated).hour().minute())
}

// MARK: - Up next

struct UpNextWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "\(AppIdentity.bundleID).upnext", provider: SnapshotProvider()) { entry in
            UpNextView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: "postflare://posts"))
        }
        .configurationDisplayName("Up next")
        .description("Your next scheduled posts.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
    }
}

struct UpNextView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        if let s = entry.snapshot {
            switch family {
            case .accessoryInline:
                if let p = s.upcoming.first {
                    Text("\(timeText(p)) · \(p.accountName)")
                } else {
                    Text("Nothing scheduled")
                }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Label("Up next", systemImage: "calendar").font(.caption2.weight(.semibold)).widgetAccentable()
                    if let p = s.upcoming.first {
                        Text(timeText(p)).font(.headline).lineLimit(1)
                        Text(p.excerpt).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    } else {
                        Text("Nothing scheduled").font(.caption)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .systemMedium:
                VStack(alignment: .leading, spacing: 6) {
                    WidgetTitle(title: "Up next", systemImage: "calendar")
                    if s.upcoming.isEmpty {
                        Spacer()
                        Text("Nothing scheduled").font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                    } else {
                        ForEach(s.upcoming.prefix(3)) { p in row(p) }
                        Spacer(minLength: 0)
                    }
                }
            default:
                VStack(alignment: .leading, spacing: 4) {
                    WidgetTitle(title: "Up next", systemImage: "calendar")
                    Spacer(minLength: 0)
                    if let p = s.upcoming.first {
                        HStack(spacing: 4) {
                            WidgetGlyph(provider: p.provider, size: 14)
                            Text(p.accountName).font(.caption2.weight(.semibold)).lineLimit(1)
                        }
                        Text(timeText(p))
                            .font(.system(.title3, design: .rounded).weight(.bold))
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                        Text(p.excerpt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        if s.upcoming.count > 1 {
                            Text("+\(s.upcoming.count - 1) more").font(.caption2).foregroundStyle(.tertiary)
                        }
                    } else {
                        Text("Nothing scheduled").font(.subheadline).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            SignedOutView(signedIn: entry.signedIn)
        }
    }

    private func row(_ p: WidgetSnapshot.UpcomingPost) -> some View {
        HStack(spacing: 8) {
            WidgetGlyph(provider: p.provider, size: 22)
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(p.accountName).font(.caption.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(timeText(p)).font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                }
                Text(p.excerpt).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

// MARK: - Today

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "\(AppIdentity.bundleID).today", provider: SnapshotProvider()) { entry in
            TodayView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: "postflare://home"))
        }
        .configurationDisplayName("Today")
        .description("Published, scheduled and failed posts today.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

struct TodayView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        if let s = entry.snapshot {
            let published = s.today(.published)
            let scheduled = s.today(.scheduled) + s.today(.publishing)
            switch family {
            case .accessoryCircular:
                Gauge(value: Double(published), in: 0...Double(max(1, published + scheduled))) {
                    Image(systemName: "paperplane")
                } currentValueLabel: {
                    Text("\(published)").font(.system(.title3, design: .rounded).weight(.bold))
                }
                .gaugeStyle(.accessoryCircularCapacity)
                .widgetAccentable()
                .accessibilityLabel(Text("\(published) of \(published + scheduled) posts published today"))
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Label("Today", systemImage: "paperplane").font(.caption2.weight(.semibold)).widgetAccentable()
                    Text("\(published) published").font(.headline)
                    Text("\(scheduled) scheduled · \(s.todayFailed) failed").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .systemMedium:
                VStack(alignment: .leading, spacing: 8) {
                    WidgetTitle(title: "Today", systemImage: "paperplane")
                    HStack(spacing: 8) {
                        stat(published, "Published", .green)
                        stat(scheduled, "Scheduled", .blue)
                        stat(s.todayFailed, "Failed", .red)
                    }
                    Spacer(minLength: 0)
                    HStack {
                        Text("This week: \(s.week(.published)) published")
                        Spacer()
                        if s.attention > 0 { Label("\(s.attention)", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            default:
                VStack(alignment: .leading, spacing: 4) {
                    WidgetTitle(title: "Today", systemImage: "paperplane")
                    Spacer(minLength: 0)
                    Text("\(published)")
                        .font(.system(size: 40, weight: .bold, design: .rounded))
                        .contentTransition(.numericText(value: Double(published)))
                    Text("published").font(.caption.weight(.medium))
                    HStack(spacing: 8) {
                        Label("\(scheduled)", systemImage: "clock").foregroundStyle(.blue)
                        if s.todayFailed > 0 { Label("\(s.todayFailed)", systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                    }
                    .font(.caption2.weight(.semibold))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            SignedOutView(signedIn: entry.signedIn)
        }
    }

    private func stat(_ n: Int, _ title: LocalizedStringKey, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(n)").font(.system(.title, design: .rounded).weight(.bold)).foregroundStyle(.primary)
            HStack(spacing: 3) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview(as: .systemMedium) {
    UpNextWidget()
} timeline: {
    SnapshotEntry.preview
}

#Preview(as: .systemSmall) {
    TodayWidget()
} timeline: {
    SnapshotEntry.preview
}
