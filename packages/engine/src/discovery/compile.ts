import {
  CapabilityArtifact,
  DeclaredOutcome,
  Health,
  InputParam,
  OutputField,
  PolicyBinding,
  Provenance,
  Step,
  TargetBinding,
  type Condition,
  type SurfaceKind,
} from "@workspace/contracts"

import type { DiscoveryParameter, DiscoveryRun } from "./types.js"

/**
 * Compiling a successful run into a capability.
 *
 * The recorded steps are already durable — the loop built them from real
 * observations as it went — so this is where the *contract* is assembled: what
 * the capability is called, what a caller must pass, what it gets back, which
 * non-success answers are legitimate, and how anyone can tell it worked.
 *
 * The result is always a `draft`. A model wrote it and no human has read it yet,
 * and unattended replay of anything that changes state is gated on approval.
 * Emitting `approved` here would quietly defeat the entire review model.
 */

export interface CompileRequest {
  readonly run: DiscoveryRun
  readonly capabilityId: string
  /** The name an agent calls it by. */
  readonly name: string
  readonly version: string
  readonly vendorProduct: string
  readonly productVersion?: string
  readonly surfaceKind: SurfaceKind
  readonly entryPoint: string
  readonly parameters: readonly DiscoveryParameter[]
  readonly allowlistRef: string
  /** Digest of the run trace. The transcript itself is never persisted. */
  readonly transcriptDigest: string
}

/**
 * A conservative starting pattern, inferred from the value discovery used.
 *
 * Only for all-digit inputs, and deliberately not length-bounded: the point is to
 * stop a caller passing a name where an id belongs, not to encode this
 * institution's current id width. A reviewer tightens it if they want to.
 */
const inferPattern = (value: string): string | undefined =>
  /^\d+$/.test(value) ? "^\\d+$" : undefined

const textPresent = (text: string): Condition => ({ _tag: "textPresent", text })

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Rewrite concrete values out of any text the artifact will carry.
 *
 * A checkpoint is written from what discovery actually saw, so it naturally
 * contains the *specific* member number that was looked up, and — as this system
 * found out the hard way — the *specific* operator id that was typed. Both are
 * wrong to persist: the first hard-codes the capability to one member, and the
 * second writes a credential into a file we commit.
 *
 * Occurrences become `{{name}}` placeholders, substituted at replay from the
 * supplied parameters and the vault. One mechanism covers both problems because
 * they are the same problem: a literal that should have been a reference.
 */
const parameterizeText = (
  text: string,
  parameters: readonly DiscoveryParameter[]
): string => {
  let out = text

  // Longest first, so a short value cannot chew a hole in a longer one.
  const ordered = [...parameters].sort(
    (a, b) => b.value.length - a.value.length
  )

  for (const parameter of ordered) {
    if (parameter.value.length < 3) continue
    out = out.replace(
      new RegExp(escapeRegExp(parameter.value), "g"),
      `{{${parameter.name}}}`
    )
  }

  return out
}

/** Apply `parameterizeText` wherever a condition carries free text. */
const parameterizeCondition = (
  condition: Condition,
  parameters: readonly DiscoveryParameter[]
): Condition => {
  switch (condition._tag) {
    case "textPresent":
    case "textAbsent":
      return {
        ...condition,
        text: parameterizeText(condition.text, parameters),
      }
    case "urlMatches":
      return {
        ...condition,
        pattern: parameterizeText(condition.pattern, parameters),
      }
    default:
      return condition
  }
}

/**
 * Choose a success condition that will still be true for a different input.
 *
 * The model picks its success text from the screen it is looking at, which means
 * it will happily choose the *value it just read* — one real run proposed the
 * member's balance. That passes today and fails for every other member, which is
 * the worst kind of check: one that looks like verification and is really a
 * recording of one particular answer.
 *
 * So the proposed text is rejected if it contains a value this run extracted, and
 * the last real step's checkpoint is used instead — that assertion was written
 * about the *screen*, not about the data on it.
 */
const buildSuccessCondition = (
  run: DiscoveryRun,
  parameters: readonly DiscoveryParameter[],
  steps: readonly Step[]
): Condition => {
  if (run.result._tag !== "Completed") throw new Error("unreachable")

  const proposed = parameterizeText(run.result.successText, parameters)

  const echoesExtractedData = run.outputs.some(
    (output) =>
      output.sampleValue.length >= 3 && proposed.includes(output.sampleValue)
  )

  if (!echoesExtractedData && proposed.trim().length > 0)
    return textPresent(proposed)

  const lastCheckpoint = [...steps]
    .reverse()
    .find((step) => step.checkpoint)?.checkpoint
  if (lastCheckpoint) return lastCheckpoint

  // Nothing durable to assert on. Say so rather than inventing a check that
  // cannot fail — a reviewer needs to see this before approving the capability.
  return textPresent(
    "REVIEW REQUIRED: no durable success condition was recorded"
  )
}

