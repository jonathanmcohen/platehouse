---
description: "How the trash works: moving models to it, restoring them and purging them."
---

# The trash

**Move to trash** takes a model out of the library, search and every API answer. The model page
has no such button. Use it on a row of the Tags, Creators or Collections pages, or in Select mode
in the library.

- The **Trash** page (also in **Settings**) lists trashed models, newest first and 100 to a page,
  with the date each will be purged, and a **Restore** button that brings a model back with its
  files, tags and collections. With more than 100, page numbers appear below the list.
- A trashed model is purged automatically 30 days after it was trashed, by a daily job at 03:30.
- **Empty trash** deletes everything in the trash, on every page and not only the one you are
  looking at, after asking. It deletes only the models that were in the trash when you opened the
  page; one trashed since, in another tab, stays. The deletion runs in the background: the page
  shows the models as being deleted until they are gone, and says how many were deleted when it is
  done. A model cannot be restored once you confirm Empty trash. After a restart or a storage
  outage, the deletion finishes when the server or the storage is back, or at the latest at the
  03:30 purge.
- A purge deletes the model's database rows and its files in the bucket. It cannot be undone in
  Platehouse. With bucket versioning on, the old versions stay at your storage provider for your
  retention period (see [Storage](../storage.md#turn-on-versioning)).
- A purge that fails part way, for example during a storage outage, leaves the model in the trash,
  and a later run finishes it. A model whose purge has begun, from Empty trash or the daily job,
  can no longer be restored, even while it is still listed. A purge can also fail because the
  model has an object in the bucket under a key outside the `models/<model id>/<blob id>` layout,
  which Platehouse will not delete. The model stays in the trash until you remove that object by
  hand, and then the next run finishes it.

The API cannot trash, delete or purge anything, and it cannot see trashed models.
