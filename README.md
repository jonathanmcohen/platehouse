# platehouse

Self-hosted library for 3D print files: plates, OrcaSlicer estimates, S3 storage, token API

## Developing

You need Node 26.13.0, the version in `.node-version`, and pnpm 12.18.0, the version in the
`packageManager` field of `package.json`. Node 26 ships without corepack, so install pnpm
yourself, for example with `npm install -g pnpm@12.18.0`.

Install the workspace from the lockfile:

```sh
pnpm install --frozen-lockfile
```

Every dependency is pinned to an exact version in `package.json` and `pnpm-lock.yaml`, and
`pnpm-workspace.yaml` sets `saveExact`, so `pnpm add` pins new ones exactly too.

### Checks

Run these from the repository root. Each one must pass before a pull request.

```sh
pnpm vitest run          # every TypeScript test under apps/ and packages/
pnpm biome check .       # lint and format
pnpm tsc -b              # type check
```

To run one test file, name it: `pnpm vitest run apps/server/test/config.test.ts`.

The slicing gate in `tools/slicing-gate` is not part of the pnpm workspace and Biome does not
check it. Its tests use Node's own test runner and need no install:

```sh
node --test 'tools/slicing-gate/test/**/*.test.mjs'
```

## Layout

- `apps/server` - the Fastify server. So far it holds `src/config.ts`, which reads the
  configuration from the environment and refuses to start when a value is missing or invalid.
  A configuration error names the key and never prints its value.
- `tools/slicing-gate` - the Task 1 slicing gate harness; see its README.
