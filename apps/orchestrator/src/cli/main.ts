import { join } from "node:path"
import { parseArgs } from "node:util"

import type { DiscoveryParameter } from "@workspace/engine"
import { config as loadEnv } from "dotenv"

import { REPO_ROOT } from "../paths.js"
import { catalog } from "./catalog.js"
import { discover } from "./discover.js"
import { recompile } from "./recompile.js"
import { replay } from "./replay.js"

// A model API key belongs in an untracked file, not in shell history.
loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true })

/**
 * `cua` — the operator-facing command line.
 *
 * Two commands matter, and the split between them is the whole system:
 * `discover` runs a model against a live application once, and `replay` runs the
 * resulting artifact forever without one.
 */

const USAGE = `cua — computer-use automation

  cua discover --goal <text> --entry <url> --name <capabilityName> [options]

    --goal      What to accomplish, in plain English.
    --entry     Where to start. Must be permitted by policy.
    --name      The name an agent will call this capability by.
    --param     name=value, repeatable. Values typed exactly as given are
                recorded as parameters instead of being hard-coded.
    --secret    name=value, repeatable. Credentials the run needs to sign on.
                Recorded as {$secret} references and masked in evidence, so the
                value never reaches the artifact or the log.
    --version   Semver for the emitted capability. Default 1.0.0.
    --product   Vendor product the recording belongs to. Default corebank.
    --headed    Show the browser.
    --max-turns Stop after this many model turns. Default 30.

  Requires GEMINI_API_KEY.

  cua replay --capability <name@version> [options]

    --capability  File in capabilities/, without the .json — e.g.
                  lookupMemberSavingsBalance@1.0.0
    --input       name=value, repeatable.
    --base-url    Which institution's install to run against. Substituted for
                  {{baseUrl}}. Default http://localhost:4100
    --headed      Show the browser.
    --update-health  Write replay telemetry back into the artifact.
    --live        Open a live-takeover gateway and *wait* for a person when the
                  run gets stuck, instead of ending it. Prints the WebSocket URL
                  an operator console connects to.
    --wait        Milliseconds to wait for an operator before giving up.
                  Only meaningful with --live. Default: wait indefinitely.
    --capture-steps  Screenshot after every step, not only on failure, so a
                  finished run can be looked through frame by frame. Roughly
                  doubles the wall time, which is why it is opt-in.
    --tenant      Run this institution's variant, resolved through
                  capabilities/overlays/<capability>.<tenant>.json. One
                  recording serves every tenant of the same vendor product.

    No model, no API key. Secrets come from CUA_SECRET_<NAME> in the
    environment or .env — never from the artifact.

    Exit codes: 0 succeeded, 1 failed, 2 escalated, 3 business outcome.

  cua catalog [--json]

    Print the capability catalog as an agent sees it: tool declarations with
    typed arguments and the declared outcomes a caller must not retry. Derived
    from the artifacts, never written alongside them. --json emits the exact
    shape a model tool-call API takes.

  cua recompile --run <evidence/…/run.json> --name <capabilityName> [options]

    Re-emit an artifact from a saved recording, through the current compiler.
    No model is called. Takes the same --param/--secret/--entry/--version
    flags as discover, because parameter values are supplied rather than
    stored — the recording deliberately does not contain them.
`

/**
 * `--param memberId=12345` becomes a declared, parameterised input.
 * `--secret password=...` becomes a vault reference the artifact never contains.
 */
