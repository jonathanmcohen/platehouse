# Adding files

Platehouse takes `.3mf`, `.stl`, `.step`, `.stp` and `.scad` files, up to 512 MiB each. A file is
checked by its contents as well as its name: a `.3mf` must really be a zip, a `.scad` must be
text, and so on. Anything else is refused with a message, and nothing is stored.

There are three ways in: the browser, the inbox folder, and the [API](../api-guide.md). Each
handles a file the library already holds differently; see [Duplicate files](#duplicate-files).

## Uploading in the browser

Drag files onto the library, or press **Add** in the top bar. The upload dialog shows a progress
bar and a status for each file.

- Each new file becomes its own model, unless you turn on **Combine into one model**, which puts
  all the files of that upload into one model.
- A file that is already in the library is skipped, and the dialog links to the model that holds
  it. Press **Import anyway** on that file to store it again.
- To add files to an existing model, drop them on its page, or press **Add files** there.
- Uploads go in 5 MiB pieces and pick up where they stopped if the connection drops.
- A file over 512 MiB is listed as too large and is not sent.

As soon as a file is stored, its plates are queued for estimates and any OpenSCAD or STEP file is
queued for rendering. The upload does not wait for either.

## How a new model is named

- A `.3mf` from MakerWorld (one that names a designer) gives the model its MakerWorld title, the
  same text shown as its caption.
- Otherwise the model is named after the file: the extension dropped, underscores and runs of two
  or more dashes turned into spaces, capitals kept. `Air_Dry--AMS.3mf` becomes `Air Dry AMS`.
- A title longer than 500 characters is cut to fit.
- A name you set yourself is never replaced by a file's title. See
  [Organising](./organising.md#renaming).

## What happens to a .3mf

When a `.3mf` arrives, Platehouse reads from it:

- the plate list, with names, object counts and thumbnails;
- the filaments, with type and colour;
- Bambu's own slice numbers, if the file was sliced, and the printer it was sliced for;
- the MakerWorld details, if it came from MakerWorld: title, designer, description, licence and
  the design's ID, used for the **View on MakerWorld** link (see
  [Models, files and plates](./models-files-plates.md#view-on-makerworld)).

MakerWorld details only fill fields that are empty, so nothing you set is overwritten. A licence
MakerWorld uses that has no standard identifier is kept as a licence note on the model.

A damaged or unusual `.3mf` is still stored, and shows "No Bambu plate data in this file". Limits
on plate count, thumbnail size and similar keep a crafted file from tying up the app.

## The inbox folder

Any supported file you put in the inbox folder (`data/inbox` in the example setup) becomes a
model of its own, with no further step, unless the library already holds it. This suits a network
share or a sync tool.

- The folder is checked every 5 seconds. A file is imported only once its size and modification
  time have stayed the same for `INBOX_SETTLE_SECONDS` (15 by default), so a copy that is still
  running is not taken early.
- Hidden files (starting with `.`), folders, symbolic links and names ending in `.part`,
  `.crdownload` or `.tmp` are left alone.
- A file the library already holds is not imported. It moves to `inbox/failed/` with a reason that
  names the model holding it.
- After the file is stored and its stored copy is checked (size and SHA-256), it is deleted from
  the inbox.
- A file that cannot be imported moves to `inbox/failed/`, with a text file beside it,
  `name.reason.txt`, that says why in one sentence. See
  [Troubleshooting](../troubleshooting.md#the-inbox). Failed inbox files also show on the
  [Activity](./activity.md) page.

If the database, the bucket or the temporary folder is down, the inbox waits and tries again,
backing off up to 5 minutes, instead of failing files.

## Duplicate files

Platehouse recognises a file it already holds by its SHA-256, whatever its name. Only models in the
library count: a file whose only copy is in the trash is not a duplicate.

| Way in         | What happens to a duplicate                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser upload | Skipped, with a link to the model that holds it. **Import anyway** stores it again.                                                                                                                           |
| Inbox folder   | Not imported. It moves to `inbox/failed/`, and its reason file names the model that holds it. To import it anyway, upload it in the browser and press **Import anyway**.                                      |
| API            | Stored again by default (`duplicates` set to `allow`), and the result lists the copies already in the library. Send `duplicates` set to `skip` to have a duplicate refused with the code `duplicate` instead. |
