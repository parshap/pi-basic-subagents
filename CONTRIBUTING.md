# Contributing

## Develop

```sh
npm install
npm run check   # Biome lint and format, then typecheck; npm run fix applies fixes
npm test
pi -e .         # try the working copy in pi
```

Behavior is specified in [docs/spec.md](docs/spec.md) and looks in [docs/ux.md](docs/ux.md); a change to either updates the doc in the same change.

## How it works

- Each subagent is a `Run` (`src/run.ts`) driving a `pi --mode rpc` child that lives only while the run is active. Every launch bumps a generation counter, so a replaced process's late events can't touch the current launch; that's what keeps a resume racing a stop, or a steer racing the end of a run, safe.
- The extension (`src/index.ts`) snapshots each report into an outbox when its run settles, since a resume would replace the result; a stopped run queues none, since whoever stopped it already knows. `subagent_run` and `subagent_continue` take their run's report from it, finding their launch's by its `done` promise; otherwise they're flushed with the wake once the parent is idle. A finished run stays in the widget until an `agent_settled` finds its report gone from the outbox, so the turn that read it has ended; changing how reports are delivered changes how long rows stay.
- Runs are recorded in the parent session as `basic-subagent` custom entries, a record at start then patches with status changes, and merged by id on `session_start` to restore them. A settle patch also records the report's file under a key that a later patch marks delivered, so a reopened session sends exactly the reports the parent missed. A report a tool call took is marked once the turn ends, when the call's result is in the session. Patches also carry the run's metrics for the UI.
- Renderers draw from tool `details` and arguments, never from the text the model reads, so that text stands on its own in modes that render nothing. The widget reads current runs; tool and report renderers draw only their saved results.
- Launch flags are computed per launch in `launchArgs()`; per-type tool limits would go there.

## Tests

- `test/run.test.ts` and `test/extension.test.ts` drive a scripted fake pi (`test/fake-pi.mjs`), which can stage races and misbehaving children that a real pi won't produce on demand.
- `test/pi.test.ts` runs the real pi from `devDependencies` with a scripted model (`test/faux-provider.ts`), so it fails when pi's RPC protocol or extension API drifts from what the fake assumes.

## Dependencies

- pi provides `@earendil-works/*` and `typebox` at runtime, so they're `peerDependencies` (`*`) and `devDependencies`, never `dependencies`: a bundled copy would bypass pi's module mapping.
- `devDependencies` use caret ranges; `package-lock.json` pins what CI installs. Dependabot opens weekly grouped updates, and patch and minor ones merge on their own once CI passes.
- CI runs only the latest Node, since pi users mostly run current Node on their own machines. `@types/node` stays on the major of pi's minimum Node (`engines`), so the typecheck catches newer APIs instead.

## Release

Run `npm version <patch|minor|major>` and `git push --follow-tags`. The tag's workflow checks that it matches `package.json`, publishes to npm with trusted publishing, and creates the GitHub release with notes that [git-cliff](https://git-cliff.org) builds from the commit subjects since the previous tag (`cliff.toml`), so commits follow the conventions in [AGENTS.md](AGENTS.md#commits). Preview the next release's notes with `npx git-cliff --unreleased --strip all`.
