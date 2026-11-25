---
description: How to install Platehouse with Docker Compose from the example files.
---

# Install

Platehouse runs as three containers under Docker Compose: the app, the slicer and Postgres.
This page walks through a first install with the example files in the repository's
`examples/` folder.

## What you need

- **A Linux host with Docker and Docker Compose v2.** The app image is built for amd64 and arm64.
  The slicer image is amd64 only, so the host must be amd64. Use Docker Engine 26.0 or newer.
  Older engines from 20.10.18 run Platehouse, but see [Security](./security.md#the-slicer-sandbox)
  (DNS) and [Troubleshooting](./troubleshooting.md#the-sandbox-is-off-on-a-new-kernel) (Landlock).
- **CPU and memory.** The example gives the slicer 4 CPUs and 4 GiB, and the app 2 CPUs and
  2 GiB, plus whatever Postgres needs. The heaviest plate measured so far used about 2.5 GiB of
  memory while slicing.
- **A Linux kernel with Landlock ABI 6 or newer.** That is Linux 6.12 or newer, updated: 6.12.24,
  6.13.12, 6.14.3, or 6.15 and later. Landlock must be turned on (`/sys/kernel/security/lsm` lists
  `landlock`), on Docker Engine 20.10.18 or newer. `uname -r` shows the kernel version, but a
  distribution kernel can carry the fix under an older-looking version, so the Activity page is the
  real check. Pictures of STL and STEP files, OpenSCAD renders, STEP conversions (for the 3D
  preview) and estimates all run inside the slicer's sandbox, which needs it. The slicer checks the
  sandbox when it starts and refuses that work when the kernel is too old; the files then keep their
  icon, and say why. The slicer still reports itself healthy, so `docker compose ps` does not show
  this: check the sandbox on the Activity page after the first start (see [7. Sign in](#7-sign-in)).
  The fix is a newer kernel; see
  [Troubleshooting](./troubleshooting.md#the-sandbox-is-off-on-a-new-kernel) for the other causes.
  Setting `SLICER_ALLOW_UNSANDBOXED=true` on the slicer lets estimates and STEP conversions run
  without the sandbox on an older kernel, which means slicing and converting untrusted files with no
  sandbox around OrcaSlicer and the STEP converter; read
  [Security](./security.md#the-slicer-sandbox) first. It never covers pictures or OpenSCAD renders,
  which need the sandbox. When the kernel is upgraded and the slicer restarts, the files it refused
  are picked up again by themselves.
- **An S3-compatible bucket** with an access key that can read, write and delete in it. See
  [Storage](./storage.md).
- **An OpenID Connect provider** with a client for Platehouse and a group for the people who
  may sign in. See [Sign-in](./sign-in.md).
- **A reverse proxy with TLS** for a host name such as `platehouse.example.com`. Platehouse only
  works over https, because its cookies are marked Secure. See
  [Reverse proxy](./reverse-proxy/index.md).

## 1. Get the example files

Platehouse's source is at <https://github.com/jonathanmcohen/platehouse>. You need two files from
it: [`examples/docker-compose.yml`](https://github.com/jonathanmcohen/platehouse/blob/main/examples/docker-compose.yml)
and [`examples/.env.example`](https://github.com/jonathanmcohen/platehouse/blob/main/examples/.env.example).
Open each link, use Raw to save it, and put both in a new folder for the project. Rename
`.env.example` to `.env`.

If you have cloned the repository, copy them from your clone instead:

```bash
mkdir platehouse && cd platehouse
cp /path/to/platehouse/examples/docker-compose.yml .
cp /path/to/platehouse/examples/.env.example .env
chmod 600 .env
```

The example is a starting point. Read it through: the comments say what each setting is for.

## 2. Fill in `.env`

Set every value in `.env`. [Configuration](./configuration.md) explains each one. The values
you must make yourself:

- `DB_PASS`: a long random password of letters and digits only. Make one with
  `openssl rand -hex 32`. The example puts it into the app's database URL as it is, so a
  password with `@`, `/`, `:`, `#`, `%`, `?` or a space breaks that URL and the app cannot
  connect to the database. See [Configuration](./configuration.md#the-database-password).
- `LINK_SECRET`: at least 32 bytes, for example from `openssl rand -base64 48`.
- The bucket's endpoint, name, region and keys.
- The OIDC issuer, client ID and client secret.

Keep `.env` out of version control and readable only by you.

## 3. Create the networks and folders

The example uses three external networks, so Compose never creates or removes them:

```bash
docker network create proxy                       # skip if your proxy already has one
docker network create --internal platehouse-db
docker network create --internal platehouse-slicer
```

- `proxy` is the network your reverse proxy container shares with the app. If your proxy already
  has one under another name, use that name in `docker-compose.yml` instead.
- `platehouse-db` holds the app and Postgres.
- `platehouse-slicer` holds the app and the slicer, and nothing else. `--internal` means nothing
  on it can reach the internet, which keeps the slicer offline.

If your reverse proxy runs directly on the host instead of in a container, you do not need the
`proxy` network: remove it from the app and uncomment the `ports` line, which publishes the app
on `127.0.0.1:3000` only.

Then create the app's folders and give them to the app image's user (uid and gid 1000). If
Docker creates them on first start they belong to root, and the app cannot write its inbox:

```bash
mkdir -p data/inbox data/tmp
sudo chown 1000:1000 data/inbox data/tmp
```

Postgres creates and owns `data/db` itself.

## 4. Check the file

```bash
docker compose config --quiet
```

This exits with no output when `.env` has every value the file needs. A missing value is named
in the error.

## 5. First start

```bash
docker compose up -d
docker compose ps
```

On its first start the app creates its database tables, starts its job queues and the inbox
watcher, and reads the bucket's versioning setting. Within a minute `docker compose ps` should
show the app and the slicer as `healthy`.

If the app keeps restarting, read its log:

```bash
docker compose logs platehouse
```

A configuration problem is named there by key, for example `Invalid configuration: LINK_SECRET
must be at least 32 bytes`. The log never prints the value.

## 6. Put it behind your proxy

Point your reverse proxy at the app (`platehouse:3000` on the `proxy` network, or
`127.0.0.1:3000` on the host) and follow the guide for your proxy in
[Reverse proxy](./reverse-proxy/index.md). Platehouse relies on the proxy for TLS and for a few
security headers, so the proxy settings matter.

## 7. Sign in

Open your `PUBLIC_ORIGIN` in a browser. You are sent to your identity provider, and back to the
library once you sign in. If sign-in is refused, the page says why; see
[Troubleshooting](./troubleshooting.md#sign-in).

Then, in **Settings**:

- add your printers under **My printers** and make one the default, so estimates are made for them;
- check that there is no red banner about bucket versioning (see [Storage](./storage.md));
- create an API token if you want to use the API.

Then open **Activity** and look at the **Slicer** section. It should say **Sandbox: on**. If it
says **Sandbox: off.**, the line says why: a kernel older than Linux 6.12, or a failed sandbox
check. Pictures, OpenSCAD renders, STEP conversions and estimates are then off; see
[What you need](#what-you-need) and [Troubleshooting](./troubleshooting.md#renders-and-step-files).
**Sandbox: checking** means the slicer has not finished its check yet; look again in a minute.

## Running it without the example

You can run Platehouse any way you run containers, as long as:

- the slicer can be reached by the app and cannot reach the internet;
- the slicer keeps the locked-down settings from the example (read-only root, the `/work`
  tmpfs, no capabilities, its own user);
- both images run tini as PID 1: do not add an init in front of them (`init: true` in Compose,
  `--init` with `docker run`); for the slicer image it turns off its clean-up of processes a job
  left behind;
- the app can reach Postgres, the bucket and your identity provider;
- the reverse proxy follows the requirements in [Reverse proxy](./reverse-proxy/index.md).
