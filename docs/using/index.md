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
- [Settings](./settings.md): the accent colour, printer, API tokens, model names and trash.
- [New in 0.1.0](./new-in-0-1-0.md): what this release brings, and what is still to come in it.

## The library

The library at `/` shows a card for each model: plate 1's thumbnail, the name, the creator, the
plate count, and the total print time and weight for your printer when every plate has numbers.
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
