# Reference feature coverage

Next Harness is an independent Next.js implementation inspired by the supplied `deepseek-harness-master/`. It is not a Cordis plugin host, a binary-compatible port, or an official DeepSeek product. The supplied root Next.js project matches the repository baseline; the reference stays outside the application build.

## Session implementation plan

| Surface | Baseline | Planned acceptance evidence |
| --- | --- | --- |
| Sessions, persisted events, file/PostgreSQL storage | Implemented | CRUD, concurrent mutations, restart recovery, actual PostgreSQL integration |
| Streaming DeepSeek model/tool loop | Implemented | Split SSE/UTF-8, tool fragments, cancellation, protocol failures; live API only when a key is available |
| Confined workspace + exact write approvals | Implemented | Traversal/symlink rejection, deny, expiry, single use, recovery |
| PTC `native` / `ptc` / `both` modes | Missing | Provider-visible tool projection, reserved `run_code`, typed SDK |
| Isolated TypeScript PTC runtime | Missing | Real fresh worker; no process/filesystem/network globals; CPU, memory, code and output limits |
| PTC host bindings and nested approvals | Missing | Registry validation, bounded dispatch, exact nested write approval, abort/expiry; no code replay |
| PTC trajectory UI | Missing | Code, logs, value, nested calls and errors displayed from saved events |
| Context compaction | Missing | Whole-turn projection, persisted summary, originals retained, no broken tool-result pairs |
| Skills | Missing | Bounded operator-configured SKILL.md discovery, selected content logged before model use |
| Delegated tasks | Missing | Bounded, cancellable, read-only child agents; result/usage and trace recorded |
| Planning / todo / goal state | Plan only | Durable state changes visible to the user and model |
| MCP external tools | Missing | Opt-in server configuration, discovery and validated calls; untrusted writes require approval |
| Browser end-to-end / deployment | Not verified | Desktop/mobile, approval flow, PTC, production build and documented persistent runtime |

## Deliberate differences

The reference supports a large plugin ecosystem: native Node execution under OS confinement, shell/terminal, SSH, browser/computer control, LSP, workflow/webhook/schedule services, multiple SDKs and experimental Python. Those are not automatically enabled by copying the reference. They remain out of scope unless an implementation and verification are explicitly listed here.

PTC must not use `eval` or `node:vm` as a security boundary. It must not replay a partially executed program after an approval or restart. Intermediate values stay inside one live invocation; persisted events are an audit record, not executable checkpoints. A process restart fails interrupted work without re-executing side effects.

Reference sources: `packages/core/tools/README.md`, `packages/ptc-runtime/ptc-runtime/README.md`, `packages/ptc-runtime/ptc-runtime-node/README.md`, and `docs/subsystems/{compaction,subagent,mcp,skills,jobs,shell,workspace,todo,plan,goal}.md` in the supplied reference folder.
