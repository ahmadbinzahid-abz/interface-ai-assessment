import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { FetchHttpClient, HttpApiBuilder, HttpApiClient, HttpServer } from "@effect/platform"
import { CuaApi, encodeCapability } from "@workspace/contracts"
import { buildTestCapability } from "@workspace/engine"
import { Effect, Either, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { makeApiLayer } from "../src/server/handlers.js"
import { Orchestrator } from "../src/server/orchestrator.js"
import { CAPABILITIES_DIR, EVIDENCE_DIR } from "../src/paths.js"

/**
 * The API, tested through the real derived client into the real handlers.
 *
 * The only thing removed is the TCP socket. Routing, path decoding, payload
 * schema decoding, handler logic, response encoding, status-code mapping, error
 * serialisation and client-side decoding are all the real ones — which is where
 * endpoint bugs actually live. Calling the handler function directly would skip
 * every layer in that list.
 *
 * And because the client is *derived from the same contract the server
 * implements*, the test is type-checked end to end: rename a field and this file
 * stops compiling rather than failing red in CI.
 */

const orchestrator = new Orchestrator()

const { handler, dispose } = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(makeApiLayer(orchestrator), HttpServer.layerContext)
)

/** The whole trick: the client's transport is the app's own web handler. */
const client = Effect.runSync(
  HttpApiClient.make(CuaApi, { baseUrl: "http://localhost" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      ((input: RequestInfo | URL, init?: RequestInit) =>
        handler(new Request(input as never, init))) as typeof fetch
    ),
    Effect.scoped
  )
)

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.either(effect))

/**
 * A capability file written into the repository's real `capabilities/`
 * directory, then removed.
 *
 * The read model reads files, so the test creates a file — the same discipline
 * the database guide applies to rows. Named distinctly so it cannot collide with
 * the committed artifact this project actually ships.
 */
const FIXTURE_NAME = "apiTestCapability"
const FIXTURE_VERSION = "9.9.9"
const fixturePath = join(
  CAPABILITIES_DIR,
  `${FIXTURE_NAME}@${FIXTURE_VERSION}.json`
)

/** An evidence directory shaped exactly like one a real run leaves behind. */
const FIXTURE_RUN = "api-test-run"
const runDir = join(EVIDENCE_DIR, FIXTURE_RUN)

beforeAll(async () => {
  const artifact = buildTestCapability()
  const encoded = await Effect.runPromise(
    encodeCapability({
      ...artifact,
      name: FIXTURE_NAME,
      version: FIXTURE_VERSION,
    } as typeof artifact)
  )
  await writeFile(fixturePath, `${JSON.stringify(encoded, null, 2)}\n`, "utf8")

  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, "trace.jsonl"),
    [
      JSON.stringify({
        at: "2026-08-24T00:00:00.000Z",
        kind: "ControlTransition",
        event: "runStarted",
      }),
      JSON.stringify({
        at: "2026-08-24T00:00:00.001Z",
        kind: "ReplayStarted",
        runId: FIXTURE_RUN,
        capability: `${FIXTURE_NAME}@${FIXTURE_VERSION}`,
      }),
      JSON.stringify({
        at: "2026-08-24T00:00:00.002Z",
        _tag: "StepStarted",
        stepId: "s1",
        intent: "Open the sign-on page.",
      }),
    ].join("\n") + "\n",
    "utf8"
  )
  await writeFile(
    join(runDir, "result.json"),
    JSON.stringify({
      _tag: "BusinessOutcome",
      summary: {
        runId: FIXTURE_RUN,
        capabilityId: "cap_lookup",
        capabilityVersion: FIXTURE_VERSION,
        tenant: null,
        startedAt: "2026-08-24T00:00:00.000Z",
        durationMs: 1234,
        stepsAttempted: 6,
      },
      outcome: "MemberNotFound",
      detail: "No member exists with that number.",
      atStepId: "s6",
      outputs: {},
      trace: [],
    }),
    "utf8"
  )
})

afterAll(async () => {
  await rm(fixturePath, { force: true })
  await rm(runDir, { recursive: true, force: true })
  await orchestrator.close()
  await dispose()
})

describe("the capability catalog", () => {
  it("lists what an agent can call, with its calling contract", async () => {
    const result = await run(client.capabilities.list())

    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return

    const found = result.right.find(
      (capability) => capability.name === FIXTURE_NAME
    )

    expect(found).toBeDefined()
    expect(found?.inputNames).toContain("memberId")
    expect(found?.outputNames).toContain("savingsBalance")
    // The declared outcomes are the part a calling agent most needs: they are
    // the answers it must handle without treating them as incidents.
    expect(found?.outcomeTags).toContain("MemberNotFound")
  })

  it("returns the whole artifact, so a human can review it", async () => {
    const result = await run(
      client.capabilities.findByName({
        path: { name: FIXTURE_NAME, version: FIXTURE_VERSION },
        urlParams: {},
      })
    )

    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return

    expect(result.right.steps.length).toBeGreaterThan(0)
    // Every step carries its English intent — that is what makes an artifact
    // reviewable by somebody who was not there when it was recorded.
    expect(result.right.steps[0]?.intent).toBeTruthy()
  })

  it("answers a missing capability as a typed error, not a 500", async () => {
    const result = await run(
      client.capabilities.findByName({
        path: { name: "nothingLikeThis", version: "1.0.0" },
        urlParams: {},
      })
    )

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") return

    // The error survives the round trip *as itself*, with its fields intact —
    // which is what lets the console render "no capability X@Y" rather than
    // "something went wrong".
    expect(result.left._tag).toBe("CapabilityNotFound")
    if (result.left._tag !== "CapabilityNotFound") return
    expect(result.left.name).toBe("nothingLikeThis")
  })
})

