<img src="docs/assets/logo.svg" alt="Platehouse logo: a roof over three stacked print layers" width="96" height="96">

# platehouse

Self-hosted library for 3D print files: plates, OrcaSlicer estimates, S3 storage, token API

## API

Platehouse has an HTTP API for scripts and tools such as AI coding assistants: upload files,
search the library, read models, plates and their estimates, download files, and add or remove
tags and collections. It never deletes anything. Make a token in Settings, under API tokens, and
send it as `Authorization: Bearer <token>`.

- [docs/api.md](docs/api.md) is the guide: tokens, errors, limits, paging, uploads and curl
  examples.
- The API reference, every operation with its parameters, answers and examples, is in the app:
  Settings, then the API reference link under API tokens.
- The OpenAPI 3.0 document is at `GET /api/v1/openapi.json` (it needs a token too).

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
search is a local index made at build time. CI builds it when `docs/`, `apps/docs` or the
workspace files change.

The docs are published to GitHub Pages by `.github/workflows/docs-pages.yml` each time a docs
change lands on `main`; the site's address is shown under Settings, Pages. Pages must first be
switched on there (Source: GitHub Actions). See [apps/docs/README.md](apps/docs/README.md).

## Slicer image

`.github/workflows/slicer-image.yml` publishes the slicer image,
`ghcr.io/jonathanmcohen/platehouse-slicer`. A deployment pins an `orca-X.Y.Z` tag, as
`examples/docker-compose.yml` does, or follows the `stable` tag. A test server can follow the
`rc` tag instead (below).

Every day at 05:00 UTC the workflow reads OrcaSlicer's latest stable release. When
`orca-X.Y.Z` for that version is not in the registry yet, it builds `apps/slicer/Dockerfile`
for that version and smoke-slices generated plates in the built image. Only when every plate
slices does it push `orca-X.Y.Z` and a run tag, `orca-X.Y.Z-r<run number>`, and move `stable` to
the same digest. A re-run of a run (Re-run all jobs or Re-run failed jobs) keeps its run number, so its run tag is
`orca-X.Y.Z-r<run number>.<attempt>` and the first attempt's tag stays on the image it named. It also runs on every release tag, at the latest Orca release, so a change to the slicer
ships with the release, and it can be run by hand from the Actions tab (a version, or a forced
failure to test the failure path). A prerelease tag such as `v0.1.0-rc.1` publishes the two
`orca-` tags but leaves `stable` alone; a plain `vX.Y.Z` tag moves it. Before anything is pushed,
a Trivy scan lists fixable HIGH and CRITICAL findings in the job log; it is a report and never
fails the run. A version first published by a prerelease tag stays off `stable` until a plain
release tag or a run by hand: the daily run sees its `orca-X.Y.Z` tag and builds nothing.

The image installs its Ubuntu packages from one fixed snapshot of the Ubuntu archive,
`APT_SNAPSHOT` in `apps/slicer/Dockerfile` (the slicing gate image, `tools/slicing-gate/Dockerfile`,
pins the same one), so every build installs the same packages. To pick up Ubuntu's security
fixes, `.github/workflows/apt-snapshot.yml` moves the snapshot forward once a month, at 06:00 UTC
on the 1st. It takes midnight UTC of the newest day snapshot.ubuntu.com has, checks that the
service has it before changing anything, and opens one pull request from the branch
`bot/apt-snapshot` saying the old and new dates. If last month's pull request is still open, it is
closed and replaced by the new one, so there is never more than one. GitHub holds the checks
of a pull request a workflow opened until someone approves them, so the workflow starts the ci
workflow on that branch itself: it builds both images, runs the container tests and the slicing
gate tests, and the slicer job ends with the same Trivy report as above, so the pull request shows
what is still open in the new image. Review and merge it like any other pull request. Merging does
not publish anything: the new packages reach the published image with the next build of it (a
release tag, a new OrcaSlicer version, or a run by hand). The Trivy scans stay reports and never
fail a build (the slicer has no internet access). The branch belongs to the workflow, which
replaces it each month, so fix a broken snapshot on another branch. The workflow can also be run by
hand from main (Actions, apt-snapshot, Run workflow). It needs the repository setting "Allow GitHub
Actions to create and approve pull requests" (Settings, Actions, General, Workflow permissions);
without it the run pushes the branch and then fails, saying so.

