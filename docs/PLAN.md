# Computer-Use Automation System — Build Plan

Internal working plan for the interface.ai take-home. Not a deliverable; the graded
write-up is `/REPORT.md`.

## 0. The through-line

> The model discovers once. The discovery is compiled into a typed artifact.
> Production replays that artifact with no model in the decision loop.

JIT-compilation for UI automation: the LLM is the compiler (slow, smart, runs once),
the artifact is the bytecode (typed, versioned, reviewable in a PR), the replay engine
is the VM (fast, deterministic, cheap). A capability is a callable function the
customer-facing agent invokes by name with typed args.

## 1. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Target app | Build `apps/target-corebank` — hostile legacy surface | Lets us inject the runtime faults that §3.3 is graded on, and fake two tenants for §3.7 |
| Perception | Accessibility tree first, screenshot fallback | Only representation that exists on web, legacy web, and desktop (UIA / AX / AT-SPI) |
| Browser control | Playwright + Chromium (CDP access) | AX tree, frames, screencast, tracing in one tool |
| LLM | **Gemini** via `@google/genai` | User directive. `gemini-3.1-pro-preview` default, `gemini-3.7-flash` cheap/stable alternative; model ID is config-driven |
| Backend | Node 24 + Effect + `@effect/platform` HttpApi | Typed error channel maps 1:1 onto the required business-outcome / failure split |
| Persistence | Postgres + Prisma (Docker) for operational data; artifacts as git-committed JSON | Artifacts are code-like assets reviewed in a PR; runs are operational data |
| Takeover | CDP `Page.startScreencast` + `Input.dispatch*` forwarding | Human drives the same live page — makes §3.6 unambiguously real |
| Frontend | Next.js 16 + React 19 + shadcn (`apps/web`) | Already scaffolded |
| Stretch goals | Agent-facing capability catalog; cross-tenant overlay reuse | Both near-free given the above |

### Why not Gemini's computer-use model

`gemini-2.5-computer-use-preview-10-2025` (and the native computer-use tool in the 3.5
Flash line) emits coordinate actions from screenshots. Excellent for discovery, wrong
for this system: coordinate actions are not deterministically replayable and carry no
symbolic handle to re-resolve. We use a general model over an AX-tree tool surface so
the recorded target is symbolic (role + name + anchors). This argument goes in REPORT.md §1.

## 2. Repo layout

```
apps/
  target-corebank/   # legacy proxy target: framesets, table layouts, no test IDs,
                     # session expiry, ?fault= injection, 2 tenant variants
  orchestrator/      # Effect HttpApi + `cua` CLI + WS gateway for live takeover
  web/               # operator console (Next.js)
packages/
  contracts/         # THE spine: Effect Schemas for CapabilityArtifact, Action,
                     # TargetDescriptor, Observation, ReplayResult, errors + HttpApi value
  surface/           # Surface interface + PlaywrightWebSurface (AX perception,
                     # ranked resolver, screencast). The desktop seam lives here.
  engine/            # DiscoveryLoop, ReplayExecutor, SessionManager + ControlLease, Escalation
  policy/            # allowlist, risk classification, Redactor
  ui/                # shadcn components (existing)
```

Frontend convention (per user directive):

```
apps/web/src/
  app/                                     # Next.js routes only — thin
  features/
    capabilities/{components,hooks,lib}/
    runs/{components,hooks,lib}/
      evidence/{components,hooks,lib}/     # sub-feature
    interventions/{components,hooks,lib}/
      live-control/{components,hooks,lib}/ # sub-feature: screencast + input forwarding
    policy/{components,hooks,lib}/
    playground/{components,hooks,lib}/
  components/common/{cards,buttons,status,layout}/
  hooks/  lib/
```

## 3. Artifact schema (centerpiece)

Top level: `schemaVersion`, `id`, `name` (agent-callable), `version` (semver),
`status` (draft → candidate → approved → deprecated), `description`, `target`, `inputs`,
`outputs`, `outcomes`, `steps`, `recoveries`, `successCondition`, `policy`,
`provenance`, `health`.

Non-negotiable properties:

- **`outcomes` are first-class.** Declared business outcomes with detectors, returned
  as typed results. "No such member" is never an error.