const parseParameter = (raw: string, secret = false): DiscoveryParameter => {
  const index = raw.indexOf("=")
  if (index <= 0) {
    throw new Error(`--param expects name=value, got "${raw}"`)
  }

  const name = raw.slice(0, index)
  const value = raw.slice(index + 1)

  return {
    name,
    value,
    description: secret
      ? `Credential resolved from the vault as {$secret:${name}} at replay time.`
      : `Value supplied by the caller for ${name}.`,
    // Identifiers in this domain point at a person, so they are masked in
    // evidence by default. A caller can widen that, never narrow it silently.
    sensitivity: secret ? "secret" : "identifier",
  }
}

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE)
    return command ? 0 : 1
  }

  if (command === "catalog") {
    const { values } = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false } },
      strict: true,
    })

    return catalog({ json: values.json as boolean })
  }

  if (command === "recompile") {
    const { values } = parseArgs({
      args: rest,
      options: {
        run: { type: "string" },
        name: { type: "string" },
        entry: {
          type: "string",
          default: "http://localhost:4100/firstcity/login",
        },
        param: { type: "string", multiple: true },
        secret: { type: "string", multiple: true },
        version: { type: "string", default: "1.0.0" },
        product: { type: "string", default: "corebank" },
      },
      strict: true,
    })

    const missing = (["run", "name"] as const).filter((key) => !values[key])
    if (missing.length > 0) {
      console.error(`Missing required option(s): ${missing.map((k) => `--${k}`).join(", ")}
`)
      console.log(USAGE)
      return 1
    }

    return recompile({
      runFile: values.run as string,
      name: values.name as string,
      version: values.version as string,
      vendorProduct: values.product as string,
      entryPoint: values.entry as string,
      parameters: [
        ...(values.param ?? []).map((raw) => parseParameter(raw)),
        ...(values.secret ?? []).map((raw) => parseParameter(raw, true)),
      ],
    })
  }

  if (command === "replay") {
    const { values } = parseArgs({
      args: rest,
      options: {
        capability: { type: "string" },
        input: { type: "string", multiple: true },
        "base-url": { type: "string", default: "http://localhost:4100" },
        headed: { type: "boolean", default: false },
        "update-health": { type: "boolean", default: false },
        live: { type: "boolean", default: false },
        wait: { type: "string" },
        tenant: { type: "string" },
        "capture-steps": { type: "boolean", default: false },
      },
      strict: true,
    })

    if (!values.capability) {
      console.error("Missing required option: --capability\n")
      console.log(USAGE)
      return 1
    }

    return replay({
      capability: values.capability,
      inputs: Object.fromEntries(
        (values.input ?? []).map((raw) => {
          const index = raw.indexOf("=")
          if (index <= 0)
            throw new Error(`--input expects name=value, got "${raw}"`)
          return [raw.slice(0, index), raw.slice(index + 1)]
        })
      ),
      baseUrl: values["base-url"] as string,
      headed: values.headed as boolean,
      updateHealth: values["update-health"] as boolean,
      live: values.live as boolean,
      waitMs: values.wait ? Number(values.wait) : undefined,
      tenant: values.tenant,
      captureSteps: values["capture-steps"] as boolean,
    })
  }

  if (command !== "discover") {
    console.error(`Unknown command "${command}".\n`)
    console.log(USAGE)
    return 1
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      goal: { type: "string" },
      entry: { type: "string" },
      name: { type: "string" },
      param: { type: "string", multiple: true },
      secret: { type: "string", multiple: true },
      version: { type: "string", default: "1.0.0" },
      product: { type: "string", default: "corebank" },
      headed: { type: "boolean", default: false },
      "max-turns": { type: "string", default: "30" },
    },
    strict: true,
  })

  const missing = (["goal", "entry", "name"] as const).filter(
    (key) => !values[key]
  )
  if (missing.length > 0) {
    console.error(
      `Missing required option(s): ${missing.map((key) => `--${key}`).join(", ")}\n`
    )
    console.log(USAGE)
    return 1
  }

  return discover({
    goal: values.goal as string,
    entryPoint: values.entry as string,
    name: values.name as string,
    parameters: [
      ...(values.param ?? []).map((raw) => parseParameter(raw)),
      ...(values.secret ?? []).map((raw) => parseParameter(raw, true)),
    ],
    vendorProduct: values.product as string,
    version: values.version as string,
    headed: values.headed as boolean,
    maxTurns: Number(values["max-turns"]),
  })
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
