# Platehouse docs site

This package builds the Platehouse user documentation with Docusaurus. The pages themselves are
the Markdown files in the repository's `docs/` folder; this package holds only the site's
configuration (`docusaurus.config.mjs`), the sidebar (`sidebars.mjs`) and the colours
(`src/css/custom.css`).

## Build and preview

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
pnpm --filter @platehouse/docs start    # live preview at http://localhost:3000
pnpm --filter @platehouse/docs build    # what CI runs; fails on a broken link or anchor
pnpm --filter @platehouse/docs serve    # serve the built site
```

## Where it is published

`.github/workflows/docs-pages.yml` publishes the site to GitHub Pages whenever a change to
`docs/`, `apps/docs/` or `pnpm-lock.yaml` lands on `main`, and it can be run by hand from the
Actions tab (docs-pages, Run workflow, on `main`). Pull requests do not publish anything; the
ci workflow's "Docs build" job is their check.

**GitHub Pages has to be switched on once before the workflow can publish:** in the repository,
open Settings, Pages, and under Build and deployment set Source to **GitHub Actions**. Until then
the workflow's "Configure Pages" step fails. Once it is on, run the workflow by hand (or push a
docs change) to publish. The address of the published site is shown on that Settings page and
on each run's deploy job.

## The site's address

The site's configuration does not hard-code the repository's address. When the workflow builds
it, the Pages setup
supplies the address through two environment variables that `docusaurus.config.mjs` reads:

| Variable         | What it is                                                     | Example                   |
| ---------------- | -------------------------------------------------------------- | ------------------------- |
| `DOCS_SITE_URL`  | the site's origin                                              | `https://owner.github.io` |
| `DOCS_BASE_PATH` | the path the site lives under, or empty for a site at the root | `/repo`                   |

A local or pull-request build sets neither and gets the placeholder address
`https://platehouse.example.com` at `/`. To check a build the way Pages will serve it, set both
for the build and for `serve`, then open http://localhost:3000/repo/:

```sh
DOCS_SITE_URL=https://owner.github.io DOCS_BASE_PATH=/repo pnpm --filter @platehouse/docs build
DOCS_SITE_URL=https://owner.github.io DOCS_BASE_PATH=/repo pnpm --filter @platehouse/docs serve
```

A variable that is set but empty or malformed fails the build, so a broken Pages setup cannot
publish a site whose links point at the placeholder. A renamed repository or a custom domain set
in the Pages settings needs no change here.

## Icons and images

Every icon and image the site shows is Platehouse's own, drawn from the one logo art by
`tools/brand` and served from where that tool writes it, never copied into this package:

- `docs/assets`: the navbar logo (`logo.svg`) and the SVG favicon (`favicon.svg`).
- `apps/web/public`: the ICO favicon, the Apple touch icon and `icon-512.png`, which is also the
  social card shown when a page is shared.

`apps/web/public` also holds the web app's manifest and its other app icons. They are copied into
the build because Docusaurus copies a static folder whole, but no docs page links them.

## Privacy

Nothing on a built page loads from another site: no analytics, no external fonts, scripts or
stylesheets, and search is a local index made at build time. Keep it that way when adding a
plugin or a theme option.
