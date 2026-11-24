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

## Language

Platehouse speaks English, Spanish and French, plus any language your server adds (see
[Translations](../translations/index.md)). Pick one from the list:

- **Browser language** (the default) follows your browser's own language list, and names the
  language it picked. A browser language Platehouse does not have shows English.
- Any other choice shows that language, whatever the browser asks for.

A pick applies at once, with no reload, and is kept in this browser only, in a cookie, so each
browser or device can have its own. If a language cannot be loaded, the page says so and stays as
it was.

Spanish and French are currently machine translations that nobody fluent has reviewed yet, so the
list shows "machine translation, not yet reviewed" beside their names. A language your server adds
that covers only part of the app shows "partly translated, the rest in English", and the rest of
the app shows in English. To add a language, or to review one, see
[Translations](../translations/index.md).

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

Create, name and revoke API tokens. A new token is shown once, in a dialog with **Copy**. Each
token says who made it. Creating one needs a sign-in from the last 5 minutes; if yours is older,
the page asks you to sign in again and brings you back here. See
[Security](../security.md#api-tokens).

**Sign out everywhere**, below the token list, ends every session of one person and can revoke
the tokens they made. Use it when someone should no longer have access; see
[Sign-in](../sign-in.md#the-allowed-group).

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
