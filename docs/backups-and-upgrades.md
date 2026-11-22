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

### The slicer

The slicer image is tagged `orca-X.Y.Z` for the OrcaSlicer version it contains, and `stable`
points to the newest one that has passed a test slice. Its `rc` tag is for test servers (see
[Testing a release candidate](#testing-a-release-candidate)). To move to a new OrcaSlicer version, change
the tag and recreate the slicer:

```bash
docker compose pull platehouse-slicer
docker compose up -d --no-deps platehouse-slicer
```

When the slicer's OrcaSlicer version changes, Platehouse re-estimates the library in the
background, since a new version can give different numbers. To go back, set the previous tag
again.

### Testing a release candidate

Both images also carry an `rc` tag, meant for a test server. Unlike a version tag it moves: every
release candidate (`vX.Y.Z-rc.N`) and every release (`vX.Y.Z`) points `rc` at that build. A
server on `rc` therefore runs the newest release candidate, or the newest release once that is
newer, and never anything older than the newest release.

To follow it, set both images in `docker-compose.yml` to `rc`:

- `ghcr.io/jonathanmcohen/platehouse:rc`
- `ghcr.io/jonathanmcohen/platehouse-slicer:rc`

Then, to pick up the newest candidate, back up the database and pull:

```bash
docker compose pull platehouse platehouse-slicer
docker compose up -d --no-deps platehouse platehouse-slicer
```

Do not run `rc` on a server you rely on. A release candidate can have bugs the release fixes, and
the app's database changes only move forward, so going back from a candidate means restoring the
dump you took before you pulled it. The slicer image's daily OrcaSlicer updates do not move `rc`;
only a new release candidate or release does.

### Postgres

The example pins `postgres:17-alpine`. Minor updates within 17 are safe to pull. Moving to a new
major version (18 or later) needs a dump and restore, or `pg_upgrade`; do not just change the tag,
or Postgres will not start on the old data folder.

### Automatic updates

If you use a tool that updates containers automatically, such as Watchtower, give it a stop
timeout of at least 40 seconds. The app needs up to 30 seconds to stop cleanly, and a tool that
kills it sooner can cut off a running job.
