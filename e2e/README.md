# End-to-end suite

Playwright specs that drive the real Platehouse server
through a real Traefik v3.7 with no middleware on the Platehouse router, which proves the cookieless
routes get through, with axe-core for accessibility. The Traefik here leaves out the reverse proxy
guide's timeouts and headers, so it does not test them; it sets `sanitizePath` and
`allowEncodedSlash` as the Traefik guide does. CI runs the specs in the e2e job of
`.github/workflows/ci.yml`, against the shipped app image.

## What it checks

| Spec                               | What must hold                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/headless-routes.spec.ts`    | Through Traefik with no cookie: an API token request succeeds, a slicer link returns the file (a hostile file name too), a page redirects to `/auth/login`, the app API answers 401, and a fresh browser signs in through the issuer.                                                                                                                                                                                                     |
| `tests/axe.spec.ts`                | Zero axe-core violations on the library, model, settings, trash and Activity pages, dark and light.                                                                                                                                                                                                                                                                                                                                       |
| `tests/first-paint.spec.ts`        | A fresh System-theme load with `prefers-color-scheme: light` paints the light background `#f6f7f9` on the first frame, with JavaScript off; the dark control paints `#121418`.                                                                                                                                                                                                                                                            |
| `tests/phone-width.spec.ts`        | At 375 px the sidebar is behind the menu button, nothing scrolls sideways and the menu reaches every section.                                                                                                                                                                                                                                                                                                                             |
| `tests/keyboard.spec.ts`           | Tab reaches every control on every page, each with a visible, non-none outline, in both themes.                                                                                                                                                                                                                                                                                                                                           |
| `tests/plate-3d.spec.ts`           | Show in 3D on a .3mf plate loads that plate's GLB alone (never the whole file), draws it with the 3D view's controls, follows the plate strip, and Show picture goes back with focus on Show in 3D; zero axe violations with the view open, both themes (#358). The page carries the app's Content-Security-Policy, and the browser reports no violation while the 3D view draws or around a tus upload through the upload dialog (#449). |
| `tests/tags-encoded-slash.spec.ts` | Through Traefik with an API token, PUT then DELETE `/api/v1/models/<id>/tags/a%2Fb` both answer 204, and the tag `a/b` appears on the model and then goes (#452).                                                                                                                                                                                                                                                                         |
| `tests/upload-drag-drop.spec.ts`   | A small STL dropped on the library drop zone opens the upload dialog; sending it runs the tus upload through Traefik to Added, and the model is found through the API (#452).                                                                                                                                                                                                                                                             |

## The stack

`compose.yml` runs Traefik (file provider, `traefik/dynamic.yml`, no middleware
on the Platehouse router), the app, the slicer stub, `postgres:17-alpine`, the S3
test server, a one-shot job that makes the bucket, and a mock OIDC issuer
(`stubs/oidc-issuer.ts`) standing in for the OIDC provider. Traefik serves
`https://platehouse.e2e.test` and `https://id.e2e.test` with a certificate made
per run.

`global-setup.ts` signs in once through the issuer and fills the library with
three generated `.3mf` files (the repo's `buildSliceable` fixture builder),
uploaded through the public API with a token made for the run. No designer
file and no real credential is used anywhere.

## The app under test

By default the app is the real server from this checkout, started from
TypeScript source the way the integration tests start it (node with
`--conditions=source`), with the checkout mounted read-only. Set
`E2E_APP_IMAGE` to a local image and `up.sh` layers `compose.image.yml` over
`compose.yml`: the app service runs that image with the same environment, as
uid 1000 with the image's own files, entrypoint and command, and no source
mounted. CI runs only this image mode (the e2e job builds `platehouse:ci`
from the app-image job's build cache), so the suite checks what ships. Run
source mode locally for a faster loop.

## Running it

It needs Docker, so it does not run on a machine without it; CI is where it runs. On a
machine with Docker, with the app from source:

```sh
pnpm install
pnpm --filter @platehouse/web build
pnpm exec playwright install --with-deps chromium
echo "127.0.0.1 platehouse.e2e.test id.e2e.test" | sudo tee -a /etc/hosts
bash e2e/up.sh
pnpm exec playwright test -c e2e
docker compose -f e2e/compose.yml --env-file "${RUNNER_TEMP:-/tmp}/platehouse-e2e/e2e.env" down -v
```

To run against the app image instead (the web build is not needed, the image carries its own),
build it with `docker build -f docker/app.Dockerfile -t platehouse:ci .` and start with
`E2E_APP_IMAGE=platehouse:ci bash e2e/up.sh`; stop it with
`docker compose -f e2e/compose.yml -f e2e/compose.image.yml --env-file <env file> down -v`.
In image mode the app's health is the image's own `HEALTHCHECK`, not a probe from the compose file.
The slicer and OIDC stubs, and the bucket job, still run from source in both modes.

`up.sh` makes the CA, the certificate and every secret with `openssl` into
`${RUNNER_TEMP:-/tmp}/platehouse-e2e`, outside the repo, and publishes Traefik
on `127.0.0.1:443`. Typecheck the suite with `pnpm exec tsc -p e2e/tsconfig.json`.
