# Computer-Use Automation System

An LLM learns how to drive a legacy back-office application **once**. That run is
compiled into a typed, reviewable **capability artifact**. Production replays the
artifact **deterministically, with no model in the decision loop**.

> The model discovers. The artifact becomes a reusable capability. Deterministic
> replay is how the AI agent invokes it.

The design write-up is [`REPORT.md`](./REPORT.md). Worked examples of every path —
discovery, replay, reuse, escalation, three distinct failure modes, and the same
artifact running against two institutions — are in
[`evidence/`](./evidence/README.md).

[`docs/architecture.html`](./docs/architecture.html) is a diagram-led walkthrough
of the same material — the pipeline, the detection ordering, the control-transfer
machine, the tenant overlay merge. Open it in a browser; it needs no server.

---

## Setup

Requires **Node ≥ 20** (developed on 24) and **pnpm 10**.

```bash
pnpm install
pnpm --filter @workspace/surface exec playwright install chromium
```

That is everything the tests and the demo need. No database, no API key, no
Docker.

A Gemini API key is needed **only** to run `cua discover` yourself:

```bash
cp .env.example .env      # then put a key from https://aistudio.google.com/apikey in it
```

Note the free tier allows roughly **20 requests per model per day**, and one
discovery run costs about a dozen. `GEMINI_MODEL` selects the model; see
`docs/PLAN.md` for which ones this key can actually reach.

---

## Run the tests

```bash
pnpm test
```

174 tests. They start the stand-in application themselves on an ephemeral port and
drive a real Chromium, so this exercises nearly the whole system without any
external service:

| Suite | What it proves |
|---|---|
| `packages/surface` | The accessibility-tree reader, the ranked resolver against hostile markup, the control lease |
| `packages/policy` | Allowlist, risk classification, redaction |
| `packages/engine` (discovery) | The agent loop, policy chokepoint, step recording, descriptor synthesis |
| `packages/engine` (replay) | **Every branch of the result contract** — success, business outcomes, recoveries, hard failures |
| `packages/engine` (tenants) | **One artifact replaying against both institutions** |
| `packages/engine` (control state) | Every legal and illegal transfer of control, including races a browser cannot be made to produce on demand |
| `packages/engine` (health, catalog) | The drift arithmetic, and the tool declarations an agent is handed |
| `apps/orchestrator` (takeover) | **A live run pausing, a person driving it, and the run completing** |
| `apps/orchestrator` (api) | The typed API through the real derived client into the real handlers |
| `apps/target-corebank` | The stand-in itself, including every injectable fault |

`pnpm typecheck` and `pnpm lint` should both be clean.

---

## The demo path

### 1. Start the application being automated

```bash
pnpm --filter target-corebank dev
```

A deliberately period-accurate legacy servicing desk on
<http://localhost:4100> — HTML 4.01, a real `<frameset>`, table layouts,
generated control names, no test IDs, and form fields with **no accessible name
at all**. Sign on with `teller01` / `demo-pass`.

Two tenants run the same vendor product with different labels:
`/firstcity/login` and `/riverbend/login`.

Members `12345` and `23456` exist; `55555` is restricted; `99999` does not exist.

### 2. Replay the capability — no model involved

```bash
CUA_SECRET_OPERATORID=teller01 CUA_SECRET_OPERATORPASSWORD=demo-pass \
pnpm --filter orchestrator run cua replay \
  --capability "lookupMemberSavingsBalance@1.0.0" \
  --input memberId=12345
```

```
  s1   I need to navigate to the login page to start the member lookup process.
  …
  s7   Extracting the savings balance for the member.

result      Succeeded in 2195ms
outputs
  savingsBalance = $4,812.65
```

Credentials come from the environment, never from the artifact — grep
`capabilities/lookupMemberSavingsBalance@1.0.0.json` for `teller01` and you will
find nothing.

### 3. The same artifact, a second institution

