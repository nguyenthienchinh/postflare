# Changelog

Changes to the `postflare` CLI ([npm](https://www.npmjs.com/package/postflare)). It is released separately from the
server, with tags `cli-v<version>`; the server's changes are in the [root changelog](../CHANGELOG.md). From 0.1.0 on this
file is maintained by release-please from Conventional Commits touching `cli/`.

## Unreleased

### Features

* `postflare playbooks [query]`, `playbooks search`, `playbooks show <id> [--prompt]` and `playbooks stats`;
  `post --playbook <id>@<version> --variant A`, `posts edit --playbook/--no-playbook/--variant`, `posts --playbook`.
  The bundled skill tells agents to look up a playbook before writing and to attribute posts.

## [0.3.0](https://github.com/FerdiKT/postflare/compare/cli-v0.2.0...cli-v0.3.0) (2026-10-17)


### Features

* **youtube:** captions, language fields, playlist creation, localizations, watch time and retention analytics ([5f5c791](https://github.com/FerdiKT/postflare/commit/5f5c791186d652aa11daacdebd5cdb61eb82d6d8))

## [0.2.0](https://github.com/FerdiKT/postflare/compare/cli-v0.1.0...cli-v0.2.0) (2026-10-16)


### Features

* answer a reply under a published post (replyTo / pf posts comment --reply-to) ([51a8882](https://github.com/FerdiKT/postflare/commit/51a8882e3054c16822c09eb7ae891e22fdcd9823))
* **cli:** postflare version command and server compatibility warning ([e10340b](https://github.com/FerdiKT/postflare/commit/e10340ba4ca196440412521b94cbb551fce777ef))
* **cli:** skill install command and platform status in platforms output ([fb8f380](https://github.com/FerdiKT/postflare/commit/fb8f380a422cd76af6e60b1c0186688a52439ac3))
* comment under a published post (POST /api/posts/:id/comments, pf posts comment) ([03290a8](https://github.com/FerdiKT/postflare/commit/03290a83c3abad81b19d92585637dc2f8d300685))
* playbooks — recipe library for agent-written posts, with attribution and ranking ([f2cef8e](https://github.com/FerdiKT/postflare/commit/f2cef8e1434c3e688f4ab8f8c205ac76e2e70298))
* version info, daily update check and release automation ([fdf0f1d](https://github.com/FerdiKT/postflare/commit/fdf0f1dd5dccc6b02d646da7aacbcd5988da888a))


### Bug Fixes

* no double posts (commit semantics + needs_check), token refresh storm, D1 per-invocation budget, media lifecycle ([87d7892](https://github.com/FerdiKT/postflare/commit/87d7892e7a9a8f11d09fa4af27262aef0cd0c266))

## 0.1.0 (2026-10-13)

First release.

### Features

* `login` / `logout` / `whoami` / `workspaces` with named profiles (`~/.config/postflare/config.json`, mode 0600) or
  `POSTFLARE_URL` + `POSTFLARE_API_KEY`.
* `accounts`, `accounts options`, `platforms`: connected accounts, platform limits and per-post settings.
* `media upload` (streamed, multipart above 90MB up to 5GB, progress bar), `media list|import|rm`, `upload-link`.
* `post`: natural dates (`--at "tomorrow 9:00"`), several accounts, local files uploaded on the fly, per-platform
  settings (`--set tiktok.privacy_level=...`), threads, drafts, dry runs; `posts show|edit|cancel|retry|rm`.
* `analytics`, `analytics top`, `analytics refresh`.
* `--json` on every command, stable exit codes (0 ok, 1 error, 2 usage). Node.js 20+, no dependencies.
