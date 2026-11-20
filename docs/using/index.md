# Using Platehouse

Platehouse has a left sidebar, with the Platehouse logo at the top, and a top bar.

- **The sidebar**: **Library**, **Creators**, **Collections**, **Tags**, **Trash**, **Activity**
  and **Settings**. On a narrow screen it folds behind a **Menu** button.
- **The top bar**: search, **Add** and the theme switch (Dark, Light or System; Dark is the
  default). The accent colour is picked in [Settings](./settings.md#accent-colour).

The pages in this section:

- [Adding files](./adding-files.md): uploading in the browser, the inbox folder, the API, how new
  models are named and what happens to duplicates.
- [Models, files and plates](./models-files-plates.md): what a model is and what its page shows.
- [Printers and estimates](./printers-and-estimates.md): where the time, weight and filament
  numbers come from.
- [Opening in a slicer](./open-in-slicer.md): the Open in Bambu Studio and Open in OrcaSlicer
  buttons and the links behind them.
- [Organising](./organising.md): search, tags, collections, creators and renaming.
- [The trash](./trash.md): deleting, restoring and purging.
- [Activity](./activity.md): library numbers, job progress and recent events.
- [Settings](./settings.md): the accent colour, language, My printers, API tokens, model names and
  trash.
- [New in 0.1.0](./new-in-0-1-0.md): the features added late in this release.

## The library

The library at `/` shows a card for each model: plate 1's thumbnail, the name, the creator, the
plate count, and the total print time and weight when every plate has numbers. The totals are for
the printer named in the library header: your default printer, unless you pick another there.
A card says "partial" when some plates have no numbers yet. STL, STEP and OpenSCAD models show a
file-type icon instead of a thumbnail. Pictures of prints sit on a neutral grey backdrop, so a
black or white print stays visible in both themes.

Search in the top bar matches names, captions, creators and tags, best match first. Pick a tag
chip to filter by tag. Loading the library never downloads a model file: the only images it
loads are the stored plate thumbnails.

### Pages and View all

The library shows 48 models a page, with **Previous**, **Next** and page numbers at the bottom
(shortened with gaps on a narrow screen). **View all** shows every match on one page instead,
loading them 200 at a time as you go.

- The count above the cards shows how many models there are, or how many match of the whole
  library while a search or filter is on.
- The page and View all are part of the address (`?page=` and `?view=all`), so Back, Forward and
  shared links bring you to the same page.
- A new search or filter starts again at page 1. An address for a page past the end shows the last
  page and says so.

### Sorting

The **Sort** menu above the cards sets the order:

- **Best match**: offered only while a search is on, and then the default.
- **Date added: newest** (the default when no search is on) and **Date added: oldest**.
- **Name: A to Z** and **Name: Z to A**, ignoring capital letters.
- **Print time: shortest** and **Print time: longest**, by the model's total print time.
- **Filament weight: lightest** and **Filament weight: heaviest**, by the model's total filament
  weight.
- **Plates: most** and **Plates: fewest**, by the number of plates.

Print time and filament weight are totals for the printer named in the library header. While one
of those four is picked, a note under the menu says that models without a print time (or filament
weight) for that printer are listed last. A model counts as having a total only once every one of
its plates has numbers, so a model still marked "partial" is in that last group too.

- The sort is part of the address (`?sort=`), like the page, so Back, Forward and shared links keep
  it. The default sort is left out of the address.
- A new sort starts again at page 1. The tag chips, the pages and View all keep it. A new search
  from the top bar goes back to the default sort: best match for a search, newest for none.
- Models that tie always come in the same order.
- Each page is worked out when you open it. If a model is added, trashed, renamed or gets its
  numbers while you go from page to page, the others shift, so a model near the edge of a page can
  show twice or be missed.

### Selecting several models

**Select**, above the cards, turns on Select mode: each card becomes a checkbox (click it, or press
Space on it) and a toolbar appears above the grid with the number selected.

- **Select all on this page** adds the cards shown (every card, in View all). **Select all
  matching** adds every model that matches the search and filters, up to 1000; if more match, the
  toolbar says only the first 1000 were selected. **Clear selection** empties it.
- The selection is kept while you change page, search or filter, so you can gather models from
  several places. **Select** again, or Escape, ends Select mode and clears the selection.

The toolbar's actions work on every selected model at once, up to 1000 in one action:

- **Add tags**: type a tag and press Enter, or pick one of the library's, up to 20 tags in one go.
  Tags a model already has are kept, and a new tag is made the first time it is used.
- **Remove tag**: pick one of the library's tags to take off the selected models. The tag itself
  stays in the library.
- **Add to collection**: pick a collection, or type a new name to make one.
- **Move to trash**: asks first, then moves the models to the trash, where they can be restored for
  30 days. See [The trash](./trash.md).

When an action finishes, the toolbar says what happened: how many models changed and how many were
already as asked (they already had the tag, did not have it, or were already in the collection).
The grid then reloads in place to show the change. Models moved to the trash leave the selection.

**When some models fail.** A selected model that has been moved to the trash, or deleted, since you
selected it (for example from another tab) is not changed. The toolbar names it, or counts it if
the page never showed it, with the reason, and it leaves the selection. Every other selected model
is still changed. If the request itself fails, for example because the server cannot be reached,
nothing is changed: the dialog stays open with the error so you can try again.
