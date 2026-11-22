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
A card says "partial" when some plates have no numbers yet. STL and STEP models show a preview
picture of the model instead of a thumbnail, once it has been rendered, and a file-type icon until
then or if it could not be rendered. OpenSCAD models show a file-type icon. Pictures of prints sit
on a neutral grey backdrop, so a black or white print stays visible in both themes.

Search in the top bar matches names, captions, creators and tags, best match first. Pick a tag
chip to filter by tag, and **All** to turn the tag filter off. The tag you are filtering by keeps
its chip even when no model has that tag any more. Typing a search in the top bar turns off a tag
filter and searches the whole library; this is deliberate, so a search always looks through every
tag. The one exception is a creator or collection filter opened from **Show in the library**,
which stays on. When nothing matches a search or filter, **Show all models** takes you back to the
whole library. Loading the library never downloads a model file: the only images it
loads are the stored plate thumbnails.

### Pages and View all

The library shows 48 models a page, with **Previous**, **Next** and page numbers at the bottom
(shortened with gaps on a narrow screen). **View all** shows the matches on one page instead,
loading them 200 at a time as you go.

- The pages and View all both reach the first 1000 matches in the chosen sort, no further. When
  more match, the count shows "1000+" and a note above the cards says only the first 1000 can be
  shown. To reach the rest, narrow the search, pick a tag or other filter, or choose another sort
  order.

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
  toolbar says only the first 1000 were selected. When nothing matches it is greyed out.
  **Clear selection** empties it.
- The selection only ever holds models the current search and filters show, and an action never
  changes a model they hide (see below). It is kept while you change page, switch to View all or
  choose another sort, so you can gather models from several pages, even past the first 1000
  matches the pages reach. A new search or filter keeps the selected models it still shows and
  drops the rest, and the toolbar says how many left. To gather models from several searches or
  tags, select them under one view that shows them all, such as the whole library with no search
  or filter. **Select** again, or Escape, ends Select mode and clears the selection.
- While the page checks which selected models a new search or filter shows, the actions wait. If
  that check fails, the toolbar says so and offers **Try again**.

The toolbar's actions work on every selected model at once, up to 1000 in one action:

- **Add tags**: type a tag and press Enter, or pick one of the library's, up to 20 tags in one go.
  Tags a model already has are kept, and a new tag is made the first time it is used.
- **Remove tag**: pick one of the library's tags to take off the selected models. The tag is not
  deleted, but once no model outside the trash has it, it is no longer listed on the **Tags** page,
  in the tag chips or in the tag pickers.
- **Add to collection**: pick a collection, or type a new name to make one.
- **Move to trash**: asks first, then moves the models to the trash, where they can be restored for
  30 days. See [The trash](./trash.md).

When an action finishes, the toolbar says what happened: how many models changed and how many were
already as asked (they already had the tag, did not have it, or were already in the collection).
The grid then reloads in place to show the change. Models moved to the trash leave the selection,
and so does any model the action takes out of the view: remove the tag you are filtering by, for
example, and those models leave the selection, with a note saying how many. These notes describe
the view they were made in, so they go once you change the search, a filter, the sort, the printer
or the page.

**When a model has left the view.** Each action is checked by the server against the search and
filters you made it in, at the moment it runs. A selected model they no longer show, for example
because another tab took off the tag you are filtering by, is not changed. The toolbar says how
many were left unchanged for that reason, and they leave the selection.

**When some models fail.** A selected model that has been moved to the trash, or deleted, since you
selected it (for example from another tab) is not changed. The toolbar names it, or counts it if
the page never showed it, with the reason, and it leaves the selection. Every other selected model
is still changed. If the server cannot be reached, or answers with an error, the dialog stays open
with the error. The page cannot tell then whether the change was made, for example when the
connection dropped after the server had made it. Trying again is safe either way: models that
already changed are reported as already done (or, for Move to trash, as already in the trash), not
changed twice.
