<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:shadcn-agent-rules -->
# This is NOT the Shadcn/ui you know

This version has breaking changes — so whenever you are working on frontend always read the `@SHADCN.md` and also always use the shadcn/ui skills to follow the best practices.
<!-- END:shadcn-agent-rules -->

<!-- BEGIN:project-rules -->
# Project conventions

## What this repo is

A computer-use automation system: an LLM discovers how to drive a legacy back-office
UI once, that run is compiled into a typed **capability artifact**, and the artifact is
replayed deterministically with no model in the decision loop. `docs/PLAN.md` holds the
locked design decisions and the phase table — read it before starting work.

## Workspace map

| Path | Role |
|---|---|
| `apps/target-corebank` | Stand-in legacy bank app we automate against. Deliberately hostile: framesets, table layouts, no test IDs, injectable runtime faults, two tenant variants. |
| `apps/orchestrator` | HTTP API (Effect `HttpApi`), the `cua` CLI, and the live-takeover WebSocket gateway. |
| `apps/web` | Operator console (Next.js). |
| `packages/contracts` | The spine. Capability artifact schema, action/observation model, replay result union, and the API contract. One declaration per shape. |
| `packages/surface` | The `Surface` abstraction — perceive and act on a computer-use surface. Playwright lives *only* here. |
| `packages/policy` | Allowlist, risk classification, redaction. |
| `packages/engine` | Discovery loop, replay executor, sessions, control lease, escalation. |
| `packages/store` | Prisma schema, client, repositories, and the test harness. |
| `packages/ui` | shadcn components. |

## TypeScript

- Every package is **source-only** — no build step. `exports` points at `src`, and
  consumers (tsx, Next.js) resolve TypeScript directly.
- Module resolution is **NodeNext**, so **relative imports need an explicit `.js`
  extension**: `import { x } from "./thing.js"`. Extensionless relative imports are a
  compile error. Package imports (`@workspace/contracts`) need no extension.
- `tsc --noEmit` is a required check. Run `pnpm typecheck`.

## Frontend structure (`apps/web/src`)

Feature-first, never layer-first:

- `features/<feature>/` owns its own `components/`, `hooks/`, and `lib/`.
- A feature may nest sub-features (`features/runs/evidence/`) with the same shape.
- Shared UI goes in `components/common/<kind>/` — `cards/`, `buttons/`, `status/`,
  `layout/`.
- `app/` holds routes only, and stays thin.

## Testing

Two suites, split by what they need (see `vitest.config.ts`):

- **unit** — pure logic, colocated as `src/**/*.test.ts`, run in parallel.
- **integration** — anything touching Postgres or a real browser, in `test/**/*.test.ts`,
  run serially in a single fork against the `cua_test` database.

Follow `.claude/skills/database-backed-test-ecosystem.md`: create real rows, call the
real entry point, assert on the result, then verify by reading the database back.
Follow `.claude/skills/end-to-end-type-safety.md` for the contract, client, and error
model.

## Rules

- **Use official CLIs; never hand-bootstrap.** `pnpm create hono`, `pnpm dlx shadcn add`,
  `prisma init`, `playwright install`. Add dependencies with `pnpm --filter <pkg> add`
  (plus `--workspace` for internal packages), never by editing `package.json` versions.
- **Install a tool's agent skills when it ships them** (Prisma and shadcn both do).
- Never commit secrets. `.env` is ignored; `.env.example` and `.env.test` are committed.
- Artifacts and evidence must never contain raw PII, credentials, or model transcripts —
  only `{$param}` / `{$secret}` references and digests.
<!-- END:project-rules -->
