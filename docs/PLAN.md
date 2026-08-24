# Computer-Use Automation System — Build Plan

Internal working plan for the interface.ai take-home. Not a deliverable; the graded
write-up is `/REPORT.md`.

## Start here (resuming in a fresh session)

**All eight phases are done.** `pnpm test` runs 172 tests with no database and no
API key; `pnpm typecheck` and `pnpm lint` are clean.

To see the whole thing, three terminals:

```
pnpm --filter target-corebank dev                  # the legacy app, :4100
CUA_SECRET_OPERATORID=teller01 CUA_SECRET_OPERATORPASSWORD=demo-pass \
  pnpm --filter orchestrator dev                   # API + evidence, :4000
pnpm --filter web dev                              # console, :3000
```

`/README.md`, `/REPORT.md` and `evidence/README.md` describe what is actually
built, and every command in the README was run as written before it was
committed.

The one thing still outstanding, and it needs quota rather than work:

1. **Re-record the capability** with a model strong enough to declare a
   `MemberNotFound` outcome — see the known imperfection below. `cua recompile`
   is faithful now and there is a test asserting the shipped artifact is exactly
   what the compiler emits from the committed recording, so a better recording
   drops straight in.

Read `AGENTS.md` for conventions before writing code.

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
| LLM | **Gemini** via `@google/genai` | User directive. Model id is config-driven via `GEMINI_MODEL` — see the availability note below before picking one |
| Backend | Node 24 + Effect + `@effect/platform` HttpApi | Typed error channel maps 1:1 onto the required business-outcome / failure split |
| Persistence | Postgres + Prisma (Docker) for operational data; artifacts as git-committed JSON | Artifacts are code-like assets reviewed in a PR; runs are operational data |
| Takeover | CDP `Page.startScreencast` + `Input.dispatch*` forwarding | Human drives the same live page — makes §3.6 unambiguously real |
| Frontend | Next.js 16 + React 19 + shadcn (`apps/web`) | Already scaffolded |
| Stretch goals | Agent-facing capability catalog; cross-tenant overlay reuse | Both near-free given the above |

### Model availability and quota — read before spending a run

Established empirically on 2026-08-21 against this project's key. Free tier, and the
numbers are per *model*, not per project:

- **Roughly 20 requests per day, per model.** One discovery run costs ~12. There is
  very little headroom, so do not spend a run casually.
- **5 requests per minute, per model.** Handled by backoff; it makes a run take a
  couple of minutes.
- **`gemini-3.1-pro-preview` is `limit: 0`** — the Pro tier is not on the free tier at
  all, so `DEFAULT_GEMINI_MODEL` in `packages/engine/src/gemini.ts` is currently
  pointing at something this key cannot call. Change it or always pass `GEMINI_MODEL`.
- **`gemini-flash-latest` is an alias for `gemini-3.7-flash`** and shares its bucket.
- `gemini-2.5-pro` and `gemini-2.5-flash-lite` return 404: retired for new users.
- Known good, each with its own daily bucket: `gemini-3-flash-preview` (produced the
  best recording — probed for the not-found screen unprompted), `gemini-3.7-flash`,
  `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`.

`ai.models.list()` filtered on `supportedActions.includes("generateContent")` is the
cheap way to see what a key can reach; it does not consume generation quota.

**Never delete `evidence/` or `capabilities/` before a replacement run has succeeded.**
Recovering a lost run costs quota that may not exist that day.

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
| 1 ✅ | `apps/target-corebank`: search → detail → sub-account form → confirmation; framesets, tables, no test IDs; session cookie; 2 tenant variants; `?fault=` injection | Every fault path walkable by hand |
| 2 ✅ | `packages/contracts` (schema + unions) and `packages/surface` (AX observation, ranked resolver, screencast) | Resolver unit tests pass on hostile markup; `Surface` signature has zero Playwright types |
| 3 ✅ | Discovery loop (Gemini tool use), policy chokepoint, evidence writer, artifact compiler (parameterization + checkpoint inference) | **One real LLM run** completes the goal and emits an artifact into `/evidence/` |
| 4 ✅ | Replay engine: executor, detection ordering, recovery layer, result contract, output extraction | Happy path + all seven fault paths hit the correct branch of the result union |
| 5 ✅ | Session manager, control lease, intervention API, WS screencast + input forwarding, operator capture, handback | Live run pauses → human drives → hands back → run completes |
| 6 ✅ | Typed HTTP API; operator console: catalog, run/evidence viewer, intervention inbox, take-control, playground | Console drives a paused run to completion |
| 7 ✅ | Tenant overlay merge, per-tenant drift telemetry, capability catalog as tool declarations | One artifact replays on both tenant variants |
| 8 ✅ | `/README.md`, `/REPORT.md` (their exact seven headings), `/evidence/` with discovery run + happy replay + **failing replay** | Tests green, `tsc --noEmit` clean |

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

