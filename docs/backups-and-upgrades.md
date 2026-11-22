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

To restore into an empty database:

```bash
docker compose stop platehouse
docker exec -i platehouse-db pg_restore -U platehouse -d platehouse --clean --if-exists < platehouse-2026-01-01.dump
docker compose start platehouse
```

:::warning Restoring an older dump can delete newer uploads

Restoring the database does not restore the bucket. Everything Platehouse stored after the dump
was taken (the files uploaded since, and the thumbnails, renders and meshes made since) stays in
the bucket, but the restored database no longer knows about it. Those objects are the only copy
left of the models the restored database lost.

The daily cleanup at 04:00 (see [Storage](./storage.md#cleanup)) treats them as leftovers. It
deletes them once they are more than 24 hours old, as long as there are no more of them than its
limit: 10 objects or a tenth of the objects it finds, whichever is larger, but never more than 100.
Platehouse has no setting to pause the cleanup, and stopping the app does not skip it: a run
missed while the app was stopped happens as soon as it starts again. So the next run after a
restore can be the one that deletes them.

- **Before you ever need a restore**, turn on bucket versioning (see
  [Storage](./storage.md#turn-on-versioning)). An object the cleanup deletes then keeps its old
  version for your retention period, and you can get it back.
- **Before you restore**, if versioning is off, copy the bucket to a second location, so the newer
  objects survive the cleanup.
- **After you restore**, before the next cleanup, upload the files of every model added since the
  dump again, through the browser or the [inbox folder](./using/adding-files.md#the-inbox-folder).
  Objects already in the bucket cannot be linked back to the restored database, so importing the
  files again is the only way to get those models back into the library. If you have no other copy
  of a file, take it from the bucket copy or the old versions: an uploaded file is stored
  unchanged, but under a random name with no extension.

When the cleanup finds more of these objects than its limit, it deletes nothing and logs why. That
is not protection: the limit rises as the library grows, up to 100, and a later run that finds
them within it deletes them all.

:::

### The bucket

- Turn on versioning and keep old versions for 30 days (see [Storage](./storage.md)). That covers
  mistakes and purges inside Platehouse.
- For a real backup, copy the bucket to a second location your storage provider or a tool such as
  `rclone` can reach, on a schedule.

## Upgrading

Platehouse follows semantic versioning. Read the [changelog](./changelog.md) before upgrading.

1. Back up the database and check the bucket's versioning is on.
2. Change the app image tag in `docker-compose.yml` to the new version, for example
   `ghcr.io/jonathanmcohen/platehouse:0.1.1`.
3. Pull and recreate the app alone:

   ```bash
   docker compose pull platehouse
   docker compose up -d --no-deps platehouse
   ```

   `--no-deps` recreates only the app. A plain `docker compose up -d` also recreates any other
   service whose settings changed, the database included, which you may not want mid-upgrade.
4. Check it came up: `docker compose ps` shows the app `healthy`, and
   `docker compose logs platehouse` shows no errors.

The app applies any database changes itself when it starts. They only move forward, so to go back
to an older version, restore the database dump you took in step 1.

:::warning Going back can delete what was uploaded since step 1

Restoring the step 1 dump puts the database back to before the upgrade, but not the bucket.
Anything uploaded after step 1 stays in the bucket with no record in the database, and the daily
04:00 cleanup deletes it once it is more than 24 hours old, within its limit. Before the next
cleanup, follow the warning under [restoring the database](#the-database): check that versioning
is on, and upload those files again after you go back.

:::

### The slicer

The slicer image is tagged `orca-X.Y.Z` for the OrcaSlicer version it contains, and `stable`
points to the newest one that has passed a test slice. To move to a new OrcaSlicer version, change
the tag and recreate the slicer:

```bash
docker compose pull platehouse-slicer
docker compose up -d --no-deps platehouse-slicer
```

When the slicer's OrcaSlicer version changes, Platehouse re-estimates the library in the
background, since a new version can give different numbers. To go back, set the previous tag
again.

### Postgres

The example pins `postgres:17-alpine`. Minor updates within 17 are safe to pull. Moving to a new
major version (18 or later) needs a dump and restore, or `pg_upgrade`; do not just change the tag,
or Postgres will not start on the old data folder.

### Automatic updates

If you use a tool that updates containers automatically, such as Watchtower, give it a stop
timeout of at least 40 seconds. The app needs up to 30 seconds to stop cleanly, and a tool that
kills it sooner can cut off a running job.
