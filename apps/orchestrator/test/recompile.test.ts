import { copyFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { recompile } from "../src/cli/recompile.js"
import { CAPABILITIES_DIR, REPO_ROOT } from "../src/paths.js"

/**
 * The shipped artifact is a compiler output, not a hand-edited file.
 *
 * Capabilities are committed and reviewed like code, which makes them exactly
 * the kind of file somebody eventually fixes in place — and a hand-edit is
 * invisible in a diff a week later. Re-running the compiler over the committed
 * recording and getting the committed artifact back proves three things at once:
 * nobody edited it, the compiler is deterministic, and `cua recompile` actually
 * works on the recording this project ships.
 *
 * When this fails after a deliberate compiler change, the fix is to re-run the
 * command in the README, not to weaken the test.
 */

const CAPABILITY = "lookupMemberSavingsBalance@1.0.0.json"
const artifactPath = join(CAPABILITIES_DIR, CAPABILITY)
const backupPath = join(CAPABILITIES_DIR, `${CAPABILITY}.bak`)

describe("the shipped capability", () => {
  it("is exactly what the compiler emits from the committed recording", async () => {
    const before = await readFile(artifactPath, "utf8")

    // Recompiling writes in place, so the committed file is restored either way.
    await copyFile(artifactPath, backupPath)

    try {
      const code = await recompile({
        runFile: "evidence/01-discovery-produces-the-capability/run.json",
        name: "lookupMemberSavingsBalance",
        version: "1.0.0",
        vendorProduct: "corebank",
        entryPoint: "http://localhost:4100/firstcity/login",
        parameters: [
          {
            name: "memberId",
            value: "12345",
            description: "Value supplied by the caller for memberId.",
            sensitivity: "identifier",
          },
          {
            name: "operatorId",
            value: "teller01",
            description:
              "Credential resolved from the vault as {$secret:operatorId} at replay time.",
            sensitivity: "secret",
          },
          {
            name: "operatorPassword",
            value: "demo-pass",
            description:
              "Credential resolved from the vault as {$secret:operatorPassword} at replay time.",
            sensitivity: "secret",
          },
        ],
      })

      expect(code).toBe(0)

      const after = await readFile(artifactPath, "utf8")
      expect(after).toBe(before)
    } finally {
      await copyFile(backupPath, artifactPath)
      await rm(backupPath, { force: true })
    }
  })

  it("resolves its run file against the repository root", async () => {
    // `--run evidence/…` means what a person typing it at the repo root means.
    // Getting this wrong reads as "the evidence is missing", which sends people
    // looking in the wrong place entirely.
    expect(REPO_ROOT.endsWith("interface-ai-assessment")).toBe(true)

    const recording = await readFile(
      join(REPO_ROOT, "evidence/01-discovery-produces-the-capability/run.json"),
      "utf8"
    )

    expect(recording.length).toBeGreaterThan(0)
  })
})
