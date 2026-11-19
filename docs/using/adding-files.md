# Adding files

Platehouse takes `.3mf`, `.stl`, `.step`, `.stp` and `.scad` files, up to 512 MiB each. A file is
checked by its contents as well as its name: a `.3mf` must really be a zip, a `.scad` must be
text, and so on. Anything else is refused with a message, and nothing is stored.

There are three ways in: the browser, the inbox folder, and the [API](../api-guide.md).

## Uploading in the browser

Drag files onto the library, or press **Add** in the top bar. The upload dialog shows a progress
bar and a status for each file.

- Each file becomes its own model, unless you turn on **Combine into one model**, which puts all
  the files of that upload into one model.
- To add files to an existing model, drop them on its page, or press **Add files** there.
- Uploads go in 5 MiB pieces and pick up where they stopped if the connection drops.
- A file over 512 MiB is listed as too large and is not sent.

As soon as a file is stored, its plates are queued for estimates and any OpenSCAD or STEP file is
queued for rendering. The upload does not wait for either.

## What happens to a .3mf

When a `.3mf` arrives, Platehouse reads from it:

- the plate list, with names, object counts and thumbnails;
- the filaments, with type and colour;
- Bambu's own slice numbers, if the file was sliced, and the printer it was sliced for;
- the MakerWorld details, if it came from MakerWorld: title, designer, description and licence.

MakerWorld details only fill fields that are empty, so nothing you set is overwritten. A licence
MakerWorld uses that has no standard identifier is kept as a licence note on the model.

A damaged or unusual `.3mf` is still stored, and shows "No Bambu plate data in this file". Limits
on plate count, thumbnail size and similar keep a crafted file from tying up the app.

## The inbox folder

Any supported file you put in the inbox folder (`data/inbox` in the example setup) becomes a
model of its own, with no further step. This suits a network share or a sync tool.

- The folder is checked every 5 seconds. A file is imported only once its size and modification
  time have stayed the same for `INBOX_SETTLE_SECONDS` (15 by default), so a copy that is still
  running is not taken early.
- Hidden files (starting with `.`), folders, symbolic links and names ending in `.part`,
  `.crdownload` or `.tmp` are left alone.
- After the file is stored and its stored copy is checked (size and SHA-256), it is deleted from
  the inbox.
- A file that cannot be imported moves to `inbox/failed/`, with a text file beside it,
  `name.reason.txt`, that says why in one sentence. See
  [Troubleshooting](../troubleshooting.md#the-inbox).

If the database, the bucket or the temporary folder is down, the inbox waits and tries again,
backing off up to 5 minutes, instead of failing files.
