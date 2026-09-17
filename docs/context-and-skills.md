# Context compaction and operator skills

## Context

`src/lib/context.ts` keeps the durable `Message[]` unchanged while offering a model-facing projection:

- `contextSize(messages)` uses the same deterministic JSON character estimate as the harness.
- `compactContext(messages, previous, options)` returns a checkpoint only when the effective (already-projected) suffix exceeds `maxCharacters` (180,000 by default). It compacts complete user turns, protects the latest two turns by default, and never places a boundary inside a user/assistant/tool protocol group. If the protected suffix itself exceeds the budget, no checkpoint is made; the caller is expected to return `CONTEXT_LIMIT`.
- `projectContext(messages, checkpoint)` validates that `throughMessageId` still exists and returns only the durable suffix after it. A stale checkpoint is a `CONTEXT_CHECKPOINT_STALE` error rather than an empty projection.

Checkpoint summaries are deterministic/extractive text, not LLM summaries. They are explicitly labeled historical and untrusted, include selected user and tool-result excerpts, and carry a prior checkpoint summary forward on repeated compaction. The default summary bound is 6,000 characters. The original messages and exact checkpoint event must be retained by the caller; the summary is not a replacement archive and does not interpret or verify tool output.

## Skills

`loadSkills(root)` reads only direct, real directories named by the safe skill-id pattern, each containing a non-symlink `SKILL.md`. The configured root itself must exist and be a real directory. Files use restricted `name`/`description` scalar frontmatter followed by an instruction body; unsupported YAML features are rejected rather than guessed. Each source is valid UTF-8 and at most 16 KiB, with at most 32 skills and 128 KiB total. A SHA-256 digest covers the exact source bytes, while `content` contains the body (frontmatter excluded).

`selectSkills(catalog, ids)` preserves requested order and rejects unknown or duplicate IDs. `skillPrompt` clearly delimits selected sources and frames them as operator-selected guidance below system safety rules. Skill text is untrusted operator input: it must not contain secrets, and the parent should log selected IDs, content, and digests for reproducible model input. There is no dynamic import, execution, recursive discovery, or automatic selection.
