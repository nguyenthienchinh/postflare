import SwiftUI

/// Connected accounts grouped by account group, with their publishing status. Connecting and reconnecting need the
/// platform's OAuth in a browser: those open the web app.
struct AccountsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var loading = false
    @State private var search = ""

    private var webAccounts: URL? { model.serverURL?.appending(path: "accounts") }

    var body: some View {
        List {
            let reconnect = model.accounts.filter(\.needsReconnect)
            if !reconnect.isEmpty {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(reconnect.count) accounts need reconnecting").font(.subheadline.weight(.semibold))
                            Text("Their posts fail until you reconnect them. This opens Postflare on the web.").font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                    if let webAccounts {
                        Button("Reconnect on the web", systemImage: "safari") { openURL(webAccounts) }
                    }
                }
            }
            ForEach(Array(model.groupedAccounts.enumerated()), id: \.offset) { _, entry in
                let accounts = entry.accounts.filter(matches)
                if !accounts.isEmpty {
                    Section {
                        ForEach(accounts) { a in AccountRow(account: a, reconnectURL: webAccounts) }
                    } header: {
                        HStack(spacing: 6) {
                            if let g = entry.group {
                                Circle().fill(Color.group(g.color)).frame(width: 8, height: 8)
                                Text(g.name)
                            } else {
                                Text(model.groups.isEmpty ? "Accounts" : "Ungrouped")
                            }
                            Spacer()
                            Text("\(accounts.count)").monospacedDigit()
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $search, prompt: Text("Search accounts"))
        .overlay {
            if model.accounts.isEmpty {
                if loading {
                    ProgressView().controlSize(.large)
                } else {
                    ContentUnavailableView {
                        Label("No accounts yet", systemImage: "person.crop.circle.badge.plus")
                    } description: {
                        Text("Connect Instagram, TikTok, X, YouTube and more in Postflare on the web.")
                    } actions: {
                        if let webAccounts, model.can("accounts.manage"), model.workspace?.demo != true {
                            Button("Connect on the web") { openURL(webAccounts) }.buttonStyle(.glassProminent)
                        }
                    }
                }
            }
        }
        .navigationTitle("Accounts")
        .toolbarTitleDisplayMode(.inlineLarge)
        .toolbar {
            if let webAccounts, model.can("accounts.manage"), model.workspace?.demo != true {
                ToolbarItem(placement: .primaryAction) {
                    Button { openURL(webAccounts) } label: { Label("Connect an account", systemImage: "plus") }
                }
            }
        }
        .refreshable { await model.refreshCatalog() }
        .task(id: model.dataVersion) {
            loading = true
            await model.refreshCatalog()
            loading = false
        }
    }

    private func matches(_ a: Account) -> Bool {
        search.isEmpty || a.name.localizedCaseInsensitiveContains(search) || (a.username ?? "").localizedCaseInsensitiveContains(search)
            || model.providerName(a.provider).localizedCaseInsensitiveContains(search)
    }
}

private struct AccountRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    var account: Account
    var reconnectURL: URL?

    var body: some View {
        HStack(spacing: 12) {
            AccountAvatar(account: account, provider: account.provider, size: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(account.name).font(.body.weight(.medium)).lineLimit(1)
                Text([account.handle, model.providerName(account.provider)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if account.needsReconnect, let message = account.statusMessage {
                    Text(message).font(.caption).foregroundStyle(.orange).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                statusBadge
                if let followers = account.metricsStatus?.metrics?.followers {
                    Text("\(Fmt.compact(followers)) followers").font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .swipeActions {
            if account.needsReconnect, let reconnectURL {
                Button("Reconnect", systemImage: "link") { openURL(reconnectURL) }.tint(.orange)
            }
            if let profile = account.profileUrl.flatMap(URL.init(string:)) {
                Button("Profile", systemImage: "person.crop.circle") { openURL(profile) }.tint(.blue)
            }
        }
        .contextMenu {
            if let profile = account.profileUrl.flatMap(URL.init(string:)) {
                Button("Open profile", systemImage: "person.crop.circle") { openURL(profile) }
            }
            if account.needsReconnect, let reconnectURL {
                Button("Reconnect on the web", systemImage: "link") { openURL(reconnectURL) }
            }
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        let (title, color): (String, Color) = switch account.status {
        case "reconnect": (String(localized: "Reconnect needed"), .orange)
        case "disabled": (String(localized: "Disabled"), .gray)
        default: (String(localized: "Active"), .green)
        }
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(color.opacity(0.13), in: Capsule())
    }
}
