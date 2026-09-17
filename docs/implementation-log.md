# Implementation log

Major, verified milestones are published to `main` throughout the session, not saved for one final push.

## 1. Baseline and build boundary

- Compared all 61 application files against GitHub `main`; the supplied upload matches.
- Inspected the reference PTC interfaces, execution model and principal subsystems.
- Found that the root TypeScript and ESLint globs included the 11,000+ reference files. The original typecheck exhausted the Node heap.
- Excluded `deepseek-harness-master/` from TypeScript, lint, formatting and Git application changes. The folder is retained locally as read-only reference material.
- Published the feature coverage plan in `docs/feature-parity.md`.
- Verified `npm run typecheck`, `npm test` (39 passing tests), `npm run lint`, and `git diff --check` after the build-boundary fix.

## 2. Isolated PTC execution engine

- Added a fresh QuickJS-WASM child process for each erasable-TypeScript program, async host bindings, console capture and structured results.
- Bounded code, CPU, VM memory, wall time, output and pending/total host calls. No Node globals, arbitrary imports, direct filesystem or network APIs are exposed to model code.
- Abort/timeout terminates the child and aborts pending host bindings. Programs are never replayed; unawaited pending bindings are rejected.
- Verified a clean milestone snapshot with `npm run typecheck`, `npm test` (49 passing, including 10 real-worker PTC tests), and `npm run lint`.
- This engine milestone is intentionally separate from the next application wiring milestone; the chat/API integration is still in progress.

Verification results are added to each milestone after the corresponding commands run. Live services are never marked tested solely from mocked responses.
