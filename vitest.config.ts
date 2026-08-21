import { defineConfig } from "vitest/config"

/**
 * Two suites, split by what they need rather than by what they are called.
 *
 *  - `unit` covers pure logic that owns no shared state — locator ranking,
 *    redaction, tenant-overlay merging, condition evaluation. Colocated with the
 *    code in `src`, run in parallel.
 *
 *  - `integration` covers everything that touches the database or a real browser.
 *    A single Postgres instance is shared state, so these run serially in one
 *    fork; see .claude/skills/database-backed-test-ecosystem.md.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/orchestrator/src/**/*.test.ts",
            "apps/target-corebank/src/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          setupFiles: ["./packages/store/src/testing/setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
          // Browser-driven replay tests are slower than a typical unit test.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
