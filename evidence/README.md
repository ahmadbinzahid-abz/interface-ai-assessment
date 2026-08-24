# Evidence

Every run here is real, against the live stand-in application
(`apps/target-corebank`). The discovery runs called Gemini; the replay runs
called nothing at all. Nothing has been edited by hand.

Each directory contains:

| File | What it is |
|---|---|
| `trace.jsonl` | The structured log: what happened, **why** — each step's intent — what policy decided, and which locator strategy resolved. Written through the redactor, so declared sensitive values never reach it. |
| `run.json` | The raw recording (discovery), so an artifact can be re-compiled after a compiler change without paying for another model run. |
| `result.json` | The full typed result (replay). |
| `capability.json` | The compiled capability, as that run emitted it. |
| `failure-*.png` | Screenshot captured at the point of failure. |

## The through-line, in order

### 01 — discovery produces the capability

`gemini-3.1-flash-lite`, 8 turns. Produced
`capabilities/lookupMemberSavingsBalance@1.0.0.json`.

Worth checking in the artifact:

- Operator credentials are `{$secret}` references. Grep for `teller01` or
  `demo-pass` and you get nothing.
- The member number is a `{$param}`.
- The balance cell is targeted as *"the cell right of account number
  `S-0001-{{memberId}}`, second one"* — **not** by the balance it happened to
  read. That distinction is what makes 05 possible.

### 02 — discovery declares a business outcome

`gemini-3-flash-preview`, 12 turns. Kept because it shows behaviour the shipped
run does not: the model **deliberately searched a member number it knew was
invalid**, saw the result, and declared an outcome without being told to:

```
{"kind":"OutcomeDeclared","tag":"MemberNotFound",
 "description":"The member number entered does not exist in the system.",
 "whenText":"No member found for"}
```

That is the distinction the entire result contract turns on. Note also the
`exploratory: true` steps in the trace — the probe is remembered as evidence but
excluded from the compiled flow, so production never repeats it.

*Caveat:* this run's `capability.json` predates several compiler fixes and its
success condition is `textPresent "$4,812.65"` — the balance it had just read,
which passes for one member and fails for every other. It is kept as a record of
the run, not as a good artifact. `run.json` was not being saved yet, so it could
not be recompiled.

### 03 — discovery escalates to a human

`gemini-3.5-flash-lite`. A weaker model could not get past sign-on, retried, and
then called `escalate` rather than thrashing:

> "Authentication failed with the provided operator credentials."

The CLI exits `2` for this, distinct from failure. Escalating is a legitimate
ending. There is no `capability.json` because nothing worth saving was learned.

### 04 — replay succeeds

The production path: no model, no API key. Seven steps, `$4,812.65` returned in
about two seconds. Every step's intent is in the trace, along with the ranked
strategy that resolved it.

### 05 — replay reuses the capability for a different member

The same artifact, `memberId=23456`, returns `$250.00`. Nothing was re-recorded
and no model was consulted. This is the whole point of the system, and it only
works because the recording refers to its inputs rather than containing them.

### 06 — replay hits a member that does not exist

`memberId=99999` → `TargetNotFound` at the extraction step.

**Honest reading:** this *should* be a `MemberNotFound` business outcome, and it
would be if this artifact declared one — run 02 shows a stronger model doing
exactly that, and the replay test suite covers the outcome path end to end. The
model that recorded the shipped artifact did not declare any outcomes, so replay
correctly reports that it could not find what the step needed rather than
inventing an answer. The failure is accurate; the artifact is incomplete.

### 07 — replay rejects bad input

`memberId=abc` → `InputValidationFailed`, against the `^\d+$` pattern the
capability declares. No browser was opened and `stepsAttempted` is 0: a bad call
costs nothing and changes nothing. The offending value is not quoted back, since
an input can be regulated data.

### 08 — replay hits an application error

A 500 injected through `/__control/fault` → `ApplicationError` at step 4, with
the HTTP status in the detail and a screenshot captured at the point of failure.
Distinct from both a business outcome and a validation error, which is the split
the result contract exists to make.

### 09 and 10 — one artifact, two institutions

The §3.7 pair, and the point of the whole overlay mechanism. Both runs execute
**the same committed capability** with the same input:

```
cua replay --capability lookupMemberSavingsBalance@1.0.0 --input memberId=12345 --tenant riverbend
cua replay --capability lookupMemberSavingsBalance@1.0.0 --input memberId=12345
```

Riverbend labels the member field `Member #` rather than `Member Number`,
captions the search button `Find Member` rather than `Search`, wraps its content
in an extra table, runs a different product version and lives at a different
path. `capabilities/overlays/lookupMemberSavingsBalance@1.0.0.riverbend.json`
names two controls and an entry point — nine lines — and nothing is re-recorded.

Both return `$4,812.65`, and `summary.tenant` records which install produced the
answer. Every step resolved at rank 0 on both, meaning the relational anchors
survived the extra table nesting without falling back to markup: the resolver
did the work the overlay did not have to.

## A note on model choice

The runs use different Gemini models because the free tier caps requests per
model per day and a discovery run costs about a dozen. Model id is config-driven
(`GEMINI_MODEL`) and changes nothing structural. More capable models produced
visibly better recordings — more checkpoints, and the outcome probing in 02 —
which is the expected shape of the trade-off: discovery runs once, and its
quality is baked into an artifact that then replays forever without a model.
