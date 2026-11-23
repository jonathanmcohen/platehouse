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
deletes them once they are more than 24 hours old, as long as there are no more of them than its
limit: 10 objects or a tenth of the objects it finds, whichever is larger, but never more than 100.
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

When the cleanup finds more of these objects than its limit, it deletes nothing and logs why. That
is not protection: the limit rises as the library grows, up to 100, and a later run that finds
them within it deletes them all.

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

### The slicer

The slicer image is tagged with the release version, `platehouse-slicer:X.Y.Z`, the same as the
app image, and that version tag is the pin. `orca-X.Y.Z` follows the newest build of that
OrcaSlicer version from main or a release, never a release candidate, and `stable` the newest such
build of any OrcaSlicer version. You move to a new release with the Upgrading steps above, which
change both tags together.

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
