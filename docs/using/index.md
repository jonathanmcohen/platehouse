# Using Platehouse

Platehouse has a left sidebar with **Library**, **Creators**, **Collections** and **Tags**, and a
top bar with search, **Add** and the theme switch (Dark, Light or System; Dark is the default).
On a narrow screen the sidebar folds behind a **Menu** button. **Settings** and **Trash** hold the
printer choice, API tokens and deleted models.

- [Adding files](./adding-files.md): uploading in the browser, the inbox folder and the API.
- [Models, files and plates](./models-files-plates.md): what a model is and what its page shows.
- [Printers and estimates](./printers-and-estimates.md): where the time, weight and filament
  numbers come from.
- [Opening in a slicer](./open-in-slicer.md): the Open in Bambu Studio and Open in OrcaSlicer
  buttons and the links behind them.
- [Organising](./organising.md): search, tags, collections, creators and renaming.
- [The trash](./trash.md): deleting, restoring and purging.
- [New in 0.1.0](./new-in-0-1-0.md): features being added before the 0.1.0 release.

## The library

The library at `/` shows a card for each model: plate 1's thumbnail, the name, the creator, the
plate count, and the total print time and weight for your printer when every plate has numbers.
A card says "partial" when some plates have no numbers yet. STL, STEP and OpenSCAD models show a
file-type icon instead of a thumbnail.

Search in the top bar matches names, captions, creators and tags, best match first. Pick a tag
chip to filter by tag. Loading the library never downloads a model file: the only images it
loads are the stored plate thumbnails.
