# Next Harness

A Next.js agent harness built from the supplied `next-deepseek-harness.zip` starter, with `deepseek-harness-master/` as the architectural reference.

## Session build plan

1. **Foundation:** preserve the root Next.js application and `src/app/api/health`, establish safe configuration and the project structure.
2. **Harness runtime:** implement sessions, durable event history, a bounded model/tool loop, provider adapters, and explicit approval of file writes.
3. **Workspace interface:** build a responsive agent workspace with streaming conversations, session navigation, tool inspection, and settings.
4. **Validation and delivery:** add automated tests, verify the production build and keyless demo, document setup and limitations, and package a clean ZIP.

Major milestones are committed to `main` during development, not only at delivery.

The upstream reference is inspected locally, not vendored wholesale. This is an independent Next.js implementation, not a claim of full compatibility with the upstream Cordis plugin system.

> Initial foundation commit. Usage instructions and verification results will be updated as implementation milestones land.
