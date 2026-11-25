---
description: What changed for people using Platehouse in 0.1.1, with a link to the page that covers each change.
---

# New in 0.1.1

This page points to what changed in 0.1.1 for the people who use and run Platehouse. Every change,
including the fixes, is in the [changelog](../changelog.md).

## Before you upgrade

Upgrade the app and the slicer images together, and check the host's kernel first: 0.1.1 needs
Linux 6.12 or newer for the slicer's sandbox. The first start can be slow while the database gets
new indexes. See [Upgrading to 0.1.1](../backups-and-upgrades.md#upgrading-to-011).

## Changes

- **Preview pictures for STL and STEP files.** An STL or STEP model shows a picture of the model on
  its library card and in the model page's **Files** tab, in place of the file-type icon. Files
  added before 0.1.1 get theirs in the background after the upgrade. See
  [Models, files and plates](./models-files-plates.md#the-3d-viewer).
- **A plate in 3D.** **Show in 3D** under a `.3mf`'s plate picture, or a click on the picture,
  shows only that plate's objects in the 3D viewer, coloured by their filament; **Show picture**
  goes back. See [Models, files and plates](./models-files-plates.md#a-plate-in-3d).
- **Delete tags and collections.** The **Tags** and **Collections** pages have a **Delete** beside
  each one, and a tag is removed on its own once no model has it. See
  [Organising](./organising.md#tags).
- **Who made each token, and Sign out everywhere.** Settings shows who made each API token, and
  **Sign out everywhere** ends every session of one person and can revoke the tokens they made.
  Making a token, signing someone else out and revoking someone else's token need a sign-in from
  the last 5 minutes. Tokens made with 0.1.0 have no recorded maker, so Sign out everywhere never
  revokes them; revoke those by hand in the token list. See [Settings](./settings.md#api-tokens)
  and [Sign-in](../sign-in.md#the-allowed-group).
- **Clearer slicing failures.** A plate whose objects do not fit the printer's bed says "The
  plate is too big for this printer's bed." instead of a general slicer error, and a plate the
  slicer refused because its sandbox is off says so. See
  [Printers and estimates](./printers-and-estimates.md#when-a-plate-cannot-be-sliced).
- **Better time-left figures.** The time Settings gives for adding a printer, and each printer's
  time left, come from how fast your slicer really works, instead of a fixed 3 plates a minute.
  See [Printers and estimates](./printers-and-estimates.md#my-printers).
- **Uploads that recover.** A failed file in the upload dialog has a **Retry** button that picks
  up from what the server already holds, a file cut off by a dropped connection starts again when
  the browser is back online, and the browser asks before you leave the page while files are still
  sending. See [Adding files](./adding-files.md#uploading-in-the-browser).
- **Library and trash changes.** The library shows the 30 most-used tags, with **More tags** for
  the rest, Escape in the search box no longer ends Select mode, and the trash shows 100 models a
  page. See [Using Platehouse](./index.md#the-library) and [The trash](./trash.md).
- **MakerWorld licences and descriptions.** MakerWorld's CC BY-ND licence is recognised, and a
  licence Platehouse does not know is kept as a licence note. MakerWorld descriptions imported
  before 0.1.1 are converted again once, in the background, unless you edited them. See
  [Adding files](./adding-files.md#what-happens-to-a-3mf).
- **Importer changes.** The Manyfold importer renews its token during a long import, and refuses a
  download redirect to a private or local address unless you name that host with
  `--allow-redirect-host`. See [Importing from Manyfold](./importing-from-manyfold.md).
