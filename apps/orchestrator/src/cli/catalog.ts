import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { decodeCapability, type CapabilityArtifact } from "@workspace/contracts"
import { declarationFor } from "@workspace/engine"
import { Effect } from "effect"

import { CAPABILITIES_DIR } from "../paths.js"

/**
 * `cua catalog` — what a customer-facing agent is handed.
 *
 * The point of printing it is to make one claim checkable: **nothing here is
 * written**. Every field comes from the artifact — the name an agent calls, the
 * typed arguments with their patterns, and the declared outcomes it must treat
 * as answers rather than errors. Change the capability and this changes with it,
 * because there is no second copy.
 *
 * `--json` emits the declarations exactly as `@google/genai` takes them in
 * `parametersJsonSchema`, so wiring an agent up is a copy rather than a
 * translation.
 */

export interface CatalogOptions {
  readonly json: boolean
}

const loadAll = async (): Promise<readonly CapabilityArtifact[]> => {
  const files = await readdir(CAPABILITIES_DIR).catch(() => [] as string[])

  const artifacts: CapabilityArtifact[] = []

  for (const file of files) {
    if (!file.endsWith(".json")) continue

    const raw = await readFile(join(CAPABILITIES_DIR, file), "utf8")
    const artifact = await Effect.runPromise(
      Effect.either(decodeCapability(JSON.parse(raw)))
    )

    if (artifact._tag === "Right") artifacts.push(artifact.right)
    else console.error(`skipped ${basename(file)}: does not decode`)
  }

  return artifacts
}

export const catalog = async (options: CatalogOptions): Promise<number> => {
  const artifacts = await loadAll()
  const declarations = artifacts.map(declarationFor)

  if (options.json) {
    console.log(JSON.stringify(declarations, null, 2))
    return 0
  }

  if (declarations.length === 0) {
    console.log("No capabilities. Record one with `cua discover`.")
    return 0
  }

  for (const [index, declaration] of declarations.entries()) {
    const artifact = artifacts[index]

    console.log(`${declaration.name}(`)
    for (const input of artifact?.inputs ?? []) {
      console.log(
        `  ${input.name}${input.required ? "" : "?"}: ${input.type}` +
          `${input.pattern ? `  // matches ${input.pattern}` : ""}`
      )
    }
    console.log(")")
    console.log(`  ${declaration.description}`)
    console.log("")
  }

  console.log(
    `${declarations.length} capability declaration(s). ` +
      "Pass --json for the form a model tool-call API takes."
  )

  return 0
}