Only those three places, the two Dockerfiles and the pins table in `tools/slicing-gate/README.md`,
may name the current snapshot or a later one, each once, in its pin; `CHANGELOG.md` is left out.
The monthly run stops before it pushes when any other tracked file does, or one of those files
names it a second time (a comment, a sentence), as the rewrite would leave that copy behind. So
the ci workflow's Ubuntu snapshot pin check job runs the same check,
`node .github/scripts/apt-snapshot.mjs leftovers`, on every pull request: to write a snapshot date
anywhere else, use one before the current pin.

A run started from a release tag (its push, a re-run of it, or a run by hand from that tag) also
tags the image with the release's version, `X.Y.Z` or `X.Y.Z-rc.N`, the same name the app image
uses, so the slicer built for a release can be found afterwards. Daily runs and runs from main tag
no version.

When a run fails, the workflow opens an issue titled "Slicer image failed for OrcaSlicer X.Y.Z".
A failure before tagging creates or moves no tag, and `stable` stays where it was. A failure
while tagging (a readback that does not match, or a passing GHCR error) can leave `orca-X.Y.Z`,
and `stable` if it had got that far, at the new digest; the issue then
lists the tags it had already pointed at the new digest. Once `orca-X.Y.Z` exists the daily run
will not retry that version, so the issue says to run the workflow by hand. For a prerelease
tag's run the issue suggests Re-run failed jobs instead, as a run by hand would move `stable`. It
re-runs the build job with the first attempt's version and pins, so it builds the failed version
again and leaves `stable` alone. The issue warns against Re-run all jobs, which runs the
detect job again and so reads OrcaSlicer's latest release again: if Orca has shipped a newer
version since, that re-run builds the newer one and leaves the failed version as the first
attempt left it.

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

A deployment that follows `stable` (for example with Watchtower) then pulls the image it now names. Every build also keeps its own
`orca-X.Y.Z-r<run number>` tag, or `orca-X.Y.Z-r<run number>.<attempt>` for a re-run, so if a
slicer change broke the image at the same Orca version, point `stable` at the previous `-r` tag of
that version instead.

The daily run leaves a rollback alone: it builds only when an Orca release has no `orca-X.Y.Z`
tag yet. A plain release tag or a run by hand always builds, and moves `stable` again when its
smoke slice passes.

### The rc tag

Both images carry an `rc` tag for a test server: set the app to
`ghcr.io/jonathanmcohen/platehouse:rc` and the slicer to
`ghcr.io/jonathanmcohen/platehouse-slicer:rc`, and pull to get the newest release candidate. It
moves, so it is not a pin. `rc` points at the newest version, by version number, that has both
images published: the highest `vX.Y.Z-rc.N` or plain `vX.Y.Z` tag for which both
`platehouse:X.Y.Z[-rc.N]` and `platehouse-slicer:X.Y.Z[-rc.N]` exist. Once a run has finished,
both `rc` tags name builds of the same tag, with the one exception below.

Only `.github/workflows/rc-tag.yml` moves `rc`. It runs after every run of the release or
slicer-image workflow, one run at a time, and works the answer out again each time from the
repository's tags and the registry, so the order in which runs finish, re-runs of old tags and
runs by hand cannot leave `rc` on the wrong tag or the two images on different tags. When the
answer has not changed it writes nothing. It reads all four tags (both version tags and both
`rc` tags) before it writes anything, and if it fails after moving one `rc` tag it points that tag
back at the build it had, so a failed run leaves `rc` where it was until the next run of either
workflow, or until rc-tag is run by hand (Actions, rc-tag, Run workflow). The exception: if that
put-back fails too, or the `rc` tag it moved did not exist before (a tag cannot be put back to not
existing), the two `rc` tags can name different tags until the next successful run. The run then
fails with an error saying the `rc` tags may name builds of different tags; run rc-tag by hand once
GHCR answers again.

