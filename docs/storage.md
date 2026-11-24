# Storage

Platehouse keeps file bytes in an S3-compatible bucket and everything else in Postgres. Any store
that speaks the S3 API should work: AWS S3, MinIO, Garage, Ceph RGW, Cloudflare R2, Backblaze B2,
Wasabi and others.

## The bucket

Give Platehouse a bucket of its own. Platehouse lists and cleans up its own prefix, and it is
simplest to reason about when nothing else writes there.

The access key needs to:

- list the bucket (`s3:ListBucket`) and get, put and delete objects in it (`s3:GetObject`,
  `s3:PutObject`, `s3:DeleteObject`);
- cancel unfinished multipart uploads (`s3:AbortMultipartUpload`);
- read the bucket's versioning setting (`s3:GetBucketVersioning`), for the Settings warning.

Scope these to the bucket and its objects, and grant nothing more. In particular, do not grant
`s3:PutBucketVersioning`, `s3:PutLifecycleConfiguration` or `s3:DeleteObjectVersion`: the first two let
a leaked key change the bucket's protection, and `s3:DeleteObjectVersion` lets it erase the old
versions that versioning keeps. Without it, Platehouse's own small storage check under `checks/`
leaves an old version and a delete marker behind each time, which the lifecycle rule below removes.

Set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, the two keys and `S3_FORCE_PATH_STYLE` as described
in [Configuration](./configuration.md). Most self-hosted stores need `S3_FORCE_PATH_STYLE=true`.
An `S3_ENDPOINT` that starts with `http:` sends every object's bytes unencrypted; use `https:`
unless the store is on the same host or a private network you trust.

The bucket does not need to be public, and it should not be. No browser or slicer ever talks to
the bucket: every download is streamed through the app, so no bucket address, key or signed URL
leaves the server.

## Turn on versioning

Turn on versioning for the bucket at your storage provider, and keep old versions for 30 days
(a lifecycle rule that expires noncurrent versions after 30 days). That gives you a way back if
a file is overwritten or deleted by mistake, including by a purge from the trash.

Add two more lifecycle rules at your storage provider:

- expire noncurrent versions of objects under the `checks/` prefix after 1 day, so the storage
  check leaves nothing behind;
- abort incomplete multipart uploads after 7 days (`AbortIncompleteMultipartUpload`), so an upload
  that was cut off does not keep using space.

Platehouse reads the bucket's versioning state when it starts. While versioning is off or
suspended, the Settings page shows a red banner: "Bucket versioning is off. Turn it on at your
storage provider and keep old versions for 30 days." Restart the app after you turn it on to clear
the banner.

## What is stored where

| Where            | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The bucket**   | Every uploaded file, unchanged; plate thumbnails taken from `.3mf` files; the STL and preview image rendered from each OpenSCAD file; the mesh made from each STEP file; the preview picture of each STL and STEP file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Postgres**     | Models, files and their names, plates, filaments, estimates, tags, collections, the trash, settings, API token hashes, sessions and the job queues.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **`data/inbox`** | Files you drop in to be imported, and `inbox/failed/` for any that could not be. An imported file is deleted from the inbox once its stored copy is checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **`data/tmp`**   | Unfinished uploads and working copies, deleted after each job; a working copy a crash left (a `render-*` or `plate-mesh-*` folder) is removed when the server starts. An unfinished upload is deleted 24 hours after it was created, whatever has arrived by then, or after an hour if it has received no byte. All uploads still in `data/tmp` may hold at most `UPLOAD_TEMP_MAX_BYTES` together (4 GiB by default), and each session or API token at most 20 unfinished uploads and 2,000 uploads in any state (a finished upload's record is kept a day after its import). The uploads folder holds at most 10,000 uploads in any state. A new upload past the total or the 10,000, or one that would leave the disk less than 1 GiB free, counting the bytes other unfinished uploads are still to receive, or fewer than 10,000 free inodes, is refused with `507`; one past the 20 or the 2,000 is refused with `429`; an empty one is refused with `400`. Refusals are logged with the session or token they were for, at most once a minute for each session or token and status. A refusal for the total also names the three users holding the most bytes, and one for the 10,000 the three holding the most uploads (`held most by ...`); the other refusals name no holder. Each upload's info file in `data/tmp/uploads` names its user. Give it its own volume or quota, apart from the database. |
| **The slicer**   | Nothing kept. Its `/work` is a memory-backed folder that is emptied after every job.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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
it. It deletes nothing when the database holds no files at all, or when a run would delete objects
from more models than its limit, which is 10 models or a tenth of the models it found, whichever
is larger, but never more than 100. The limit counts models, not objects, so one interrupted
import, which can leave over a hundred objects under one model, is cleaned up. A run may delete
every object of up to that many models, at most 100 models with all their files. A restored old
database is refused only when the restore leaves more models without files than the limit. It
logs why. If you see such a log line, check that the app is pointed at the right database and
bucket.

Those two checks stop a run when the database looks plainly wrong; they do not stop it deleting
objects that are not really leftovers. After you restore an older database dump, the database
still holds files, so the first check passes, and every object stored since the dump has no
matching file. The cleanup deletes those objects once they are more than 24 hours old, as long as
they belong to few enough models to fit within the limit, and they are the only copy left of the
models the restored database no longer knows about. The same happens when the app is pointed at
another Platehouse database, or a second Platehouse shares the bucket. Platehouse has no setting to pause the cleanup, and a run
missed while the app was stopped happens when it starts again. Bucket versioning is the
protection: turn it on before you need it. For what to do after a restore, see
[Backups and upgrades](./backups-and-upgrades.md#the-database).

To back up the bucket, see [Backups and upgrades](./backups-and-upgrades.md).