## 10a. Phase 2 findings

**Phase 2 — complete.** `packages/contracts` holds the whole vocabulary: values and
`ValueRef`, ranked targeting, conditions, actions and the risk ladder, the capability
artifact, the replay result union, tenant overlays, and observations.
`packages/surface` holds the `Surface` seam, the pure ranked resolver, the control
lease, and the Playwright/CDP adapter. 56 tests pass.

Two corrections that came out of running the thing rather than reasoning about it:

1. **Role is a filter, not a strategy.** The first resolver draft treated a bare
   `role` as rank 0, so a descriptor saying "a textbox, in the cell right of
   *Member Number*" matched *every* textbox on the page at rank 0 and reported
   ambiguity before the anchor was ever tried. Role now constrains every strategy;
   only `name` makes role+name a strategy of its own. Similarly, `name` is applied
   *only* to the role+name strategy — re-applying it to an anchor's candidates
   rejects the very control the anchor exists to find, since that control usually
   has no name at all.
2. **Chromium reports layout tables under private roles.** The raw CDP tree returns
   `LayoutTable` / `LayoutTableRow` / `LayoutTableCell` for presentational tables —
   which is every form in this class of application. Playwright's `ariaSnapshot`
   shows the ARIA roles and hides this completely, so the earlier probe was
   misleading; only dumping `Accessibility.getFullAXTree` revealed it. Without the
   mapping, no relational anchor resolves anything. Both are pinned by tests.

Also worth recording: `Accessibility.getFullAXTree` returns *ignored* nodes, and they
are kept deliberately — they carry the parent chain that relational anchors walk.

## 10b. Phase 3 status

**Phase 3 — built and tested; the real model run is outstanding.** 85 tests pass.

`packages/policy` is the chokepoint: a default-deny allowlist as data, risk judged
from what a control *says* rather than from the action verb, and a redactor that runs
on the way *into* evidence rather than on the way out. Discovery is capped at `safe`,
so the model may reach a confirmation screen but is refused the irreversible button
and told to escalate.

`packages/engine` holds the loop, the recorder, and the compiler:

- The model never authors a locator. It points at a numbered control; the recorder
  synthesises the ranked descriptor and then **verifies it resolves back to that exact
  node**, narrowing with a declared `nth` if not. A step that was ambiguous the moment
  it was recorded would be a latent production failure.
- A typed value matching a declared task input is recorded as `{$param}`. That one
  substitution is what makes the artifact reusable *and* keeps the member number out
  of a committed file.
- Policy refusals are returned to the model as ordinary tool results, with the reason,
  so it can escalate instead of thrashing.
- Compilation always emits `status: draft`. A model wrote it; nobody has read it.

`apps/orchestrator` exposes `cua discover`.

### Design correction found by testing

The loop originally generated its own `runId` while the caller granted the control
lease separately. Every action was refused, and the refusal looked exactly like an
operator holding the session. The run now **acquires the lease itself** under its own
id, which makes the mismatch unrepresentable.

### Phase 3 closed: the real run happened

Three genuine Gemini-driven runs are in `/evidence/` (see `evidence/README.md`), and
`capabilities/lookupMemberSavingsBalance@1.0.0.json` was produced by one of them.

Five defects only a real model surfaced, each now fixed and the fix explained where it
lives:

1. **Retrying a daily quota burned the quota.** The first backoff treated every 429 as
   transient; each attempt consumed another request from the exhausted budget. The
   distinction has to be made on the quota *id* — `PerDay` is fatal, `PerMinute` is
   exactly what backoff is for.
2. **The model looped on sign-on** because nothing ever gave it credentials. That is
   what `{$secret}` was designed for and it simply was not wired: `--secret` now
   declares them, and the artifact records references rather than values.
3. **Nothing detected the loop.** Identical actions are now counted, and a run that
   repeats one stops — the same "stuck" signal that routes an intervention in replay.
