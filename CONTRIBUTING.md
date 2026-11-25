# Contributing

This page has what you need to build Platehouse, run its checks and preview its documentation.
The versions of Node and pnpm are in the Contributing section of the [README](README.md). To add
a language, see [Adding a language to Platehouse](docs/translations/contributing.md). Maintainers
cutting a release read [RELEASING.md](RELEASING.md).

## Setup

Node 26 ships without corepack, so install pnpm yourself, for example with
`npm install -g pnpm@12.18.0`.

Install the workspace from the lockfile:

```sh
pnpm install --frozen-lockfile
```

Every dependency is pinned to an exact version in `package.json` and `pnpm-lock.yaml`, and
`pnpm-workspace.yaml` sets `saveExact`, so `pnpm add` pins new ones exactly too.

## Checks

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

CI (`.github/workflows/ci.yml`) runs on every pull request and on every push to main or a release
branch. It runs Biome, the type check, the unit tests, the integration tests and the end-to-end
tests in a chain, and the end-to-end tests run against the built app image. It also builds the app
image for amd64 and arm64 and checks that it starts healthy and passes the Trivy gates, runs the
Ubuntu snapshot pin check and the base image pin check, and audits the production dependencies for
critical advisories. Some jobs run only when what they cover changes: the container tests for the
slicer image, the slicing gate tests and the gate image build, and the docs build. It fails a test
job when no test ran.

The slicing gate in `tools/slicing-gate` is not part of the pnpm workspace and Biome does not
check it. Its tests use Node's own test runner and need no install:

```sh
node --test 'tools/slicing-gate/test/**/*.test.mjs'
```

## Documentation

The user documentation is a Docusaurus site. The pages are Markdown files in `docs/`; the site
that builds them is the workspace package `apps/docs`. Example deployment files the pages refer
to are in `examples/`.

After `pnpm install --frozen-lockfile` (above), preview the site with live reload at
http://localhost:3000 (add `--port 3001` or another port if 3000 is taken):

```sh
pnpm --filter @platehouse/docs start
```

Build it the way CI does, which fails on a broken link or anchor, and serve the result:

```sh
pnpm --filter @platehouse/docs build
pnpm --filter @platehouse/docs serve
```

The built site loads nothing from another site: no analytics, no external fonts or scripts, and
search is a local index made at build time. CI builds it when `docs/`, `apps/docs`,
`apps/web/public` (the icons the site serves) or the workspace files change.

The docs are published to GitHub Pages by `.github/workflows/docs-pages.yml` each time a docs
change lands on `main`; the site's address is shown under Settings, Pages. Pages must first be
switched on there (Source: GitHub Actions). See [apps/docs/README.md](apps/docs/README.md).
