# Storage

Platehouse keeps file bytes in an S3-compatible bucket and everything else in Postgres. Any store
that speaks the S3 API should work: AWS S3, MinIO, Garage, Ceph RGW, Cloudflare R2, Backblaze B2,
Wasabi and others.

## The bucket

Give Platehouse a bucket of its own. Platehouse lists and cleans up its own prefix, and it is
simplest to reason about when nothing else writes there.

The access key needs to:

- put, get, list and delete objects in the bucket;
- read the bucket's versioning setting (`GetBucketVersioning`), for the Settings warning;
- delete a specific object version (`DeleteObjectVersion`), if versioning is on. Without it,
  Platehouse's own small storage check leaves an old version and a delete marker behind until
  your retention period removes them.

Set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, the two keys and `S3_FORCE_PATH_STYLE` as described
in [Configuration](./configuration.md). Most self-hosted stores need `S3_FORCE_PATH_STYLE=true`.

The bucket does not need to be public, and it should not be. No browser or slicer ever talks to
the bucket: every download is streamed through the app, so no bucket address, key or signed URL
leaves the server.

## Turn on versioning

Turn on versioning for the bucket at your storage provider, and keep old versions for 30 days
(a lifecycle rule that expires noncurrent versions after 30 days). That gives you a way back if
a file is overwritten or deleted by mistake, including by a purge from the trash.

Platehouse reads the bucket's versioning state when it starts. While versioning is off or
suspended, the Settings page shows a red banner: "Bucket versioning is off. Turn it on at your
storage provider and keep old versions for 30 days." Restart the app after you turn it on to clear
the banner.

## What is stored where

| Where            | What                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The bucket**   | Every uploaded file, unchanged; plate thumbnails taken from `.3mf` files; the STL and preview image rendered from each OpenSCAD file; the mesh made from each STEP file; the preview picture of each STL and STEP file. |
| **Postgres**     | Models, files and their names, plates, filaments, estimates, tags, collections, the trash, settings, API token hashes, sessions and the job queues.                                                                     |
| **`data/inbox`** | Files you drop in to be imported, and `inbox/failed/` for any that could not be. An imported file is deleted from the inbox once its stored copy is checked.                                                            |
| **`data/tmp`**   | Unfinished uploads (deleted after 24 hours untouched) and working copies, deleted after each job.                                                                                                                       |
| **The slicer**   | Nothing kept. Its `/work` is a memory-backed folder that is emptied after every job.                                                                                                                                    |

Objects are stored under `models/<model id>/<blob id>`, two random IDs with no file name or
extension in them. Renaming a model or file in Platehouse changes only its display name; the
object keeps its key. Platehouse writes one object outside that layout, `checks/write-check`,
which it puts and deletes again when it checks that the bucket can be written to.

## When the bucket is unreachable

- Library and model pages still load from the database, and files show as unavailable right now.
- An upload fails visibly and leaves no half-made model.
- Nothing is marked missing or damaged because of an outage.
- Estimates and renders wait for the bucket and carry on when it is back.

## Cleanup

A daily job at 04:00 deletes objects under `models/` that have no matching file in the database
and are more than 24 hours old, such as one left behind by a crash between an upload and saving
it. It deletes nothing when the database holds no files at all, or when a run would delete more
than its limit, which is 10 objects or a tenth of what it found, whichever is larger, but never
more than 100. It logs why. If you see such a log line, check that the app is pointed at the right
database and bucket.

Those two checks stop a run when the database looks plainly wrong; they do not stop it deleting
objects that are not really leftovers. After you restore an older database dump, the database
still holds files, so the first check passes, and every object stored since the dump has no
matching file. The cleanup deletes those objects once they are more than 24 hours old, as long as
they fit within the limit, and they are the only copy left of the models the restored database no
longer knows about. The same happens when the app is pointed at another Platehouse database, or a
second Platehouse shares the bucket. Platehouse has no setting to pause the cleanup, and a run
missed while the app was stopped happens when it starts again. Bucket versioning is the
protection: turn it on before you need it. For what to do after a restore, see
[Backups and upgrades](./backups-and-upgrades.md#the-database).

To back up the bucket, see [Backups and upgrades](./backups-and-upgrades.md).
