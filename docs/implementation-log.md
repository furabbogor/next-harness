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

## 3. End-to-end PTC and reference-inspired capabilities

- Connected native/PTC/both tool modes, generated SDKs, direct `/ptc` execution, nested live approvals and saved parent/child execution traces.
- Verified two successive approvals without code replay, one-time decisions, caught and uncaught denial, cancellation, expiry, restart interruption and shared budgets. Fixed structured binding error codes at the QuickJS boundary.
- Added literal search, exact edit, todo, goal and bounded read-only delegation tools; selected operator-managed skills; whole-turn extractive context checkpoints; and opt-in MCP discovery/execution with mandatory approvals.
- Wired session settings, the PTC console and generic approval/event rendering. Browser behavior is verified in the next milestone, not inferred from compilation.
- Preserved the external worker through the Next.js 16 production build; fixed Turbopack's `fork` entry rewriting by launching a real Node child with IPC. Runtime files and QuickJS dependencies are explicitly traced; application data/reference files are excluded.
- Verified `npm run build`, `npm run typecheck`, `npm run lint`, `git diff --check`, and **86 passing tests** (the three opt-in PostgreSQL tests are skipped without a database URL). Real local PostgreSQL tests separately passed migration/idempotence, CRUD, rollback, concurrency and version-2 persistence.
- No live DeepSeek API or third-party MCP account was used. Full reference parity and OS-level sandboxing are not claimed.

Verification results are added to each milestone after the corresponding commands run. Live services are never marked tested solely from mocked responses.