4. **A credential reached the artifact through the checkpoint.** The value channel was
   correctly a secret reference, but the model set `expect: "teller01"`, and checkpoint
   text was not sanitised. Text is now parameterised, and the compiler *refuses to
   emit* an artifact containing a declared secret — a whole-artifact scan, because the
   list of paths a credential can take is exactly the kind of thing that grows later.
5. **A success condition that echoed the answer.** One run proposed
   `textPresent: "$4,812.65"` — the balance it had just read. Passes for member 12345,
   fails for everyone else. Rejected now, with a durable fallback.

Two smaller ones: exploratory probe steps were being replayed in production (now
excluded, `exploratory: true`), and a URL containing a parameter was recorded as a
literal (now a `template` value ref).

To reproduce:

```
pnpm --filter target-corebank dev          # terminal 1
pnpm --filter orchestrator run cua discover \
  --goal "Look up member 12345 and read their current savings balance." \
  --entry http://localhost:4100/firstcity/login \
  --name lookupMemberSavingsBalance \
  --param memberId=12345
```

## 10d. Phase 4 status

**Phase 4 — complete.** 108 tests. The full thread runs end to end: a real
Gemini discovery run, a compiled capability, and deterministic replay with no
model — including replay of the *same* artifact for a member it was never
recorded against.

The executor's shape is the deliverable. After every step it evaluates, in this
order: declared business outcome → declared recovery → built-in surface signal →
the step's own checkpoint. Checking the checkpoint first would report "expected
the member page, saw something else" for a not-found result, which is true and
useless.

Six defects found by running it, each fixed where it belonged:

1. **`read` used `innerText`**, which is empty for an `<input>`. Every "did the
   field take what we typed?" checkpoint failed. The checkpoint designed to catch
   silently-rejected input caught a bug in the reader instead.
2. **Nothing waited.** A checkpoint was evaluated before the navigation it was
   waiting for had landed. The checkpoint *is* the wait now — polled until it
   holds or the step times out, so an artifact never carries a sleep.
3. **Placeholders were not substituted in descriptors**, only in conditions. An
   anchor on `S-0001-{{memberId}}` matched nothing.
4. **Recovery has two kinds.** Dismissing an interstitial clears an obstruction —
   the action already happened and re-running it is wrong. Re-authenticating
   restores lost context — the action must be redone. `Recovery.retriesStep`
   makes the distinction explicit, defaulting to the safer of the two.
5. **Even a context-restoring recovery must re-check before re-acting**, because
   re-authentication replays the sign-on prelude and may already have completed
   the interrupted step.
6. **Discovery had the same missing-wait bug**, which made its tests flaky. It now
   reads until two consecutive observations agree.

### Recording quality, and where it is enforced

Three fixes moved recording from "works for the record it was recorded against"
to genuinely reusable. All three belong in the *recorder*, where the page is
available and a choice can be verified:

- A `type` step's checkpoint is decided by the compiler, not the model. Models
  reliably name the screen the flow is heading for rather than this step's effect.
- An expectation the recorder can see is false is **not recorded**, and the model
  is told so it can supply a real one.
- An extraction target is never identified by the value it is about to extract,
  and anchors prefer text that is *unique on the page* — the account number, not
  the opening date that every account opened that day shares.

One correction worth keeping: an earlier attempt made the last fix in the
*compiler*, which weakened a descriptor the recorder had already verified as
unique and produced an ambiguous target. The compiler has no page in front of it
and must not second-guess a verified recording.

## 10c. Carry-over into Phase 4 (now delivered)

Concrete obligations the replay engine inherits. These are not ideas — each one
already exists in a committed artifact and will fail without the matching support:

1. **`{{placeholder}}` substitution.** Checkpoints, success conditions and outcome
   detectors carry `{{memberId}}`-style placeholders, and `ValueRef` has a `template`
   variant carrying them inside URLs. The replay evaluator must resolve them from the
   supplied inputs, earlier outputs, and the vault before matching or acting. The
   shipped capability will not replay correctly until this exists.
2. **`{$secret}` resolution needs a vault.** There is no vault yet — discovery took
   credentials from `--secret`. Replay needs somewhere to resolve `operatorId` and
   `operatorPassword` from, even if the first version is an env-backed stub behind a
   clean interface.