export const compileCapability = ({
  run,
  capabilityId,
  name,
  version,
  vendorProduct,
  productVersion,
  surfaceKind,
  entryPoint,
  parameters,
  allowlistRef,
  transcriptDigest,
}: CompileRequest): CapabilityArtifact => {
  if (run.result._tag !== "Completed") {
    throw new Error(
      `Only a completed discovery run can be compiled; this one ${run.result._tag}.`
    )
  }

  /**
   * Secrets are not inputs. A caller does not pass the operator password — the
   * vault resolves it at replay from the `{$secret}` reference in the step. If
   * they appeared here, the capability's public contract would be asking every
   * caller for a credential.
   */
  const inputs = parameters
    .filter((parameter) => parameter.sensitivity !== "secret")
    .map(
      (parameter) =>
        new InputParam({
          name: parameter.name,
          type: "string",
          description: parameter.description,
          required: true,
          pattern: inferPattern(parameter.value),
          sensitivity: parameter.sensitivity ?? "identifier",
        })
    )

  const outputs = run.outputs.map(
    (output) =>
      new OutputField({
        name: output.name,
        type:
          output.format === "integer" || output.format === "decimal"
            ? "number"
            : "string",
        format: output.format,
        description: output.description,
        // A balance read out of a banking screen is regulated data by default.
        // Under-classifying here is what leaks it into a log later.
        sensitivity: output.format === "currency-usd" ? "financial" : "pii",
      })
  )

  const outcomes = run.outcomes.map(
    (outcome) =>
      new DeclaredOutcome({
        tag: outcome.tag,
        description: outcome.description,
        detect: textPresent(parameterizeText(outcome.whenText, parameters)),
        partialOutputs: [],
      })
  )

  /**
   * Steps the model took to *learn* the application — probing an invalid id to
   * find the not-found screen — are deliberately excluded from the flow. They
   * belong in evidence, and their findings belong in `outcomes`, but replaying
   * them would make every production invocation do pointless work.
   *
   * The caveat, stated plainly: dropping a step can leave the next one starting
   * from a different screen than it was recorded against. That is precisely what
   * the following step's checkpoint is for — replay reports it honestly instead
   * of proceeding blindly.
   */
  const steps = run.steps
    .filter((step) => !step.exploratory)
    .map(
      (step) =>
        new Step({
          id: step.id,
          intent: step.intent,
          action: step.action,
          riskClass: step.riskClass,
          checkpoint: step.checkpoint
            ? parameterizeCondition(step.checkpoint, parameters)
            : undefined,
          timeoutMs: 10_000,
          observedMs: step.observedMs,
        })
    )

  const highestRisk = run.steps.some(
    (step) => step.riskClass === "irreversible"
  )
    ? ("irreversible" as const)
    : run.steps.some((step) => step.riskClass === "risky")
      ? ("risky" as const)
      : ("safe" as const)

  const artifact = new CapabilityArtifact({
    schemaVersion: "capability/v1",
    id: capabilityId,
    name,
    version,
    status: "draft",
    description: run.result.summary,

    target: new TargetBinding({
      surfaceKind,
      vendorProduct,
      productVersion,
      // Recorded against the product, not the institution. A tenant that differs
      // gets an overlay rather than its own recording.
      tenant: null,
      entryPoint,
    }),

    inputs,
    outputs,
    outcomes,
    steps,
    recoveries: [],
    successCondition: buildSuccessCondition(run, parameters, steps),

    policy: new PolicyBinding({
      allowlistRef,
      maxRiskClass: highestRisk,
      requiresApproval: highestRisk !== "safe",
    }),

    provenance: new Provenance({
      discoveredBy: run.modelId,
      discoveredAt: new Date().toISOString(),
      runId: run.runId,
      transcriptDigest,
    }),

    health: new Health({ replays: 0, successes: 0, fallbackHitRate: {} }),
  })

  assertNoSecretsLeaked(artifact, parameters)

  return artifact
}

/**
 * Defence in depth: refuse to emit an artifact containing a declared secret.
 *
 * Every individual path that could carry a credential is handled above — the
 * value channel becomes a `{$secret}` reference, checkpoint text is
 * parameterised, secrets are kept out of `inputs`. This check exists because
 * that list is exactly the kind of thing that grows a new member later. The
 * first real discovery run put an operator id into a checkpoint through a route
 * nobody had thought about; a whole-artifact scan catches the next such route
 * without anyone having to predict it.
 *
 * Failing loudly is the right behaviour. An artifact is committed to a
 * repository, so emitting one with a credential in it is not recoverable by
 * noticing later.
 */
const assertNoSecretsLeaked = (
  artifact: CapabilityArtifact,
  parameters: readonly DiscoveryParameter[]
): void => {
  const secrets = parameters.filter(
    (parameter) =>
      parameter.sensitivity === "secret" && parameter.value.length >= 3
  )
  if (secrets.length === 0) return

  const serialised = JSON.stringify(artifact)
  const leaked = secrets.filter((secret) => serialised.includes(secret.value))

  if (leaked.length > 0) {
    throw new Error(
      `Refusing to emit a capability containing declared secret(s): ` +
        `${leaked.map((secret) => secret.name).join(", ")}. ` +
        "A credential reached the artifact through an unparameterised field."
    )
  }
}
