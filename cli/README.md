# postflare (CLI)

Command line client for Postflare, the self-hosted social media scheduler on Cloudflare: schedule
posts to 36 platforms (see the Platform status table in the main README), upload media, and read analytics from your terminal or from an AI agent (Claude Code...).

- Node.js 20+, no runtime dependencies.
- Human-friendly tables by default, `--json` on every command for scripts and agents.
- Exit codes: `0` ok, `1` error (API errors print the server's message), `2` usage error.

## Install

```bash
npm i -g postflare
postflare --help       # `pf` is a short alias: pf posts --upcoming
```

From a clone of the repo instead: `npm run cli:build && npm i -g ./cli`.

## Log in

Create an API key in Postflare → **Profile → API keys**. A key belongs to one workspace and acts with your
permissions there.

```bash
postflare login --url https://postflare.example.com    # asks for the key without echoing it
echo "$KEY" | postflare login --url https://postflare.example.com
postflare whoami
```

Credentials are saved to `~/.config/postflare/config.json` (mode 0600; `$XDG_CONFIG_HOME` is honored,
`POSTFLARE_CONFIG` overrides the path). Several instances/workspaces: `postflare login --profile work ...`, then
`--profile work` on any command or `POSTFLARE_PROFILE=work`. `POSTFLARE_URL` + `POSTFLARE_API_KEY` override the saved
profile (handy in CI). `postflare logout [--profile x | --all]`.

## Commands

| Command | |
|---|---|
| `whoami`, `workspaces` | User, workspace and permissions of the key |
| `version` | CLI version and the server's version/commit (`--version` prints the CLI version only) |
| `accounts [--platform id] [--group g]` | Connected accounts, group, status, followers, analytics state |
| `accounts options <account> <key>` | Choices of a dynamic setting (Pinterest boards, subreddits, TikTok privacy...) |
| `accounts group <account...> --to <group\|none>` | Move accounts into an account group (or out of it) |
| `groups [create\|rename\|rm]` | Account groups (brands / projects) |
| `platforms [id] [--connected]` | Limits and per-post settings of each platform (`platforms tiktok` lists every field and option) |
| `media upload <files...> [--alt]` | Upload (streamed; >90MB uses multipart, up to 5GB, with a progress bar) |
| `media list`, `media import <url>`, `media rm <ids...>` | Media library |
| `upload-link [--note] [--wait]` | One-time upload page (send photos from a phone); `--wait` prints the media ids |
| `post ...` | Create posts (see below) |
| `posts [--status] [--upcoming] [--from] [--to] [-a]` | List posts |
| `posts show <id>` | Post with its publishing log and metrics |
| `posts edit <id> [--text] [--at] [--set] [--media] [--thread] [--app\|--no-app] [--autolink\|--no-autolink]` | Edit / reschedule |
| `posts cancel\|retry\|rm <ids...>` | |
| `analytics [--range 7d\|30d\|90d \| --from --to] [-a] [--platform]` | KPIs vs the previous period, per platform/account, top posts |
| `analytics top [--sort views\|engagements\|engagementRate\|publishedAt\|clicks\|installs\|proceeds] [--limit]` | Best posts |
| `analytics refresh --post <id> \| --account <selector>` | Collect metrics now |
| `playbooks [query] [--platform] [--goal] [--format]`, `playbooks search <query>` | Find a recipe for the post (built-in and the workspace's own) |
| `playbooks show <id>[@version] [--prompt] [-a]` | The playbook, or `--prompt`: the ready-to-use agent prompt with your accounts' limits |
| `playbooks stats [--days] [--platform] [-a] [--sort lift\|installs\|proceeds\|installs-per-post\|proceeds-per-post]` | Rank playbooks (and A/B variants) by lift vs each account's usual, or by App Store installs / proceeds |
| `apps`, `apps add <appStoreId> [--name]`, `apps import`, `apps rm <app>` | App Store apps of the workspace (added by id, or imported from Revflare) |
| `apps bio-link -a <account> --app <app>` | Tracked bio link of an account for an app (Instagram/TikTok captions aren't clickable) |
| `links [-a] [--app] [--kind post\|bio] [--post]` | Tracked links with clicks, installs and proceeds |
| `skill install [--dir ~/.claude/skills]` | Install/update the bundled Claude Code skill (`<dir>/postflare/SKILL.md`) |

`postflare <command> --help` shows every option with examples.

### Creating posts

```bash
# Same text to X and Bluesky tomorrow at 9:00 (local time)
postflare post -a x -a bluesky --text "Shipping v2 today" --at "tomorrow 9:00"

# A Reel to Instagram + TikTok, uploading the file first
postflare post -a instagram_standalone -a tiktok -m reel.mp4 --text-file caption.txt --at "fri 18:00" \
  --set tiktok.privacy_level=PUBLIC_TO_EVERYONE --set tiktok.allowComment=true

# A thread, published now
postflare post -a x --text "1/ How we cut our build time" --thread "2/ ..." --thread "3/ ..." --now

# Validate only
postflare post -a youtube -m video.mp4 --set title="Launch" --draft --dry-run
```

- `--account/-a` (repeatable or comma separated): account id, `@username`, a platform id when you have one account
  there, an account name, `platform:@username`, or `group:<name>` (every enabled account of an account group). Ambiguous
  or unknown selectors list the candidates.
- Text: `--text`, `--text-file <path>`, `--text -` / `--text-file -` (stdin), or just pipe it.
- `--media/-m`: media ids (`med_...`) or local files (uploaded first; width/height/duration are read from the file).
- When: exactly one of `--at <when>`, `--now`, `--draft`. `--at` understands `"2026-10-14 09:00"`, `"tomorrow 9am"`,
  `"mon 18:00"`, `"next fri 10:00"`, `"18:00"`, `"in 2h"`, `"in 30m"`, ISO dates with an offset, ms timestamps. Times are
  local unless the ISO date has an offset.
- `--set key=value` fills a platform setting for every selected platform that has it; `--set tiktok.key=value` or
  `--set acc_xxx.key=value` targets one. Values are checked against the field type and options (`postflare platforms <id>`).
  Field defaults are filled in like in the web composer. Required settings that are missing are reported with the
  `--set` to add before anything is uploaded.
- `--thread "text"` (repeatable): follow-ups (thread replies, first comment) for platforms that support them.
- `--playbook <id>[@version]` records the playbook the post was written with (for `playbooks stats`), `--variant A`
  labels an A/B version. `posts edit --playbook ... | --no-playbook | --variant` changes it.
- `--app <app>` (app id, App Store id or name, see `postflare apps`) tags the post with an App Store app: posts on
  clickable platforms (X, Threads, Bluesky, LinkedIn, Facebook, Pinterest, Reddit, Mastodon, YouTube...) get a tracked
  link `https://<postflare>/a/<code>` with an App Store campaign token per post and platform. With auto-insert on
  (workspace setting, or `--autolink`) the app's App Store URLs in the text are replaced by it, or it is appended;
  `--no-autolink` creates the link but leaves the text alone. Instagram/TikTok captions aren't clickable: use
  `postflare apps bio-link -a <account> --app <app>` and put that URL in the bio. `posts edit --app ... | --no-app` changes it.

### App Store campaign links

```bash
postflare apps                                   # apps of the workspace (postflare apps add 1234567890 / apps import)
postflare post -a x -a threads --text "Tempo 2.0 is out: https://apps.apple.com/app/id1234567890" --app Tempo --at "fri 9:00"
postflare apps bio-link -a instagram_standalone --app Tempo
postflare links --app Tempo                      # clicks, installs, proceeds per link
postflare analytics top --sort installs --range 30d
postflare playbooks stats --sort proceeds-per-post
```

Clicks are counted by Postflare (bots filtered roughly). Installs (first-time App Store downloads), redownloads and
proceeds come from Apple App Analytics through Revflare: they lag 2-3 days, Apple withholds small numbers (fewer than 5
users) and proceeds are Apple's estimate. `posts show <id>`, `analytics`, `analytics top` and `playbooks stats` show them
when posts have tracked links.

### Scripting

```bash
id=$(postflare media upload clip.mp4 --json | jq -r '.[0].id')
postflare post -a tiktok -m "$id" --set privacy_level=SELF_ONLY --now --json | jq -r '.[].id'
postflare analytics --range 7d --json | jq '.summary.totals'
```

## Versions and compatibility

The CLI is versioned and released separately from the server (tags `cli-v*`, changes in [CHANGELOG.md](CHANGELOG.md)).
Servers report their REST API version at `GET /api/version`; when it is older or newer than this CLI supports, the CLI
prints one warning on stderr suggesting which side to update (`POSTFLARE_NO_VERSION_CHECK=1` turns the check off).
Servers without that endpoint are assumed compatible.

## Development

```bash
npm run cli:build       # embeds skills/postflare/SKILL.md (scripts/embed-skill.mjs), then tsc → cli/dist
npm run cli:typecheck   # src + tests
npx vitest run --project cli
```

Sources are in `cli/src` (TypeScript, ESM, only Node built-ins), tests in `cli/test` (part of the repo's vitest
projects).

## License

AGPL-3.0-only
