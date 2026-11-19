# Configuration

Platehouse reads its configuration from environment variables only. With the example Compose
file you set them in `.env`. The app checks every value when it starts and refuses to start if a
required one is missing or any one is invalid. The error names the variable and why it failed,
and never prints its value.

An empty value (`KEY=`) counts as not set: a required variable is then missing, and an optional
one takes its default.

## The app

| Variable               | Required | Default              | What it does                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`        | Yes      | -                    | The address people use to reach Platehouse, such as `https://platehouse.example.com`. It must be `https`, with no path, query, fragment or user name. Every link Platehouse builds starts with it: the sign-in redirect, slicer links and the API description. Platehouse never builds a link from the request's Host header. |
| `DATABASE_URL`         | Yes      | -                    | The Postgres connection, as a `postgres://` or `postgresql://` URL, for example `postgres://platehouse:PASSWORD@platehouse-db:5432/platehouse`.                                                                                                                                                                               |
| `PORT`                 | No       | `3000`               | The port the app listens on inside its container.                                                                                                                                                                                                                                                                             |
| `S3_ENDPOINT`          | Yes      | -                    | The bucket's S3 endpoint, an `http` or `https` URL. See [Storage](./storage.md).                                                                                                                                                                                                                                              |
| `S3_REGION`            | Yes      | -                    | The bucket's region. For a self-hosted store that ignores regions, any value it accepts, often `us-east-1`.                                                                                                                                                                                                                   |
| `S3_BUCKET`            | Yes      | -                    | The bucket name. Use a bucket for Platehouse alone.                                                                                                                                                                                                                                                                           |
| `S3_ACCESS_KEY_ID`     | Yes      | -                    | The access key ID.                                                                                                                                                                                                                                                                                                            |
| `S3_SECRET_ACCESS_KEY` | Yes      | -                    | The secret access key. It stays on the server: no browser or slicer ever sees it.                                                                                                                                                                                                                                             |
| `S3_FORCE_PATH_STYLE`  | Yes      | -                    | `true` or `false`. `true` addresses the bucket as `https://endpoint/bucket/key`, which most self-hosted stores need. `false` uses `https://bucket.endpoint/key`, as AWS S3 prefers.                                                                                                                                           |
| `OIDC_ISSUER`          | Yes      | -                    | Your OpenID Connect provider's issuer URL, `https` only, with no query, fragment or user name. Platehouse reads `/.well-known/openid-configuration` under it. See [Sign-in](./sign-in.md).                                                                                                                                    |
| `OIDC_CLIENT_ID`       | Yes      | -                    | The client ID of the Platehouse client at your provider.                                                                                                                                                                                                                                                                      |
| `OIDC_CLIENT_SECRET`   | Yes      | -                    | That client's secret.                                                                                                                                                                                                                                                                                                         |
| `OIDC_GROUP`           | No       | `platehouse`         | Only users whose `groups` claim holds this group may sign in.                                                                                                                                                                                                                                                                 |
| `LINK_SECRET`          | Yes      | -                    | A random secret of at least 32 bytes. Separate keys for slicer links and for the sign-in cookie are derived from it. Changing it ends every sign-in in progress and every live slicer link, which is harmless: a sign-in can be started again and a link lasts 10 minutes anyway.                                             |
| `SLICER_URL`           | No       | `http://slicer:8080` | Where the app reaches the slicer container. The example sets `http://platehouse-slicer:8080`, the slicer's container name.                                                                                                                                                                                                    |
| `SLICE_PLATE_SECONDS`  | No       | `120`                | How many seconds OrcaSlicer may spend on one plate. Give the slicer the same value. The default comes from the slowest plate measured in testing, about 55 seconds.                                                                                                                                                           |
| `INBOX_DIR`            | No       | `/data/inbox`        | The inbox folder inside the container. See [Adding files](./using/adding-files.md).                                                                                                                                                                                                                                           |
| `TMP_DIR`              | No       | `/data/tmp`          | Where unfinished uploads and working copies are kept. It needs room for your largest upload, up to 512 MiB, plus a copy.                                                                                                                                                                                                      |
| `INBOX_SETTLE_SECONDS` | No       | `15`                 | How many seconds a file in the inbox must stay the same size and age before it is imported, so a copy still running is not taken early.                                                                                                                                                                                       |

:::note OIDC_ISSUER

`OIDC_ISSUER` is required as of 0.1.0. Earlier development builds had a default for it.

:::

The example Compose file also uses `TZ`, the container's time zone. The daily jobs run at local
time: the trash purge at 03:30 and the cleanup of stray bucket objects at 04:00.

## The slicer

The slicer image sets its own defaults, and the only variable you normally set is
`SLICE_PLATE_SECONDS`. The rest are listed for completeness.

| Variable                           | Required         | Default                    | What it does                                                                                            |
| ---------------------------------- | ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SLICE_PLATE_SECONDS`              | No               | `120`                      | The time cap for one plate. Set it to the app's value.                                                  |
| `SLICE_TIMEOUT_SECONDS`            | No               | `SLICE_PLATE_SECONDS` + 60 | When the slicer kills a plate's slice outright.                                                         |
| `SCAD_TIMEOUT_SECONDS`             | No               | `120`                      | The time cap for one OpenSCAD render.                                                                   |
| `STEP_TIMEOUT_SECONDS`             | No               | `120`                      | The time cap for one STEP conversion.                                                                   |
| `WORK_MIN_FREE_MIB`                | No               | `640`                      | The slicer reports itself unhealthy, while idle, when its `/work` folder has less free space than this. |
| `PORT`                             | No               | `8080`                     | The slicer's port inside its network.                                                                   |
| `ORCA_VERSION`, `OPENSCAD_VERSION` | Set by the image | -                          | The versions built into the image. Do not change them.                                                  |

The image also sets the paths of the programs it runs (`WORK_DIR`, `PROFILES_DIR`, `ORCA_BIN`,
`OPENSCAD_BIN` and others). Leave them as they are.

## Fixed limits

These are part of Platehouse and not configurable:

- An upload can be at most 512 MiB.
- A slicer link lasts 10 minutes.
- A sign-in session lasts 7 days without use and 30 days at most.
- Trashed models are purged 30 days after they were trashed.
- An OpenSCAD file can be at most 1 MiB and a STEP file at most 256 MiB.
