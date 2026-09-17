# Next Harness

A Next.js agent workspace built from the supplied starter and continued using `deepseek-harness-master/` as an architectural reference. Includes **programmatic tool calling (PTC)**, an inspectable provider/tool loop, exact approvals, durable sessions and confined text workspaces. Independent implementation—not an official DeepSeek product or a drop-in Cordis port.

Major verified milestones are pushed to `main` during development. See [implementation log](docs/implementation-log.md) and [feature coverage](docs/feature-parity.md) for evidence and explicit gaps.

## Quick start

Node.js **22.19+** (Node 24 recommended) and npm are required.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:3000. The default **deterministic demo** needs no API key and makes no model calls. Workspace operations and approvals are real. To use DeepSeek, set `DEEPSEEK_API_KEY` on the server, restart, and select DeepSeek in **Agent settings**. Provider errors never silently fall back to the demo.

## What works

- Streamed model/tool loop; persisted messages, events, approvals, plans, todos and goals.
- `native`, `ptc` and `both` tool modes; generated SDK exposes only enabled bindings.
- **PTC console** executes TypeScript directly without calling a provider. Programs use top-level `await` and `return`, e.g.:

  ```ts
  const files = await tools.list_files({});
  console.log({ count: files.length });
  return files.map(file => file.path);
  ```

- Nested write/edit/MCP approvals continue the same live program—no replay. Denials are catchable using `error.code`; unhandled failures remain failures.
- File listing, reading, literal searching, writing and exact editing inside each session's workspace.
- Whole-turn extractive context compaction; original messages remain saved.
- Explicitly selected local skills and bounded read-only delegated tasks.
- Optional Streamable HTTP MCP tools, schema validation and mandatory per-call approval.
- File-backed persistence by default; optional PostgreSQL with Drizzle.

Guides: [PTC runtime](docs/ptc-runtime.md), [context and skills](docs/context-and-skills.md), [MCP setup](docs/mcp.md), [PostgreSQL tests](docs/postgres-testing.md).

## Storage and checks

State lives under `HARNESS_DATA_DIR` (default `.harness`). For PostgreSQL, set `DATABASE_URL` then run `npm run db:migrate`; workspace files still need persistent disk storage.

```sh
npm run typecheck
npm test
npm run lint
npm run build
npm start
```

The root layout remains Next.js-first: `src/app/`, `src/app/api/health/`, `src/db/`, `src/lib/`, `runtime/` and `tests/`. The large supplied reference folder is excluded from builds and application artifacts.

Key routes: `/api/health`, `/api/config`, `/api/sessions`, and per-session `/run`, `/ptc`, `/tools`, `/cancel`, `/approvals/:approvalId`, `/files`, `/export`.

## Runtime and safety limits

Use **one persistent Node process** for one trusted user. A live PTC approval keeps a child process in memory until the run deadline; restarting the server interrupts it without replaying completed actions. This is not a serverless or horizontally distributed run coordinator.

PTC runs in a fresh QuickJS-WASM child with strict JSON, CPU/memory/output/call/time limits, and no exposed Node, filesystem, network or arbitrary import APIs. It is **not an OS sandbox**, shell, or general-purpose Node interpreter. Tool-mediated effects retain server-side validation and exact approvals. Treat MCP servers and returned data as untrusted.

Set a strong `HARNESS_ACCESS_TOKEN` (24+ characters), `HARNESS_PUBLIC_URL` and HTTPS before remote use. Keep keys in server environment variables. Skills and MCP servers are operator-configured, not model-selected.

Shell/terminal/SSH, browser/computer control, LSP, schedules/webhooks/workflows, Python PTC and full reference plugin compatibility are **not implemented**. Live DeepSeek and third-party MCP credentials have not been tested in this build session.
