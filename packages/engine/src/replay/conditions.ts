import {
  allNodes,
  nodeText,
  type Condition,
  type LeafCondition,
  type Observation,
} from "@workspace/contracts"
import type { Surface } from "@workspace/surface"
import { Effect } from "effect"

import {
  resolveValueRef,
  substitute,
  substituteDescriptor,
  type Bindings,
} from "./bindings.js"

/**
 * Evaluating a condition against what is on screen.
 *
 * One evaluator serves all four uses — step checkpoints, declared business
 * outcomes, recovery triggers, and the success condition — which is what allows
 * the executor to run them in a fixed priority order after every step instead of
 * scattering bespoke checks through the flow.
 *
 * Every result carries a human-readable `detail`. That is not decoration: it
 * becomes the `observed` field of a `CheckpointFailed`, and the difference
 * between an error a person can act on and one they have to reproduce.
 */

export interface ConditionResult {
  readonly passed: boolean
  /** What was actually seen, phrased for whoever reads the failure. */
  readonly detail: string
}

export interface EvalContext {
  readonly observation: Observation
  readonly surface: Surface
  readonly bindings: Bindings
}

/** All readable text on screen, across every frame. */
const screenText = (observation: Observation): string =>
  allNodes(observation)
    .map((node) => nodeText(node))
    .filter((text) => text.trim().length > 0)
    .join(" | ")

const excerpt = (value: string, limit = 160): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`

const evaluateLeaf = (
  condition: LeafCondition,
  context: EvalContext
): Effect.Effect<ConditionResult, never> =>
  Effect.gen(function* () {
    const { observation, surface, bindings } = context

    switch (condition._tag) {
      case "urlMatches": {
        const pattern = substitute(condition.pattern, bindings)
        // Recorded patterns are usually plain URLs, so they are matched as
        // substrings first and only then as regular expressions. A URL contains
        // `?` and `.`, which would otherwise quietly turn into wildcards.
        const passed =
          observation.url.includes(pattern) ||
          safeRegex(pattern)?.test(observation.url) === true

        return {
          passed,
          detail: passed
            ? `url is ${observation.url}`
            : `expected url matching ${pattern}, saw ${observation.url}`,
        }
      }

      case "textPresent": {
        const text = substitute(condition.text, bindings)
        const haystack = screenText(observation)
        const passed = haystack.toLowerCase().includes(text.toLowerCase())

        return {
          passed,
          detail: passed
            ? `found "${text}"`
            : `expected "${text}" on screen; screen reads: ${excerpt(haystack)}`,
        }
      }

      case "textAbsent": {
        const text = substitute(condition.text, bindings)
        const passed = !screenText(observation)
          .toLowerCase()
          .includes(text.toLowerCase())

        return {
          passed,
          detail: passed ? `"${text}" is absent` : `"${text}" is present`,
        }
      }

      case "elementPresent":
      case "elementAbsent": {
        const resolved = yield* surface
          .resolve(substituteDescriptor(condition.target, bindings))
          .pipe(Effect.either)
        const found = resolved._tag === "Right"
        const passed = condition._tag === "elementPresent" ? found : !found

        return {
          passed,
          detail: `${condition.target.description} was ${found ? "found" : "not found"}`,
        }
      }

      case "valueEquals": {
        const expected = resolveValueRef(condition.expected, bindings)
        const resolved = yield* surface
          .resolve(substituteDescriptor(condition.target, bindings))
          .pipe(Effect.either)

        if (resolved._tag === "Left") {
          return {
            passed: false,
            detail: `could not find ${condition.target.description} to check its value`,
          }
        }

        const actual = yield* surface
          .read(resolved.right.handle)
          .pipe(Effect.catchAll(() => Effect.succeed("")))

        // A field's text and its value differ across control types, so both are
        // accepted; the point is to catch a field that silently took nothing.
        const passed =
          actual.trim() === expected.trim() || actual.includes(expected)

        return {
          passed,
          // The expected value is not quoted back — it may be a credential.
          detail: passed
            ? `${condition.target.description} holds the expected value`
            : `${condition.target.description} does not hold the expected value`,
        }
      }

      case "httpStatusIn": {
        const status = observation.httpStatus
        const passed =
          status !== undefined && condition.statuses.includes(status)

        return {
          passed,
          detail:
            status === undefined
              ? "no http status observed"
              : `http status was ${status}`,
        }
      }
    }
  })

const safeRegex = (pattern: string): RegExp | undefined => {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

export const evaluateCondition = (
  condition: Condition,
  context: EvalContext
): Effect.Effect<ConditionResult, never> =>
  Effect.gen(function* () {
    switch (condition._tag) {
      case "all": {
        const results = yield* Effect.all(
          condition.of.map((leaf) => evaluateLeaf(leaf, context))
        )
        const failed = results.filter((result) => !result.passed)

        return failed.length === 0
          ? { passed: true, detail: results.map((r) => r.detail).join("; ") }
          : { passed: false, detail: failed.map((r) => r.detail).join("; ") }
      }

      case "any": {
        const results = yield* Effect.all(
          condition.of.map((leaf) => evaluateLeaf(leaf, context))
        )
        const passed = results.some((result) => result.passed)

        return { passed, detail: results.map((r) => r.detail).join(" | ") }
      }

      case "not": {
        const result = yield* evaluateLeaf(condition.condition, context)
        return { passed: !result.passed, detail: `not(${result.detail})` }
      }

      default:
        return yield* evaluateLeaf(condition, context)
    }
  })

/** Describe a condition for a failure message, without resolving secrets into it. */
export const describeCondition = (condition: Condition): string => {
  switch (condition._tag) {
    case "urlMatches":
      return `url matches ${condition.pattern}`
    case "textPresent":
      return `"${condition.text}" on screen`
    case "textAbsent":
      return `"${condition.text}" absent`
    case "elementPresent":
      return `${condition.target.description} present`
    case "elementAbsent":
      return `${condition.target.description} absent`
    case "valueEquals":
      return `${condition.target.description} holds the expected value`
    case "httpStatusIn":
      return `http status in ${condition.statuses.join(", ")}`
    case "all":
      return condition.of.map(describeCondition).join(" and ")
    case "any":
      return condition.of.map(describeCondition).join(" or ")
    case "not":
      return `not ${describeCondition(condition.condition)}`
  }
}
