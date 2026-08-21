# Computer-Use Automation System

An LLM learns how to drive a legacy back-office application **once**. That run is
compiled into a typed, reviewable **capability artifact**. Production replays the
artifact **deterministically, with no model in the decision loop**.

> The model discovers. The artifact becomes a reusable capability. Deterministic
> replay is how the AI agent invokes it.

The design write-up is [`REPORT.md`](./REPORT.md). Worked examples of every path —
discovery, replay, reuse, escalation, and three distinct failure modes — are in
[`evidence/`](./evidence/README.md).

---

## Setup

Requires **Node ≥ 20** (developed on 24) and **pnpm 10**.

```bash
pnpm install
pnpm --filter @workspace/surface exec playwright install chromium
```

That is everything the tests and the replay demo need. No database, no API key,
no Docker.

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

108 tests. They start the stand-in application themselves on an ephemeral port and
drive a real Chromium, so this exercises nearly the whole system without any
external service:

| Suite | What it proves |
|---|---|
| `packages/surface` | The accessibility-tree reader, the ranked resolver against hostile markup, the control lease |
| `packages/policy` | Allowlist, risk classification, redaction |
| `packages/engine` (discovery) | The agent loop, policy chokepoint, step recording, descriptor synthesis |
| `packages/engine` (replay) | **Every branch of the result contract** — success, business outcomes, recoveries, hard failures |
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

result      Succeeded in 2271ms
outputs
  savingsBalance = $4,812.65
```

Credentials come from the environment, never from the artifact — grep
`capabilities/lookupMemberSavingsBalance@1.0.0.json` for `teller01` and you will
find nothing.

### 3. The parts worth actually looking at

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

### 4. Run discovery yourself (needs a key)

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

### 5. Re-emit an artifact without calling a model

```bash
pnpm --filter orchestrator run cua recompile \
  --run ../../evidence/01-discovery-produces-the-capability/run.json \
  --name lookupMemberSavingsBalance \
  --param memberId=12345 \
  --secret operatorId=teller01 --secret operatorPassword=demo-pass
```

Discovery saves the raw recording, so an improved compiler can be applied to
capabilities that already exist. Re-running the model instead would be expensive
*and* non-deterministic — a second run explores differently.

---

## Layout

```
apps/
  target-corebank/   the legacy application being automated (the stand-in)
  orchestrator/      the `cua` CLI
  web/               operator console (Next.js) — not yet built out
packages/
  contracts/         the artifact schema, action model, result contract
  surface/           the Surface abstraction + the Playwright/CDP adapter
  policy/            allowlist, risk classification, redaction
  engine/            discovery loop, replay executor, evidence
  store/             Prisma schema and test harness — not yet used
capabilities/        capability artifacts, committed and reviewable
evidence/            worked examples of every path
```

## Where things stand

Built and tested: the discovery loop, the artifact schema, deterministic replay
with the full error taxonomy, the policy chokepoint and redaction, and evidence.

Not yet built: the operator console UI, the live-takeover screencast (the control
lease and escalation seam exist and are enforced; the co-browsing surface is not),
multi-tenant overlay demonstration, and the database-backed persistence. See the
Cuts section of `REPORT.md`.
