---
description: What to back up, how to restore the database, and how to upgrade Platehouse and its slicer.
---

# Backups and upgrades

## What to back up

Platehouse keeps its data in two places, and you need both:

| What              | Where                              | How                                              |
| ----------------- | ---------------------------------- | ------------------------------------------------ |
| **The database**  | Postgres, `data/db` in the example | `pg_dump` regularly (below)                      |
| **The bucket**    | Your S3-compatible store           | Versioning, and a copy to a second location      |
| **Your settings** | `.env` and `docker-compose.yml`    | Keep a copy somewhere safe; `.env` holds secrets |

The database knows which files exist and where; the bucket holds their bytes. A database without
its bucket has no files, and a bucket without its database is a pile of objects with random names.
Back them up at about the same time.

You do not need to back up `data/tmp` or the slicer. `data/inbox` only holds files waiting to be
imported, and `data/inbox/failed` files you may want to look at.

### The database

Dump it with `pg_dump` from the database container:

```bash
docker exec platehouse-db pg_dump -U platehouse -d platehouse -Fc > platehouse-$(date +%F).dump
```

Use your own `DB_USER` and `DB_NAME`. Run it on a schedule and keep several days of dumps
somewhere other than the server. The dump holds API token hashes and session hashes, but no
secret values.

Restoring an older dump can delete files uploaded since it was taken, and that can happen as soon
as the restored app starts. Read the warning below and do its steps before you run the restore
commands under it.

:::warning Restoring an older dump can delete newer uploads

Restoring the database does not restore the bucket. Everything Platehouse stored after the dump
was taken (the files uploaded since, and the thumbnails, renders and meshes made since) stays in
the bucket, but the restored database no longer knows about it. Those objects are the only copy
left of the models the restored database lost.