```bash
… cua replay --capability "lookupMemberSavingsBalance@1.0.0" \
    --input memberId=12345 --tenant riverbend
```

```
tenant      riverbend via overlay · {{baseUrl}}/riverbend/login
…
result      Succeeded in 2240ms
outputs
  savingsBalance = $4,812.65
```

Riverbend labels the member field `Member #` rather than `Member Number`, captions
the button `Find Member` rather than `Search`, wraps its content in an extra table
and runs a different product version.
[`capabilities/overlays/lookupMemberSavingsBalance@1.0.0.riverbend.json`](./capabilities/overlays/)
names two controls and an entry point. Nothing is re-recorded, and the artifact
that ran records which institution produced the answer.

### 4. The parts worth actually looking at

**Reuse.** The same artifact, a member it was never recorded against:

```bash
… cua replay --capability "lookupMemberSavingsBalance@1.0.0" --input memberId=23456
# savingsBalance = $250.00
```

**A bad input is refused before a browser opens:**

```bash
… cua replay --capability "lookupMemberSavingsBalance@1.0.0" --input memberId=abc
# Failed — InputValidationFailed, stepsAttempted 0
```

**An injected application error is reported as one:**

```bash
curl -X POST http://localhost:4100/__control/fault \
  -H 'content-type: application/json' -d '{"mode":"server-error","times":4}'

… cua replay --capability "lookupMemberSavingsBalance@1.0.0" --input memberId=12345
# Failed — ApplicationError at step s4 (http 500), with a screenshot in evidence/
```

Other faults you can arm the same way: `session-expired`, `interstitial`, `slow`,
`validation`. `POST /__control/reset` clears them.

Exit codes distinguish the branches for a shell caller:
**0** succeeded, **1** failed, **2** escalated, **3** business outcome.

**Drift telemetry.** `--update-health` accumulates per-step, per-tenant fallback
rates back onto the artifact, and names the steps that need an overlay entry:

```bash
… cua replay … --tenant riverbend --update-health
```

### Seeing the run, not just the answer

A replay finishes in about two seconds, so by default it is over before you can
look at it, and screenshots are captured only on failure. Three ways to see it:

```bash
… cua replay … --headed            # watch Chromium drive, live
… cua replay … --capture-steps     # keep a frame from every step
```

`--capture-steps` writes `step-s1.png … step-sN.png` into the run's evidence
directory and roughly doubles the wall time, which is why it is opt-in. The
console pairs each frame with that step's English intent under a **Filmstrip**
tab — a screenshot alone shows a page, a screenshot beside *"Entering the member
ID to search for the member"* shows whether the automation was doing what it
believed it was doing.

The console also streams a **live view** on any run still in flight: the same
CDP screencast the takeover uses, pointed at a running session. Connecting is
read-only by construction — acting requires holding the control lease, and the
automation is holding it — so watching is safe for anyone with the URL. If the
run then pauses for a person, the panel says so and links straight to the
intervention.

### 5. What an AI agent is handed

```bash
pnpm --filter orchestrator run cua catalog          # human-readable
pnpm --filter orchestrator run cua catalog --json   # tool-declaration form
```

```
lookupMemberSavingsBalance(
  memberId: string  // matches ^\d+$
)
  Looked up member <memberId> and extracted their savings balance.
  Returns: savingsBalance (string). Status: draft — not yet approved for
  unattended use of anything beyond safe actions.
```

Every field is derived from the artifact, so what an agent believes it can do
cannot drift from what the system will execute. The `--json` form is exactly what
Gemini's `parametersJsonSchema` takes.

---

## The operator console

Three terminals:

```bash
pnpm --filter target-corebank dev                        # the legacy app, :4100

CUA_SECRET_OPERATORID=teller01 CUA_SECRET_OPERATORPASSWORD=demo-pass \
  pnpm --filter orchestrator dev                         # API + evidence, :4000

pnpm --filter web dev                                    # console, :3000
```

