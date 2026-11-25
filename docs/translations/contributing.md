# Adding a language to Platehouse

A language added to the source repository ships with Platehouse, for everyone. This page is for
contributors. To add a language to your own server only, see
[Adding a language to your server](./locales-dir.md).

## Where the files are

The translations live in `packages/i18n/locales/` in the repository:

- `en.json` is the source of truth. Every key is an English message.
- `es.json` and `fr.json` are Spanish and French. Currently both are machine translations, marked
  `"status": "machine-draft"` with `"review": { "needed": true }` in their `$meta`.

The web app and the server find every `<code>.json` in that folder by themselves, so there is no
list of languages to edit.

Right-to-left languages, such as Arabic or Hebrew, are not supported yet: the page would still lay
out left to right.

## Add a language

1. Copy `en.json` to a file named for the language code, such as `de.json` or `pt-BR.json`.
2. Set its `$meta`: `"locale"` to the code, `"name"` to the language's name in itself (such as
   `"Deutsch"`), and, for a machine translation, `"status": "machine-draft"` with
   `"review": { "needed": true, "reviewedBy": null, "reviewedOn": null }`.
3. Translate every value. Keep every placeholder (`{name}`), every tag (`<time>`), and give every
   plural the forms your language uses (see [How a translation file looks](./index.md#how-a-translation-file-looks)).
4. Write the file in UTF-8 as you like, then run the formatter from the repository root:

   ```sh
   pnpm i18n:format
   ```

   It sorts the keys, puts `$meta` first and writes every character outside ASCII as a `\u`
   escape, because the repository keeps its source files ASCII. Platehouse shows the real
   characters.
5. Run the checks:

   ```sh
   pnpm vitest run --project unit packages/i18n apps/web
   ```

   The catalog test fails when a built-in language misses a key, has a key English does not,
   drops or adds a placeholder or tag, lacks a plural form its language needs, or is not in the
   formatter's form.
6. Open a pull request. Add a line to `CHANGELOG.md` under the next version.

A built-in language must be complete: every English key, translated. A partial translation is
better added to a server through `LOCALES_DIR`, where missing keys fall back to English.

## Review an existing translation

To review Spanish or French, read the file next to `en.json`, fix what reads wrongly, and in
`$meta` set `"status": "reviewed"`, `"review": { "needed": false, "reviewedBy": "<your name>",
"reviewedOn": "<the date>" }`. Run `pnpm i18n:format` and the checks, and open a pull request. The
Language menu stops marking the language as a machine translation once its status is no longer
`machine-draft`.

Some terms to check first:

- Printing words should match Bambu Studio and OrcaSlicer in that language (for example plate,
  slicer, filament, nozzle).
- The line about Bambu Studio's "This file is not from a trusted site" prompt should match the
  wording Bambu Studio itself shows in that language.

## Adding a new English message

When you add text to the web app, add its key to `en.json` and the same key, translated, to every
other built-in language, then run `pnpm i18n:format`. A source test fails if the code names a key
`en.json` lacks, if `en.json` has a key no code uses, or if a component shows bare English text
instead of a message.
