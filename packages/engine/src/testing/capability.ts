import {
  CapabilityArtifact,
  DeclaredOutcome,
  Health,
  InputParam,
  OutputField,
  PolicyBinding,
  Provenance,
  Recovery,
  Step,
  TargetBinding,
  TargetDescriptor,
  type Condition,
} from "@workspace/contracts"

import type { Vault } from "../replay/bindings.js"

/**
 * A capability written by hand rather than taken from a discovery run.
 *
 * It lives in `src/testing` rather than beside one suite because more than one
 * suite needs it — the replay taxonomy tests and the live-takeover test both
 * need an artifact whose every branch is reachable, and duplicating it would
 * mean two artifacts drifting apart.
 *
 * Every branch of the result taxonomy needs something to exercise it, and a
 * single recorded run only ever demonstrates the path it happened to take. This
 * one declares both business outcomes and a recovery, so the executor's decision
 * ordering can be tested directly.
 */

export const testVault: Vault = {
  resolve: (ref) =>
    ({ operatorId: "teller01", operatorPassword: "demo-pass" })[ref],
}

const descriptor = (
  fields: Partial<ConstructorParameters<typeof TargetDescriptor>[0]>
) =>
  new TargetDescriptor({
    description: "target",
    frame: [],
    anchors: [],
    fallbacks: [],
    ...fields,
  })

const textPresent = (text: string): Condition => ({ _tag: "textPresent", text })

const field = (label: string, controlName: string) =>
  descriptor({
    description: `${label} field`,
    frame: ["contentFrame"],
    role: "textbox",
    anchors: [
      {
        relation: "rightOf",
        role: "cell",
        match: { text: label, exact: true },
      },
    ],
    fallbacks: [{ _tag: "controlName", name: controlName }],
  })

const button = (label: string) =>
  descriptor({
    description: `${label} button`,
    frame: ["contentFrame"],
    role: "button",
    name: { text: label, exact: true },
  })

/**
 * The capability under test, written by hand rather than taken from a discovery
 * run so every branch of the taxonomy has something to exercise — declared
 * outcomes for not-found and permission-denied, and a recovery for the
 * maintenance interstitial.
 */