<http://localhost:3000> gives you the capability catalog, the artifact rendered
for review (with a per-institution view that re-resolves it through that tenant's
overlay), a run and evidence viewer, the intervention inbox, and a playground that
invokes a capability the way an agent would.

### Live takeover

Start a run from the console with **“wait for a person if it gets stuck”** on, or
from the CLI:

```bash
… cua replay --capability "lookupMemberSavingsBalance@1.0.0" \
    --input memberId=99999 --live
```

The run reaches a step it cannot resolve, pauses, and prints a
`ws://…/takeover` URL. Open the intervention in the console and you get the live
page over a CDP screencast, with why it stopped, the step and its English intent,
a screenshot from the moment it paused, and the last few things the automation
did. **Take control** and you are driving the same browser — same cookies, same
half-filled form — with your clicks and keystrokes forwarded as real input
events. While you hold it, the automation is *refused*, not merely paused.

Hand back with **“I did this step”** (the automation must not repeat an
irreversible action) or **“I cleared the way”** (it should try again on a screen
that has changed), and the run continues. Everything you did is captured as
coordinates *and* as role plus name — the second is what would let an operator's
fix become a new artifact version.

---

## Recording and re-compiling

### Run discovery yourself (needs a key)

```bash
pnpm --filter orchestrator run cua discover \
  --goal "Look up member 12345 and read their current savings balance." \
  --entry http://localhost:4100/firstcity/login \
  --name lookupMemberSavingsBalance \
  --param memberId=12345 \
  --secret operatorId=teller01 \
  --secret operatorPassword=demo-pass
```

`--param` values typed verbatim by the model are recorded as `{$param}`;
`--secret` values become `{$secret}` references that never enter the artifact.
This overwrites `capabilities/lookupMemberSavingsBalance@1.0.0.json` and writes a
new run under `evidence/`.

### Re-emit an artifact without calling a model

```bash
pnpm --filter orchestrator run cua recompile \
  --run evidence/01-discovery-produces-the-capability/run.json \
  --name lookupMemberSavingsBalance \
  --param memberId=12345 \
  --secret operatorId=teller01 --secret operatorPassword=demo-pass
```

Discovery saves the raw recording, so an improved compiler can be applied to
capabilities that already exist. Re-running the model instead would be expensive
*and* non-deterministic — a second run explores differently. The shipped artifact
was regenerated this way after the compiler learned to reference the entry point
rather than repeat it, which is what made the tenant overlay work at all.

A test asserts this command is a no-op against the committed artifact — that the
file in `capabilities/` is exactly what the compiler emits from the recording in
`evidence/`, and so was not hand-edited.

---

## Layout

```
apps/
  target-corebank/   the legacy application being automated (the stand-in)
  orchestrator/      the `cua` CLI, the typed HTTP API, the takeover gateway
  web/               operator console (Next.js)
packages/
  contracts/         the artifact schema, action model, result contract, the API
  surface/           the Surface abstraction + the Playwright/CDP adapter
  policy/            allowlist, risk classification, redaction
  engine/            discovery loop, replay executor, sessions, evidence, catalog
  store/             Prisma schema and test harness — set up, not used
capabilities/        capability artifacts and per-tenant overlays, committed
evidence/            worked examples of every path
```

## Where things stand

**Built and tested:** the discovery loop against a real application with a real
model; the artifact schema; deterministic replay with the full error taxonomy;
live takeover over CDP screencast with a real control lease; the typed HTTP API
and the operator console; per-tenant overlays with one artifact proven against two
institutions; per-tenant drift telemetry; the agent-facing capability catalog; the
policy chokepoint and redaction; and evidence for all of it.

**Not built:** Postgres persistence (`packages/store` is set up and unused —
artifacts live in git, which is where reviewable things belong, and runs live in
`evidence/`), and masking sensitive regions of a screenshot before capture. See
the Cuts section of `REPORT.md` for why, and for the one known imperfection in the
shipped artifact.
