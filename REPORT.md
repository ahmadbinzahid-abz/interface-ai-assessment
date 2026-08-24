# Design write-up

Setup and the demo path are in [`README.md`](./README.md); worked examples of every
path are in [`evidence/`](./evidence/README.md).

---

## 1. Architecture

The system is a compiler and a virtual machine. An LLM is the compiler: slow,
expensive, tolerant of ambiguity, and run **once** per capability. The artifact is
the bytecode: typed, versioned, diffable in a pull request. Deterministic replay
is the VM: fast, cheap, and incapable of improvising. Everything else follows from
taking that split seriously — in particular, that no code path lets the model's
judgement leak into replay.

```
apps/target-corebank    the legacy application being automated (built, not borrowed)
apps/orchestrator       the `cua` CLI
packages/contracts      artifact schema, action model, result contract  ← the spine
packages/surface        the Surface abstraction + the Playwright/CDP adapter
packages/policy         allowlist, risk classification, redaction
packages/engine         discovery loop, replay executor, evidence
```

**Perception is the accessibility tree, not the DOM.** The load-bearing choice. It
is the one representation that exists everywhere this system needs to go — Chromium
over CDP, Windows through UI Automation, macOS through the AX API — so a desktop
adapter fills in the same `Observation` type rather than needing a new schema. It is
also what a human operator perceives, and an order of magnitude smaller than the
equivalent markup, which is what makes a multi-step discovery run affordable.

**Why not Gemini's computer-use model.** `gemini-2.5-computer-use-preview` emits
coordinate actions from screenshots. Excellent for discovery and wrong for this
system: a coordinate carries no symbolic handle, so it cannot be re-resolved
deterministically, and deterministic replay is the entire point. We use a general
model over an accessibility-tree tool surface so what gets recorded is symbolic.

**The model never authors a locator.** It sees a numbered list of controls and
says "click #7". The recorder decides how #7 becomes durable, then *verifies that
descriptor resolves back to exactly that node*. Putting the most brittle decision
in the system into the least deterministic component would be a strange choice.

**Effect** is used for the typed error channel, which maps one-to-one onto the
business-outcome/failure split — the compiler enforces that callers handle every
branch. The cost is a learning curve for anyone unfamiliar with it.

**The target application is ours** (`apps/target-corebank`): HTML 4.01, a real
`<frameset>`, table layouts, generated control names, no test IDs, and form fields
with *no accessible name at all*. Building rather than borrowing bought the thing
the brief actually grades — a controllable runtime failure surface. Eight faults are
armed out of band through `/__control/fault`, so a fault replay drives exactly the
same URLs as a happy one.

---

## 2. Artifact schema

`capabilities/lookupMemberSavingsBalance@1.0.0.json` is a real one, produced by a
real Gemini run. It is a **contract**, not a recording — a step list tells you what
was clicked once; a contract tells a caller what it needs, what it returns, which
non-success answers are legitimate, and how to know it worked.

**Business outcomes are first class.** `outcomes` declares answers like
`MemberNotFound` with a detector. The brief names conflating these with failures as
the most common mistake here, so the split is structural rather than
conventional — they are different *types* in `ReplayResult`, and "no such member"
can never surface as an incident.

**Targeting is a ranked strategy list, not a selector.** Role plus accessible name,
then relations to a nearby landmark, then markup queries, then coordinates. A
selector encodes the page's implementation; a role plus "the cell right of the cell
reading *Member Number*" encodes what a person actually looks for. Resolution
requires a **unique** match — matching several is a failure, not permission to take
the first, because acting on the wrong control in a banking application is worse
than not acting. Genuine ambiguity must be *declared* with `nth`, which makes it
visible to a reviewer.

**Values are references.** A step never holds a value: `{$param}` for caller inputs,
`{$secret}` for credentials, `template` for a string that *embeds* one (a URL with a
member id in it). This single mechanism does two jobs — it makes the capability
reusable, and it keeps regulated data and credentials out of a file we commit. The
real artifact's extract step anchors on `S-0001-{{memberId}}`, which is why the same
recording works for a member it never saw.

**Every step carries `intent` in English and a `riskClass`.** The first is what makes
the artifact reviewable by someone who was not there; the second lets policy act per
action rather than per capability.

**Governance is in the schema.** `status` runs draft → candidate → approved →
deprecated, and compilation always emits `draft`: a model wrote it, nobody has read
it. `provenance` records a **digest** of the run rather than the transcript, because
a transcript contains whatever was on screen.

---

## 3. Determinism & error handling

Determinism comes from: no model, fixed step order, unique-match resolution, an
explicit checkpoint after every step, and condition-based waiting.

**The checkpoint is the wait.** An action that navigates has not finished when it
returns, so the condition is polled until it holds or the step times out. That is
why no artifact contains a sleep and why a page that loads in 40 ms costs 40 ms.

**After every step, four things are evaluated in this order:**

1. **A declared business outcome** → stop and return it. Checked *first* because it
   is an answer, and every other reading of that screen would be wrong. Checking
   the checkpoint first would report "expected the member page, saw something else"
   for a not-found result — true, and useless.
