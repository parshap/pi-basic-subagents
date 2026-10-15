## Documentation

- `README.md`: what it is, install, and configuration, for users
- `docs/spec.md`: what it does
- `docs/ux.md`: what it draws
- `CONTRIBUTING.md`: how it works, developing, testing, releasing, and dependency policy

Docs describe what's true now: rewrite them in place rather than appending changes, and give each fact one home that others link to.

## Workflow

1. A change to behavior or looks updates `docs/spec.md` or `docs/ux.md` first. Bug fixes and refactors can go code-first.
2. Implement, with tests.
3. Verify: `npm run check` (`npm run fix` applies fixes) and `npm test`.
4. Before calling it done, update the docs this changed: rewrite what's no longer true.