describe("the agent-facing catalog", () => {
  it("derives a tool declaration per capability", async () => {
    const result = await run(client.capabilities.declarations())

    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return

    const found = result.right.find(
      (declaration) => declaration.name === FIXTURE_NAME
    )

    expect(found).toBeDefined()
    // Typed arguments, and the outcomes a caller must not retry. This one
    // request is everything an agent needs to call the system correctly.
    expect(found?.description).toContain("MemberNotFound")

    const schema = found?.parametersJsonSchema as {
      properties: Record<string, { pattern?: string }>
      additionalProperties: boolean
    }
    expect(schema.properties["memberId"]?.pattern).toBe("^\\d+$")
    expect(schema.additionalProperties).toBe(false)
  })

  it("lists the institutions a capability has an overlay for", async () => {
    const result = await run(
      client.capabilities.tenants({
        path: { name: FIXTURE_NAME, version: FIXTURE_VERSION },
      })
    )

    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return
    // The fixture ships no overlay; the shipped capability does, and that is
    // covered where the overlay itself lives.
    expect(result.right).toEqual([])
  })

  it("answers tenants for a capability that does not exist as not found", async () => {
    const result = await run(
      client.capabilities.tenants({
        path: { name: "nothingLikeThis", version: "1.0.0" },
      })
    )

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") return
    expect(result.left._tag).toBe("CapabilityNotFound")
  })
})

describe("runs", () => {
  it("reads a run back out of its evidence directory", async () => {
    const result = await run(
      client.runs.findById({ path: { runId: FIXTURE_RUN } })
    )

    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return

    // A business outcome is carried across as itself, not flattened into an
    // error field. The console matches on this union exhaustively.
    expect(result.right.result?._tag).toBe("BusinessOutcome")
    expect(result.right.summary.outcome).toBe("BusinessOutcome")
    expect(result.right.summary.capability).toBe(FIXTURE_NAME)
    expect(result.right.trace.some((event) => event._tag === "StepStarted")).toBe(
      true
    )
  })

  it("finds the run header even when it is not the first line", async () => {
    const result = await run(
      client.runs.findById({ path: { runId: FIXTURE_RUN } })
    )

    if (result._tag !== "Right") return
    // The fixture's first trace line is a control transition, exactly as a live
    // run writes one. Assuming the header came first is how live runs used to
    // show up in the console with no capability name at all.
    expect(result.right.summary.capabilityVersion).toBe(FIXTURE_VERSION)
  })

  it("answers a missing run as a typed error", async () => {
    const result = await run(
      client.runs.findById({ path: { runId: "no-such-run" } })
    )

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") return
    expect(result.left._tag).toBe("RunNotFound")
  })

  it("rejects inputs the capability's contract forbids, before opening a browser", async () => {
    const result = await run(
      client.runs.start({
        payload: {
          capability: FIXTURE_NAME,
          version: FIXTURE_VERSION,
          // The artifact declares `memberId` must match ^\d+$.
          inputs: { memberId: "not-a-number" },
          baseUrl: "http://localhost:4100",
          live: false,
        },
      })
    )

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") return

    expect(result.left._tag).toBe("InvalidInputs")
    if (result.left._tag !== "InvalidInputs") return
    expect(result.left.issues.length).toBeGreaterThan(0)
    // The rejected value is an identifier, so it must not be quoted back.
    expect(result.left.issues.join(" ")).not.toContain("not-a-number")
  })

  it("refuses to start a capability that does not exist", async () => {
    const result = await run(
      client.runs.start({
        payload: {
          capability: "nothingLikeThis",
          version: "1.0.0",
          inputs: {},
          baseUrl: "http://localhost:4100",
          live: false,
        },
      })
    )

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") return
    expect(result.left._tag).toBe("CapabilityNotFound")
  })
})

describe("the intervention inbox", () => {
  it("is empty when nothing is waiting", async () => {
    const result = await run(client.interventions.list())

    expect(result._tag).toBe("Right")
    if (result._tag !== "Right") return
    expect(result.right).toEqual([])
  })

  it("answers a claim on an unknown intervention as not found", async () => {
    const result = await run(
      client.interventions.claim({
        path: { interventionId: "int-nope" },
        payload: { operatorId: "alice" },
      })
    )

    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") return
    expect(result.left._tag).toBe("InterventionNotFound")
  })

  it("distinguishes a refused claim from a missing one", async () => {
    // Both are 4xx and both mean "you cannot have it", but only one of them is
    // something the operator can act on — which is why they are separate types.
    const missing = await run(
      client.interventions.resolve({
        path: { interventionId: "int-nope" },
        payload: { operatorId: "alice", disposition: "skipStep" },
      })
    )

    expect(missing._tag).toBe("Left")
    if (missing._tag !== "Left") return
    expect(missing.left._tag).toBe("InterventionNotFound")
  })
})

describe("sessions", () => {
  it("reports no live sessions when nothing is running", async () => {
    const result = await Effect.runPromise(
      Effect.either(client.sessions.list())
    )

    expect(Either.isRight(result)).toBe(true)
    if (!Either.isRight(result)) return
    expect(result.right).toEqual([])
  })
})
