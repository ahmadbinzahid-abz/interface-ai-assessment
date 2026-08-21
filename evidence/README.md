# Evidence

Every run here is a real Gemini-driven run against the live stand-in application
(`apps/target-corebank`). Nothing is simulated, and nothing has been edited by hand.

Each run directory contains:

| File | What it is |
|---|---|
| `trace.jsonl` | The structured log: what the agent did, **why** it did it, what policy decided, and which locator strategy resolved. Written through the redactor, so declared sensitive values never reach it. |
| `run.json` | The raw recording, so an artifact can be re-compiled after a compiler change without paying for another model run. |
| `capability.json` | The compiled capability, as emitted by that run. |

Discovery replays are not here yet — that is Phase 4.

## The runs

### `discovery-2026-08-21T13-12-46-021Z` — the shipped capability

`gemini-3.1-flash-lite`, completed in 9 turns. This run produced
`capabilities/lookupMemberSavingsBalance@1.0.0.json`.

Worth looking at in the artifact:

- The operator credentials are `{$secret}` references. Grepping the artifact for
  `teller01` or `demo-pass` returns nothing.
- The member number is a `{$param}`, so the capability works for any member.
- Step 7's URL became a `template` —
  `http://localhost:4100/firstcity/desk/member/{{memberId}}` — rather than a literal
  containing `12345`. Recorded as a literal it would have pinned the capability to
  one member forever.
- The success condition is `urlMatches` on that same parameterised pattern.

### `discovery-2026-08-21T13-09-36-470Z-escalated` — escalation, unprompted

`gemini-3.5-flash-lite`. This weaker model could not get past sign-on, retried,
and then **called `escalate`** rather than thrashing or inventing a workaround:

> "Authentication failed with the provided operator credentials."

The CLI exits `2` for this, distinct from a failure. Escalating is a legitimate
ending, not a crash — it is the path a human operator picks up. There is no
`capability.json` because nothing was learned worth saving.

### `discovery-2026-08-21T13-00-48-339Z` — outcome discovery

`gemini-3-flash-preview`, completed in 12 turns. Kept because it shows a behaviour
the shipped run does not: the model **deliberately searched a member number it knew
was invalid**, saw the "No member found for" screen, and declared a business outcome:

```
{"kind":"OutcomeDeclared","tag":"MemberNotFound",
 "description":"The member number entered does not exist in the system.",
 "whenText":"No member found for"}
```

That is the distinction the whole result contract turns on — "no such member" is an
answer the caller needs, not an error — and this model found it on its own because
the prompt asks it to.

**Caveat, stated plainly:** this run's `capability.json` was compiled by an earlier
version of the compiler and contains a success condition of
`textPresent: "$4,812.65"` — the balance it had just read. That check passes for
member 12345 and fails for every other member, which is the worst kind of
verification: it looks like a check and is really a recording of one answer. The
compiler now rejects a success condition that echoes extracted data and falls back
to a durable one; `run.json` was not being saved yet, so this artifact could not be
re-compiled without spending another model run.

## A note on model choice

The runs use different Gemini models because the free tier caps requests per model
per day, and a discovery run costs roughly a dozen. Model id is config-driven
(`GEMINI_MODEL`); it changes nothing about the system. The more capable models
produced visibly better recordings — more checkpoints, and the outcome probing
above — which is the expected shape of this trade-off: discovery runs once and its
quality is baked into an artifact that then replays forever without a model.
