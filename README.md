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

## Slicer image

`.github/workflows/slicer-image.yml` publishes the slicer image,
`ghcr.io/jonathanmcohen/platehouse-slicer`. Hades runs its `stable` tag.

Every day at 05:00 UTC the workflow reads OrcaSlicer's latest stable release. When
`orca-X.Y.Z` for that version is not in the registry yet, it builds `apps/slicer/Dockerfile`
for that version and smoke-slices generated plates in the built image. Only when every plate
slices does it push `orca-X.Y.Z` and `orca-X.Y.Z-r<run number>` and move `stable` to the same
digest. It also runs on every release tag, at the latest Orca release, so a change to the slicer
ships with the release, and it can be run by hand from the Actions tab (a version, or a forced
failure to test the failure path). A prerelease tag such as `v0.1.0-rc.1` publishes the two
`orca-` tags but leaves `stable` alone; a plain `vX.Y.Z` tag moves it. Before anything is pushed,
a Trivy scan lists fixable HIGH and CRITICAL findings in the job log; it is a report and never
fails the run. A version first published by a prerelease tag stays off `stable` until a plain
release tag or a run by hand: the daily run sees its `orca-X.Y.Z` tag and builds nothing.

When a run fails, the workflow opens an issue titled "Slicer image failed for OrcaSlicer X.Y.Z".
A failure before tagging creates or moves no tag, and `stable` stays where it was. A failure
while tagging (a readback that does not match, or a passing GHCR error) can leave `orca-X.Y.Z`,
and `stable` if it had got that far, at the new digest; the issue then
lists the tags it had already pointed at the new digest. Once `orca-X.Y.Z` exists the daily run
will not retry that version, so the issue says to run the workflow by hand.

### Rolling the slicer back

Point `stable` back at the last version that worked. Log in to GHCR first with a token that
has `write:packages` (`docker login ghcr.io`), then:

```sh
docker buildx imagetools create --prefer-index=false \
  -t ghcr.io/jonathanmcohen/platehouse-slicer:stable \
  ghcr.io/jonathanmcohen/platehouse-slicer:orca-<previous>
```

`--prefer-index=false` makes `stable` an exact copy of that image. Without it, buildx wraps the
image in a new index with a digest of its own. Check that the two digests now match:

```sh
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse-slicer:stable --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse-slicer:orca-<previous> --format '{{.Manifest.Digest}}'
```

Watchtower on Hades then pulls the image `stable` now names. Every build also keeps its own
`orca-X.Y.Z-r<run number>` tag, so if a slicer change broke the image at the same Orca version,
point `stable` at the previous `-r` tag of that version instead.

The daily run leaves a rollback alone: it builds only when an Orca release has no `orca-X.Y.Z`
tag yet. A plain release tag or a run by hand always builds, and moves `stable` again when its
smoke slice passes.

## Layout

- `apps/server` - the Fastify server. So far it holds `src/config.ts`, which reads the
  configuration from the environment and refuses to start when a value is missing or invalid.
  A configuration error names the key and never prints its value.
  - `src/db` - the Postgres schema as hand-written, numbered SQL files in `src/db/migrations`,
    the forward-only migrator (`migrate.ts`) and the Kysely setup. An applied migration is
    never edited: the migrator refuses to run if one changed, so a change goes in a new file.
  - `src/repos` - the database repositories the rest of the server calls.
- `tools/slicing-gate` - the Task 1 slicing gate harness; see its README.
