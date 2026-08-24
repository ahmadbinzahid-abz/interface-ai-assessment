import type { NextConfig } from "next"

/**
 * The console builds with webpack rather than Turbopack, for one reason.
 *
 * Every workspace package here is **source-only**: `exports` points at `.ts`,
 * module resolution is NodeNext, and NodeNext requires relative imports to carry
 * an explicit `.js` extension (`./values.js` referring to `values.ts`). tsx and
 * `tsc` both understand that; Turbopack does not, and has no extension-alias
 * setting to teach it — it looks for a literal `values.js` and fails.
 *
 * Webpack's `resolve.extensionAlias` is exactly the missing piece, so the
 * console keeps consuming `@workspace/contracts` straight from TypeScript source
 * with no build step. That matters more than the dev-server speed: the derived
 * API client needs the *runtime* schemas, not just the types, and a build step
 * between the contract and its consumer is one more thing that can be stale.
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui", "@workspace/contracts"],

  webpack: (config) => {
    config.resolve = config.resolve ?? {}
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    }
    return config
  },
}

export default nextConfig
