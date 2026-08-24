import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

/** Repository root, from `apps/orchestrator/src`. */
export const REPO_ROOT = resolve(here, "..", "..", "..")

/**
 * Capabilities are committed to the repository rather than kept in the database.
 *
 * They are code-like assets: reviewed in a pull request, versioned with the rest
 * of the system, and diffable when a recording changes. Operational data — runs,
 * interventions, evidence indexes — lives in Postgres, because it is mutable and
 * nobody reviews it.
 */
export const CAPABILITIES_DIR = join(REPO_ROOT, "capabilities")

/**
 * Tenant overlays live beside the capabilities they specialise, one file per
 * tenant per capability. Named `<capability>@<version>.<tenant>.json` so the
 * three things that have to agree are visible in the filename.
 */
export const OVERLAYS_DIR = join(CAPABILITIES_DIR, "overlays")

export const EVIDENCE_DIR = join(REPO_ROOT, "evidence")
