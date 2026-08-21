import type { ToolDeclaration } from "../model.js"

/**
 * The tool surface the model drives the application through.
 *
 * Three properties are deliberate:
 *
 *  - **Controls are referenced by number, never by selector.** The model points
 *    at what it can see; the recorder decides how that becomes a durable target.
 *  - **Every acting tool demands a `why`.** It becomes the step's `intent`, which
 *    is what makes the finished artifact reviewable by someone who was not there.
 *    Requiring it also measurably improves the model's own choices.
 *  - **`escalate` is a first-class option, not a failure path.** A model that can
 *    only succeed or flail will flail; giving "hand this to a human" the same
 *    standing as any other tool is what makes the guardrail workable rather than
 *    something to be argued around.
 */

const ref = {
  type: "integer",
  description:
    "The #number of the control, exactly as shown in the current view.",
}

const why = {
  type: "string",
  description:
    "One sentence, in plain English, on why this step is needed. This is recorded as " +
    "the step's intent and will be read by a human reviewing the capability.",
}

const exploratory = {
  type: "boolean",
  description:
    "Set true if this step is only to learn how the application behaves — for " +
    "example searching a deliberately invalid value to find the 'not found' " +
    "screen. Exploratory steps are remembered as evidence and inform the declared " +
    "outcomes, but are left out of the saved flow so replay does not repeat them.",
}

const expect = {
  type: "string",
  description:
    "Optional. Distinctive text you expect to see afterwards if this step worked. " +
    "It becomes the step's checkpoint, so prefer something specific to the resulting " +
    "screen over something present on every page.",
}

export const discoveryTools: readonly ToolDeclaration[] = [
  {
    name: "observe",
    description:
      "Re-read the current screen. Use when you want to look again without acting; " +
      "every other tool already returns the updated screen.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "navigate",
    description: "Go to a URL. Only URLs permitted by policy will be allowed.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, why },
      required: ["url", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click a control.",
    parameters: {
      type: "object",
      properties: { ref, why, expect, exploratory },
      required: ["ref", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Type text into a field, replacing anything already there. If the value came " +
      "from the task inputs, pass it exactly as given so it can be recorded as a " +
      "parameter rather than hard-coded.",
    parameters: {
      type: "object",
      properties: { ref, value: { type: "string" }, why, expect, exploratory },
      required: ["ref", "value", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description: "Choose an option in a dropdown.",
    parameters: {
      type: "object",
      properties: { ref, value: { type: "string" }, why, expect, exploratory },
      required: ["ref", "value", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "extract",
    description:
      "Record a value on screen as one of this capability's outputs. This is how the " +
      "calling agent gets an answer back, so extract everything the goal asks for.",
    parameters: {
      type: "object",
      properties: {
        ref,
        output: {
          type: "string",
          description: "Output name in camelCase, e.g. savingsBalance.",
        },
        format: {
          type: "string",
          enum: [
            "text",
            "integer",
            "decimal",
            "currency-usd",
            "date-iso",
            "boolean",
          ],
        },
        description: {
          type: "string",
          description: "What this output means to a caller.",
        },
        why,
      },
      required: ["ref", "output", "format", "description", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "declare_outcome",
    description:
      "Record a legitimate non-success answer this capability can return — for example " +
      "'no such member' or 'permission denied'. These are results the calling agent " +
      "needs, not errors. Declare one whenever you see such a screen, or when you are " +
      "confident the application has one.",
    parameters: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          description:
            "PascalCase discriminant the caller matches on, e.g. MemberNotFound.",
        },
        description: { type: "string" },
        whenText: {
          type: "string",
          description:
            "Distinctive text that appears on screen when this outcome occurs.",
        },
      },
      required: ["tag", "description", "whenText"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate",
    description:
      "Hand the session to a human operator. Use this when you are stuck, when policy " +
      "refuses something the task needs, or when a step would be irreversible. This is " +
      "a legitimate outcome, not a failure.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "What you need a person to do, and why.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description:
      "The goal is met. Call this once you are on the screen that proves it.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What the capability does, for its catalog entry.",
        },
        successText: {
          type: "string",
          description:
            "Distinctive text on the final screen that proves the goal was reached. " +
            "This becomes the capability's success condition.",
        },
      },
      required: ["summary", "successText"],
      additionalProperties: false,
    },
  },
  {
    name: "give_up",
    description:
      "The goal cannot be met on this application. Explain what blocked you.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
]
