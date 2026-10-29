import SwiftUI

/// Long text that collapses to a few lines with "Show more" / "Show less" (YouTube description style). Hashtags,
/// mentions and links are tinted like on the platforms.
struct ExpandableText: View {
    var text: String
    var lineLimit = 5
    var font: Font = .subheadline
    /// Bold prefix on the first line (Instagram's "username caption").
    var lead: String?
    var linkColor = Color(uiColor: .link)
    var selectable = true
    /// Characters from this offset on are over the platform's limit (marked red).
    var overflowAt: Int?

    @State private var expanded = false
    @State private var fullHeight: CGFloat = 0
    @State private var limitedHeight: CGFloat = 0

    private var truncates: Bool { fullHeight > limitedHeight + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            styled
                .lineLimit(expanded ? nil : lineLimit)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(alignment: .topLeading) {
                    // Hidden copies measure the full and the collapsed height at the same width.
                    ZStack(alignment: .topLeading) {
                        styled.fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                        styled.lineLimit(lineLimit).fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { limitedHeight = $0 }
                    }
                    .hidden()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
                .modifier(Selectable(enabled: selectable && (expanded || !truncates)))
            if truncates || expanded {
                Button {
                    withAnimation(.snappy) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "Show more")
                        .font(font.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 2)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .tint(.secondary)
                .accessibilityHint(Text(expanded ? "Collapses the text" : "Shows the whole text"))
            }
        }
    }

    private var styled: Text {
        var s = AttributedString()
        if let lead, !lead.isEmpty {
            var l = AttributedString(lead + " ")
            l.font = font.weight(.semibold)
            s += l
        }
        var main = Self.linkified(text, color: linkColor)
        if let overflowAt, overflowAt < main.characters.count {
            let start = main.characters.index(main.startIndex, offsetBy: overflowAt)
            main[start...].foregroundColor = .red
            main[start...].backgroundColor = Color.red.opacity(0.15)
        }
        s += main
        return Text(s).font(font)
    }

    /// Tints #hashtags, @mentions and links.
    static func linkified(_ text: String, color: Color) -> AttributedString {
        var out = AttributedString(text)
        guard let regex = try? NSRegularExpression(pattern: #"(?<![\w@#])(?:[#@][\p{L}\p{N}_.]+|https?://\S+)"#) else { return out }
        let ns = text as NSString
        for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let r = Range(m.range, in: text),
                  let lower = AttributedString.Index(r.lowerBound, within: out),
                  let upper = AttributedString.Index(r.upperBound, within: out) else { continue }
            out[lower..<upper].foregroundColor = color
        }
        return out
    }

    private struct Selectable: ViewModifier {
        var enabled: Bool
        func body(content: Content) -> some View {
            if enabled { content.textSelection(.enabled) } else { content }
        }
    }
}
