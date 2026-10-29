## What and why

<!-- What does this change and why? Link related issues: "Fixes #123". -->

## How it was tested

<!-- Tests added, manual checks (which platform, real or mocked API...). -->

## Checklist

- [ ] `npm run typecheck`, `npm test`, `npm run cli:build` and `npx vite build` pass
- [ ] PR title follows Conventional Commits (`feat: ...`, `fix(scope): ...`, `feat!: ...` for breaking changes; see CONTRIBUTING.md)
- [ ] Tests for new behavior (provider tests mock the API; API changes have a `test/workers/` test)
- [ ] Queries scoped by `workspace_id` and routes guarded by permissions
- [ ] Providers stay within the Free plan budget and are safe to retry (see docs/provider-brief.md)
- [ ] `cli/src/types.ts` in sync with `shared/types.ts`
- [ ] Docs / README updated for user-visible changes
- [ ] No secrets, tokens or personal config in the diff
