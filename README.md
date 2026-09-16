# Next Harness

An independent Next.js agent harness built from the supplied `next-deepseek-harness.zip` starter, with `deepseek-harness-master/` as its architectural reference. This is not a Cordis-compatible port or an official DeepSeek product.

## Development milestones

- [x] Initialize GitHub and preserve the root Next.js / `src/app/api/health` / `src/db` layout.
- [x] Add durable sessions, a streamed model/tool loop, explicit write approvals, confined workspaces, and demo/DeepSeek provider adapters.
- [x] Validate the runtime with 39 unit/regression tests, TypeScript, ESLint, and a key-free production build.
- [ ] Connect the responsive workspace interface.
- [ ] Complete browser and PostgreSQL integration checks, deployment documentation, and ZIP delivery.

Each major milestone is pushed to `main` during the build.

## Run the current milestone

Requires Node.js 22.19 or newer.

```sh
npm ci
cp .env.example .env
npm run dev
```

The default is an **explicit, deterministic demo** with file-backed persistence. It does not call a language model. A selected DeepSeek provider requires `DEEPSEEK_API_KEY` and never falls back silently. PostgreSQL is optional: set `DATABASE_URL`, then run `npm run db:migrate`.

The runtime API includes `/api/sessions`, per-session `/run`, `/cancel`, `/approvals/:approvalId`, `/files`, `/export`, and `/api/health`. The interactive UI is the next milestone.

## Safety

Localhost and one Node process are the supported default. Set a strong `HARNESS_ACCESS_TOKEN` before remote exposure. No shell execution, network-fetch tools, dynamic plugins, or unrestricted host filesystem access are provided. Workspace confinement is not an operating-system sandbox. File writes pause for exact, one-time approval.
