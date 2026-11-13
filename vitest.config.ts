import { defineConfig } from "vitest/config";

// Vitest 5 reads no vitest.workspace.ts, so the root config is this file.
// Only the TypeScript suites under apps/ and packages/ run here. The slicing
// gate's tests use node:test and run with node --test (see ci.yml).
//
// Three projects, one per CI job (build plan Tasks 3 and 11):
// - unit: every test file except those under a test/integration/ or
//   test/container/ folder.
// - integration: the files under test/integration/, which start real
//   containers (Postgres and the S3 test server) through testcontainers and
//   need Docker. Container start-up includes an image pull, hence the longer
//   timeouts.
// - container: the files under test/container/, which build the slicer image
//   (apps/slicer/Dockerfile) and test it over HTTP. The image build downloads
//   OrcaSlicer and OpenSCAD and takes minutes, hence the hour-long hook
//   timeout; the files run one at a time so the build happens once and the
//   later files reuse Docker's cache.
//
// Workspace packages export their TypeScript source under the "source"
// condition, so tests import them without a build; Node and tsc use the
// built dist/ files.
const INTEGRATION = [
  "apps/*/test/integration/**/*.test.ts",
  "packages/*/test/integration/**/*.test.ts",
];
const CONTAINER = ["apps/*/test/container/**/*.test.ts", "packages/*/test/container/**/*.test.ts"];

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  ssr: {
    resolve: {
      conditions: ["source"],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // The web app's component tests are TSX (Task 19's
          // library.test.tsx), so .test.tsx files under apps/ run here too.
          include: [
            "apps/*/test/**/*.test.ts",
            "apps/*/test/**/*.test.tsx",
            "packages/*/test/**/*.test.ts",
          ],
          exclude: [...INTEGRATION, ...CONTAINER],
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
      {
        extends: true,
        test: {
          name: "container",
          include: CONTAINER,
          testTimeout: 300_000,
          hookTimeout: 3_600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
