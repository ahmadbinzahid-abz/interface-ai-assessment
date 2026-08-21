import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config as loadEnv } from "dotenv"

/**
 * Vitest setup for database-backed tests.
 *
 * Loads `.env.test` and refuses to run against anything that is not obviously a
 * test database. The suite truncates tables between tests, so pointing it at the
 * development database would silently destroy data — this guard makes that
 * impossible rather than merely unlikely.
 */

const here = dirname(fileURLToPath(import.meta.url))

loadEnv({ path: resolve(here, "../../.env.test"), override: true })

const databaseUrl = process.env["DATABASE_URL"]

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Database-backed tests read it from packages/store/.env.test."
  )
}

const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "")

if (!databaseName.endsWith("_test")) {
  throw new Error(
    `Refusing to run tests against database "${databaseName}": the name must end in "_test". ` +
      "Tests truncate tables, so this guard prevents them from destroying development data."
  )
}
