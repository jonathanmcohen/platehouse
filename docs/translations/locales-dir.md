# Adding a language to your server

You can give your own Platehouse server more languages, or fix words in a built-in one, without
rebuilding anything: put translation files in a folder and set `LOCALES_DIR`.

## Set it up

1. Make a folder on the host for the files, for example `/opt/platehouse/locales`.
2. Mount it into the app container, read-only, and set `LOCALES_DIR` to where it is inside the
   container. In `docker-compose.yml`, on the `app` service:

   ```yaml
   services:
     app:
       volumes:
         - /opt/platehouse/locales:/data/locales:ro
       environment:
         LOCALES_DIR: /data/locales
   ```

   `LOCALES_DIR` must be an absolute path. Left unset, Platehouse offers its built-in languages
   only.
3. Put a file in the folder for each language, named for its code: `de.json`, `it.json`,
   `pt-BR.json`. See [How a translation file looks](./index.md#how-a-translation-file-looks).

Platehouse reads the folder when it starts, then again every 15 seconds in the background. A new
or changed file is picked up within those 15 seconds, with no restart. Pages never wait for the
folder: they are always shown with the languages from the last read.

## What Platehouse checks

Every file is checked before anything in it is used:

- It must be named `<code>.json` for a language code, be a regular file (a symlink is refused),
  be at most 256 KiB, and hold a JSON object. At most 50 files are read.
- Every message is checked against English. A message is dropped when it uses markup, a
  placeholder or tag the English message does not have, a plural form the language does not have,
  or a control or text-direction character. A key that is not an English key is dropped.
- Whatever is missing or dropped shows in English.
- Each message is shown as text, never as HTML.

What was dropped is written to the server log by file name and key, never with the words
themselves, for example:

```
platehouse: locales: messages in a LOCALES_DIR file were dropped {"file":"de.json","unknownKeys":["shell.nav.libary"],"refusedKeys":[]}
```

If the folder cannot be read, for example a typo in the path or a volume that was never mounted,
Platehouse offers its built-in languages only until it can, and writes one line to the log:

```
platehouse: locales: LOCALES_DIR cannot be read, so only the built-in languages are offered {"code":"ENOENT"}
```

A network mount that hangs or takes longer than 5 seconds to answer keeps the languages from the
last read that worked on offer meanwhile, and writes a different line:

```
platehouse: locales: LOCALES_DIR is slow to read, so the languages last read from it are offered {"readLimitMs":5000}
```

If that slow read then fails, the "cannot be read" line follows it. If a folder that could not be
read comes back but slow, its languages are offered again and the "slow to read" line follows. Nothing
more is logged while the folder stays that way, however many times it is read. When a read works again within the limit, the log says so once:
`locales: LOCALES_DIR can be read again`.

## Fixing words in a built-in language

A file named for a built-in language, such as `es.json`, replaces the built-in messages it has and
leaves the rest alone. English (`en.json`) cannot be replaced.

## A partial translation

A server file does not need every key. The Language menu marks a language that covers only part of
the app as partly translated, and the rest of the app shows in English. Platehouse keeps the
English keys stable within a version; after an upgrade, a renamed key shows in English until your
file is updated, and the log names it.
