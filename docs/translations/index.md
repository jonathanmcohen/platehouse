---
description: The languages Platehouse speaks, how a translation file looks, and the two ways to add a language.
---

# Translations

Platehouse speaks English, Spanish and French, and you can add more languages.

- **Choosing a language.** Platehouse follows your browser's language. To pick another one, open
  **Settings** and choose it under **Language**. The choice applies at once and is kept in that
  browser only, so each browser or device can have its own. **Browser language** goes back to
  following the browser.
- **Spanish and French are currently machine translations.** Nobody fluent in either language has
  reviewed them yet, and the Language menu says so beside their names. They are good enough to use,
  but some wording will read oddly. A review by a fluent speaker is welcome; see
  [Adding a language to Platehouse](./contributing.md).
- **What stays English.** The in-app API reference, this documentation, server logs, the public
  API's error messages and the reason files in the inbox's `failed` folder stay English. A message
  from OpenSCAD, the STEP converter or OrcaSlicer is shown as the program wrote it.

There are two ways to add a language:

- [Add it to Platehouse itself](./contributing.md), so everyone gets it: a JSON file in the source
  repository and a pull request.
- [Add it to your own server](./locales-dir.md), with no rebuild: drop a JSON file into a folder and
  point `LOCALES_DIR` at it.

## How a translation file looks

Each language is one JSON file named for its language code, such as `de.json` for German or
`pt-BR.json` for Brazilian Portuguese. English (`en.json`) is the source: every other file has the
same keys with the words in its own language.

```json
{
  "$meta": { "locale": "de", "name": "Deutsch" },
  "shell.nav.library": "Bibliothek",
  "library.card.plates": "{count, plural, one {# Platte} other {# Platten}}",
  "trash.purgeAfter": "Endgueltig geloescht nach dem <time>{date}</time>."
}
```

- `{name}` is a placeholder: keep it as it is, and move it wherever the sentence needs it.
- `{count, plural, one {...} other {...}}` picks the right form for the number. `#` stands for the
  number. Use the plural forms your language has (`zero`, `one`, `two`, `few`, `many`, `other`;
  `other` is always needed), and `=0` for an exact number if you want one.
- `<time>...</time>`, `<link>...</link>`, `<code>...</code>` and similar mark text that Platehouse
  turns into a date, a link or code. Keep the same tags around the matching words.
- Write text only. A translation can never hold HTML: anything that looks like markup, other than
  the tags the English message has, is refused.
