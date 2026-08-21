import {
  TargetDescriptor,
  type CapabilityArtifact,
  type ReplayOutputs,
  type ValueRef,
} from "@workspace/contracts"

/**
 * Turning the references in an artifact back into concrete values.
 *
 * A recorded step never holds a value — it holds a reference to one. That is what
 * makes a capability reusable and what keeps credentials out of a file we commit,
 * but it means replay needs one honest place where references become real
 * strings, and one place where the resulting mistakes can be reported without
 * echoing a secret into a log.
 */

/** Where secrets come from. Deliberately an interface, not an implementation. */
export interface Vault {
  readonly resolve: (ref: string) => string | undefined
}

/**
 * Reads secrets from the environment, e.g. `operatorPassword` →
 * `CUA_SECRET_OPERATORPASSWORD`.
 *
 * A real deployment would put a managed secret store behind this interface. The
 * shape is what matters: replay asks for a *reference*, never for a value, so
 * the artifact and the store stay separate and the credential exists only in
 * memory for the moment it is typed.
 */
export const envVault = (prefix = "CUA_SECRET_"): Vault => ({
  resolve: (ref) => process.env[`${prefix}${ref.toUpperCase()}`],
})

export interface Bindings {
  readonly baseUrl: string
  readonly inputs: Record<string, string>
  readonly outputs: ReplayOutputs
  readonly vault: Vault
}

export class ValueResolutionError extends Error {
  constructor(
    readonly reference: string,
    message: string
  ) {
    super(message)
    this.name = "ValueResolutionError"
  }
}

/**
 * Substitute `{{name}}` placeholders.
 *
 * Placeholders appear in checkpoint text, success conditions, and inside
 * `template` values such as a URL that embeds a member id. `baseUrl` is
 * available to every artifact so one recording can point at a different
 * institution's install.
 */
export const substitute = (text: string, bindings: Bindings): string =>
  text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (name === "baseUrl") return bindings.baseUrl

    const input = bindings.inputs[name]
    if (input !== undefined) return input

    const output = bindings.outputs[name]
    if (output !== undefined && output !== null) return String(output)

    const secret = bindings.vault.resolve(name)
    if (secret !== undefined) return secret

    // Leaving the placeholder intact is deliberate: a checkpoint that silently
    // matched the literal text "{{memberId}}" would be worse than one that fails.
    return whole
  })

/**
 * Substitute placeholders inside a target descriptor.
 *
 * Descriptors carry text too, and it is just as parameterised as a checkpoint:
 * the savings row is found by anchoring on the account number, which embeds the
 * member id. Without this the anchor would look for the literal characters
 * "{{memberId}}" and resolve nothing.
 */
export const substituteDescriptor = (
  descriptor: TargetDescriptor,
  bindings: Bindings
): TargetDescriptor =>
  new TargetDescriptor({
    ...descriptor,
    name: descriptor.name
      ? { ...descriptor.name, text: substitute(descriptor.name.text, bindings) }
      : undefined,
    anchors: descriptor.anchors.map((anchor) => ({
      ...anchor,
      match: { ...anchor.match, text: substitute(anchor.match.text, bindings) },
    })),
  })

export const resolveValueRef = (ref: ValueRef, bindings: Bindings): string => {
  switch (ref._tag) {
    case "literal":
      return ref.value

    case "param": {
      const value = bindings.inputs[ref.name]
      if (value === undefined) {
        throw new ValueResolutionError(
          ref.name,
          `No value supplied for input "${ref.name}".`
        )
      }
      return value
    }

    case "secret": {
      const value = bindings.vault.resolve(ref.ref)
      if (value === undefined) {
        throw new ValueResolutionError(
          ref.ref,
          `No secret available for "${ref.ref}". Set CUA_SECRET_${ref.ref.toUpperCase()}.`
        )
      }
      return value
    }

    case "output": {
      const value = bindings.outputs[ref.name]
      if (value === undefined || value === null) {
        throw new ValueResolutionError(
          ref.name,
          `Step referenced output "${ref.name}", which no earlier step produced.`
        )
      }
      return String(value)
    }

    case "template":
      return substitute(ref.text, bindings)
  }
}

/**
 * Values that must never appear in a trace, an error message, or a screenshot.
 *
 * Collected from what the artifact *declares* rather than guessed from shape, so
 * the redactor masks the operator password because the capability said it was a
 * secret — not because it happened to look like one.
 */
export const sensitiveValues = (
  artifact: CapabilityArtifact,
  bindings: Bindings
): readonly string[] => {
  const values: string[] = []

  for (const step of artifact.steps) {
    const ref = "value" in step.action ? step.action.value : undefined
    if (ref?._tag === "secret") {
      const resolved = bindings.vault.resolve(ref.ref)
      if (resolved) values.push(resolved)
    }
  }

  for (const input of artifact.inputs) {
    if (input.sensitivity === "none") continue
    const value = bindings.inputs[input.name]
    if (value) values.push(value)
  }

  return values
}

/**
 * Validate supplied inputs against the declared contract *before* opening a
 * browser, so a bad call costs nothing and changes nothing.
 */
export const validateInputs = (
  artifact: CapabilityArtifact,
  supplied: Record<string, string>
): readonly string[] => {
  const issues: string[] = []

  for (const input of artifact.inputs) {
    const value = supplied[input.name]

    if (value === undefined || value === "") {
      if (input.required) issues.push(`Missing required input "${input.name}".`)
      continue
    }

    if (input.pattern && !new RegExp(input.pattern).test(value)) {
      // The value itself is not quoted back: an input can be regulated data.
      issues.push(`Input "${input.name}" does not match ${input.pattern}.`)
    }
  }

  const declared = new Set(artifact.inputs.map((input) => input.name))
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) issues.push(`Unknown input "${name}".`)
  }

  return issues
}
