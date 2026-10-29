# Contributing to Postflare

Thanks for helping! Bug reports, platform fixes, new platforms and docs improvements are all welcome.

## Development setup

Requirements: Node.js 22.12 or newer (Vitest 5 and Vite 8 need it), npm. No Cloudflare account is needed for
development or tests: Vite runs the Worker locally with emulated D1, R2 and Workflows.

```bash
git clone https://github.com/FerdiKT/postflare.git
cd postflare
npm install
npm run dev            # http://localhost:5173, create the first user (instance admin) in the browser
```

Useful variables for local development go in a git-ignored `.dev.vars` file, for example `DEMO_MODE=true` to try the
sandboxed live demo at `/demo`.

Project layout: `worker/` (Hono API, publishing workflow, one file per platform in `worker/providers/`), `src/` (React
app), `shared/` (types used by both), `cli/` (the `postflare` CLI), `skills/` (Claude Code skill), `migrations/` (D1
schema). [CLAUDE.md](CLAUDE.md) has the short list of rules the code follows.

## Checks

```bash
npm run typecheck      # tsc -b (app + worker + tests)
npm test               # vitest: providers (mocked APIs), CLI, and integration tests in workerd (local D1/R2)
npm run cli:build      # build the CLI
npx vite build         # production build of the app and Worker
```

CI runs the same commands on every pull request.

## Adding or fixing a platform

Read [docs/provider-brief.md](docs/provider-brief.md) first: it describes the `Provider` contract
(`worker/providers/types.ts`), the HTTP helpers, media streaming and the **Workers Free plan budget** every provider
must respect (~10ms CPU and at most 40 outgoing requests per call; media is streamed, never buffered).

In short:
1. Add `worker/providers/<id>.ts`, register it in `worker/providers/registry.ts` and add its display name to `shared/providerNames.ts`.
2. Use `ctx.fetch` through the `http.ts` helpers, never the global `fetch`.
3. `publish`, `checkStatus` and `reply` run as retried Workflow steps: they must be safe to retry and never double-post.
4. Add `test/providers/<id>.test.ts` with mocked API responses (see `test/helpers.ts`).

## Writing a playbook

Built-in playbooks are Markdown files in [`playbooks/`](playbooks/), bundled into the Worker at build time
(`worker/lib/playbooks.ts`) and validated by `test/playbooks.test.ts`. One file per playbook, named `<id>.md`:

```markdown
---
id: app-feature-spotlight            # kebab-case, unique, equals the file name, never renamed
version: 1                           # bump when the advice changes meaningfully (posts record the version they used)
name: App feature spotlight          # ≤ 60 characters
summary: One sentence, ≤ 160 characters.
goal: conversions                    # engagement | reach | clicks | followers | conversions
platforms: [short-video, x, threads] # provider ids or groups: short-video, microblog, professional, visual, all
formats: [video, image, carousel]    # text, thread, image, carousel, video
tags: [mobile-app, feature]          # lowercase
inputs: [app name, the one feature, store link]  # what the writer must know first (no commas inside an item)
---
```

(The frontmatter is a strict subset of YAML: one `key: value` per line, inline `[a, b]` lists, no comments in real
files.) The body has exactly these `## ` sections, in this order: **When to use**, **Structure**, **Platform notes**,
**Hooks**, **Examples**, **Avoid**, **Checklist** (`- [ ] ...` items). Use `###` inside sections, plain Markdown only (no
tables or HTML).

Quality bar: be concrete and specific, not generic marketing advice.
- Structure as numbered steps with real constraints ("line 1: the hook, ≤ 70 characters").
- Platform notes with real numbers: X 280 (a URL counts as 23; links in the main post cut reach and cost more through
  the API, so put them in the first reply), Bluesky 300, Threads 500, LinkedIn's ~210-character fold, Instagram's
  ~125-character fold and no clickable links, TikTok's first two seconds... Mention Postflare follow-ups (thread replies
  / first comment) for links where they help.
- 2–4 hook formulas with `{placeholders}` and why each works; 1–3 complete, realistic examples that obey the playbook's
  own rules (with character counts for short posts).
- An *Avoid* list of what platforms penalise or audiences hate (engagement bait, hashtag stuffing, misleading hooks).
- Never present invented statistics as facts.

Run `npx vitest run test/playbooks.test.ts` to check the file. Changing a playbook's advice: bump `version`.

## Database changes

Add a new `migrations/000N_*.sql` file; never edit an existing migration. Migrations are applied automatically on the
first request. Every query on workspace data (accounts, posts, media, upload links, API keys...) must be scoped by
`workspace_id`; see the multi-tenant notes in [CLAUDE.md](CLAUDE.md) and the tests in `test/workers/`.

## Commit messages

Releases and changelogs are generated from commit messages ([release-please](docs/RELEASING.md)), so commits on `main`
(and PR titles: PRs are squash-merged, the title becomes the commit) follow
[Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<optional scope>): <summary in the imperative>
```

| Type | For | Release |
|---|---|---|
| `feat` | a user-visible feature | minor |
| `fix` | a bug fix | patch |
| `perf` | a performance improvement | patch |
| `docs` | documentation only | none (listed in the changelog) |
| `refactor`, `test`, `build`, `ci`, `chore` | everything else | none (hidden from the changelog) |

- Add `!` after the type (`feat!: ...`) or a `BREAKING CHANGE: <what and how to upgrade>` footer for breaking changes
  (API, config, behaviour self-hosters must act on). Explain the upgrade steps: they end up in the release notes.
- Scopes are free-form, e.g. `feat(tiktok): ...`, `fix(composer): ...`. Changes under `cli/` are released with the CLI
  (`feat(cli): ...`); a commit touching both the server and `cli/` appears in both changelogs, so prefer separate
  commits.
- Never bump versions or edit `CHANGELOG.md` by hand: release PRs do it.

## Pull request checklist

- [ ] `npm run typecheck`, `npm test`, `npm run cli:build` and `npx vite build` pass.
- [ ] PR title is a [Conventional Commit](#commit-messages) (`feat: ...`, `fix(x): ...`, `feat!: ...` if breaking).
- [ ] Breaking REST API change? Bump `API_VERSION` in `shared/version.ts` and the CLI range in `cli/src/compat.ts`.
- [ ] New behavior has tests (provider tests mock the platform API; API changes have a `test/workers/` test).
- [ ] Workspace-scoped queries and permission guards for new routes.
- [ ] `cli/src/types.ts` updated when `shared/types.ts` API shapes change.
- [ ] README / docs updated for user-visible changes.
- [ ] No secrets, personal domains or credentials in the diff (personal deploy settings belong in `wrangler.local.jsonc`).

By contributing you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).
