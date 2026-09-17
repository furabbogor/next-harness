# Reference feature coverage

Next Harness is an independent Next.js implementation inspired by the supplied `deepseek-harness-master/`. It is not a Cordis plugin host, a binary-compatible port, or an official DeepSeek product. The supplied root application matched the repository baseline; the reference stays outside the build and distribution.

## Implemented and verified

| Surface | Implementation | Acceptance evidence |
| --- | --- | --- |
| Sessions and durable events | File and PostgreSQL stores, version-1 compatibility, version-2 planning/context state | CRUD, rollback, concurrency, restart interruption; real PostgreSQL migration/round-trip suite |
| Provider/model loop | Streaming DeepSeek adapter and explicit deterministic demo | SSE/UTF-8 fragmentation, tool arguments, errors, cancellation; no live DeepSeek account tested |
| Workspaces and approvals | Confined text files; literal search and exact edits; one-time write approvals | Traversal/symlink rejection; approve, deny, expiry, duplicate response and restart tests |
| PTC modes | `native`, `ptc`, `both`; reserved `run_code`; visible-only generated TypeScript SDK | Direct and provider-initiated integration tests; disabled/recursive binding rejection |
| Isolated PTC execution | Fresh QuickJS-WASM Node child, strict JSON, no host globals/imports/network APIs | Real worker tests for loops, concurrent bindings, code/CPU/memory/output/call limits and cancellation |
| Nested PTC approval | Same live invocation waits for exact approval; ordered host dispatch | Two successive approvals without replay; caught/uncaught denial; cancellation, expiry, restart and shared budget tests |
| PTC interface | Console, tool modes, approval cards and saved execution events | TypeScript/lint/production build passed; browser verification is a separate milestone |
| Context compaction | Bounded extractive checkpoints at whole-turn boundaries; originals retained | Tool/result pairing, stale checkpoints, repeated compaction and fresh-service reuse |
| Skills | Operator-managed `SKILL.md` discovery and explicit session selection | Path/symlink/size checks, prompt injection boundary, content/digest audit trail |
| Delegated tasks | Bounded read-only child agents, shared usage/call/time budgets | Tool restrictions, child traces, result round-trip and public reasoning redaction |
| Planning / todos / goals | Durable state tools and model-visible planning state | Updates through actual harness/PTC; file search/edit regression coverage |
| MCP | Opt-in Streamable HTTP gateway; schema-validated discovered tools; every call requires approval | Real local MCP transport fixture plus harness approval integration; third-party deployments not tested |

## Not implemented / not claimed

- Shell, terminal, SSH, unrestricted Node/Python execution and OS-level sandboxing.
- Browser/computer control, LSP, workflow/webhook/schedule services.
- Cordis plugin/API compatibility or full parity with every reference subsystem.
- Distributed live-run coordination, serverless execution or safe multi-tenant hosting.

PTC is not shell access. QuickJS isolates guest JavaScript from exposed host APIs but is **not an operating-system sandbox**. No partially executed program is replayed after approval or restart. A process restart fails interrupted work; durable traces are audit records, not executable checkpoints. Every external MCP call crosses a trust boundary and must be approved.

Reference sources: `packages/core/tools/README.md`, the `packages/ptc-runtime/` READMEs, and `docs/subsystems/{compaction,subagent,mcp,skills,jobs,shell,workspace,todo,plan,goal}.md` in the supplied reference folder.
