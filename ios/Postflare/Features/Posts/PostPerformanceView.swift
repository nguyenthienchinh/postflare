import Charts
import SwiftUI

/// The numbers of a published post (`GET /posts/:id/metrics`) as list sections: every metric it has, when they were
/// collected (with "Refresh now" and "Open on <platform>"), growth over the snapshots, and for YouTube the audience
/// retention curve and traffic sources.
struct PostPerformanceSections: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize
    var post: Post
    var providerId: String
    @Binding var metrics: PostMetrics?
    @State private var growthKey = "views"
    @State private var selectedHours: Double?
    @State private var refreshing = false
    @State private var refreshError: String?

    var body: some View {
        overview
        if let growth = growthData { growthSection(growth) }
        if let points = metrics?.details?.retentionPoints, points.count > 1 { retentionSection(points) }
        if let sources = metrics?.details?.trafficSources?.filter({ $0.views > 0 }), !sources.isEmpty { trafficSection(sources) }
    }

    private var providerName: String { model.providerName(providerId) }

    /// The platform does not collect post numbers at all.
    private var noPostAnalytics: Bool { model.provider(providerId)?.analytics?.post == false }

    // MARK: Overview

    private struct Tile: Identifiable {
        var id: String
        var title: String
        var value: String
        var symbol: String
    }

    private func tiles(_ m: MetricValues) -> [Tile] {
        var out = MetricInfo.keys(of: m).compactMap { key -> Tile? in
            guard let v = m[key] else { return nil }
            return Tile(id: key, title: MetricInfo.title(key), value: MetricInfo.format(key, v), symbol: MetricInfo.symbol(key))
        }
        if let rate = m.engagementRate {
            out.insert(Tile(id: "engagementRate", title: String(localized: "Engagement rate"), value: Fmt.percent(rate), symbol: "percent"), at: min(1, out.count))
        }
        return out
    }

    private var overview: some View {
        Section {
            if let m = metrics?.metrics {
                let columns = Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .topLeading), count: typeSize.isAccessibilitySize ? 2 : 3)
                LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                    ForEach(tiles(m)) { t in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(t.value)
                                .font(.system(.title3, design: .rounded).weight(.bold))
                                .monospacedDigit()
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Label(t.title, systemImage: t.symbol)
                                .labelStyle(CompactLabelStyle())
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(t.title))
                        .accessibilityValue(Text(t.value))
                    }
                }
                .padding(.vertical, 6)
            } else if noPostAnalytics {
                Text("\(providerName) does not report numbers for posts.").foregroundStyle(.secondary)
            } else if let next = metrics?.metricsNextAt {
                Text("First numbers \(Fmt.relative(ms: next)).").foregroundStyle(.secondary)
            } else {
                Text("No numbers yet.").foregroundStyle(.secondary)
            }

            if let line = collectionLine {
                Label(line, systemImage: "clock.arrow.circlepath")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if model.canWrite, !noPostAnalytics, post.externalId != nil {
                Button {
                    Task { await refresh() }
                } label: {
                    HStack {
                        Label("Refresh now", systemImage: "arrow.clockwise")
                        if refreshing { Spacer(); ProgressView() }
                    }
                }
                .disabled(refreshing)
            }

            if let url = post.externalUrl.flatMap(URL.init(string:)) {
                Button { openURL(url) } label: {
                    HStack {
                        Label("Open on \(providerName)", systemImage: "arrow.up.right.square")
                        Spacer()
                        Text(url.host() ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        } header: {
            Text("Performance")
        } footer: {
            if let refreshError {
                Text(refreshError).foregroundStyle(.red)
            } else if metrics?.metrics?.engagementRate != nil {
                Text("Engagement rate: likes, comments, shares, saves, replies, reposts, quotes and clicks per view.")
            }
        }
    }

    /// "Collected 2 hr. ago · Next update in 1 day".
    private var collectionLine: String? {
        guard let m = metrics else { return nil }
        var parts: [String] = []
        if let at = m.metricsAt { parts.append(String(localized: "Collected \(Fmt.relative(ms: at))")) }
        if m.metrics != nil {
            if let next = m.metricsNextAt {
                parts.append(String(localized: "Next update \(Fmt.relative(ms: next))"))
            } else if m.metricsAt != nil {
                parts.append(String(localized: "No more automatic updates"))
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func refresh() async {
        guard let client = model.client else { return }
        refreshing = true
        refreshError = nil
        defer { refreshing = false }
        do {
            _ = try await client.refreshPostMetrics(post.id)
            metrics = try await client.postMetrics(post.id)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch is CancellationError {
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            refreshError = model.handle(error)
            // The server may still have stored something (the error response carries the post).
            if let fresh = try? await client.postMetrics(post.id) { metrics = fresh }
        }
    }

    // MARK: Growth

    private struct GrowthPoint: Identifiable {
        var hours: Double
        var value: Double
        var id: Double { hours }
    }

    private struct Growth {
        var keys: [String]
        var key: String
        var points: [GrowthPoint]
    }

    /// Cumulative metrics with at least two snapshots, the chosen one's points (hours since publishing).
    private var growthData: Growth? {
        guard let m = metrics, m.snapshots.count > 1 else { return nil }
        let start = m.publishedAt ?? post.publishedAt ?? m.snapshots[0].capturedAt
        let candidates = (MetricInfo.postKeys + MetricInfo.extraOrder).filter { key in
            MetricInfo.isCumulative(key) && !MetricInfo.hiddenExtras.contains(key) && m.snapshots.filter({ $0.metrics[key] != nil }).count > 1
                && m.snapshots.contains { ($0.metrics[key] ?? 0) > 0 }
        }
        guard !candidates.isEmpty else { return nil }
        let key = candidates.contains(growthKey) ? growthKey : candidates[0]
        var points = m.snapshots.compactMap { s in
            s.metrics[key].map { GrowthPoint(hours: max(0, (s.capturedAt - start) / 3_600_000), value: $0) }
        }
        // Everything starts at 0 when the post goes live.
        if let first = points.first, first.hours > 0.05 { points.insert(GrowthPoint(hours: 0, value: 0), at: 0) }
        return Growth(keys: candidates, key: key, points: points)
    }

    private func growthSection(_ g: Growth) -> some View {
        let maxHours = g.points.last?.hours ?? 1
        let selected = selectedHours.flatMap { h in g.points.min { abs($0.hours - h) < abs($1.hours - h) } }
        return Section {
            Chart {
                ForEach(g.points) { p in
                    AreaMark(x: .value("Time since publishing", p.hours), y: .value("Value", p.value))
                        .foregroundStyle(LinearGradient(colors: [Color.chart.opacity(0.22), Color.chart.opacity(0)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Time since publishing", p.hours), y: .value("Value", p.value))
                        .foregroundStyle(Color.chart)
                        .interpolationMethod(.monotone)
                    PointMark(x: .value("Time since publishing", p.hours), y: .value("Value", p.value))
                        .foregroundStyle(Color.chart)
                        .symbolSize(selected?.hours == p.hours ? 70 : 24)
                }
                if let selected {
                    RuleMark(x: .value("Time since publishing", selected.hours))
                        .foregroundStyle(.secondary.opacity(0.4))
                        .zIndex(-1)
                        .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                            VStack(spacing: 2) {
                                Text(selected.hours == 0 ? String(localized: "Published") : String(localized: "After \(Fmt.elapsed(hours: selected.hours))"))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text(MetricInfo.format(g.key, selected.value)).font(.caption.weight(.bold)).monospacedDigit()
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                        }
                }
            }
            .chartXSelection(value: $selectedHours)
            .chartXScale(domain: 0...max(maxHours, 1))
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { v in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.15))
                    AxisValueLabel { if let h = v.as(Double.self) { Text(Fmt.elapsed(hours: h)) } }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { v in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                    AxisValueLabel { if let n = v.as(Double.self) { Text(MetricInfo.format(g.key, n)) } }
                }
            }
            .frame(height: 170)
            .padding(.vertical, 8)
            .accessibilityLabel(Text("\(MetricInfo.title(g.key)) since publishing"))
            .accessibilityValue(Text(growthSummary(g)))
        } header: {
            HStack {
                Text("Growth")
                Spacer()
                if g.keys.count > 1 {
                    Menu {
                        Picker("Metric", selection: Binding(get: { g.key }, set: { growthKey = $0; selectedHours = nil })) {
                            ForEach(g.keys, id: \.self) { Text(MetricInfo.title($0)).tag($0) }
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Text(MetricInfo.title(g.key))
                            Image(systemName: "chevron.up.chevron.down").font(.caption2)
                        }
                        .font(.footnote.weight(.semibold))
                        .textCase(nil)
                    }
                    .accessibilityLabel(Text("Metric"))
                    .accessibilityValue(Text(MetricInfo.title(g.key)))
                }
            }
        } footer: {
            Text("Time since publishing. Numbers are collected about 1 hour, 1 day, 3 days, 7 days and 30 days after publishing.")
        }
    }

    private func growthSummary(_ g: Growth) -> String {
        g.points.filter { $0.hours > 0 }.map { String(localized: "After \(Fmt.elapsed(hours: $0.hours)): \(MetricInfo.format(g.key, $0.value))") }.joined(separator: ", ")
    }

    // MARK: Retention

    private func retentionSection(_ points: [MetricDetails.RetentionPoint]) -> some View {
        let data = points.map { (x: $0.progress * 100, y: $0.ratio * 100) }
        let top = max(110, (data.map(\.y).max() ?? 100) * 1.05)
        return Section {
            Chart {
                ForEach(data, id: \.x) { p in
                    AreaMark(x: .value("Video progress", p.x), y: .value("Still watching", p.y))
                        .foregroundStyle(LinearGradient(colors: [Color.chart.opacity(0.28), Color.chart.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Video progress", p.x), y: .value("Still watching", p.y))
                        .foregroundStyle(Color.chart)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.monotone)
                }
                RuleMark(y: .value("Still watching", 100))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .annotation(position: .top, alignment: .trailing) {
                        Text("100%").font(.caption2).foregroundStyle(.secondary)
                    }
            }
            .chartXScale(domain: 0...100)
            .chartYScale(domain: 0...top)
            .chartXAxis {
                AxisMarks(values: [0, 25, 50, 75, 100]) { v in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.15))
                    AxisValueLabel { if let n = v.as(Double.self) { Text(Fmt.percent(n / 100)) } }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                    AxisValueLabel { if let n = v.as(Double.self) { Text(Fmt.percent(n / 100)) } }
                }
            }
            .frame(height: 180)
            .padding(.vertical, 8)
            .accessibilityLabel(Text("Audience retention"))
            .accessibilityValue(Text(retentionSummary(points)))
        } header: {
            Text("Audience retention")
        } footer: {
            Text("How many viewers are still watching at each point of the video (x: how far into the video). Above 100% means parts were rewatched.")
        }
    }

    private func retentionSummary(_ points: [MetricDetails.RetentionPoint]) -> String {
        func at(_ progress: Double) -> String {
            let p = points.min { abs($0.progress - progress) < abs($1.progress - progress) }
            return Fmt.percent(p?.ratio ?? 0)
        }
        return String(localized: "\(at(0.25)) still watching at a quarter, \(at(0.5)) at the middle, \(at(1)) at the end")
    }

    // MARK: Traffic sources

    private func trafficSection(_ sources: [MetricDetails.TrafficSource]) -> some View {
        let total = sources.reduce(0) { $0 + $1.views }
        let rows = sources.sorted { $0.views > $1.views }.map { (name: TrafficSourceName.title($0.source), views: $0.views, share: total > 0 ? $0.views / total : 0) }
        return Section {
            Chart(rows, id: \.name) { r in
                BarMark(x: .value("Views", r.views), y: .value("Source", r.name), height: .ratio(0.65))
                    .foregroundStyle(Color.chart)
                    .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: 4, topTrailingRadius: 4))
                    .annotation(position: .trailing, spacing: 4) {
                        Text("\(Fmt.compact(r.views)) · \(Fmt.percent(r.share))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
            }
            .chartXAxis(.hidden)
            .chartXScale(domain: 0...((rows.first?.views ?? 1) * 1.45))
            .chartYAxis {
                AxisMarks { _ in AxisValueLabel().font(.caption) }
            }
            .frame(height: CGFloat(rows.count) * 30 + 8)
            .padding(.vertical, 6)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Traffic sources"))
            .accessibilityValue(Text(rows.map { "\($0.name) \(Fmt.percent($0.share))" }.joined(separator: ", ")))
        } header: {
            Text("Traffic sources")
        } footer: {
            if let at = metrics?.detailsAt {
                Text("Where the views came from. From YouTube Analytics, \(Fmt.relative(ms: at)).")
            } else {
                Text("Where the views came from.")
            }
        }
    }
}