2. **A declared recovery** → handle it. The caller never hears about the maintenance
   notice we dismissed; the trace does.
3. **Built-in surface signals** — session expiry, HTTP ≥ 500 — which every
   application in this class exhibits and no artifact should have to declare.
4. **The step's own checkpoint.**

**Recovery has two kinds, and conflating them causes real damage.** Dismissing an
interstitial *clears an obstruction*: the action already happened, and re-running a
sign-on click that succeeded before the notice appeared would look for a button
that no longer exists. Re-authenticating *restores lost context*: whatever the step
did was thrown away with the session, so it must be redone. `Recovery.retriesStep`
makes the distinction explicit and defaults to the safer one, because re-running an
action that already took effect is how a replay submits a form twice. Even then, a
context-restoring recovery re-checks before re-acting — re-authentication replays
the sign-on prelude and may already have completed the interrupted step.

The result union is `Succeeded | BusinessOutcome | Escalated | Failed`, with
`ReplayError` distinguishing `InputValidationFailed`, `TargetNotFound`,
`AmbiguousTarget`, `CheckpointFailed`, `StepTimeout`, `PolicyDenied`,
`SessionExpiredUnrecoverable`, `UnexpectedDialog`, `ApplicationError`, and
`SurfaceUnavailable`. Every one carries which step, what was expected, and what was
observed. Inputs are validated against the declared contract *before* a browser
opens, so a bad call costs nothing and changes nothing.

**On drift.** Not the interesting failure here, but cheap to observe: replay records
which rank resolved each step, so one that used to resolve by role and now resolves
by its markup fallback still passes while telling you this install has moved. That
is `fallbackHitRate`, and it is the signal that a tenant needs an overlay.

---

## 4. Heterogeneity & multi-tenant

**The seam** is `packages/surface`. `Surface` — observe, resolve, act, read,
describe, screenshot — mentions no browser, no selector, no DOM; a test asserts
that, because the seam is the deliverable. Everything Playwright-shaped is confined
to one directory. Adding a desktop surface means writing an adapter, not touching
the schema, the replay engine, or a single artifact: `Observation` is already
role/name/parent-child, which is what UI Automation and the macOS AX API expose, and
the resolver that consumes it is pure and browser-free.

Within the web adapter, the division is: **the accessibility tree decides *which*
control** (portable reasoning), **the adapter decides how to touch it**
(browser-specific). The one strategy that already crosses surfaces intact is the
coordinate fallback, which is what a screenshot-driven desktop surface would use.

**Multi-tenant reuse** is a base artifact plus thin overlays. A capability is
recorded against the *vendor product* with `tenant: null`; a tenant that differs
carries a `TenantOverlay` that can override the entry point, retarget individual
steps, and add recoveries — resolved by a deterministic merge, with both versions
recorded on every run. The overlay deliberately **cannot** add, remove, or reorder
steps: a tenant whose *flow* differs is not a configured variant of the same
capability and needs its own recording, and making that inexpressible keeps the
distinction honest. Drift is detected by the rank telemetry above, which also tells
you *which step* needs the override.

The stand-in serves two tenants (`firstcity`, `riverbend`) with different field
labels, button captions, and table nesting, so the mechanism has something real to
work against. **The merge is implemented and unit-tested** — including that it
leaves the base artifact untouched, appends rather than replaces recoveries, and
ignores a stale override rather than failing a tenant's whole replay. **Replaying
an artifact end-to-end against the second tenant is not yet demonstrated.**

---

## 5. Escalation & handoff

**Detecting stuck.** Discovery counts identical actions and stops when one repeats —
a model that cannot make progress does not stop, it tries again, which is expensive
as well as useless. Replay escalates when policy returns `RequireApproval`, and
surfaces `TargetNotFound` after every ranked strategy has been tried. Both are real
and exercised: evidence run 03 is a genuine run where a weaker model could not
authenticate and called `escalate` rather than thrashing.

**The control-transfer model** is a lease with exactly one holder — `automation`,
`operator`, or `none` — checked by the adapter before every mutating command, and
enforced by *identity*: one automation run may not act on a session leased to a
different run. An early bug had the loop generate its own run id while the caller
granted the lease separately, and every action was refused in a way indistinguishable
from an operator holding the session. The run now acquires the lease itself, which
makes the mismatch unrepresentable.

One deliberate asymmetry: **observation and reading do not require the lease; acting
does.** We keep observing while a human drives, because that is how the handoff gets
recorded.

```
AutomationDriving ──requestIntervention()──► PauseRequested
       ▲                                          │ (current action completes)
       │                                          ▼
       │                              AwaitingOperator ──claim──► OperatorDriving
       │                                          │                      │
       └──── ResumeAccepted ◄── HandbackRequested ◄──── operator done ────┘
```

When policy requires approval, replay captures a screenshot, writes an
`InterventionRaised` event carrying the capability, step id, intent, and reason, and
returns `Escalated { interventionId }` — deliberately outside the success/failure
axis, with its own CLI exit code.

