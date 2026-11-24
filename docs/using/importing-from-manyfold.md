# Importing from Manyfold

If your library lives in [Manyfold](https://manyfold.app), the Platehouse importer copies it across
once. Each Manyfold model becomes one Platehouse model, with every file Platehouse takes, its name,
the MakerWorld details Manyfold holds (creator, title, description and licence), and its tags and
collections.

The importer only reads Manyfold. It asks for a read-only token and never creates, changes or
deletes anything there, so you can run it as often as you like and keep Manyfold until you are
happy with the result.

## What you need

- A checkout of the Platehouse repository with Node 26 and pnpm, on any machine that can reach both
  servers. The importer is not part of the app image.
- Both servers on **https**. The importer refuses a plain http address, and it sends its tokens only
  to the two addresses you give it (a file download that Manyfold redirects to its object store is
  fetched with no token at all). A redirect to a private, loopback or link-local address, or to a name
  without a dot or ending in `.local`, `.localhost`, `.home.arpa`, `.internal` or `.localdomain`, is
  refused unless you name it with `--allow-redirect-host` (see the options below). Names are not
  looked up for this check.
- A Manyfold OAuth application that allows the client credentials grant with the `read` scope. Its
  client id and client secret are what the importer signs in with. The importer stops before reading
  anything if Manyfold grants it more than `read`. The token is renewed during a long import, shortly
  before it expires and once after Manyfold refuses it, and a renewal must also be `read` only.
- A Platehouse API token, made in **Settings > API tokens**. It is shown once; keep it in your
  password manager.

## Build it

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @platehouse/importer build
```

## Run it

The three credentials come only from the environment, never from the command line, so they do not
end up in your shell history. Set them from your password manager or secret store:

- `MANYFOLD_CLIENT_ID`: the Manyfold application's client id
- `MANYFOLD_CLIENT_SECRET`: its client secret
- `PLATEHOUSE_TOKEN`: the Platehouse API token

Then start with a dry run, which is the default:

```sh
node apps/importer/dist/src/cli.js \
  --manyfold https://manyfold.example.com \
  --platehouse https://platehouse.example.com
```

A dry run reads both sides and plans every model, but downloads nothing and writes nothing. Read its
report, and when it says what you expect, run the same command with `--apply` to make the models,
add their tags and collections and upload their files.

Instead of the two flags you can set `MANYFOLD_BASE` and `PLATEHOUSE_BASE`. Neither address has a
default.

Other options:

- `--model <id>` limits the run to one Manyfold model, by the id in its address (`/models/<id>`).
  Useful for trying one model before the whole library.
- `--download-idle-timeout <seconds>` (or `MANYFOLD_DOWNLOAD_IDLE_TIMEOUT`) fails a file download
  that receives nothing for that long. The default is 120 seconds. It is an idle limit, not a limit
  on the whole transfer, so a large file over a slow link still finishes as long as bytes keep
  arriving.
- `--upload-idle-timeout <seconds>` (or `PLATEHOUSE_UPLOAD_IDLE_TIMEOUT`) is the same limit for an
  upload that Platehouse stops taking.
- `--allow-redirect-host <host>` (repeatable, or `MANYFOLD_ALLOW_REDIRECT_HOSTS`, comma-separated)
  lets a file download be redirected to that private host, for a Manyfold whose object store is on
  your own network, such as `--allow-redirect-host minio.lan` or `--allow-redirect-host 192.168.1.20`.
  Give the host only, with no scheme, port or path. The redirect is still https only, still
  fetched with no token, and still counts toward the 3-redirect limit.

## Running it again

Each Platehouse model remembers the Manyfold model it came from. A second run, after a full run or
one that stopped part way, only adds what is missing: files, tags and collections a model does not
have yet. It never makes a second copy of a model.

A model you moved to the Platehouse [trash](./trash.md) is skipped, and the report says so, so a
re-run never brings back something you deleted. Restore it first if you want it imported again.

## The report

The importer prints one line per model with what happened to it (imported, skipped with the reason,
or failed with the reason), and under it one row per file with Manyfold's size, the size Platehouse
stored and the start of the SHA-256 Platehouse recorded. Every file's size is checked against
Manyfold's and against the bytes downloaded, so a mismatch shows up in the report rather than in the
library. A file type Platehouse does not take (anything but `.3mf`, `.stl`, `.step`, `.stp` and
`.scad`) is skipped with that reason and never downloaded.

No credential, token or signed download address is ever printed: every line the importer writes goes
through a filter that removes them.

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Every model was handled.                                                                                                                                                                                                                                                                    |
| 1    | At least one model failed; the report says which and why. Running again finishes what is missing. One failed token renewal fails only the request that needed it; a renewal that grants more than `read`, or a second failure in a row, stops the import after its summary, with this exit. |
| 2    | The run could not start: a bad argument or address, missing credentials, either server refusing the token or not answering, Manyfold granting more than `read`, or Manyfold's lists could not be read.                                                                                      |
