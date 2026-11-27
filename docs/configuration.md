---
description: Every setting the Platehouse app and slicer read from the environment, with its default, and the fixed limits.
---

# Configuration

Platehouse reads its configuration from environment variables only. With the example Compose
file you set most of them in `.env`, and `docker-compose.yml` passes them to the containers. Some
are not read from `.env` as they are: `DATABASE_URL` is built from `DB_USER`, `DB_PASS` and
`DB_NAME`; the app's `PORT`, `SLICER_URL`, `INBOX_DIR` and `TMP_DIR` are written into
`docker-compose.yml` itself; and the slicer's `SLICE_TIMEOUT_SECONDS`, `SCAD_TIMEOUT_SECONDS`,
`STEP_TIMEOUT_SECONDS`, `WORK_MIN_FREE_MIB` and `PORT` are not passed at all. To change one of
those, set it under that service's `environment:` in `docker-compose.yml`. The app checks every
value when it starts and refuses to start if a required one is missing or any one is invalid. The
error names the variable and why it failed, and never prints its value.

A `docker-compose.yml` copied from the example before it passed `UPLOAD_TEMP_MAX_BYTES`,
`LOCALES_DIR` and `SLICER_ALLOW_UNSANDBOXED` on, as the one shipped with 0.1.1 did not, ignores
those three in `.env`. Add the lines you need under that service's `environment:`, the first two on
`platehouse` and the third on `platehouse-slicer` (in place of its commented line):

```yaml
UPLOAD_TEMP_MAX_BYTES: ${UPLOAD_TEMP_MAX_BYTES:-4294967296}
LOCALES_DIR: ${LOCALES_DIR:-}
SLICER_ALLOW_UNSANDBOXED: ${SLICER_ALLOW_UNSANDBOXED:-false}
```

For the app, an empty value (`KEY=`) counts as not set: a required variable is then missing, and
an optional one takes its default. The slicer does not read an empty value as not set, but the
example Compose file gives `SLICER_ALLOW_UNSANDBOXED` its default, `false`, when `.env` leaves it
empty.

## The app

