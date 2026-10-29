import SwiftUI

/// What the analytics screen shows: everything, one platform or one account. Stored as "", "p:<provider>", "a:<account id>".
enum AnalyticsFilter: Hashable, Sendable {
    case all
    case provider(String)
    case account(String)

    init(raw: String) {
        if raw.hasPrefix("p:"), raw.count > 2 { self = .provider(String(raw.dropFirst(2))) }
        else if raw.hasPrefix("a:"), raw.count > 2 { self = .account(String(raw.dropFirst(2))) }
        else { self = .all }
    }

    var raw: String {
        switch self {
        case .all: ""
        case let .provider(p): "p:\(p)"
        case let .account(a): "a:\(a)"
        }
    }

    var scope: APIClient.AnalyticsScope {
        switch self {
        case .all: .all
        case let .provider(p): APIClient.AnalyticsScope(provider: p)
        case let .account(a): APIClient.AnalyticsScope(accountId: a)
        }
    }
}

/// The filter as a chip: platform glyph or account avatar, its name, and a clear button.
struct AnalyticsFilterChip: View {
    @Environment(AppModel.self) private var model
    var filter: AnalyticsFilter
    var choose: () -> Void
    var clear: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: choose) {
                HStack(spacing: 7) {
                    switch filter {
                    case .all:
                        Image(systemName: "line.3.horizontal.decrease.circle")
                            .foregroundStyle(.secondary)
                    case let .provider(p):
                        PlatformGlyph(provider: p, size: 22)
                    case let .account(id):
                        AccountAvatar(account: model.account(id), provider: model.account(id)?.provider ?? "", size: 22)
                    }
                    Text(title).font(.subheadline.weight(.medium)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                .padding(.leading, 8)
                .padding(.trailing, 12)
                .padding(.vertical, 6)
                .background(filter == .all ? Color(.secondarySystemGroupedBackground) : Color.accentColor.opacity(0.16), in: Capsule())
                .overlay { Capsule().strokeBorder(filter == .all ? .clear : Color.accentColor.opacity(0.6), lineWidth: 1) }
                .foregroundStyle(.primary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Filter: \(title)"))
            .accessibilityHint(Text("Choose a platform or an account"))

            if filter != .all {
                Button(action: clear) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Show all accounts"))
            }
            Spacer(minLength: 0)
        }
    }

    private var title: String {
        switch filter {
        case .all: String(localized: "All accounts")
        case let .provider(p): model.providerName(p)
        case let .account(id): model.account(id)?.name ?? String(localized: "Unknown account")
        }
    }
}

/// Picks the analytics filter: all, a platform, or an account (accounts grouped by platform).
struct AnalyticsFilterSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var selection: AnalyticsFilter
    var choose: (AnalyticsFilter) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row(.all) {
                        Image(systemName: "square.grid.2x2")
                            .frame(width: 30, height: 30)
                            .foregroundStyle(.secondary)
                        Text("All accounts")
                    }
                }
                ForEach(platforms, id: \.provider) { group in
                    Section {
                        row(.provider(group.provider)) {
                            PlatformGlyph(provider: group.provider, size: 30)
                            Text("All of \(model.providerName(group.provider))")
                        }
                        ForEach(group.accounts) { a in
                            row(.account(a.id)) {
                                AccountAvatar(account: a, provider: a.provider, size: 30)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(a.name).lineLimit(1)
                                    if let handle = a.handle {
                                        Text(handle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                            }
                        }
                    } header: {
                        Text(model.providerName(group.provider))
                    }
                }
            }
            .navigationTitle("Show analytics for")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// Platforms of the workspace's accounts (those with analytics), each with its accounts.
    private var platforms: [(provider: String, accounts: [Account])] {
        let withAnalytics = model.accounts.filter { a in
            guard let info = model.provider(a.provider)?.analytics else { return true }
            return info.post || info.account
        }
        let byProvider = Dictionary(grouping: withAnalytics, by: \.provider)
        return byProvider
            .map { ($0.key, $0.value.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) }
            .sorted { model.providerName($0.0).localizedCaseInsensitiveCompare(model.providerName($1.0)) == .orderedAscending }
    }

    private func row(_ filter: AnalyticsFilter, @ViewBuilder label: () -> some View) -> some View {
        Button {
            choose(filter)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                label()
                Spacer()
                if filter == selection {
                    Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .foregroundStyle(.primary)
        .accessibilityAddTraits(filter == selection ? .isSelected : [])
    }
}