- A release tag cut for an older version after a newer candidate (a backport, such as `v0.1.1`
  after `v0.2.0-rc.1`) does not move `rc`, by design: `rc` stays on the newer candidate.
- Throwaway tags such as `v0.0.0-test` and other prerelease kinds (`-beta.1`, `-rc` with no
  number) never qualify.
- A new candidate reaches `rc` only once both of its images are published, so a test server never
  pulls a new app with an old slicer.

To see where `rc` points, compare digests (the releases page lists neither candidates nor `rc`):

```sh
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse:rc --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse:0.2.0-rc.1 --format '{{.Manifest.Digest}}'
```

or read the summary of the latest rc-tag run, which lists every candidate tag, whether each image
is published for it, and where it pointed `rc`.

## Layout

- `apps/server` - the Fastify server: sign-in, the app API the web app uses, the public API
  (`src/api`), uploads, ingest, the job queues, storage and the slicer client. `src/main.ts`
  starts it. `src/config.ts` reads the configuration from the environment and refuses to start
  when a value is missing or invalid; a configuration error names the key and never prints its
  value.
  - `src/db` - the Postgres schema as hand-written, numbered SQL files in `src/db/migrations`,
    the forward-only migrator (`migrate.ts`) and the Kysely setup. An applied migration is
    never edited: the migrator refuses to run if one changed, so a change goes in a new file.
  - `src/repos` - the database repositories the rest of the server calls.
- `apps/web` - the web app: React, built with Vite. The server serves its build.
- `apps/slicer` - the slicer server that runs in the slicer container: OrcaSlicer estimates,
  OpenSCAD renders and STEP conversion over the slicer HTTP contract, on the internal network
  only. Its image is `apps/slicer/Dockerfile`.
- `apps/importer` - `platehouse-import`, the one-time import of a Manyfold library through the
  public API.
- `apps/docs` - the Docusaurus site that builds the pages in `docs/`.
- `packages/threemf` - reads a `.3mf` project: its plates, filaments and the numbers Bambu saved.
- `packages/makerworld` - the MakerWorld details in a `.3mf`, its description as Markdown, the
  licence map and the sanitising Markdown renderer.
- `packages/slicer-contract` - the slicer HTTP contract's schemas, shared by the slicer server
  and the server's slicer client.
- `packages/i18n` - the translations: the message format, the catalogs in `locales/` (English is
  the source) and their check.
- `docker` - the app image (`app.Dockerfile`, the server with the web app beside it) and the
  script CI uses to test it.
- `e2e` - the end-to-end tests: Playwright through a real Traefik; see its README.
- `examples` - the example `docker-compose.yml` and `.env.example` the Install page starts from.
- `tools/slicing-gate` - the slicing gate harness, which proved OrcaSlicer slices real files headless before the slicer was built; see its README.
- `tools/brand` - writes the logo's static files (the favicons, app icons and web manifest in
  `apps/web/public`, and `docs/assets/logo.svg` and `favicon.svg`) from the art in
  `apps/web/src/shell/logoArt.ts` and the two colours in `tools/brand/icons.ts`: `ACCENT`, and
  `ICON_TILE`, the app icons' tile, which nothing derives from `ACCENT`, so change both together.
  After changing any of them, run `node tools/brand/generate.ts` and commit what it writes; the
  PNGs are drawn by Playwright's Chromium (`pnpm exec playwright install chromium` the first
  time). The app itself draws the logo in the colour scheme's accent, so only these files carry a
  fixed colour.

## License

Platehouse is free software, licensed under the GNU Affero General Public License, version 3
only (AGPL-3.0-only). The full text is in [LICENSE](LICENSE). If you run a modified version of
Platehouse for other people over a network, the licence requires you to offer them its source.
