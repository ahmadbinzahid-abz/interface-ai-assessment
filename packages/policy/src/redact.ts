/**
 * Redaction at the evidence boundary.
 *
 * Everything this system writes down — traces, observations, screenshots'
 * metadata, model transcripts — passes through here on its way to disk. Making
 * it a boundary rather than a discipline is the point: there is no code path
 * that writes evidence without redacting, so "remember to mask the SSN" is not
 * something a future contributor can forget.
 *
 * Two mechanisms, because neither is sufficient alone:
 *
 *  - **Pattern-based** catches regulated data we did not know was on the page.
 *    It has false negatives by nature; an account number format we have not
 *    seen will get through.
 *  - **Value-based** masks the specific strings we know are sensitive, because
 *    the capability declared them — every input marked `pii`/`financial`, and
 *    every resolved secret. This is exact, and it is why declaring sensitivity
 *    in the artifact is load-bearing rather than documentation.
 */

export interface RedactionRule {
  readonly name: string
  readonly pattern: RegExp
  readonly replace: (match: string) => string
}

const mask = (label: string) => () => `[redacted:${label}]`

/**
 * Card numbers are checked against Luhn rather than matched by length alone, so
 * that a 16-digit reference number is not mangled while a real PAN is.
 */
const luhnValid = (digits: string): boolean => {
  if (digits.length < 13 || digits.length > 19) return false

  let sum = 0
  let double = false

  for (let i = digits.length - 1; i >= 0; i--) {
    const char = digits[i]
    if (char === undefined) return false

    let value = char.charCodeAt(0) - 48
    if (value < 0 || value > 9) return false

    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }

    sum += value
    double = !double
  }

  return sum % 10 === 0
}

export const defaultRules: readonly RedactionRule[] = [
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: mask("ssn"),
  },
  {
    name: "card",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    replace: (match) =>
      luhnValid(match.replace(/[^0-9]/g, "")) ? "[redacted:card]" : match,
  },
  {
    name: "email",
    pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,
    replace: mask("email"),
  },
  {
    name: "account-number",
    // Long bare digit runs that survived the card rule.
    pattern: /\b\d{9,}\b/g,
    replace: mask("account-number"),
  },
]

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export interface RedactorOptions {
  /** Exact strings to mask wherever they appear. Resolved secrets and declared PII. */
  readonly values?: readonly string[]
  readonly rules?: readonly RedactionRule[]
}

export interface Redactor {
  readonly text: (value: string) => string
  /** Redacts every string inside an arbitrary structure, keys included. */
  readonly deep: <A>(value: A) => A
}

export const makeRedactor = ({
  values = [],
  rules = defaultRules,
}: RedactorOptions = {}): Redactor => {
  // Longest first, so masking "12345" does not leave fragments of "123456".
  const declared = [...values]
    .filter((value) => value.trim().length >= 3)
    .sort((a, b) => b.length - a.length)

  const text = (value: string): string => {
    let out = value

    for (const declaredValue of declared) {
      out = out.replace(
        new RegExp(escapeRegExp(declaredValue), "g"),
        "[redacted:declared]"
      )
    }

    for (const rule of rules) {
      out = out.replace(rule.pattern, (match) => rule.replace(match))
    }

    return out
  }

  const deep = <A>(value: A): A => {
    if (typeof value === "string") return text(value) as A
    if (Array.isArray(value)) return value.map((item) => deep(item)) as A

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          deep(item),
        ])
      ) as A
    }

    return value
  }

  return { text, deep }
}
