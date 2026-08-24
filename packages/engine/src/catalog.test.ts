import {
  CapabilityArtifact,
  DeclaredOutcome,
  InputParam,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"

import { declarationFor } from "./catalog.js"
import { buildTestCapability } from "./testing/capability.js"

/**
 * What a customer-facing agent is handed.
 *
 * The declaration is derived from the artifact, so these tests are really about
 * one claim: everything an agent is told is something the system will actually
 * honour. A description written by hand beside the artifact would drift; a
 * derived one cannot.
 */

describe("deriving a tool declaration", () => {
  it("calls the capability by the name an agent invokes", () => {
    const declaration = declarationFor(buildTestCapability())

    expect(declaration.name).toBe("lookupMemberSavingsBalance")
  })

  it("publishes the input pattern, not just the type", () => {
    const declaration = declarationFor(buildTestCapability())
    const memberId = declaration.parametersJsonSchema.properties["memberId"] as {
      type: string
      pattern?: string
    }

    // The pattern is part of the contract. Publishing it means a capable model
    // gets the format right on the first call instead of learning it from a
    // rejection — and the *same* pattern rejects the call server-side.
    expect(memberId.type).toBe("string")
    expect(memberId.pattern).toBe("^\\d+$")
    expect(declaration.parametersJsonSchema.required).toContain("memberId")
  })

  it("refuses arguments the capability never declared", () => {
    const declaration = declarationFor(buildTestCapability())

    // A model that invents an extra argument should be told, not humoured.
    expect(declaration.parametersJsonSchema.additionalProperties).toBe(false)
  })

  it("tells the agent which answers are outcomes rather than errors", () => {
    const declaration = declarationFor(buildTestCapability())

    /**
     * The single most important line in the declaration. An agent that treats
     * "no such member" as a failure will retry something that can never succeed,
     * and will page a human about a working system.
     */
    expect(declaration.description).toContain("MemberNotFound")
    expect(declaration.description).toContain("must not be retried")
  })

  it("says when a capability has not been reviewed by a person", () => {
    const base = buildTestCapability()

    const draft = declarationFor(
      new CapabilityArtifact({ ...base, status: "draft" })
    )
    const approved = declarationFor(
      new CapabilityArtifact({ ...base, status: "approved" })
    )

    // An agent choosing between two capabilities should know one of them was
    // written by a model and read by nobody.
    expect(draft.description).toContain("draft")
    expect(approved.description).not.toContain("Status:")
  })

  it("renders replay placeholders in a form a model can read", () => {
    const base = buildTestCapability()
    const declaration = declarationFor(
      new CapabilityArtifact({
        ...base,
        description: "Looks up member {{memberId}} and reads their balance.",
      })
    )

    // `{{memberId}}` is an instruction to the replay engine and noise to a
    // model. `<memberId>` says the same thing in a convention it understands.
    expect(declaration.description).toContain("<memberId>")
    expect(declaration.description).not.toContain("{{")
  })

  it("marks an optional input as not required", () => {
    const base = buildTestCapability()
    const declaration = declarationFor(
      new CapabilityArtifact({
        ...base,
        inputs: [
          ...base.inputs,
          new InputParam({
            name: "branch",
            type: "string",
            description: "Optional branch filter.",
            required: false,
            sensitivity: "none",
          }),
        ],
      })
    )

    expect(
      Object.keys(declaration.parametersJsonSchema.properties)
    ).toContain("branch")
    expect(declaration.parametersJsonSchema.required).not.toContain("branch")
  })

  it("omits the outcome sentence when a capability declares none", () => {
    const base = buildTestCapability()
    const declaration = declarationFor(
      new CapabilityArtifact({ ...base, outcomes: [] as DeclaredOutcome[] })
    )

    // Saying nothing is right here: a capability with no declared outcomes has
    // only ever seen its happy path, and inventing reassurance would be worse
    // than silence.
    expect(declaration.description).not.toContain("must not be retried")
  })
})