- **Targeting is a ranked strategy list, not a selector.**
  `primary` (role + name) → `anchors` (relational: "cell to the right of the cell
  reading Member #") → `fallbacks` (css, xpath, coordinates). Plus `frame.path` for
  framesets. Resolution requires a *unique* match and **records which rank won**.
- **`health.fallbackHitRate` is the drift alarm.** Rising fallback usage per step per
  tenant is a drift signal, and the basis for proposing a tenant overlay. ~20 lines.
- **Values are `{$param}` / `{$secret}` refs, never literals.** A recorded member number
  would be both a reuse bug and a compliance violation.
- **Every step carries `intent` in English** — what makes the artifact human-reviewable.
- **Every step carries `riskClass`** (safe | risky | irreversible) so policy acts per action.
- **`target.tenant: null` on the base artifact**; `TenantOverlay` documents override
  entry point, per-step targets, label vocabulary, and extra recoveries via a
  deterministic merge. One base + N thin overlays, never N recordings.
- **`provenance.transcriptDigest`, not the raw transcript** — transcripts contain PII.

## 4. Replay result contract and error taxonomy

```
ReplayResult =
  | Succeeded        { outputs, stepsRun, durationMs }
  | BusinessOutcome  { outcome, data, atStep }
  | Escalated        { interventionId, reason, resumedBy, finalState }
  | Failed           { error: ReplayError, atStep, expected, observed, evidenceRef }

ReplayError =
  InputValidationFailed | TargetNotFound (with strategies tried) | AmbiguousTarget
  | CheckpointFailed | StepTimeout | PolicyDenied | SessionExpiredUnrecoverable
  | SurfaceCrashed | UnexpectedDialog
```

Between them sits the **recovery layer** — invisible to the caller, fully logged as
`RecoveryApplied` events: bounded retry on transient load, declared interstitial
dismissal, single re-auth on session expiry, one re-resolve on stale element.

**Detection order after every step** (the piece most submissions miss):

1. declared outcome detector fires → return `BusinessOutcome` (stop)
2. recovery condition fires → apply recovery, retry step (bounded)
3. step checkpoint passes → continue
4. global surface signal fires → classify (timeout / 500 / dialog)
5. otherwise → `CheckpointFailed`

Determinism: no model, fixed step order, unique-match requirement, explicit checkpoint
after *every* step, condition-based waits — never sleeps.

## 5. Control-transfer model

```
AutomationDriving --requestIntervention()--> PauseRequested
       ^                                          |  (current action completes atomically)
       |                                          v
       |                              AwaitingOperator --claim--> OperatorDriving
       |                                          |                     |
       +---- ResumeAccepted <-- HandbackRequested <---- operator done ---+
```

- One `Session` = one browser context, long-lived. The **control lease**
  (`automation | operator | none`) lives on it.
- `Surface.act(actor, action)` **rejects any action whose actor does not hold the lease.**
  Control transfer is enforced at runtime, not by convention.
- Operator drives via CDP screencast + input forwarding over WS — same page, same
  cookies, same session.
- Operator actions are captured into an `OperatorActionLog` → evidence, and *promotable*
  into artifact steps as a new draft version (explicit, reviewed — never automatic).
- Intervention request carries: capability + goal, step id + intent, why it stopped,
  redacted screenshot, recent action log.

**Stuck triggers:** max steps / wall-clock, no state change across N actions (loop
detection), `TargetNotFound` after all strategies, policy `RequireApproval` on a risky
step, undeclared dialog, unrecoverable session expiry.

## 6. Safety model

- **One chokepoint.** `PolicyEngine.decide(context, action) → Allow | Deny(rule) |
  RequireApproval(rule)` sits between *every* actor (LLM and replay engine alike) and
  `Surface.act`. Shared by discovery and replay.
- **Allowlist:** permitted origins + path patterns + action types + deny patterns on
  risky control labels (`/close|delete|wire|transfer|disburse/i`).
- **Risk ladder:** discovery is capped at `safe` — the model may *reach* a confirmation
  screen but is blocked from pressing the irreversible button and must escalate.
  Replay executes `risky` only when the artifact is `approved`; `irreversible` always
  requires human confirmation through the intervention channel.
- **Redaction at the evidence boundary** (structural, not disciplinary): everything
  written to disk passes through a `Redactor`. Pattern-based (SSN, Luhn-valid PANs,
  emails, account numbers) *plus* schema-driven — fields marked
  `sensitivity: pii|financial|secret` masked by value everywhere. Screenshot regions
  masked **before** the PNG is written.
- **Stated limits** (REPORT.md §6): regex redaction has false negatives; the model sees
  unredacted page content in flight; page content is an untrusted prompt-injection
  vector, mitigated only by the policy chokepoint on actions.

## 7. Testing

Per `.claude/skills/database-backed-test-ecosystem.md`:

- Real Postgres in Docker, `.env.test`, truncation isolation driven by declared
  dependencies, factories for tenants / artifacts / runs / interventions.
- API tests run through the **real derived client over an in-process transport** into
  the real handlers into the real DB, then **verify by reading the DB back**.
- Replay-engine suite applies the same philosophy to the browser: spin up the real
  target app, replay real artifacts, **one test per branch of the error taxonomy** with
  the matching fault injected. This suite *is* the evidence that §3.3 works.
- Pure units where genuinely pure: ranked resolver, redactor, overlay merge, condition
  evaluator.

Per `.claude/skills/end-to-end-type-safety.md`: one API value → derived client,
Effect Schema codecs, tagged errors, serializer seam between every row and every
response, `Effect.either` at the hook boundary, `Match.exhaustive` in the console so
adding an outcome to a capability breaks the build until the UI handles it.
`tsc --noEmit` is a required check.

## 8. Phases

| Phase | Scope | Gate |
|---|---|---|
| 0 ✅ | Deps via official CLIs; `apps/web` → `src/features/…`; Vitest; docker-compose Postgres | `pnpm typecheck` + `pnpm lint` clean |
| 1 | `apps/target-corebank`: search → detail → sub-account form → confirmation; framesets, tables, no test IDs; session cookie; 2 tenant variants; `?fault=` injection | Every fault path walkable by hand |
| 2 | `packages/contracts` (schema + unions) and `packages/surface` (AX observation, ranked resolver, screencast) | Resolver unit tests pass on hostile markup; `Surface` signature has zero Playwright types |
| 3 | Discovery loop (Gemini tool use), policy chokepoint, evidence writer, artifact compiler (parameterization + checkpoint inference) | **One real LLM run** completes the goal and emits an artifact into `/evidence/` |
| 4 | Replay engine: executor, detection ordering, recovery layer, result contract, output extraction | Happy path + all seven fault paths hit the correct branch of the result union |
| 5 | Session manager, control lease, intervention API, WS screencast + input forwarding, operator capture, handback | Live run pauses → human drives → hands back → run completes |
| 6 | Operator console: catalog, run/evidence viewer, intervention inbox, take-control, playground | — |
| 7 | Tenant overlay merge, drift telemetry, capability catalog as Gemini function declarations + demo invocation | One artifact replays on both tenant variants |
| 8 | `/README.md`, `/REPORT.md` (their exact seven headings), `/evidence/` with discovery run + happy replay + **failing replay** | Tests green, `tsc --noEmit` clean |

## 9. Fault matrix (target app → requirement)

| Injected fault | Exercises |
|---|---|
| `memberId=99999` → "No member found" | business outcome, not error |
| restricted account → permission denial | business outcome |
| "Session expired" banner | recoverable → re-auth → retry |
| 3s stall on search endpoint | recoverable → bounded wait / retry |
| "Scheduled maintenance" interstitial | recoverable → declared dismissal |
| bad field value → validation error | business outcome |
| hard 500 | hard failure with debuggable detail |
| "Close Account" button present | irreversible action → policy blocks, escalates |

## 10. Status log

**Phase 0 — complete.** Workspace wired: `contracts`, `surface`, `policy`, `engine`,
`store` packages plus `orchestrator` and `target-corebank` apps. `apps/web` restructured
to the `src/features/…` layout. Playwright Chromium installed, Prisma 7.9.1 initialised
(its agent skills relocated to the repo root), Vitest 4 configured with the unit /
integration split, docker-compose written. `pnpm typecheck`, `pnpm lint`, and `pnpm test`
all clean.

Verified explicitly rather than assumed: NodeNext requires `.js` extensions on relative
imports, and cross-package imports resolve from TypeScript source at both compile time
and runtime with no build step (`orchestrator → policy → contracts`).

*Open:* Docker Desktop was not running, so `pnpm db:up` has not been exercised. Nothing
depends on it until the Prisma schema lands in Phase 2.

## 11. Prerequisites

- `GEMINI_API_KEY` (AI Studio) — **required** for the Phase 3 discovery run, which is
  the one non-negotiable in the brief.
- Docker (present: 29.4.1) for Postgres.
- `pnpm exec playwright install chromium`.
