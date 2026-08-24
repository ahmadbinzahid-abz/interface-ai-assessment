import type { CapabilityArtifact, InputParam } from "@workspace/contracts"

/**
 * The catalog a customer-facing agent sees.
 *
 * This is the payoff for everything the artifact schema insists on. A capability
 * already declares its name, its typed inputs with patterns, its typed outputs
 * and the non-success answers a caller is entitled to — which is exactly, and
 * not coincidentally, what a tool declaration needs. So the declaration is
 * *derived*, never written: an agent's view of what it can do cannot drift from
 * what the system will actually execute, because there is nothing to keep in
 * sync.
 *
 * The shape emitted is plain JSON Schema, which is what Gemini's
 * `parametersJsonSchema` takes and what OpenAI, Anthropic and MCP all accept
 * with trivial reshaping. Nothing here imports a model SDK — a catalog that
 * depended on one provider would be the wrong thing to build on.
 */

export interface CapabilityDeclaration {
  readonly name: string
  readonly description: string
  readonly parametersJsonSchema: {
    readonly type: "object"
    readonly properties: Record<string, unknown>
    readonly required: readonly string[]
    readonly additionalProperties: false
  }
}

const propertyFor = (input: InputParam): Record<string, unknown> => ({
  type:
    input.type === "number"
      ? "number"
      : input.type === "boolean"
        ? "boolean"
        : "string",
  description: readablePlaceholders(input.description),
  // The pattern is part of the contract, not a hint. Publishing it means a
  // capable model gets the format right on the first call instead of learning
  // it from a rejection.
  ...(input.pattern ? { pattern: input.pattern } : {}),
})

/**
 * Placeholders are for the replay engine, not for the model reading this.
 *
 * A description saying "looked up member {{memberId}}" is correct and unhelpful:
 * `{{…}}` means nothing to a calling agent. Rendered as `<memberId>` it becomes
 * the widely understood convention for "this slot is filled by that argument",
 * which is exactly what it is.
 */
const readablePlaceholders = (text: string): string =>
  text.replace(/\{\{(\w+)\}\}/g, "<$1>")

/**
 * What the agent is told this capability *returns*, in prose.
 *
 * Deliberately part of the description rather than a separate schema: a tool
 * declaration has no standard place to describe a return shape, and the one
 * thing a calling agent must know is that a declared outcome is a legitimate
 * answer rather than an error to retry. Saying so in the description is the only
 * place the model will reliably read it.
 */
const describeContract = (artifact: CapabilityArtifact): string => {
  const returns = artifact.outputs
    .map((output) => `${output.name} (${output.type})`)
    .join(", ")

  const outcomes = artifact.outcomes
    .map(
      (outcome) =>
        `${outcome.tag} — ${readablePlaceholders(outcome.description)}`
    )
    .join("; ")

  return [
    readablePlaceholders(artifact.description),
    returns ? `Returns: ${returns}.` : undefined,
    outcomes
      ? `May instead answer with one of these outcomes, which are legitimate ` +
        `results and must not be retried: ${outcomes}.`
      : undefined,
    artifact.status === "approved"
      ? undefined
      : // An agent choosing between two capabilities should know one of them has
        // not been reviewed by a person yet.
        `Status: ${artifact.status} — not yet approved for unattended use of ` +
        `anything beyond safe actions.`,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ")
}

export const declarationFor = (
  artifact: CapabilityArtifact
): CapabilityDeclaration => ({
  name: artifact.name,
  description: describeContract(artifact),
  parametersJsonSchema: {
    type: "object",
    properties: Object.fromEntries(
      artifact.inputs.map((input) => [input.name, propertyFor(input)])
    ),
    required: artifact.inputs
      .filter((input) => input.required)
      .map((input) => input.name),
    // A model that invents an extra argument should be told, not humoured.
    additionalProperties: false,
  },
})

export const declarationsFor = (
  artifacts: readonly CapabilityArtifact[]
): readonly CapabilityDeclaration[] => artifacts.map(declarationFor)
