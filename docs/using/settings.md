# Settings

**Settings**, at the bottom of the sidebar, holds these sections, top to bottom.

## Accent colour

Pick one of twelve colour schemes for buttons, links and the logo: Green, Workshop green, Filament
orange, Spool teal, Blueprint indigo (the default), PLA violet, Coral, Amber, Sky blue, Magenta,
Graphite and Lime. The accent works with any theme (Dark, Light or System, from the switch in the
top bar), and a pick re-colours the app at once.

The choice is kept in this browser only, in a cookie, so each browser or device can have its own.
The picker works with the arrow keys, Home and End. Every scheme keeps text and controls readable
in both themes.

## Bucket versioning warning

While the bucket's versioning is off or suspended, a red banner reads "Bucket versioning is off.
Turn it on at your storage provider and keep old versions for 30 days." See
[Storage](../storage.md#turn-on-versioning).

## My printers

The printers you own, in your order, with one marked **Default**. Platehouse estimates every plate
for each of them.

- Pick a printer and nozzle in **Add a printer** and press **Add printer**. Adding a printer queues
  every plate in the library for it, and the page says how many and about how long that takes.
- **Up** and **Down** set the order, and **Make default** picks the printer shown first on the
  library and model pages.
- **Remove** asks first and drops the estimates still waiting for that printer. The default cannot
  be removed until another printer is made the default.

See [Printers and estimates](./printers-and-estimates.md#my-printers).

## API tokens

Create, name and revoke API tokens. A new token is shown once, in a dialog with **Copy**. See
[Security](../security.md#api-tokens).

## Model names

**Use file titles** is a one-off action for models that were added before Platehouse named new
models from their MakerWorld title (see
[Adding files](./adding-files.md#how-a-new-model-is-named)).

1. Press **Use file titles**. A dialog shows how many models it would rename, with examples, and
   how many it leaves alone and why. Nothing is renamed yet.
2. Press **Rename** in the dialog to apply exactly that list. If the library changed in the
   meantime, nothing is renamed and the dialog asks you to look again.

It renames a model only to a title read from one of its own `.3mf` files, and only when the model
still carries one of its files' names. It never changes a model you renamed, one made by the
Manyfold importer, or one made through the API's create-model call.

## Trash

The trashed models, with their purge dates, **Restore** and **Empty trash**. See
[The trash](./trash.md).
