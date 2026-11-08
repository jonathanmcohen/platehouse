import { defineConfig } from "vitest/config";

// Vitest 5 reads no vitest.workspace.ts, so the root config is this file.
// Only the TypeScript suites under apps/ and packages/ run here. The slicing
// gate's tests use node:test and run with node --test (see ci.yml).
//
// Two projects, one per CI job (build plan Task 3):
// - unit: every test file except those under a test/integration/ folder.
// - integration: the files under test/integration/, which start real
//   containers (Postgres and the S3 test server) through testcontainers and
//   need Docker. Container start-up includes an image pull, hence the longer
//   timeouts.
const INTEGRATION = [
  "apps/*/test/integration/**/*.test.ts",
  "packages/*/test/integration/**/*.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          exclude: INTEGRATION,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: INTEGRATION,
          testTimeout: 60_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
