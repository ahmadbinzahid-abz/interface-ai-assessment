import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/**
 * The seam is the deliverable, so it gets a test.
 *
 * `types.ts` defines what a surface *is*; `resolve.ts` decides which control a
 * descriptor means. Neither may know that browsers exist — otherwise adding a
 * desktop adapter later means renegotiating the interface rather than
 * implementing it. This is the kind of rule that erodes through one convenient
 * import, so it is asserted rather than documented.
 */

const here = dirname(fileURLToPath(import.meta.url))

const sourceOf = (file: string): string =>
  readFileSync(join(here, file), "utf8")

describe("the surface abstraction stays surface-agnostic", () => {
  it.each(["types.ts", "resolve.ts", "control.ts", "errors.ts"])(
    "%s does not import a browser",
    (file) => {
      const source = sourceOf(file)

      expect(source).not.toMatch(/from\s+["']playwright/)
      expect(source).not.toMatch(/from\s+["']puppeteer/)
    }
  )

  it("keeps browser specifics inside the playwright adapter", () => {
    // The adapter is allowed — indeed required — to import it.
    expect(sourceOf("playwright/web-surface.ts")).toMatch(
      /from\s+["']playwright["']/
    )
  })
})