**What is not built:** the co-browsing surface. The intended mechanism is CDP
`Page.startScreencast` streamed over a WebSocket with `Input.dispatch*` forwarded
back, so the operator drives the *same* page with the same cookies — not a fresh
session. The lease, the pause point, the intervention record, and the evidence
capture are all real; the pixels and the operator console are not. This is the
largest gap in the submission and I would build it next.

---

## 6. Safety

**One chokepoint.** `PolicyEngine.decide` sits between every actor — the discovery
loop and the replay executor alike — and the surface. There is no code path where a
model decides to click something and the click simply happens. This is also the only
real answer to prompt injection: page content is untrusted input, a member's name
field could say "ignore your instructions", and nothing stops a model being
persuaded. What stops the damage is that the resulting click is classified and
refused by rules the model cannot reach.

**Risk is judged by what a control says, not by the action verb.** Clicking is not
dangerous; clicking "Close Account" is. Typing is never dangerous, because an
unsubmitted field has changed nothing. The ladder is `safe` → `risky` →
`irreversible`, and **discovery is capped at `safe`**: the model may *reach* a
confirmation screen — that is how the flow gets recorded — but is refused the
irreversible button and told to escalate. An unsupervised model should not be the
last actor before an irreversible financial action. In replay the same condition
becomes an approval request, because by then a human has reviewed the artifact.

**Redaction runs on the way in, not on the way out.** Every write to evidence passes
through the redactor, so there is no path that puts regulated data on disk. Two
mechanisms, because neither suffices: pattern-based (SSN, Luhn-checked card numbers,
emails, long digit runs) catches what we did not know was there; value-based masks
exactly what the capability *declared* sensitive.

**The compiler refuses to emit an artifact containing a declared secret.** This is a
whole-artifact scan rather than a list of checked fields, and it exists because the
first real discovery run put an operator id into a *checkpoint* — the value channel
was correctly a secret reference, but nobody had thought about `expect: "teller01"`.
The list of routes a credential can take is exactly the kind of thing that grows a
new member later.

**Limits, stated plainly.** Regex redaction has false negatives — an account-number
format we have not seen gets through. The model sees unredacted page content in
flight; only what is *persisted* is masked. Screenshots are pixels and the redactor
cannot mask them after the fact, which is why they are captured sparingly, on
failures and escalations; masking sensitive regions before capture is possible
because the artifact declares which fields are sensitive, and is not built. Risk
classification by label is imperfect — a button labelled "OK" that wires money would
be classed safe — which is why the ladder sits on top of a default-deny allowlist
rather than replacing it. The vault is an interface with an environment-backed
implementation; a real deployment would put a managed secret store behind it.

---

## 7. Cuts

**What is built and tested** (108 tests, no database or API key required): the
discovery loop against a real application with a real model, the artifact schema,
deterministic replay with the full error taxonomy, the policy chokepoint,
redaction, evidence, and the CLI.

**What is deliberately not built:**

- **The co-browsing operator surface.** The seam is real and enforced; the screencast
  is not. Biggest gap, and the first thing I would build.
- **The operator console UI.** `apps/web` is scaffolded to the intended structure and
  empty. The brief permits mocking this; I would rather ship an honest seam than a
  screenshot of one.
- **Postgres persistence.** The schema and test harness are set up and unused —
  artifacts live in git (which is where reviewable things belong) and runs currently
  live in `evidence/`. Wiring the database would add setup friction for a reviewer
  and prove nothing the brief asks about.
- **Multi-tenant demonstration.** The overlay merge is implemented and unit-tested;
  replaying against `riverbend` is a short piece of work I did not get to.
- **The agent-facing capability catalog.** The typed inputs are already there and
  generating tool declarations from them is small; nothing consumes them yet.

**One known imperfection in the shipped artifact.** Evidence run 06 reports
`TargetNotFound` where a `MemberNotFound` business outcome would be better. The
path is fully covered by the replay tests, and evidence run 02 shows a stronger
model discovering and declaring that outcome unprompted — the weaker model that
recorded the shipped artifact declared none, so replay honestly reports that it
could not find what the step needed rather than inventing an answer. The failure is
accurate; the artifact is incomplete. Free-tier quota (~20 requests per model per
day, a run costing about a dozen) ran out before I could re-record it with a better
model.

**What I would do next, in order:** the live takeover; a `MemberNotFound` re-record;
the riverbend overlay replay; then the capability catalog. After that, masking
screenshot regions from the declared sensitivity, and an assisted single-step LLM
recovery on replay failure — bounded, policy-checked, and recorded as evidence.

**A note on how this was built.** Several of the design decisions above are
corrections. The resolver first treated a bare role as a strategy, which made every
anchored descriptor ambiguous. Chromium reports layout tables under private roles
that `ariaSnapshot` hides, so no relational anchor resolved until the raw CDP tree
was dumped. An attempt to strip a data-valued name from a descriptor was made in the
compiler, where it silently weakened a descriptor the recorder had already *verified*
as unique — the compiler has no page in front of it and must not second-guess a
verified recording. Each of those is now a test.
