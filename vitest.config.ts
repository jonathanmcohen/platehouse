import { defineConfig } from "vitest/config";

// Vitest 5 reads no vitest.workspace.ts, so the root config is this file.
// Only the TypeScript suites under apps/ and packages/ run here. The slicing
// gate's tests use node:test and run with node --test (see ci.yml).
export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
  },
});