The daily cleanup at 04:00 (see [Storage](./storage.md#cleanup)) treats them as leftovers. It
deletes them once they are more than 24 hours old, as long as they belong to no more models than
its limit: 10 models or a tenth of the models it finds, whichever is larger, but never more than
100. One run may delete every object of up to that many models, at most 100 models with all their
files.
Platehouse has no setting to pause the cleanup, and stopping the app does not skip it: a run
missed while the app was stopped happens as soon as it starts again.

The cleanup can run as soon as the restored app starts, not only at the next 04:00. The job queue
lives in the same database, so the restore puts it back as it was when the dump was taken. If a
04:00 run was due between the dump and the restore, the restored app counts that run as missed and
runs it when it starts. With a dump older than the last 04:00, the first start after the restore
can delete the newer objects.

- **Before you ever need a restore**, turn on bucket versioning (see
  [Storage](./storage.md#turn-on-versioning)). An object the cleanup deletes then keeps its old
  version for your retention period, and you can get it back.
- **Before you restore**, check that versioning is on. If it is off, copy the bucket to a second
  location before you run the restore commands, so the newer objects survive the cleanup.
- **After you restore**, upload the files of every model added since the dump again, through the
  browser or the [inbox folder](./using/adding-files.md#the-inbox-folder). Objects already in the
  bucket cannot be linked back to the restored database, so importing the files again is the only
  way to get those models back into the library. The cleanup may already have deleted the objects
  by then, so if you have no other copy of a file, take it from the bucket copy or the old
  versions: an uploaded file is stored unchanged, but under a random name with no extension.

When the objects belong to more models than the limit, the cleanup deletes nothing and logs why.
That protects you only when the restore leaves more models without rows than the limit, and it is
not a lasting protection: the limit rises as the library grows, up to 100 models, and a restore
that leaves fewer models than the limit has them deleted in full.

:::

To restore, once you have done the steps above, recreate the database and restore into the new,
empty one. Do not restore over the existing database with `pg_restore --clean`: it drops only the
objects the dump holds, so a newer version's tables, which an older dump does not hold, would stay
and stop the next upgrade with "relation already exists". The app must be stopped first, because
`dropdb` fails while it holds connections:

```bash
docker compose stop platehouse
docker exec platehouse-db dropdb -U platehouse platehouse
docker exec platehouse-db createdb -U platehouse platehouse
docker exec -i platehouse-db pg_restore -U platehouse -d platehouse --exit-on-error --single-transaction < platehouse-2026-01-01.dump
docker compose start platehouse
```

Use your own `DB_USER` and `DB_NAME` in place of `platehouse` in the three database commands.

This ends with `start`, which is right when the images are the version the dump came from. To go
back to an older version, set both image tags back first and finish with
`docker compose up -d --no-deps platehouse platehouse-slicer` instead, as [Upgrading](#upgrading)
says.

Then upload the files of the models added since the dump again, as the warning says.

### The bucket

- Turn on versioning and keep old versions for 30 days (see [Storage](./storage.md)). That covers
  mistakes and purges inside Platehouse.
- For a real backup, copy the bucket to a second location your storage provider or a tool such as
  `rclone` can reach, on a schedule.

## Upgrading

Platehouse follows semantic versioning. Read the [changelog](./changelog.md) before upgrading.

1. Back up the database and check the bucket's versioning is on.
2. Change both image tags in `docker-compose.yml`, the app's and the slicer's, to the new version,
   for example `ghcr.io/jonathanmcohen/platehouse:X.Y.Z` and
   `ghcr.io/jonathanmcohen/platehouse-slicer:X.Y.Z`.
3. Pull and recreate the app and the slicer, and nothing else:

   ```bash
   docker compose pull platehouse platehouse-slicer
   docker compose up -d --no-deps platehouse platehouse-slicer
   ```

   `--no-deps` recreates only those two. A plain `docker compose up -d` also recreates any other
   service whose settings changed, the database included, which you may not want mid-upgrade.
4. Check it came up: `docker compose ps` shows the app `healthy`, and
   `docker compose logs platehouse` shows no errors.

The app applies any database changes itself when it starts. They only move forward, so going back
to an older version means first setting both image tags back to that version (see
[the slicer](#the-slicer) for 0.1.0), then restoring the database dump you took in step 1, into a
recreated database as described under [restoring the database](#the-database), not a cleaned one,
and finishing with `docker compose up -d --no-deps platehouse platehouse-slicer` instead of the
`start` that section ends with, which would start the image you are leaving. Read the warning below
before you restore it.

:::warning Going back can delete what was uploaded since step 1

Restoring the step 1 dump puts the database back to before the upgrade, but not the bucket.
Anything uploaded after step 1 stays in the bucket with no record in the database, and the cleanup
deletes it once it is more than 24 hours old, within its limit. The restore also puts back the job
queue as it was at step 1, so if a 04:00 run was due since then, the cleanup can run as soon as the
app starts on the restored database, not only at the next 04:00.

Before you restore the step 1 dump, check that versioning is on, and copy the bucket to a second
location if it is off. After you go back, upload those files again. The warning under
[restoring the database](#the-database) has the details.

:::

### Upgrading to 0.1.1

Before and after the steps above, when you go from 0.1.0 to 0.1.1:

- **Change both image tags together**, to `platehouse:0.1.1` and `platehouse-slicer:0.1.1`. The
  0.1.1 app cannot read an older slicer's answers: new files get no estimates, the Activity page
  shows the slicer as **Not reachable**, and preview pictures wait for the slicer for up to 2
  hours (see [Troubleshooting](./troubleshooting.md#estimates)).
- **Check the host's kernel** with `uname -r` before you upgrade. 0.1.1 runs estimates and STEP
  conversions inside the slicer's sandbox too, which needs a kernel with Landlock ABI 6 (see
  [What you need](./install.md#what-you-need)). On a kernel without it, pictures and OpenSCAD renders are off, and estimates and STEP conversions stop unless
  `SLICER_ALLOW_UNSANDBOXED=true` is set on the slicer (see [Security](./security.md#the-slicer-sandbox)
  for what that gives up). The example Compose file shipped with 0.1.1 has that line commented
  out, so to set it, add this line under the `platehouse-slicer` service's `environment:` in
  `docker-compose.yml` (in place of the commented one) and set `SLICER_ALLOW_UNSANDBOXED=true` in
  `.env`:

  ```yaml
  SLICER_ALLOW_UNSANDBOXED: ${SLICER_ALLOW_UNSANDBOXED:-false}
  ```

  After the upgrade, check the **Sandbox** line in the **Slicer** section of the
  [Activity](./using/activity.md#the-slicer-section) page.
- **Expect a slower first start.** Before it answers, the first start of 0.1.1 builds new
  database indexes (migration 0016), which takes longer on a large library. It can take longer
  than the app image's 60-second health check start period, so `docker compose ps` may show the
  app as unhealthy for a while. Wait for it, and read `docker compose logs platehouse`, before you
  restart anything.
- **Some sessions end.** Migration 0013 ends the sessions of any account whose user id (the
  `sub` claim) is longer than 255 characters, since such an account can no longer sign in (see
  [Sign-in](./sign-in.md#what-platehouse-asks-of-the-provider)). Every other session carries on.
- **Older tokens have no maker.** Settings now shows who made each API token. Tokens made with
  0.1.0 show "Made by an unknown user (before Platehouse recorded who made each token)"; they keep
  working. From 0.1.2, Sign out everywhere can revoke them with a second box (see
  [Sign-in](./sign-in.md#the-allowed-group), step 2 of cutting someone off), though a shared
  script may stop working. Checking the token list in Settings after the upgrade is still a good
  idea.
- **Background work after the first start.** Older STL and STEP files get their preview pictures
  in the background ("Preview pictures for older STL and STEP files" under **Scheduled jobs** on
  the Activity page). MakerWorld descriptions imported before 0.1.1 are converted again from their
  `.3mf` once (migration 0014), and models whose MakerWorld licence 0.1.0 did not recognise, CC
  BY-ND among them, get their licence or licence note back; the Activity page lists this as
  "MakerWorld descriptions and licences (until they finish)" until it is done. A description you
  edited, and a licence or licence note already set, are left as they are.
- **No init in front of the app.** The 0.1.1 app image runs tini as PID 1, like the slicer image.
  If you added `init: true` (or `--init`) to either service, remove it.

### The slicer

The slicer image is tagged with the release version, `platehouse-slicer:X.Y.Z`, the same as the
app image, and that version tag is the pin. `orca-X.Y.Z` follows the newest build of that
OrcaSlicer version from main or a release, never a release candidate, and `stable` the newest such
build of any OrcaSlicer version. You move to a new release with the Upgrading steps above, which
change both tags together. From 0.1.1 on, upgrade them together in any case: the 0.1.1 app refuses
an older slicer, pictures and OpenSCAD renders need a kernel with Landlock ABI 6 (see
[What you need](./install.md#what-you-need)), and without one estimates and STEP conversions stop unless `SLICER_ALLOW_UNSANDBOXED=true` is set on the
slicer. See [Upgrading to 0.1.1](#upgrading-to-011).

When the slicer's OrcaSlicer version changes, Platehouse re-estimates the library in the
background, since a new version can give different numbers. From 0.1.1 on, to go back, set both
images to the previous version tag. 0.1.0 has no slicer version tag, because those began after it.
To go back to 0.1.0, set the slicer to `ghcr.io/jonathanmcohen/platehouse-slicer:orca-2.5.1-r3`,
the build 0.1.0's example file resolved to (`orca-2.5.1` itself still points at it, but is a moving
tag), together with `ghcr.io/jonathanmcohen/platehouse:0.1.0`.

A pinned deployment gets the slicer's fixes, such as a newer Ubuntu snapshot or OrcaSlicer, with
the next Platehouse release's version tag. Pulling the same version tag again gets nothing new. The
STL and STEP preview pictures added in 0.1.1 need a slicer image from 0.1.1 or later. With an older one, a preview waits for the slicer,
for up to 2 hours, and then shows "The slicer is not answering, so the preview picture could not
be made. It will be tried again automatically." It is tried again in the background, so the
picture appears once the slicer image is updated.

### Testing a release candidate

Both images also carry an `rc` tag, meant for a test server. Unlike a version tag it moves. It
points at the newest version, by version number, that has both images published: the highest
release candidate (`vX.Y.Z-rc.N`) or release (`vX.Y.Z`) whose app image and slicer image were
both built. Both `rc` tags point at builds of the same version, so a test server does not run a
new app with an old slicer. The workflow that moves them reads both before it moves either, and if
it fails after moving one, it moves that one back. Only if moving it back fails too can the two
differ for a while, until the workflow next succeeds; compare the digests (below) if a candidate
behaves as if app and slicer do not match.

To follow it, set both images in `docker-compose.yml` to `rc`:

- `ghcr.io/jonathanmcohen/platehouse:rc`
- `ghcr.io/jonathanmcohen/platehouse-slicer:rc`

Then, to pick up the newest candidate, back up the database and pull:

```bash
docker compose pull platehouse platehouse-slicer
docker compose up -d --no-deps platehouse platehouse-slicer
```

A release for an older version that is cut after a newer candidate, such as a `0.1.1` fix while
`0.2.0-rc.1` is being tested, does not move `rc`: it stays on the newer candidate, by design.
Throwaway tags such as `v0.0.0-test` and other prerelease kinds never move it.

To check which version `rc` points at, compare its digest with a version's (the project's
releases page does not list candidates, so it cannot tell you):

```bash
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse:rc --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse:0.2.0-rc.1 --format '{{.Manifest.Digest}}'
```

Do not run `rc` on a server you rely on. A release candidate can have bugs the release fixes, and
the app's database changes only move forward, so going back from a candidate means restoring the
dump you took before you pulled it. First set both image tags back to the previous version (see
[the slicer](#the-slicer) for 0.1.0), then recreate the database and restore into it, as described
under [restoring the database](#the-database), but finish with
`docker compose up -d --no-deps platehouse platehouse-slicer` instead of `start`, which would start
the candidate again. Read the warning there about files uploaded since the dump.

### Postgres

The example pins `postgres:17-alpine`. Minor updates within 17 are safe to pull. Moving to a new
major version (18 or later) needs a dump and restore, or `pg_upgrade`; do not just change the tag,
or Postgres will not start on the old data folder.

### Automatic updates

If you use a tool that updates containers automatically, such as Watchtower, give it a stop
timeout of at least 40 seconds. The app needs up to 30 seconds to stop cleanly, and a tool that
kills it sooner can cut off a running job.

Such a tool pulls the tag a container already uses again, and recreates the container when that
tag now names a newer image. It never changes the tag:

- With the version tags the example pins, such as `0.1.1`, it finds nothing new, because a
  version tag does not move. Upgrade by hand, with the steps above.
- Moving tags, such as the app's `latest` and the slicer's `stable`, can leave the app and the
  slicer on different versions. Each container is updated on its own, so one can be pulled before
  the other has moved, and `stable` also moves between releases, whenever the daily slicer build
  publishes a new OrcaSlicer version. Do not follow them with an automatic update; the app and the
  slicer must be the same version. The `rc` tag is the one moving tag kept on the same version for
  both images, and it is for test servers only (see
  [Testing a release candidate](#testing-a-release-candidate)).
