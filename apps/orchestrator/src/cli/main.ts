import { join } from "node:path"
import { parseArgs } from "node:util"

import type { DiscoveryParameter } from "@workspace/engine"
import { config as loadEnv } from "dotenv"

import { REPO_ROOT } from "../paths.js"
import { discover } from "./discover.js"

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

  Requires GEMINI_API_KEY. Replay does not.
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
