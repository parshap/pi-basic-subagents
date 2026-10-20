## Documentation

- `README.md`: what it is, install, and configuration, for users
- `docs/spec.md`: what it does
- `docs/ux.md`: what it draws
- `CONTRIBUTING.md`: how it works, developing, testing, releasing, and dependency policy
- `docs/issues/`: open problems, one per file
- `docs/research/`: dated research memos, not updated after the fact

Docs describe what's true now: rewrite them in place rather than appending changes, and give each fact one home that others link to. Resolve an issue into the spec, then delete it.

## Workflow

1. A change to behavior or looks updates `docs/spec.md` or `docs/ux.md` first. Bug fixes and refactors can go code-first.
2. Implement, with tests.
3. Verify: `npm run check` (`npm run fix` applies fixes) and `npm test`.
4. Before calling it done, update the docs this changed: rewrite what's no longer true, file problems you didn't solve as issues, and keep research that isn't current truth in a dated memo.

## Commits

- One logical change per commit. Subject in the imperative, under 72 characters, saying what changed: "Cancel dialogs in subagents", not "dialog fixes".
- Subjects become the release notes. Prefix changes that don't affect the published package with `Docs:`, `Tests:`, `CI:`, or `Build:` (tooling and dependencies) so the notes leave them out.
- A body, when needed, says why.

## Releasing

1. `npm version <patch|minor|major>`; before 1.0, minor for breaking changes and patch otherwise.
2. Once approved, `git push --follow-tags`. The tag's workflow publishes to npm and creates the GitHub release.
