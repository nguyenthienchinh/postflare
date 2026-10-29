# Releasing Postflare

For the maintainer. Two things are released from this repository, separately:

| What | Version in | Tag | Changelog | Published to |
|---|---|---|---|---|
| Server + web app | `package.json` | `v<x.y.z>` | `CHANGELOG.md` | GitHub release (self-hosters deploy it) |
| CLI | `cli/package.json` | `cli-v<x.y.z>` | `cli/CHANGELOG.md` | GitHub release + npm (`postflare`) |

Both use [semver](https://semver.org). Before 1.0, `feat` bumps the minor version, `fix` the patch, and breaking changes
(`!`) the minor version (`bump-minor-pre-major`). The REST API has its own integer `API_VERSION`
(`shared/version.ts`): bump it only on breaking API changes, together with `MIN_API_VERSION`/`MAX_API_VERSION` in
`cli/src/compat.ts`, so old CLIs warn their users.

## How releases work (release-please)

[`release.yml`](../.github/workflows/release.yml) runs
[release-please](https://github.com/googleapis/release-please) on every push to `main`
(config: [`release-please-config.json`](../release-please-config.json), current versions:
[`.release-please-manifest.json`](../.release-please-manifest.json)).

1. Merge PRs with [Conventional Commit](../CONTRIBUTING.md#commit-messages) titles (squash merge: the PR title becomes
   the commit).
2. release-please keeps **one release PR per component** open: "chore(main): release postflare x.y.z" for the server and
   "chore(main): release cli x.y.z" for the CLI. Each bumps the version in its `package.json` and updates its
   changelog. Commits that only touch `cli/` go to the CLI only (`exclude-paths`); commits touching both go to both.
   `chore`, `ci`, `test`, `refactor` and `build` commits do not trigger a release by themselves.
3. Edit the release PR if you like (changelog wording), then merge it. release-please tags the merge commit, creates the
   GitHub release with the changelog section as notes, and:
   - **server** (`v*`): instances see the new version in Admin → Instance settings within a day; copies made with the
     Deploy button get an update PR from `postflare-update.yml` within a week.
   - **CLI** (`cli-v*`): the `publish-cli` job typechecks, tests, builds and publishes `cli/` to npm with provenance.
     GitHub marks every new release "Latest", so the workflow then moves "Latest" back to the newest server release.
     (Instances' update check lists releases and picks the highest `v*` tag itself, so it never sees CLI releases.)

Breaking change in the server? Say so in the commit (`feat!:` or a `BREAKING CHANGE:` footer) and describe the upgrade
steps in the release PR's changelog (they become the release notes self-hosters read). If `wrangler.jsonc` changes
(new binding, cron...), call it out: Deploy-button copies keep their own `wrangler.jsonc` and must apply it by hand
(their update PR shows the diff).

Optional: add a `RELEASE_PLEASE_TOKEN` secret (fine-grained PAT or GitHub App token with contents + pull requests write)
so CI runs on release PRs; PRs opened with the default `GITHUB_TOKEN` trigger no workflows.

## One-time setup

1. **Actions may open PRs**: Settings → Actions → General → Workflow permissions → enable *Allow GitHub Actions to create
   and approve pull requests* (release-please needs it).
2. **npm Trusted Publishing** (no `NPM_TOKEN` secret): on npmjs.com open the `postflare` package → **Settings** →
   **Trusted publisher** → **GitHub Actions**, and enter:
   - Organization or user: `FerdiKT`
   - Repository: `postflare`
   - Workflow filename: `release.yml`
   - Environment: leave empty

   Then (recommended) under **Publishing access** choose *Require two-factor authentication and disallow tokens*, and
   revoke old automation tokens. Publishing needs npm 11.5.1+ (the job installs the latest npm) and
   `id-token: write` (set on the job). Provenance requires the repository to be **public**: run the first automated
   CLI release after making it public.
3. Make sure the repository is public before relying on the update check: private repositories answer 404 and
   instances then report no updates (silently).

## Launch day checklist

Until launch the repository is private and the landing page (`public/landing/index.html`) is in **teaser mode**: every
GitHub / Deploy to Cloudflare button is a non-clickable "Coming soon" pill and the hero and open-source section ask
visitors to follow on X. The real URLs stay in the markup (`data-launch-href` on each pill).

- **X profile URL** (the "Follow for launch updates" buttons and the footer "Follow on X" link): edit the `href` of
  `<a id="follow-x">` in the hero; every other `[data-follow]` link copies it at load time.
- **Launch flag**: `<html lang="en" data-launched="false">` at the top of `public/landing/index.html`.

On launch day, in this order:

1. [ ] Make the repository public (Settings → General → Danger zone → Change visibility). Check that
       `https://github.com/FerdiKT/postflare` and the Deploy button URL
       (`https://deploy.workers.cloudflare.com/?url=https://github.com/FerdiKT/postflare`) work while logged out.
2. [ ] Flip the flag: `data-launched="true"` in `public/landing/index.html`. With it, the page script turns each
       "Coming soon" pill into its real link and hides the pre-launch elements (`[data-prelaunch]`: the follow
       buttons in the hero and open-source section, the "coming soon" note). The footer "Follow on X" link stays.
       Preview: `npx vite preview` (or open the file) and check the hero, open-source section and footer.
3. [ ] Deploy (see [Deploying your own instance](#deploying-your-own-instance-after-a-release)) and check
       https://postflare.ferdi.app/ (desktop and mobile).
4. [ ] Cut the releases: follow [First public release](#first-public-release-by-hand) (tags `cli-v0.1.0`, `v0.1.0`),
       then merge the open release-please PRs so the newer CLI (with `pf skill install`) reaches npm.
5. [ ] Enable branch protection on `main` (Settings → Branches / Rulesets: require pull requests and the CI checks,
       block force pushes and deletions).
6. [ ] Enable **private vulnerability reporting** (Settings → Code security → Private vulnerability reporting), which
       [SECURITY.md](../SECURITY.md) points to, plus Dependabot alerts.
7. [ ] Finish the [one-time setup](#one-time-setup) that needs a public repo (npm trusted publishing with provenance,
       Actions permission to open PRs).
8. [ ] Announce: tweet the repository and the live demo, and invite beta platform reports ("Tried a beta platform?
       Open an issue with the result").


release-please starts from the manifest (`0.1.0` for both) and looks for the tags `v0.1.0` and `cli-v0.1.0`; create
them once, by hand, with GitHub releases:

```bash
# 1. Commit and push the release tooling, then make the repository public.
git switch main && git pull

# 2. CLI 0.1.0 is already on npm: tag the commit it was published from (the "Initial release" commit), so the newer
#    CLI changes (postflare version, compatibility warning) go into the next CLI release. Check with:
#    npm view postflare@0.1.0 gitHead   (if empty, use the commit you published from)
gh release create cli-v0.1.0 --target d96eadf --title "postflare CLI 0.1.0" --latest=false \
  --notes "First release of the postflare CLI: https://www.npmjs.com/package/postflare/v/0.1.0. Changes: https://github.com/FerdiKT/postflare/blob/main/cli/CHANGELOG.md"

# 3. Server v0.1.0 at the current main (package.json says 0.1.0), marked Latest.
git tag v0.1.0 && git push origin v0.1.0
gh release create v0.1.0 --title "Postflare v0.1.0" -F docs/releases/v0.1.0.md --latest
```

`gh release create --target <sha>` creates the tag on GitHub if it does not exist. Afterwards every release goes
through release-please PRs. If release-please ever proposes a wrong version, force one with a `Release-As: x.y.z`
footer in a commit message on `main`.

## Deploying your own instance after a release

Your instance (postflare.ferdi.app) deploys from your clone with the git-ignored `wrangler.local.jsonc`:

```bash
git switch main && git pull --tags      # or: git checkout v0.2.0
npx wrangler d1 time-travel info DB -c wrangler.local.jsonc   # note the bookmark (restore point), just in case
npm ci
npm run deploy                          # builds with wrangler.local.jsonc and deploys; migrations run on first request
curl -s https://postflare.ferdi.app/api/version
```

Restore if something goes wrong: `npx wrangler d1 time-travel restore DB --bookmark <bookmark> -c wrangler.local.jsonc`,
then redeploy the previous tag.

## Checklist for a release PR

- [ ] CI green on `main`.
- [ ] Changelog wording is user-facing; breaking changes and manual steps (new secrets/vars, `wrangler.jsonc` changes)
      are spelled out.
- [ ] `API_VERSION` bumped (and the CLI's range) if the REST API broke compatibility.
- [ ] After merging: release created, npm package published (CLI), `postflare.ferdi.app` deployed.