export const buildTestCapability = () =>
  new CapabilityArtifact({
    schemaVersion: "capability/v1",
    id: "cap_lookup",
    name: "lookupMemberSavingsBalance",
    version: "1.0.0",
    status: "approved",
    description: "Look up a member and read their savings balance.",

    target: new TargetBinding({
      surfaceKind: "legacy-web",
      vendorProduct: "corebank",
      tenant: null,
      entryPoint: "{{baseUrl}}/firstcity/login",
    }),

    inputs: [
      new InputParam({
        name: "memberId",
        type: "string",
        description: "Member number.",
        required: true,
        pattern: "^\\d+$",
        sensitivity: "identifier",
      }),
    ],
    outputs: [
      new OutputField({
        name: "savingsBalance",
        type: "string",
        format: "currency-usd",
        description: "Current savings balance.",
        sensitivity: "financial",
      }),
    ],

    outcomes: [
      new DeclaredOutcome({
        tag: "MemberNotFound",
        description: "No member exists with that number.",
        detect: textPresent("No member found for"),
        partialOutputs: [],
      }),
      new DeclaredOutcome({
        tag: "AccountRestricted",
        description: "The operator may not view this member.",
        detect: textPresent("is restricted"),
        partialOutputs: [],
      }),
    ],

    steps: [
      new Step({
        id: "s1",
        intent: "Open the servicing desk sign-on page.",
        action: {
          _tag: "navigate",
          // Referenced, not repeated: an overlay changes `target.entryPoint`
          // and this step follows it. Writing the URL out here again is what
          // makes a capability silently open the tenant it was recorded against.
          url: { _tag: "template", text: "{{entryPoint}}" },
        },
        riskClass: "safe",
        checkpoint: textPresent("Sign On"),
        timeoutMs: 10_000,
      }),
      new Step({
        id: "s2",
        intent: "Enter the operator id.",
        action: {
          _tag: "type",
          target: descriptor({
            description: "Operator ID field",
            role: "textbox",
            anchors: [
              {
                relation: "rightOf",
                role: "cell",
                match: { text: "Operator ID", exact: true },
              },
            ],
          }),
          value: { _tag: "secret", ref: "operatorId" },
          clearFirst: true,
        },
        riskClass: "safe",
        timeoutMs: 10_000,
      }),
      new Step({
        id: "s3",
        intent: "Enter the operator password.",
        action: {
          _tag: "type",
          target: descriptor({
            description: "Password field",
            role: "textbox",
            anchors: [
              {
                relation: "rightOf",
                role: "cell",
                match: { text: "Password", exact: true },
              },
            ],
            fallbacks: [{ _tag: "controlName", name: "f1_ctl02" }],
          }),
          value: { _tag: "secret", ref: "operatorPassword" },
          clearFirst: true,
        },
        riskClass: "safe",
        timeoutMs: 10_000,
      }),
      new Step({
        id: "s4",
        intent: "Sign on to reach the servicing desk.",
        action: {
          _tag: "click",
          target: descriptor({
            description: "Sign On button",
            role: "button",
            name: { text: "Sign On", exact: true },
          }),
        },
        riskClass: "safe",
        checkpoint: textPresent("Member Search"),
        timeoutMs: 10_000,
      }),
      new Step({
        id: "s5",
        intent: "Enter the member number being looked up.",
        action: {
          _tag: "type",
          target: field("Member Number", "f1_ctl03"),
          value: { _tag: "param", name: "memberId" },
          clearFirst: true,
        },
        riskClass: "safe",
        checkpoint: {
          _tag: "valueEquals",
          target: field("Member Number", "f1_ctl03"),
          expected: { _tag: "param", name: "memberId" },
        },
        timeoutMs: 10_000,
      }),
      new Step({
        id: "s6",
        intent: "Run the member search.",
        action: { _tag: "click", target: button("Search") },
        riskClass: "safe",
        checkpoint: textPresent("Current Balance"),
        timeoutMs: 10_000,
      }),
      new Step({
        id: "s7",
        intent: "Read the savings balance from the accounts table.",
        action: {
          _tag: "extract",
          target: descriptor({
            description: "Savings balance cell",
            frame: ["contentFrame"],
            role: "cell",
            anchors: [
              {
                relation: "rightOf",
                role: "cell",
                match: { text: "S-0001-{{memberId}}", exact: true },
              },
            ],
            nth: 1,
          }),
          output: "savingsBalance",
          as: "currency-usd",
        },
        riskClass: "safe",
        timeoutMs: 10_000,
      }),
    ],

    recoveries: [
      new Recovery({
        name: "dismiss-maintenance-notice",
        when: textPresent("Scheduled maintenance"),
        /**
         * Deliberately not frame-scoped. An interstitial replaces the whole
         * document, so the frame the flow was working in does not exist while it
         * is showing — a recovery pinned to `contentFrame` would resolve nothing
         * and quietly do nothing.
         */
        do: [
          {
            _tag: "click",
            target: descriptor({
              description: "Continue button on the maintenance notice",
              role: "button",
              name: { text: "Continue", exact: true },
            }),
          },
        ],
        maxPerRun: 2,
      }),
    ],

    successCondition: textPresent("Current Balance"),

    policy: new PolicyBinding({
      allowlistRef: "corebank-readonly",
      maxRiskClass: "safe",
      requiresApproval: false,
    }),

    provenance: new Provenance({
      discoveredBy: "hand-written-for-test",
      discoveredAt: "2026-08-21T00:00:00.000Z",
      runId: "test",
      transcriptDigest: "sha256:test",
    }),

    health: new Health({ replays: 0, successes: 0, fallbackHitRate: {} }),
  })

export { descriptor, textPresent, field, button }