| Variable                | Required | Default                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`         | Yes      | -                               | The address people use to reach Platehouse, such as `https://platehouse.example.com`. It must be `https`, with no path, query, fragment or user name. Every link Platehouse builds starts with it: the sign-in redirect, slicer links and the API description. Platehouse never builds a link from the request's Host header.                                                                                                                                                                                                                                                       |
| `DATABASE_URL`          | Yes      | -                               | The Postgres connection, as a `postgres://` or `postgresql://` URL, for example `postgres://platehouse:PASSWORD@platehouse-db:5432/platehouse`. The password must be URL-safe; see [the database password](#the-database-password).                                                                                                                                                                                                                                                                                                                                                 |
| `PORT`                  | No       | `3000`                          | The port the app listens on inside its container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `S3_ENDPOINT`           | Yes      | -                               | The bucket's S3 endpoint, an `http` or `https` URL. See [Storage](./storage.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `S3_REGION`             | Yes      | -                               | The bucket's region. For a self-hosted store that ignores regions, any value it accepts, often `us-east-1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `S3_BUCKET`             | Yes      | -                               | The bucket name. Use a bucket for Platehouse alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `S3_ACCESS_KEY_ID`      | Yes      | -                               | The access key ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `S3_SECRET_ACCESS_KEY`  | Yes      | -                               | The secret access key. It stays on the server: no browser or slicer ever sees it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `S3_FORCE_PATH_STYLE`   | Yes      | -                               | `true` or `false`. `true` addresses the bucket as `https://endpoint/bucket/key`, which most self-hosted stores need. `false` uses `https://bucket.endpoint/key`, as AWS S3 prefers.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `OIDC_ISSUER`           | Yes      | -                               | Your OpenID Connect provider's issuer URL, `https` only, with no query, fragment or user name. Platehouse reads `/.well-known/openid-configuration` under it. See [Sign-in](./sign-in.md).                                                                                                                                                                                                                                                                                                                                                                                          |
| `OIDC_CLIENT_ID`        | Yes      | -                               | The client ID of the Platehouse client at your provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OIDC_CLIENT_SECRET`    | Yes      | -                               | That client's secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OIDC_GROUP`            | No       | `platehouse`                    | Only users whose `groups` claim holds this group may sign in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `LINK_SECRET`           | Yes      | -                               | A random secret of at least 32 bytes. Separate keys for slicer links and for the sign-in cookie are derived from it. Changing it ends every sign-in in progress and every live slicer link, which is harmless: a sign-in can be started again and a link lasts 10 minutes anyway.                                                                                                                                                                                                                                                                                                   |
| `SLICER_URL`            | No       | `http://platehouse-slicer:8080` | Where the app reaches the slicer container. The default, and the example's value, is the slicer's service and container name in the example compose file.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SLICE_PLATE_SECONDS`   | No       | `120`                           | How many seconds OrcaSlicer may spend on one plate. Give the slicer the same value. The default comes from the slowest plate measured in testing, about 55 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `INBOX_DIR`             | No       | `/data/inbox`                   | The inbox folder inside the container. See [Adding files](./using/adding-files.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TMP_DIR`               | No       | `/data/tmp`                     | Where unfinished uploads and working copies are kept. It needs room for a whole upload batch: every file being uploaded at once, each up to 512 MiB, plus a copy of one. While a render job runs, the slicer's answer is written there too: a GLB or STL of up to 256 MiB, plus a picture. Put it on its own volume, or give it a quota, separate from the database's, so a full temp folder cannot stop Postgres. Give each app server its own `TMP_DIR`: at start-up the app deletes the working copies it finds there, so two app servers sharing one would delete each other's. |
| `UPLOAD_TEMP_MAX_BYTES` | No       | `4294967296`                    | The most that unfinished uploads, and finished ones waiting to be imported, may hold together in `TMP_DIR`, in bytes; the default is 4 GiB. The other upload limits are in [Storage](./storage.md#upload-limits).                                                                                                                                                                                                                                                                                                                                                                   |
| `LOCALES_DIR`           | No       | -                               | A folder of translation files that adds languages, or fixes words in a built-in one, without a rebuild. Unset, only the built-in languages (English, Spanish, French) are offered. See [Adding a language to your server](./translations/locales-dir.md).                                                                                                                                                                                                                                                                                                                           |
| `INBOX_SETTLE_SECONDS`  | No       | `15`                            | How many seconds a file in the inbox must stay the same size and age before it is imported, so a copy still running is not taken early.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

:::note OIDC_ISSUER

`OIDC_ISSUER` is required as of 0.1.0. Earlier development builds had a default for it.

:::

## The database password

`DATABASE_URL` is a URL, so its password part must be URL-safe. The example Compose file builds
it from `DB_USER`, `DB_PASS` and `DB_NAME` in `.env` without encoding them, and gives the same
`DB_PASS` to Postgres as `POSTGRES_PASSWORD`. So:

- Use a password of letters and digits only, for example from `openssl rand -hex 32`. This is the
  simple, recommended choice.
- A password with `/`, `#` or `?` ends the URL's address part early. Usually the app then refuses
  to start with `Invalid configuration: DATABASE_URL must be a postgres:// or postgresql:// URL`,
  although the URL scheme is fine. In two cases the check passes instead, and the app starts and
  then connects to the wrong place:
  - when the part of the password before that character is empty or a number up to 65535, it
    tries the database user name as the host and that number as the port;
  - when the password has an `@` before that character, that `@` ends the user part, so the text
    between it and that character is taken as the host. For example, with `p@ss/word` the app
    tries a host named `ss` with the password `p`.
- A password with `%` followed by two hexadecimal digits, such as `%41`, is read as an encoded
  character, so the app starts and then cannot connect: Postgres refuses the password, or the
  database driver cannot read the URL. A `%` that is not followed by two hexadecimal digits, as
  in `ab%zz`, reaches Postgres as typed with the database driver Platehouse ships, but only
  because that driver repairs such a URL before reading it, so encode it as well.
- If you must use a password with any character other than letters and digits, percent-encode it
  in `DATABASE_URL` (for example `@` as `%40`, `/` as `%2F` and `%` as `%25`) and give Postgres
  the plain password.

## Other settings

The example Compose file also uses `TZ`, the container's time zone. The daily jobs run at local
time: the trash purge at 03:30 and the cleanup of stray bucket objects at 04:00.

## The slicer

The slicer image sets its own defaults, and the only variable you normally set is
`SLICE_PLATE_SECONDS`. The rest are listed for completeness.

The app follows the slicer's three time settings (`SLICE_TIMEOUT_SECONDS`, `SCAD_TIMEOUT_SECONDS`
and `STEP_TIMEOUT_SECONDS`) on its own: it reads them from the slicer's health answer, so only the
slicer needs them. `SLICE_PLATE_SECONDS` still goes to both, because the app uses it until the
slicer has answered.

| Variable                           | Required         | Default                    | What it does                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLICE_PLATE_SECONDS`              | No               | `120`                      | The time cap for one plate. Set it to the app's value.                                                                                                                                                                                                                                                                                   |
| `SLICE_TIMEOUT_SECONDS`            | No               | `SLICE_PLATE_SECONDS` + 60 | When the slicer kills a plate's slice outright.                                                                                                                                                                                                                                                                                          |
| `SCAD_TIMEOUT_SECONDS`             | No               | `120`                      | The time cap for one OpenSCAD render.                                                                                                                                                                                                                                                                                                    |
| `STEP_TIMEOUT_SECONDS`             | No               | `120`                      | The time cap for one STEP conversion.                                                                                                                                                                                                                                                                                                    |
| `WORK_MIN_FREE_MIB`                | No               | `640`                      | The slicer reports itself unhealthy, while idle, when its `/work` folder has less free space than this.                                                                                                                                                                                                                                  |
| `SLICER_ALLOW_UNSANDBOXED`         | No               | `false`                    | `true` or `false`. When the slicer finds its sandbox off, because the kernel is older than Linux 6.12 or its start-up check failed, it refuses every request that needs the sandbox and says so. Set to `true`, it still slices and converts STEP files without the sandbox; OpenSCAD renders and STL pictures are never run without it. |
| `PORT`                             | No               | `8080`                     | The slicer's port inside its network.                                                                                                                                                                                                                                                                                                    |
| `ORCA_VERSION`, `OPENSCAD_VERSION` | Set by the image | -                          | The versions built into the image. Do not change them.                                                                                                                                                                                                                                                                                   |

The image also sets the paths of the programs it runs and the folders its sandbox lets them use
(`WORK_DIR`, `PROFILES_DIR`, `ORCA_BIN`, `ORCA_DIR`, `APP_DIR`, `OPENSCAD_BIN`, `OPENSCAD_DIR`,
`CHOOM_BIN`, `PRLIMIT_BIN` and others). Leave them as they are: the slicer refuses to start when one of those folders is a
system folder such as `/usr`, sits under or around `WORK_DIR`, or when `ORCA_BIN` is not inside
`ORCA_DIR`.

## Fixed limits

These are part of Platehouse and not configurable:

- An upload can be at most 512 MiB.
- A slicer link lasts 10 minutes.
- A sign-in session lasts 7 days without use and 30 days at most.
- Trashed models are purged 30 days after they were trashed.
- The slicer renders an OpenSCAD file of at most 1 MiB, and takes an STL or STEP file of at most
  256 MiB. A larger file is still stored, but a larger `.scad` is not rendered, a larger STL gets
  no preview picture, and a larger STEP file is not converted, so it has no 3D view or picture.
