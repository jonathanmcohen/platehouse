# End-to-end suite

Build plan Task 22. Playwright specs that drive the real Platehouse server
through a real Traefik v3, the way Hades will serve it, with axe-core for
accessibility. CI runs them in the e2e job of `.github/workflows/ci.yml`.

## What it checks

| Spec                            | What must hold                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/headless-routes.spec.ts` | Through Traefik with no cookie: an API token request succeeds, a slicer link returns the file (a hostile file name too), a page redirects to `/auth/login`, the app API answers 401, and a fresh browser signs in through the issuer (AC-082, AC-041, AC-080, lesson 1). |
| `tests/axe.spec.ts`             | Zero axe-core violations on the library, model, settings and trash pages, dark and light (AC-075).                                                                                                                                                                       |
| `tests/first-paint.spec.ts`     | A fresh System-theme load with `prefers-color-scheme: light` paints the light background `#f6f7f9` on the first frame, with JavaScript off; the dark control paints `#121418` (AC-070, lesson 6).                                                                        |
| `tests/phone-width.spec.ts`     | At 375 px the sidebar is behind the menu button, nothing scrolls sideways and the menu reaches every section (AC-074).                                                                                                                                                   |
| `tests/keyboard.spec.ts`        | Tab reaches every control on every page, each with a visible, non-none outline, in both themes (AC-075).                                                                                                                                                                 |

## The stack

`compose.yml` runs Traefik (file provider, `traefik/dynamic.yml`, no middleware
on the Platehouse router), the app from this checkout (started from source as
the integration tests start it), the slicer stub, `postgres:17-alpine`, the S3
test server, a one-shot job that makes the bucket, and a mock OIDC issuer
(`stubs/oidc-issuer.ts`) standing in for Pocket ID. Traefik serves
`https://platehouse.e2e.test` and `https://id.e2e.test` with a certificate made
per run.

`global-setup.ts` signs in once through the issuer and fills the library with
three generated `.3mf` files (the repo's `buildSliceable` fixture builder),
uploaded through the public API with a token made for the run. No designer
file and no real credential is used anywhere.

## Running it

It needs Docker, so it does not run on mini01; CI is where it runs. On a
machine with Docker:

```sh
pnpm install
pnpm --filter @platehouse/web build
pnpm exec playwright install --with-deps chromium
echo "127.0.0.1 platehouse.e2e.test id.e2e.test" | sudo tee -a /etc/hosts
bash e2e/up.sh
pnpm exec playwright test -c e2e
docker compose -f e2e/compose.yml --env-file "${RUNNER_TEMP:-/tmp}/platehouse-e2e/e2e.env" down -v
```

`up.sh` makes the CA, the certificate and every secret with `openssl` into
`${RUNNER_TEMP:-/tmp}/platehouse-e2e`, outside the repo, and publishes Traefik
on `127.0.0.1:443`. Typecheck the suite with
`pnpm exec tsc -p e2e/tsconfig.json`.