3. **`valueEquals` must be implemented.** Typed steps now get an automatic checkpoint
   asserting the field holds what was typed; it is the cheapest instance of "never
   assume the action worked".
4. **Richer signal on failure (§3.5).** `Surface.screenshot` exists and the evidence
   writer takes images, but nothing captures one yet. Replay failures and escalations
   are where it belongs.
5. **Health write-back.** `health.fallbackHitRate` is the drift alarm described in §3,
   and replay is the only thing that can populate it — the resolution rank is already
   returned on every resolve.

## 10e. Phase 5 status

**Phase 5 — complete.** 132 tests. The gate is met by an integration test that
takes no shortcuts: a real replay reaches a step policy will not let it perform,
pauses, hands the live Chromium session to a WebSocket client that drives it with
real `Input.dispatch*` events at coordinates read from the accessibility tree,
hands back, and **the run continues and succeeds**.

The design decision that made it work is that an escalation is a *call that
blocks*, not an error that propagates. `Escalator.raise` returns the operator's
decision, so the executor's "run pauses → human drives → run resumes" is literally
what the code does. With no escalator configured the same call site returns
`Escalated` and ends the run, which is what an unattended batch replay needs — the
difference between attended and unattended operation is one optional dependency.

Three things are worth keeping:

- **The lease is derived from the state machine, never assigned.** `Session`
  owns both, and `controlHolderOf` is the only thing that decides who may act.
  The bug class where a console says "you have control" while the surface
  disagrees is unrepresentable rather than merely tested for.
- **A disconnect returns the session to the queue; it never resumes the run.** An
  operator whose laptop slept mid-form decided nothing, and inferring a decision
  from a dropped socket is how automation completes a half-finished transfer.
- **`skipStep` is the disposition that ends a policy escalation well**, because
  the operator pressed the irreversible button themselves. `retryStep` puts the
  automation back in front of a control policy will refuse again — so handbacks
  per step are bounded, and the checkpoint still runs after a `skipStep`. A
  human's word that the screen is where it should be is exactly the assumption
  the checkpoint exists to remove.

### Two defects only a real socket surfaced

1. **Messages were handled concurrently, so a mouse-up overtook its mouse-down.**
   The press handler pauses to read the accessibility tree and the release
   handler does not, so they reached the browser out of order and the click
   silently did nothing. Each connection now processes messages strictly in
   sequence. Input is a sequence, not a set.
2. **The click target was described *after* the input was dispatched.** By then
   the click had navigated and the node was gone, so every captured action had a
   coordinate and no name — the log was faithful and unpromotable. The press is
   read before it is forwarded, which is also the more honest target: a click
   belongs to where the mouse went down.

Also settled while building it: `DOM.getBoxModel` and `Input.dispatchMouseEvent`
share the top-level viewport's coordinate space even for controls inside a
frameset's child frame, so no per-frame offset is needed. Verified with a probe
rather than assumed, because the alternative fails silently.

### What is deliberately not policed

An operator's *click* is classified and recorded but never refused. The
intervention usually exists precisely so a person can press the button policy
would not; blocking them would make takeover useless at the moment it matters. An
operator's *navigation* is checked against the same allowlist as the automation —
otherwise the takeover channel is an exfiltration path out of a machine holding
banking credentials. That asymmetry is intentional and belongs in REPORT.md §6.

To see it by hand:

```
pnpm --filter target-corebank dev          # terminal 1
pnpm --filter orchestrator run cua replay   --capability lookupMemberSavingsBalance@1.0.0   --input memberId=12345 --live --headed
```

It prints a `ws://…/takeover` URL and blocks when it needs a person.

## 10f. Phase 6 status

**Phase 6 — complete.** 144 tests. `packages/contracts/src/api.ts` is the API as a
*value*; `apps/orchestrator/src/server` implements it; `apps/web` consumes a client
derived from the same value. Nothing is hand-written between them, so they cannot
drift.

The console is proven the same way the engine is — by driving it. A live run was
started through the API, paused at a step it could not resolve, and an operator
took control **through the browser console**, clicked a control on the live
legacy page, saw it captured as `click · Search`, and handed the run back. The
screencast, the input forwarding and the control lease all work end to end
through the UI, not just through the integration test.

Decisions worth keeping:

- **The read model reads what already exists.** Capabilities are files in
  `capabilities/`; runs are the evidence directories the run itself wrote,
  redacted on the way in. No second copy in Postgres to disagree with the
  evidence an auditor would find. `repositories.ts` is the seam where a database
  belongs the day runs need querying across machines.
