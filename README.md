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
pnpm vitest run --project unit          # every test outside a test/integration/ or test/container/ folder
pnpm vitest run --project integration   # the test/integration/ folders; needs Docker
pnpm vitest run --project container     # the test/container/ folders; needs Docker and STEP_SAMPLE
pnpm biome check .                      # lint and format
pnpm tsc -b                             # type check
```

The integration tests start Postgres and the S3 test server in containers through
testcontainers, so they need a running Docker.

The container tests build the slicer image from `apps/slicer/Dockerfile` and test it over HTTP.
They need a running Docker on an amd64 host (the image is amd64 only). The first build downloads
OrcaSlicer, OpenSCAD and Node and takes minutes, which is why the project allows its setup an
hour. `apps/slicer/test/container/step.test.ts` also needs `STEP_SAMPLE` set to the path of the
NIST CTC-01 STEP file (`nist_ctc_01_asme1_rd.stp`, public NIST test data) and fails without it.
The "Fetch the STEP sample" step of the container job in `.github/workflows/ci.yml` downloads
that file and checks it against its sha256; do the same, then run:

```sh
STEP_SAMPLE=/path/to/nist_ctc_01_asme1_rd.stp pnpm vitest run --project container
```

A plain `pnpm vitest run` runs all three projects, the container tests included, so on a machine
without Docker run the projects one by one as above.

To run one test file, name it: `pnpm vitest run apps/server/test/config.test.ts`.

CI (`.github/workflows/ci.yml`) runs Biome, the type check, the unit tests and the integration
tests on every pull request and on every push to main or a release branch. It runs the container
tests, in their own job, when the slicer or anything its image is built from changes. It fails a
test job when no test ran.

The slicing gate in `tools/slicing-gate` is not part of the pnpm workspace and Biome does not
check it. Its tests use Node's own test runner and need no install:

```sh
node --test 'tools/slicing-gate/test/**/*.test.mjs'
```

## Layout

- `apps/server` - the Fastify server. So far it holds `src/config.ts`, which reads the
  configuration from the environment and refuses to start when a value is missing or invalid.
  A configuration error names the key and never prints its value.
  - `src/db` - the Postgres schema as hand-written, numbered SQL files in `src/db/migrations`,
    the forward-only migrator (`migrate.ts`) and the Kysely setup. An applied migration is
    never edited: the migrator refuses to run if one changed, so a change goes in a new file.
  - `src/repos` - the database repositories the rest of the server calls.
- `tools/slicing-gate` - the Task 1 slicing gate harness; see its README.
