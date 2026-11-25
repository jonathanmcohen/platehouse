---
description: The features added late in Platehouse 0.1.0, the first release.
---

# New in 0.1.0

0.1.0 was the first release of Platehouse, so everything in these docs was new in it. This page
points to the features added late in that release. For later versions, see the
[changelog](../changelog.md).

## Added late in 0.1.0

- **Numbered library pages and View all**, in place of Load more. See
  [Using Platehouse](./index.md#pages-and-view-all).
- **Duplicate files**: the browser upload skips a file the library already holds, with Import
  anyway; the inbox moves one to `failed/`; the API can skip them. See
  [Adding files](./adding-files.md#duplicate-files).
- **The Activity page**: library numbers, estimate progress, queues, scheduled jobs, the slicer's
  health and recent events. See [Activity](./activity.md).
- **Accent colour picker**: twelve colour schemes in Settings. See
  [Settings](./settings.md#accent-colour).
- **The logo**, as the favicon, the app icons and the sidebar brand. It follows the accent colour.
- **Names from the 3MF title**: new models take their MakerWorld title, or a cleaned file name. See
  [Adding files](./adding-files.md#how-a-new-model-is-named).
- **Rename on the model page.** See [Organising](./organising.md#renaming).
- **View on MakerWorld** links. See
  [Models, files and plates](./models-files-plates.md#view-on-makerworld).
- **Use file titles**, to rename older models from their MakerWorld titles. See
  [Settings](./settings.md#model-names).
- **A neutral grey backdrop** behind pictures of prints, so black and white prints stay visible.
- **Cleaner failure details**: a failed estimate's OrcaSlicer message has file paths, network
  addresses and tokens taken out on the model page and in the API, as on the Activity page.
- **Rotate and flip** buttons under a plate's large image. See
  [Models, files and plates](./models-files-plates.md#turning-a-plate-image).
- **Several printers**: My printers in Settings lists every printer you own, with one default, and
  every plate is estimated for each of them. The library header and the model page's Plates tab
  get a printer switch. See [Printers and estimates](./printers-and-estimates.md#my-printers).
- **Sorting the library** by date added, name, print time, filament weight or plate count, and by
  best match while searching. See [Using Platehouse](./index.md#sorting).
- **Select mode**: select several models, or every match, and add tags, remove a tag, add them to a
  collection or move them to the trash in one go. See
  [Using Platehouse](./index.md#selecting-several-models).
- **Translations**: the interface in English, Spanish and French, with a Language menu in Settings,
  and your own languages through `LOCALES_DIR`. Spanish and French are currently machine
  translations. See [Settings](./settings.md#language) and [Translations](../translations/index.md).
