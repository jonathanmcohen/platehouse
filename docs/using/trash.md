# The trash

**Move to trash** on a model takes it out of the library, search and every API answer.

- The **Trash** page (also in **Settings**) lists trashed models, newest first and 100 to a page,
  with the date each will be purged, and a **Restore** button that brings a model back with its
  files, tags and collections. With more than 100, page numbers appear below the list.
- A trashed model is purged automatically 30 days after it was trashed, by a daily job at 03:30.
- **Empty trash** purges everything in the trash at once, on every page and not only the one you
  are looking at, after asking. It purges only the models that were in the trash when you opened
  the page; one trashed since, in another tab, stays.
- A purge deletes the model's database rows and its files in the bucket. It cannot be undone in
  Platehouse. With bucket versioning on, the old versions stay at your storage provider for your
  retention period (see [Storage](../storage.md#turn-on-versioning)).
- A purge that fails part way, for example during a storage outage, leaves the model in the trash,
  and a later run finishes it. A model whose purge has begun deleting files can no longer be
  restored.

The API cannot trash, delete or purge anything, and it cannot see trashed models.
