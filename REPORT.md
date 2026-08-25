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
apps/orchestrator       the `cua` CLI, the typed HTTP API, the takeover gateway
apps/web                the operator console
packages/contracts      artifact schema, action model, result contract, the API  ← the spine
packages/surface        the Surface abstraction + the Playwright/CDP adapter
packages/policy         allowlist, risk classification, redaction
packages/engine         discovery loop, replay executor, sessions, evidence, catalog
```

**The API is a value, not a set of routes.** `packages/contracts/src/api.ts` is
one declaration that the orchestrator implements and the console consumes through
a *derived* client. There is no SDK to regenerate and nothing to keep in sync: add
a declared error to an endpoint and every screen that consumes it stops compiling
until somebody decides what it should look like. The same property that makes the
artifact schema the spine of the engine makes this the spine of the interface.

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

**On drift.** Replay records which rank resolved each step, so one that used to
resolve by role and now resolves by its markup fallback still passes while telling
you this install has moved. That is `fallbackHitRate`, and it is kept **per
institution** — the aggregate stops being actionable the moment one capability
serves many installs, because three percent across forty tenants is either forty
slightly degraded or one that has moved, and only the second is something a person
can do anything about. `driftingSteps` turns the split into a concrete proposal:
*these steps need an entry in this tenant's overlay*, which is a reviewable pull
request rather than an alert nobody knows what to do with.

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
labels, button captions, table nesting, product versions, and entry points.
**The shipped capability replays against both.** Evidence runs 09 and 10 are real
CLI runs of the same committed artifact against the two installs; both return
`$4,812.65`, and the Riverbend run records `summary.tenant: "riverbend"`. The
overlay is nine lines — two controls and an entry point — and every step still
resolved at rank 0 on both, meaning the relational anchors survived the extra table
nesting without falling back to markup. The resolver did the work the overlay did
not have to.

**Getting there found the defect that made the whole idea not work.** The recording
wrote its opening step as a *literal* URL, so an overlay setting `entryPoint`
changed a field nothing read: the run signed into First City and then failed on a
Riverbend label. It failed for a plausible-looking wrong reason, which is exactly
how a bug like that survives review. The fix belongs in the compiler, not the
overlay — a navigate URL that *is* the declared entry point is emitted as
`{{entryPoint}}` and the install's origin as `{{baseUrl}}`, so `target.entryPoint`
is load-bearing rather than decorative. A test asserts the run ends on
`/riverbend/` and never touches `/firstcity/`.

A quieter sibling: the compiler gives every `type` step a `valueEquals` checkpoint
carrying its **own copy** of the descriptor. An overlay that retargeted the action
alone would fill the field correctly and then fail to confirm it — a failure that
reads as a broken tenant rather than a half-applied overlay. A checkpoint asserting
the control the overlay just moved now moves with it, and explicit `checkpoints`
and `successCondition` overrides exist for assertions about *words on a screen*
rather than about controls.

---

## 5. Escalation & handoff

**Detecting stuck.** Discovery counts identical actions and stops when one repeats —
a model that cannot make progress does not stop, it tries again, which is expensive
as well as useless. Replay escalates on two triggers: policy returning
`RequireApproval`, which is the designed path, and `TargetNotFound` after every
ranked strategy has been tried, which means the UI has moved. The second is where a
person is genuinely better than a retry — the strategies will fail identically the
second time, while an operator who can see the screen gets past a relabelled button
in seconds. With nobody available it stays a hard failure with the strategy count
intact, which is the debuggable form. Evidence run 03 is a genuine discovery run
where a weaker model could not authenticate and called `escalate` rather than
thrashing.

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

**An escalation is a call that blocks, not an error that propagates.** This is the
design decision the rest of the section rests on. `Escalator.raise` returns the
operator's decision, so "the run pauses, a human drives, the run resumes and
completes" is literally what the code does rather than a description of what it
implies. With no escalator configured, the same call site returns
`Escalated { interventionId }` and ends the run — correct for an unattended batch
replay, which has nobody to ask and should not pretend otherwise. The difference
between attended and unattended operation is one optional dependency.

**The operator drives the same page**, over CDP `Page.startScreencast` out and
`Input.dispatch*` in, on a WebSocket. Not a reconstruction: reproducing a legacy
session in a second browser is the hard problem, and it would fail exactly when a
takeover is needed. The intervention carries what a person needs to decide without
asking anybody — the capability's goal, the step and its English intent, why it
stopped, a redacted screenshot from the moment it paused, and the recent action
log.

**Handback is two genuinely different answers.** `skipStep` means *I did it*, and
the automation must not repeat an irreversible action; `retryStep` means *I cleared
the way*, and it should try again on a screen that has changed. The checkpoint
still runs after a `skipStep` — trusting a human's word that the screen is where it
should be is exactly the assumption checkpoints exist to remove, and it is no more
warranted there than for the automation. Handbacks per step are bounded, because a
person answering "try again" to a step policy will refuse again is a loop with a
human in it.

**A dropped socket returns the session to the queue; it never resumes the run.** An
operator whose laptop slept mid-form decided nothing, and inferring a decision from
a disconnect is how automation completes a transfer a person abandoned halfway.

**What the operator did is captured twice** — as coordinates, which is what
actually happened, and as role plus name read back from the accessibility tree,
which is the only form an artifact step can be written in. A log of pixel positions
is faithful and unpromotable.

The control lease is *derived* from the state machine above and never assigned, so
the bug class where a console says "you have control" while the surface disagrees
is unrepresentable rather than merely tested for. Two defects only a real socket
surfaced: messages were handled concurrently, so a mouse-up overtook its mouse-down
and the click silently did nothing; and the click target was described *after*
dispatch, by which time the navigation had destroyed the node, leaving every
captured action with a coordinate and no name.

The whole loop is proven by an integration test that takes no shortcuts — a real
Chromium, a real screencast, real input at coordinates read from the accessibility
tree, and the real executor blocked on the real intervention — and by driving it by
hand through the console.

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

**One asymmetry during takeover is deliberate.** An operator's *click* is
classified and recorded but never refused — the intervention usually exists
precisely so a person can press the button policy would not, and blocking them
would make takeover useless at the moment it matters. An operator's *navigation*
**is** checked against the same allowlist as the automation, because otherwise the
takeover channel is an exfiltration path off a machine that holds banking
credentials by design. An irreversible action taken by hand is written as its own
audit event.

**Redaction runs on the way in, not on the way out.** Every write to evidence passes
through the redactor, so there is no path that puts regulated data on disk. Two
mechanisms, because neither suffices: pattern-based (SSN, Luhn-checked card numbers,
emails, long digit runs) catches what we did not know was there; value-based masks
exactly what the capability *declared* sensitive. A mask carries the *name* of the
declaring field — `[redacted:memberId]`, not `[redacted]` — which leaks nothing the
artifact does not already publish and makes the evidence readable to an auditor.

**The compiler refuses to emit an artifact containing a declared secret.** This is a
whole-artifact scan rather than a list of checked fields, and it exists because the
first real discovery run put an operator id into a *checkpoint* — the value channel
was correctly a secret reference, but nobody had thought about `expect: "teller01"`.
The list of routes a credential can take is exactly the kind of thing that grows a
new member later.

**It also refuses to emit an artifact containing a redaction marker**, which is the
same shape of defence and was found the same way. A recording is evidence, and
evidence is redacted on the way to disk — so recompiling one produced an anchor
reading `S-0001-[redacted:declared]`: not a leak and not a crash, but a capability
that compiles, commits, reviews cleanly and resolves nothing. Labelled masks let
the compiler turn `[redacted:memberId]` straight back into `{{memberId}}` without
ever seeing the value; the scan catches the case where it cannot.

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

**What is built and tested** (174 tests, no database or API key required): the
discovery loop against a real application with a real model; the artifact schema;
deterministic replay with the full error taxonomy; live takeover over a CDP
screencast with a real, enforced control lease; the typed HTTP API and the operator
console; per-tenant overlays, with one artifact proven against two institutions;
per-tenant drift telemetry; the agent-facing capability catalog; the policy
chokepoint; redaction; evidence; and the CLI.

**What is deliberately not built:**

- **Postgres persistence.** `packages/store` has a schema and a test harness and is
  unused. Artifacts live in git, which is where reviewable things belong, and runs
  live in `evidence/` — read back by the console, so what an operator sees is
  exactly what an auditor would find, with no second copy to disagree. The seam for
  a database is `apps/orchestrator/src/server/repositories.ts`, and it belongs there
  the day runs need querying across machines rather than listing from one. Wiring it
  now would add setup friction for a reviewer and prove nothing the brief asks
  about.
- **Masking sensitive regions of a screenshot before capture.** Pixels are not
  strings and the redactor cannot mask them after the fact, which is why screenshots
  are captured sparingly — on failures and escalations, where the debugging value is
  highest. The artifact already declares which fields are sensitive, so the
  information needed to do it exists; the work does not.
- **Promoting an operator's actions into a new artifact version.** The capture is
  there and is deliberately symbolic (role plus name, not just coordinates) so that
  it *could* be, but the promotion itself — a reviewed draft version — is not built.
  Doing it automatically would be wrong; doing it well needs a diff UI.
- **Authentication on the console.** It is an internal tool bound to loopback with a
  permissive CORS policy, and the thing actually guarding the automation is the
  policy chokepoint rather than the browser's origin check. A real deployment needs
  operator identity for the audit trail to mean anything — the log already records
  *who*, it just takes their word for it.

**One known imperfection in the shipped artifact.** Evidence run 06 reports
`TargetNotFound` where a `MemberNotFound` business outcome would be better. The
path is fully covered by the replay tests, and evidence run 02 shows a stronger
model discovering and declaring that outcome unprompted — the weaker model that
recorded the shipped artifact declared none, so replay honestly reports that it
could not find what the step needed rather than inventing an answer. The failure is
accurate; the artifact is incomplete. Free-tier quota (~20 requests per model per
day, a run costing about a dozen) ran out before I could re-record it with a better
model. `cua recompile` is faithful now, so a better recording drops straight in.

**One framework concession.** `apps/web` builds with webpack rather than Turbopack.
Every workspace package is source-only under NodeNext, whose `.js` specifiers point
at `.ts` files, and Turbopack has no extension-alias setting to teach it that.
Webpack's `resolve.extensionAlias` is exactly the missing piece. The alternative — a
build step for `@workspace/contracts` — would put a stale-able artifact between the
contract and the client that decodes with it, which is the one thing this design is
trying not to have.

**What I would do next, in order:** re-record with a stronger model to get the
declared outcome; promotion of an operator's fix into a reviewed draft version;
masking screenshot regions from the declared sensitivity; then an assisted
single-step LLM recovery on replay failure — bounded, policy-checked, and recorded
as evidence, which is the only shape in which a model belongs anywhere near the
replay path.

**A note on how this was built.** Several of the design decisions above are
corrections. The resolver first treated a bare role as a strategy, which made every
anchored descriptor ambiguous. Chromium reports layout tables under private roles
that `ariaSnapshot` hides, so no relational anchor resolved until the raw CDP tree
was dumped. An attempt to strip a data-valued name from a descriptor was made in the
compiler, where it silently weakened a descriptor the recorder had already *verified*
as unique — the compiler has no page in front of it and must not second-guess a
verified recording. A run had two ids, one from the caller that opened the evidence
directory and one the executor generated, so every screenshot reference in an
intervention pointed at a directory that did not exist. And an overlay pointed at a
second institution changed a field nothing read, because the recording had written
its opening URL out as a literal. Each of those is now a test.