- **`Effect.either` at every hook boundary.** A typed failure becomes a value in
  the success channel, so `RunNotFound` reaches JSX with its type intact. That
  keeps transport state (`isPending`, network down) and domain state (the server
  answered "no such run") on separate axes — conflating them is why so many
  consoles show a red banner for an ordinary 404.
- **`Match.exhaustive` over the result union in the UI.** Adding a branch to
  `ReplayResult` or an error to an endpoint breaks the console build until a
  human decides what it looks like. A business outcome gets a neutral card, not
  a red one, for the same reason the executor returns it as data.
- **Starting a run answers 202 with a run id.** A replay that may wait minutes on
  a person is the wrong shape for a held-open HTTP request.

### Three defects found by running it

1. **A run had two ids.** The orchestrator named the evidence directory and the
   executor generated its own, so every screenshot reference in an intervention
   pointed at a directory that did not exist. `ReplayRequest.runId` now carries
   the caller's name through. One run, one id.
2. **The trace header stopped being the first line.** A live run writes a control
   transition before `ReplayStarted`, so every live run appeared in the console
   with no capability name. The header is now *found* by its `kind` rather than
   assumed to be first — and there is a test whose fixture puts a transition
   first on purpose.
3. **Escalation covered one of the two places resolution can fail.** A descriptor
   that resolved to a coordinate and then could not be read failed *inside* the
   action, which never reached the escalation hook — so a live run still ended as
   a bare `TargetNotFound` instead of asking the operator who was watching. Both
   paths now escalate, and only for the "UI moved" family: a dead browser is not
   something a person can fix by looking at the screen.

### The one framework concession

`apps/web` builds with **webpack rather than Turbopack**. Every workspace package
is source-only with NodeNext resolution, which requires relative imports to carry
an explicit `.js` extension pointing at a `.ts` file. Turbopack has no
extension-alias setting and looks for a literal `.js`; webpack's
`resolve.extensionAlias` is exactly the missing piece. The alternative — a build
step for `@workspace/contracts` — would put a stale-able artifact between the
contract and the client that decodes with it, which is the one thing this design
is trying not to have.

## 10g. Phase 7 status

**Phase 7 — complete.** 172 tests. The gate is met twice over: an integration suite
that replays one artifact against both tenants of the stand-in, and two committed
evidence directories (`09-`, `10-`) from real CLI runs of the *shipped* capability
against both installs. Both return `$4,812.65`; the Riverbend run carries
`summary.tenant: "riverbend"`.

The overlay is nine lines. Riverbend labels the member field `Member #`, captions
the button `Find Member`, wraps its content in an extra table, runs a different
product version and lives at a different path — and every step still resolved at
rank 0, meaning the relational anchors survived the extra nesting without falling
back to markup. The resolver did the work the overlay did not have to.

### The defect that made the whole idea not work

The shipped artifact recorded its opening step as a **literal URL**
(`http://localhost:4100/firstcity/login`), and its `urlMatches` checkpoint the
same way. An overlay setting `entryPoint` therefore changed a field nothing read:
the run signed into First City and then failed on a Riverbend label. It failed
for a *plausible-looking wrong reason*, which is exactly how a bug like this
survives review.

The fix is a compiler change, not an overlay one. A navigate URL that *is* the
declared entry point is now emitted as `{{entryPoint}}`, and the install's origin
as `{{baseUrl}}` — so the artifact references its entry point rather than
repeating it, and `target.entryPoint` becomes load-bearing instead of decorative.
A test asserts the run ends on `/riverbend/` and never touches `/firstcity/`.

A second, quieter one: the compiler gives every `type` step a `valueEquals`
checkpoint carrying its **own copy** of the descriptor. An overlay retargeting
the action alone would fill the field correctly and then fail to confirm it — a
failure that reads as a broken tenant rather than a half-applied overlay. A
checkpoint asserting the control the overlay just moved now moves with it, and
`checkpoints` / `successCondition` overrides exist for assertions that are about
*words on a screen* rather than about controls.

### `cua recompile` was quietly broken, and it mattered here

Regenerating the artifact through the fixed compiler surfaced this: a recording
is **evidence**, and evidence is redacted on the way to disk. The compiler
parameterises by *searching for the value*, and the value had already been masked
— so recompiling produced an anchor reading `S-0001-[redacted:declared]`. That
compiles, commits, reviews cleanly, and resolves nothing.

