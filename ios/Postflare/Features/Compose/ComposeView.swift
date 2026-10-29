import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// One attached photo or video: uploading (progress), uploaded (its media id) or failed.
@MainActor
@Observable
final class Attachment: Identifiable {
    enum State: Equatable { case preparing, uploading(Double), done(String), failed(String) }

    let id = UUID()
    var state: State
    var preview: UIImage?
    var isVideo: Bool
    var task: Task<Void, Never>?

    init(state: State, isVideo: Bool, preview: UIImage? = nil) {
        self.state = state
        self.isVideo = isVideo
        self.preview = preview
    }

    var mediaId: String? { if case let .done(id) = state { id } else { nil } }
    var isBusy: Bool {
        switch state {
        case .preparing, .uploading: true
        default: false
        }
    }
}

/// A video from the photo library, copied to a temporary file.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

struct ComposeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var request: ComposeRequest

    enum When: String, CaseIterable, Identifiable {
        case now, later, draft
        var id: String { rawValue }
        var title: LocalizedStringKey {
            switch self {
            case .now: "Now"
            case .later: "Later"
            case .draft: "Draft"
            }
        }
    }

    @State private var selected: Set<String> = []
    @State private var text = ""
    @State private var attachments: [Attachment] = []
    @State private var thread: [ThreadItem] = []
    @State private var when: When = .later
    @State private var date = Calendar.current.date(byAdding: .hour, value: 1, to: .now) ?? .now
    /// Per-account values of the platforms' required settings.
    @State private var settings: [String: [String: JSONValue]] = [:]
    @State private var picks: [PhotosPickerItem] = []
    @State private var errors: [String] = []
    @State private var submitting = false
    @State private var planLimit: PlanLimit?
    @State private var confirmDiscard = false
    @State private var prefilled = false
    @FocusState private var textFocused: Bool

    private var selectedAccounts: [Account] { model.accounts.filter { selected.contains($0.id) } }
    private var providersInUse: [ProviderInfo] {
        let ids = Set(selectedAccounts.map(\.provider))
        return model.providers.filter { ids.contains($0.id) }.sorted { $0.name < $1.name }
    }
    private var uploading: Bool { attachments.contains(where: \.isBusy) }
    private var hasContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty }
    private var canSubmit: Bool { !selected.isEmpty && hasContent && !uploading && !submitting && !attachments.contains { if case .failed = $0.state { true } else { false } } }

    var body: some View {
        NavigationStack {
            Form {
                accountsSection
                textSection
                mediaSection
                whenSection
                ForEach(selectedAccounts.filter { !requiredFields(for: $0).isEmpty }) { account in
                    settingsSection(account)
                }
                if !errors.isEmpty {
                    Section {
                        ForEach(errors, id: \.self) { e in
                            Label(e, systemImage: "exclamationmark.circle.fill").foregroundStyle(.red).font(.subheadline)
                        }
                    } header: {
                        Text("Fix these first")
                    }
                }
            }
            .navigationTitle(request.duplicate == nil ? "New post" : "Duplicate post")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { _ in AccountPickerView(selected: $selected) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if hasContent { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submit() }
                    } label: {
                        if submitting { ProgressView() } else { Text(submitTitle) }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(!canSubmit)
                }
            }
            .confirmationDialog("Discard this post?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) {
                    for a in attachments { a.task?.cancel() }
                    dismiss()
                }
            }
            .planLimitAlert($planLimit)
            .onChange(of: picks) { _, items in
                guard !items.isEmpty else { return }
                for item in items { attach(item) }
                picks = []
            }
            .onChange(of: selected) { _, _ in fillDefaults() }
            .onAppear(perform: prefill)
            .task {
                if model.accounts.isEmpty || model.providers.isEmpty { await model.refreshCatalog() }
            }
        }
        .interactiveDismissDisabled(hasContent)
    }

    private var submitTitle: LocalizedStringKey {
        switch when {
        case .now: "Publish"
        case .later: "Schedule"
        case .draft: "Save draft"
        }
    }

    // MARK: Accounts

    private var accountsSection: some View {
        Section {
            NavigationLink(value: "accounts") {
                if selectedAccounts.isEmpty {
                    Label("Choose accounts", systemImage: "person.crop.circle.badge.plus")
                } else {
                    HStack(spacing: -6) {
                        ForEach(selectedAccounts.prefix(6)) { a in
                            AccountAvatar(account: a, provider: a.provider, size: 30)
                        }
                        Text(selectedAccounts.count == 1 ? selectedAccounts[0].name : String(localized: "\(selectedAccounts.count) accounts"))
                            .padding(.leading, 14)
                            .lineLimit(1)
                    }
                }
            }
            if !model.groups.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.groupedAccounts.compactMap(\.group)) { g in
                            let ids = Set(model.accounts.filter { $0.groupId == g.id && $0.status != "disabled" }.map(\.id))
                            let all = !ids.isEmpty && ids.isSubset(of: selected)
                            Button {
                                if all { selected.subtract(ids) } else { selected.formUnion(ids) }
                            } label: {
                                Label(g.name, systemImage: all ? "checkmark.circle.fill" : "circle")
                                    .font(.caption.weight(.medium))
                            }
                            .buttonStyle(.bordered)
                            .tint(all ? .brand : Color.group(g.color))
                            .accessibilityLabel(Text(all ? "Deselect \(g.name)" : "Select all of \(g.name)"))
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        } header: {
            Text("Post to")
        }
    }

    // MARK: Text

    private var textSection: some View {
        Section {
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text("What do you want to share?")
                        .foregroundStyle(.tertiary)
                        .padding(.top, 8)
                        .padding(.leading, 5)
                        .accessibilityHidden(true)
                }
                TextEditor(text: $text)
                    .focused($textFocused)
                    .frame(minHeight: 150)
                    .scrollContentBackground(.hidden)
                    .accessibilityLabel(Text("Post text"))
            }
            if !providersInUse.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(providersInUse) { p in counter(p) }
                    }
                }
            }
            if !thread.isEmpty {
                Label("Includes \(thread.count) follow-ups from the original post", systemImage: "text.bubble")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            let notes = providersInUse.filter { $0.capabilities.text == "required" && text.trimmingCharacters(in: .whitespaces).isEmpty }
            if !notes.isEmpty {
                Text("\(notes.map(\.name).formatted(.list(type: .and))) need text.")
            }
        }
    }

    private func counter(_ p: ProviderInfo) -> some View {
        let used = text.unicodeScalars.count
        let max = p.capabilities.maxLength
        let over = max > 0 && used > max
        return HStack(spacing: 5) {
            PlatformGlyph(provider: p.id, size: 16)
            Text(max > 0 ? "\(used)/\(max)" : "\(used)")
                .monospacedDigit()
        }
        .font(.caption.weight(over ? .bold : .regular))
        .foregroundStyle(over ? Color.red : Color.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background((over ? Color.red : Color.secondary).opacity(0.1), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(over ? "\(p.name): \(used) of \(max) characters, too long" : "\(p.name): \(used) of \(max) characters"))
    }

    // MARK: Media

    private var mediaSection: some View {
        Section {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(attachments) { a in AttachmentTile(attachment: a) { remove(a) } }
                    }
                    .padding(.vertical, 4)
                }
            }
            if model.workspace?.demo == true {
                Label("The demo workspace does not take uploads.", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if model.can("media.write") {
                PhotosPicker(selection: $picks, maxSelectionCount: 10, selectionBehavior: .ordered, matching: .any(of: [.images, .videos])) {
                    Label("Add photos or videos", systemImage: "photo.badge.plus")
                }
            }
        } header: {
            Text("Media")
        } footer: {
            let notes = providersInUse.compactMap { p -> String? in
                if p.capabilities.media.required { return String(localized: "\(p.name) needs a photo or video.") }
                return p.capabilities.mediaNote.map { "\(p.name): \($0)" }
            }
            if !notes.isEmpty { Text(notes.joined(separator: "\n")) }
        }
    }

    // MARK: When

    private var whenSection: some View {
        Section("When") {
            Picker("When", selection: $when) {
                ForEach(When.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if when == .later {
                DatePicker("Publish at", selection: $date, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
            }
        }
    }

    // MARK: Platform settings

    private func requiredFields(for account: Account) -> [FieldDef] {
        guard let p = model.provider(account.provider) else { return [] }
        let values = settings[account.id] ?? [:]
        return p.settingsFields.filter { f in
            guard f.isRequired else { return false }
            guard let cond = f.showIf else { return true }
            let v = values[cond.key] ?? p.settingsFields.first { $0.key == cond.key }?.default ?? .null
            return v == cond.equals
        }
    }

    private func settingsSection(_ account: Account) -> some View {
        Section {
            ForEach(requiredFields(for: account), id: \.key) { field in
                FieldEditor(field: field, accountId: account.id, value: Binding(
                    get: { settings[account.id]?[field.key] ?? field.default ?? .null },
                    set: { settings[account.id, default: [:]][field.key] = $0 }
                ))
            }
        } header: {
            HStack(spacing: 6) {
                PlatformGlyph(provider: account.provider, size: 16)
                Text("\(model.providerName(account.provider)) · \(account.name)")
            }
        }
    }

    /// Defaults of required fields for newly selected accounts.
    private func fillDefaults() {
        for a in selectedAccounts {
            guard let p = model.provider(a.provider) else { continue }
            for f in p.settingsFields where f.isRequired {
                if settings[a.id]?[f.key] == nil, let d = f.default { settings[a.id, default: [:]][f.key] = d }
            }
        }
    }

    // MARK: Attachments

    private func attach(_ item: PhotosPickerItem) {
        let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
        let a = Attachment(state: .preparing, isVideo: isVideo)
        attachments.append(a)
        a.task = Task {
            do {
                let (file, preview): (UploadFile, UIImage?)
                if isVideo {
                    guard let movie = try await item.loadTransferable(type: PickedMovie.self) else { throw APIError.invalidResponse }
                    (file, preview) = try await UploadPreparation.video(movie.url)
                } else {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw APIError.invalidResponse }
                    (file, preview) = try UploadPreparation.image(data, type: item.supportedContentTypes.first)
                }
                a.preview = preview
                a.state = .uploading(0)
                guard let client = model.client else { throw APIError.notSignedIn }
                let media = try await client.upload(file) { p in Task { @MainActor in if a.isBusy { a.state = .uploading(p) } } }
                try? FileManager.default.removeItem(at: file.url)
                model.remember(media)
                a.state = .done(media.id)
            } catch is CancellationError {
            } catch let APIError.planLimit(limit) {
                a.state = .failed(limit.error)
                planLimit = limit
            } catch {
                a.state = .failed(model.handle(error) ?? error.localizedDescription)
            }
        }
    }

    private func remove(_ a: Attachment) {
        a.task?.cancel()
        attachments.removeAll { $0.id == a.id }
    }

    // MARK: Prefill (Duplicate)

    private func prefill() {
        guard !prefilled else { return }
        prefilled = true
        if let p = request.duplicate {
            text = p.content
            selected = [p.accountId]
            settings[p.accountId] = p.settings
            thread = p.thread
            attachments = p.media.map { id in
                let m = model.media[id]
                return Attachment(state: .done(id), isVideo: m?.isVideo ?? false)
            }
            model.loadMedia(p.media)
        }
    }

    // MARK: Submit

    private func submit() async {
        guard let client = model.client else { return }
        errors = []
        let media = attachments.compactMap(\.mediaId)
        let input = CreatePostsInput(
            scheduledAt: when == .now ? .now : when == .draft ? .draft : .at(date),
            posts: selectedAccounts.map { a in
                let threads = model.provider(a.provider)?.capabilities.thread == true ? thread : []
                return .init(accountId: a.id, content: text, media: media, settings: (settings[a.id] ?? [:]).filter { !$0.value.isEmpty }, thread: threads)
            }
        )
        submitting = true
        defer { submitting = false }
        do {
            _ = try await client.createPosts(input)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            model.dataChanged()
            dismiss()
        } catch let APIError.planLimit(limit) {
            planLimit = limit
        } catch let APIError.server(_, message, list, _) {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            errors = list.isEmpty ? [message] : list
        } catch {
            errors = [model.handle(error) ?? error.localizedDescription]
        }
    }
}

/// Thumbnail of an attachment with its upload progress and a remove button.
private struct AttachmentTile: View {
    var attachment: Attachment
    var remove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image = attachment.preview {
                    Image(uiImage: image).resizable().scaledToFill()
                } else if let id = attachment.mediaId {
                    MediaThumb(mediaId: id, size: 88)
                } else {
                    Rectangle().fill(Color(.tertiarySystemFill))
                }
            }
            .frame(width: 88, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay { overlay }

            Button(action: remove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.title3)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.55))
            }
            .buttonStyle(.plain)
            .padding(4)
            .accessibilityLabel(Text("Remove"))
        }
    }

    @ViewBuilder
    private var overlay: some View {
        switch attachment.state {
        case .preparing:
            ZStack { Color.black.opacity(0.35); ProgressView().tint(.white) }
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        case let .uploading(p):
            ZStack {
                Color.black.opacity(0.35)
                ProgressView(value: p)
                    .progressViewStyle(.circular)
                    .tint(.white)
                Text(p.formatted(.percent.precision(.fractionLength(0))))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .offset(y: 26)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityLabel(Text("Uploading \(p.formatted(.percent.precision(.fractionLength(0))))"))
        case let .failed(message):
            ZStack {
                Color.red.opacity(0.55)
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.white)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityLabel(Text("Upload failed: \(message)"))
        case .done:
            if attachment.isVideo {
                Image(systemName: "video.fill").font(.caption).foregroundStyle(.white).padding(6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
        }
    }
}

/// Accounts grouped by account group, with "select all" per group.
struct AccountPickerView: View {
    @Environment(AppModel.self) private var model
    @Binding var selected: Set<String>
    @State private var search = ""

    var body: some View {
        List {
            ForEach(Array(model.groupedAccounts.enumerated()), id: \.offset) { _, entry in
                let accounts = entry.accounts.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || ($0.username ?? "").localizedCaseInsensitiveContains(search) }
                if !accounts.isEmpty {
                    Section {
                        ForEach(accounts) { a in row(a) }
                    } header: {
                        HStack {
                            if let g = entry.group {
                                Circle().fill(Color.group(g.color)).frame(width: 8, height: 8)
                                Text(g.name)
                            } else {
                                Text(model.groups.isEmpty ? "Accounts" : "Ungrouped")
                            }
                            Spacer()
                            let ids = Set(accounts.filter { $0.status != "disabled" }.map(\.id))
                            Button(ids.isSubset(of: selected) ? "Deselect all" : "Select all") {
                                if ids.isSubset(of: selected) { selected.subtract(ids) } else { selected.formUnion(ids) }
                            }
                            .font(.caption.weight(.semibold))
                            .textCase(nil)
                        }
                    }
                }
            }
        }
        .searchable(text: $search)
        .navigationTitle("Accounts")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if model.accounts.isEmpty {
                ContentUnavailableView("No accounts", systemImage: "person.crop.circle.badge.questionmark", description: Text("Connect accounts in Postflare on the web."))
            }
        }
    }

    private func row(_ a: Account) -> some View {
        Button {
            if selected.contains(a.id) { selected.remove(a.id) } else { selected.insert(a.id) }
        } label: {
            HStack(spacing: 12) {
                AccountAvatar(account: a, provider: a.provider, size: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text(a.name).foregroundStyle(.primary)
                    Text([a.handle, model.providerName(a.provider)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if a.needsReconnect {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        .accessibilityLabel(Text("Reconnect needed"))
                }
                Image(systemName: selected.contains(a.id) ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected.contains(a.id) ? Color.brand : Color.secondary)
            }
        }
        .disabled(a.status == "disabled")
        .accessibilityAddTraits(selected.contains(a.id) ? .isSelected : [])
    }
}

/// Editor for one platform setting (FieldDef).
struct FieldEditor: View {
    @Environment(AppModel.self) private var model
    var field: FieldDef
    var accountId: String
    @Binding var value: JSONValue
    @State private var dynamic: [FieldOption]?
    @State private var loadError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            editor
            if let help = field.help { Text(help).font(.caption).foregroundStyle(.secondary) }
            if let loadError { Text(loadError).font(.caption).foregroundStyle(.red) }
        }
    }

    @ViewBuilder
    private var editor: some View {
        switch field.type {
        case "checkbox":
            Toggle(field.label, isOn: Binding(get: { value.bool ?? false }, set: { value = .bool($0) }))
        case "select":
            let options = field.dynamicOptions == true ? (dynamic ?? []) : (field.options ?? [])
            Picker(field.label, selection: Binding(get: { value.string ?? "" }, set: { value = .string($0) })) {
                Text("Choose…").tag("")
                ForEach(options, id: \.value) { Text($0.label).tag($0.value) }
            }
            .task(id: accountId) {
                guard field.dynamicOptions == true, dynamic == nil, let client = model.client else { return }
                do { dynamic = try await client.options(accountId: accountId, key: field.key) } catch { loadError = model.handle(error) }
            }
        case "number":
            TextField(field.label, value: Binding(get: { value.number }, set: { value = $0.map(JSONValue.number) ?? .null }), format: .number)
                .keyboardType(.decimalPad)
        case "tags":
            TextField(field.label, text: Binding(get: {
                if case let .array(a) = value { a.compactMap(\.string).joined(separator: ", ") } else { "" }
            }, set: { s in
                value = .array(s.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }.filter { !$0.isEmpty })
            }), prompt: Text(field.placeholder ?? String(localized: "Comma-separated")))
        case "datetime":
            DatePicker(field.label, selection: Binding(get: {
                value.string.flatMap { try? Date($0, strategy: .iso8601) } ?? .now
            }, set: { value = .string($0.formatted(.iso8601)) }))
        case "textarea":
            TextField(field.label, text: stringBinding, prompt: field.placeholder.map { Text($0) }, axis: .vertical)
                .lineLimit(2...6)
        default:
            TextField(field.label, text: stringBinding, prompt: field.placeholder.map { Text($0) })
                .keyboardType(field.type == "url" ? .URL : .default)
                .textInputAutocapitalization(field.type == "url" ? .never : .sentences)
        }
    }

    private var stringBinding: Binding<String> {
        Binding(get: { value.string ?? "" }, set: { s in
            let limited = field.maxLength.map { String(s.prefix($0)) } ?? s
            value = .string(limited)
        })
    }
}
