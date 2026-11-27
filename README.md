<img src="docs/assets/logo.svg" alt="Platehouse logo: a roof over three stacked print layers" width="96" height="96">

# Platehouse

A self-hosted library for 3D print files. It reads every plate in a Bambu Studio or OrcaSlicer
`.3mf`, estimates print time and filament for your printers with OrcaSlicer, and keeps the files
in your own S3-compatible storage.

Documentation: <https://jonathanmcohen.github.io/platehouse/>. Start with [Install](https://jonathanmcohen.github.io/platehouse/install).

## What it does

- Lists every plate of a `.3mf` up front, with its thumbnail, filaments, print time and weight.
- Gives each plate's print time and filament for every printer in **My printers**: Bambu's own
  numbers when the file has them for that printer, and an OrcaSlicer estimate otherwise.
- Opens a `.3mf` in Bambu Studio or OrcaSlicer with one click.
- Keeps model files, thumbnails and renders in an S3-compatible bucket.
- Takes files by drag and drop, from an inbox folder it watches, or through the token API.
- Organises the library with tags, collections, creators and search. Deleted models stay in a
  trash for 30 days. Select mode changes many models at once.
- Fills in the MakerWorld title, designer, description and licence from a `.3mf` that has them.
- Shows STL, STEP and OpenSCAD files in a 3D viewer, with preview pictures.
- Speaks English, Spanish and French.
- Works on a phone.
- Imports an existing Manyfold library with `platehouse-import`.

## What it is not

- It is for one household sharing one library. There are no user accounts inside Platehouse.
- It does not talk to printers: no sending jobs, no monitoring.
- It keeps no G-code. A slice is used for its numbers and then thrown away.
- It is not meant for the open internet. Run it on your own network or behind a VPN, and read
  [Security](https://jonathanmcohen.github.io/platehouse/security).

## What you need

- A Linux amd64 host with Docker Compose v2.
- Linux 6.12.24, 6.13.12, 6.14.3 or 6.15 and later (Landlock ABI 6) for the slicer's
  sandbox; see [What you need](docs/install.md#what-you-need). Without it, preview pictures and
  OpenSCAD renders stay off.
- CPU and memory: the example gives the slicer 4 CPUs and 4 GiB, and the app 2 CPUs and 2 GiB,
  plus what Postgres needs.
- An S3-compatible bucket.
- An OpenID Connect provider, with a group for the people who may sign in.
- A reverse proxy with TLS. See the
  [reverse proxy guides](https://jonathanmcohen.github.io/platehouse/reverse-proxy).

## Quick start

1. Get [`examples/docker-compose.yml`](examples/docker-compose.yml) and
   [`examples/.env.example`](examples/.env.example). Save the second as `.env`.
2. Fill in `.env`: a database password, a link secret, the bucket and the OIDC provider.
3. Create the three Docker networks the example uses, then run `docker compose up -d`.
4. Put the app behind your reverse proxy and sign in.

The [Install page](https://jonathanmcohen.github.io/platehouse/install) walks through each
step. A deployment pins the version tag, as the example file does:
`ghcr.io/jonathanmcohen/platehouse:0.1.1`, with the slicer image
`ghcr.io/jonathanmcohen/platehouse-slicer:0.1.1` at the same version. See also
[Backups and upgrades](https://jonathanmcohen.github.io/platehouse/backups-and-upgrades).

## API

Platehouse has an HTTP API for scripts and tools such as AI coding assistants: upload files,
search the library, read models, plates and their estimates, download files, and add or remove
tags and collections. It never deletes anything. Make a token in Settings, under API tokens, and
send it as `Authorization: Bearer <token>`. The
[API guide](https://jonathanmcohen.github.io/platehouse/api) covers tokens, errors, limits and
curl examples. The OpenAPI 3.0 document is at `GET /api/v1/openapi.json` (it needs a token too).

## Status

Platehouse is at 0.1.x: early releases. See [CHANGELOG.md](CHANGELOG.md) and the
[releases page](https://github.com/jonathanmcohen/platehouse/releases).

## Contributing

You need Node 26.13.0, the version in `.node-version`, and pnpm 12.18.0, the version in the
`packageManager` field of `package.json`. Node 26 ships without corepack, so install pnpm
yourself, for example with `npm install -g pnpm@12.18.0`.

```sh
pnpm install --frozen-lockfile
```

Run these from the repository root. Each one must pass before a pull request.

```sh
pnpm vitest run --project unit
pnpm vitest run --project integration   # needs Docker
pnpm vitest run --project container     # needs Docker and STEP_SAMPLE
pnpm biome check .
pnpm tsc -b
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the detail: what the integration and container tests
need, the CI jobs, the slicing gate tests and the documentation site. Maintainers: see
[RELEASING.md](RELEASING.md).

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
