import { describe, expect, it } from "vitest"

import { coreBankReadonly } from "./allowlist.js"
import { classifyRisk, decide, type PolicyContext } from "./decide.js"
import { makeRedactor } from "./redact.js"

const discovery: PolicyContext = { phase: "discovery", maxRiskClass: "safe" }
const replay: PolicyContext = {
  phase: "replay",
  maxRiskClass: "risky",
  artifactApproved: true,
}

const url = (path: string) => `http://localhost:4100${path}`

describe("risk classification", () => {
  it("treats reading and typing as safe regardless of the control", () => {
    expect(
      classifyRisk(coreBankReadonly, {
        kind: "type",
        url: url("/firstcity/desk"),
        targetLabel: "Close Account",
      })
    ).toBe("safe")

    expect(
      classifyRisk(coreBankReadonly, {
        kind: "extract",
        url: url("/firstcity/desk"),
      })
    ).toBe("safe")
  })

  it("judges a click by what the control says", () => {
    expect(
      classifyRisk(coreBankReadonly, {
        kind: "click",
        url: url("/firstcity/desk"),
        targetLabel: "Search",
      })
    ).toBe("safe")

    expect(
      classifyRisk(coreBankReadonly, {
        kind: "click",
        url: url("/firstcity/desk"),
        targetLabel: "Continue",
      })
    ).toBe("risky")

    expect(
      classifyRisk(coreBankReadonly, {
        kind: "click",
        url: url("/firstcity/desk"),
        targetLabel: "Close Account",
      })
    ).toBe("irreversible")
  })
})

describe("the allowlist", () => {
  it("permits an ordinary navigation inside the tenant namespace", () => {
    const decision = decide(coreBankReadonly, discovery, {
      kind: "navigate",
      url: url("/firstcity/login"),
    })

    expect(decision._tag).toBe("Allow")
  })

  it("refuses an origin nobody listed", () => {
    const decision = decide(coreBankReadonly, discovery, {
      kind: "navigate",
      url: "https://example.com/anything",
    })

    expect(decision).toMatchObject({ _tag: "Deny", rule: "allowedOrigins" })
  })

  it("refuses the fault-injection hooks, which are not application surface", () => {
    const decision = decide(coreBankReadonly, discovery, {
      kind: "navigate",
      url: url("/__control/fault"),
    })

    expect(decision).toMatchObject({ _tag: "Deny", rule: "deniedPaths" })
  })

  it("refuses a path outside the tenant namespace", () => {
    const decision = decide(coreBankReadonly, discovery, {
      kind: "navigate",
      url: url("/admin/users"),
    })

    expect(decision).toMatchObject({ _tag: "Deny", rule: "allowedPaths" })
  })

  it("refuses an action kind the policy does not grant", () => {
    const readOnly = {
      ...coreBankReadonly,
      allowedActions: ["navigate", "extract"] as const,
    }

    const decision = decide(readOnly as typeof coreBankReadonly, discovery, {
      kind: "click",
      url: url("/firstcity/desk"),
      targetLabel: "Search",
    })

    expect(decision).toMatchObject({ _tag: "Deny", rule: "allowedActions" })
  })
})

describe("the risk ladder", () => {
  /**
   * The behaviour the whole safety argument rests on: a model exploring an app
   * may reach the confirmation screen, but may not be the thing that presses the
   * irreversible button.
   */
  it("stops discovery before an irreversible action and tells it to escalate", () => {
    const decision = decide(coreBankReadonly, discovery, {
      kind: "click",
      url: url("/firstcity/desk/member/12345"),
      targetLabel: "Close Account",
    })

    expect(decision._tag).toBe("Deny")
    if (decision._tag !== "Deny") return
    expect(decision.rule).toBe("maxRiskClass")
    expect(decision.reason).toContain("Escalate")
  })

  it("stops discovery at a merely risky action too, under a safe-only limit", () => {
    const decision = decide(coreBankReadonly, discovery, {
      kind: "click",
      url: url("/firstcity/desk/member/12345/subaccount"),
      targetLabel: "Continue",
    })

    expect(decision).toMatchObject({ _tag: "Deny", rule: "maxRiskClass" })
  })

  it("lets an approved replay run a risky step it was recorded with", () => {
    const decision = decide(coreBankReadonly, replay, {
      kind: "click",
      url: url("/firstcity/desk/member/12345/subaccount"),
      targetLabel: "Continue",
    })

    expect(decision).toMatchObject({ _tag: "Allow", riskClass: "risky" })
  })

  it("asks for approval rather than refusing outright during replay", () => {
    const decision = decide(coreBankReadonly, replay, {
      kind: "click",
      url: url("/firstcity/desk/member/12345"),
      targetLabel: "Close Account",
    })

    expect(decision).toMatchObject({
      _tag: "RequireApproval",
      riskClass: "irreversible",
    })
  })

  it("will not run a risky step unattended from an unapproved capability", () => {
    const decision = decide(
      coreBankReadonly,
      { phase: "replay", maxRiskClass: "risky", artifactApproved: false },
      { kind: "click", url: url("/firstcity/desk/x"), targetLabel: "Confirm" }
    )

    expect(decision).toMatchObject({
      _tag: "RequireApproval",
      rule: "artifactApproved",
    })
  })
})

describe("redaction", () => {
  it("masks regulated identifiers found in page text", () => {
    const redact = makeRedactor()

    expect(redact.text("SSN 123-45-6789 on file")).toContain("[redacted:ssn]")
    expect(redact.text("write to dana@example.com")).toContain(
      "[redacted:email]"
    )
  })

  it("distinguishes a real card number from a lookalike reference", () => {
    const redact = makeRedactor()

    // Luhn-valid test number: identified as a card.
    expect(redact.text("card 4111111111111111")).toContain("[redacted:card]")

    // Same length but fails Luhn, so it is not a PAN. It is still masked — a long
    // digit run in a banking application is an account number until proven
    // otherwise — but the label says which rule fired, which is what a reviewer
    // needs when deciding whether redaction is over- or under-reaching.
    const reference = redact.text("ref 1234567812345678")
    expect(reference).toContain("[redacted:account-number]")
    expect(reference).not.toContain("1234567812345678")
  })

  it("leaves short numbers alone, so ordinary text survives", () => {
    const redact = makeRedactor()

    expect(redact.text("branch 0042 opened 2019")).toBe(
      "branch 0042 opened 2019"
    )
  })

  it("masks values the capability declared sensitive, whatever their shape", () => {
    const redact = makeRedactor({ values: ["Dana Whitfield", "hunter2"] })

    const line = redact.text("Signed in as hunter2 for member Dana Whitfield")
    expect(line).not.toContain("hunter2")
    expect(line).not.toContain("Dana Whitfield")
  })

  it("reaches strings nested anywhere in a structure", () => {
    const redact = makeRedactor({ values: ["Dana Whitfield"] })

    const redacted = redact.deep({
      step: "s3",
      observed: { rows: [{ name: "Dana Whitfield", ssn: "123-45-6789" }] },
    })

    expect(JSON.stringify(redacted)).not.toContain("Dana Whitfield")
    expect(JSON.stringify(redacted)).not.toContain("123-45-6789")
  })

  it("ignores very short declared values, which would mask everything", () => {
    const redact = makeRedactor({ values: ["a"] })

    expect(redact.text("a balanced sentence")).toBe("a balanced sentence")
  })
})
