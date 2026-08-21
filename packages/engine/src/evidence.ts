import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Redactor } from "@workspace/policy"

/**
 * Everything this system writes down about a run.
 *
 * Two properties matter more than the format:
 *
 *  1. **Redaction is on the way in, not on the way out.** Every write goes
 *     through the redactor here, so there is no code path that puts evidence on
 *     disk unredacted. Sanitising at read time would mean the regulated data was
 *     already sitting in a file.
 *  2. **The log says why, not just what.** A trace of "clicked #4, clicked #7" is
 *     useless in an incident. Each event carries the step's intent, the policy
 *     decision, which locator strategy resolved, and any recovery applied.
 */

export interface EvidenceWriter {
  readonly runDir: string
  /** Appends one JSON line to the run's trace. */
  readonly event: (event: Record<string, unknown>) => Promise<void>
  readonly json: (name: string, value: unknown) => Promise<string>
  readonly text: (name: string, value: string) => Promise<string>
  /**
   * Images bypass the text redactor — pixels are not strings.
   *
   * The honest limitation: a screenshot of a member record contains that
   * member's data and this system cannot mask it after the fact. The mitigation
   * is to capture screenshots sparingly (failures and escalations, where the
   * debugging value is highest) rather than on every step. Masking sensitive
   * regions before capture needs the surface to know which controls are
   * sensitive, which the artifact declares — see REPORT.md, Safety.
   */
  readonly screenshot: (name: string, bytes: Uint8Array) => Promise<string>
}

export interface EvidenceOptions {
  /** Repository-relative evidence root, normally `evidence/`. */
  readonly root: string
  readonly runId: string
  readonly redactor: Redactor
}

const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "-")

export const makeEvidenceWriter = async ({
  root,
  runId,
  redactor,
}: EvidenceOptions): Promise<EvidenceWriter> => {
  const runDir = join(root, runId)
  await mkdir(runDir, { recursive: true })

  const tracePath = join(runDir, "trace.jsonl")

  return {
    runDir,

    event: async (event) => {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        ...redactor.deep(event),
      })
      await appendFile(tracePath, `${line}\n`, "utf8")
    },

    json: async (name, value) => {
      const path = join(runDir, `${safeName(name)}.json`)
      await writeFile(
        path,
        `${JSON.stringify(redactor.deep(value), null, 2)}\n`,
        "utf8"
      )
      return path
    },

    text: async (name, value) => {
      const path = join(runDir, safeName(name))
      await writeFile(path, redactor.text(value), "utf8")
      return path
    },

    screenshot: async (name, bytes) => {
      const path = join(runDir, `${safeName(name)}.png`)
      await writeFile(path, bytes)
      return path
    },
  }
}