Three changes, in the order they matter:

1. **The redactor labels what it masked** — `[redacted:memberId]` rather than
   `[redacted:declared]`. The label is the declaring field's name, which the
   artifact already publishes, so it leaks nothing and makes evidence more
   readable besides.
2. **The compiler turns a labelled marker straight back into a reference**, so a
   recording is recompilable without the compiler ever seeing the value.
3. **The compiler refuses to emit an artifact containing a redaction marker** —
   the same defence-in-depth shape as the existing secret scan. A silently broken
   artifact is worse than a failed compile.

`recompile` now also preserves the original transcript digest and discovery
timestamp: reading an old recording through a new compiler does not change *when*
or *by which model* the flow was discovered, and stamping it would lose the only
thing tying an artifact back to its trace. The one committed recording was
migrated to labelled masks (three occurrences, each verified to be the member id
— secrets never reach a recording as values, only as `{$secret}` refs).

### Drift telemetry is per tenant, or it means nothing

`fallbackHitRate` is split by institution, because the aggregate stops being
actionable the moment one capability serves many installs: three percent across
forty tenants is either forty slightly degraded or one that has moved, and only
the second is something a person can act on. `driftingSteps` turns that into a
concrete proposal — *these steps need an entry in this tenant's overlay* — which
is a reviewable pull request rather than an alert nobody knows what to do with.
The running-mean arithmetic is pure and unit-tested.

Health write-back had a latent bug worth naming: it wrote back the artifact it
*ran*, which under `--tenant` is the resolved one. That would have quietly turned
the shared base capability into Riverbend's. It writes onto the base now, with
the tenant as a key.

### The catalog closes the loop

`cua catalog [--json]` and `GET /api/capabilities/declarations` emit tool
declarations **derived** from the artifacts — name, typed arguments with their
patterns, and the declared outcomes a caller must not retry. Nothing is written
alongside the artifact, so what an agent believes it can do cannot drift from
what the system will execute. `{{memberId}}` renders as `<memberId>`: a
placeholder is an instruction to the replay engine and noise to a model.

Known rough edge: the artifact's description is still the model's own past-tense
summary ("Looked up member <memberId>…"). Accurate, slightly odd as a tool
description. Rewriting a model's prose is a compiler concern and not one worth
guessing at.

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

Postgres verified: `pnpm db:up` brings the container up healthy with both `cua` and
`cua_test` created by the init script.

**Phase 1 — complete.** `apps/target-corebank` serves a period-accurate legacy servicing
app: HTML 4.01, a real `<frameset>`, table layouts, `f1_ctl03`-style control names, no
test IDs, and no accessible names on inputs. Sign-on → member search → member detail →
sub-account form → confirmation, plus an irreversible "Close Account" control for the
policy engine to refuse. Two tenants (`firstcity`, `riverbend`) run the same vendor
product with different labels, button captions, and table nesting. Faults are armed out
of band via `/__control/fault`, so a fault replay drives exactly the same URLs as a happy
one. 20 tests through the real Hono app; all eight rows of the §9 fault matrix reachable.

### Phase 1 probe findings (these change Phase 2)

Verified against a real browser rather than assumed:

1. **`newCDPSession(frame)` does not work for same-origin frames** — Playwright throws
   *"This frame does not have a separate CDP session"*. The Surface adapter must instead
   walk `Page.getFrameTree` and call `Accessibility.getFullAXTree({ frameId })` per frame.
   The page-level session alone returns **zero** controls for a frameset.
2. **The member-id input has no accessible name at all** (`role=textbox name=""`), while
   submit buttons do get one from `value` (`role=button name="Search"`). This is the mix
   the ranked resolver has to handle: role+name for buttons, relational anchors for fields.
3. **Extraction targets are ambiguous and state-dependent.** After a sub-account is
   opened there are *two* rows whose first cell reads "Savings". The unique-match rule is
   load-bearing, and the artifact's extract step must disambiguate — anchor on the account
   number pattern rather than the product label alone.

## 11. Prerequisites

- `GEMINI_API_KEY` (AI Studio) — **required** for the Phase 3 discovery run, which is
  the one non-negotiable in the brief.
- Docker (present: 29.4.1) for Postgres.
- `pnpm exec playwright install chromium`.
