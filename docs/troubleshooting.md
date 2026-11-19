# Troubleshooting

Start with the app's log: `docker compose logs app`. Platehouse logs what went wrong in plain words,
and never logs a secret, token or slicer link.

## The app will not start

- **`Invalid configuration: KEY is missing`** or **`KEY must be ...`**: a setting in `.env` is
  missing or wrong. The message names the key and why. See [Configuration](./configuration.md).
- **It restarts over and over, or stays unhealthy.** `/healthz` answers 200 only while the database
  answers within 3 seconds, the job queues run and the web app is present. Check the database
  container is healthy and `DATABASE_URL` is right.
- **The inbox cannot be written.** Make sure `data/inbox` and `data/tmp` belong to uid and gid 1000
  (see [Install](./install.md#3-create-the-networks-and-folders)).

## Sign-in

- **"Login is unavailable right now"**: Platehouse cannot reach your OIDC provider. Check
  `OIDC_ISSUER`, that the app container can reach it over https, and that the provider's
  certificate is trusted.
- **The provider says the redirect URL is wrong**: set the client's redirect URL to exactly
  `PUBLIC_ORIGIN` followed by `/auth/callback`, for example
  `https://platehouse.example.com/auth/callback`.
- **A page says you are not allowed in**: the user is not in the `OIDC_GROUP` group, the provider
  does not send a `groups` claim, or `email_verified` is not true. Check the group membership and
  that the provider includes groups for the `groups` scope.
- **You sign in and land back on the login page**: the browser is not keeping the Secure session
  cookie, which happens when Platehouse is opened over http, or at an address other than
  `PUBLIC_ORIGIN`.

## Uploads

- **Large uploads fail part way, or with 413**: the reverse proxy's body size limit or read timeout
  is too small. See [Reverse proxy](./reverse-proxy/index.md#large-uploads).
- **"Storage is unavailable right now; nothing was saved"**: the bucket could not be reached.
  Nothing is half-saved; try again once it answers.
- **A file is refused**: only `.3mf`, `.stl`, `.step`, `.stp` and `.scad` are taken, up to 512 MiB,
  and the contents must match the extension.
- **"No Bambu plate data in this file"**: the `.3mf` was stored, but Platehouse could not read plate
  data from it. It may be damaged, not a Bambu or OrcaSlicer project, or over one of the safety
  limits (for example more than 128 plates).

## The inbox

A file that cannot be imported moves to `inbox/failed/`, with `name.reason.txt` beside it saying
why. The common reasons:

| Reason                                                                     | What to do                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The file type or contents are not supported.                               | Only `.3mf`, `.stl`, `.step`, `.stp` and `.scad`, with matching contents.                       |
| The file is larger than the upload limit (512 MiB).                        | Split or shrink it.                                                                             |
| The file name is not valid UTF-8.                                          | Rename it.                                                                                      |
| The import failed three times in a row; the reason quotes the error.       | Read the error. Move the file back into the inbox to try again.                                 |
| The file was still being written.                                          | Something was still writing it when it was taken. Move it back once the copy has finished.      |
| It could not be put back under its name, or another file took its name.    | A file with the same name arrived during the import. Check both files.                          |
| A model was made, but the file changed during the import.                  | The library has the version that was imported. Compare it with the file before deleting either. |
| It was stored but could not be removed from the inbox.                     | The model is probably in the library already; check before importing it again.                  |
| Platehouse could not check whether it is the imported file or a newer one. | Compare it with the model in the library before deleting it.                                    |

If the database, the bucket or the temporary folder is down, files are not moved to `failed`: the
inbox waits and tries again, and the log says an outage started and ended.

## Estimates

- **Plates stay "estimating"**: the slicer may be down or busy. Check `docker compose ps` shows it
  healthy and `docker compose logs slicer`. Estimates run one plate at a time, so a large library
  takes a while after a printer change or a slicer update.
- **"The slicer could not slice this plate."** after several tries: the app could not reach the
  slicer, or the slice was lost. Check the slicer, then press **Retry**.
- **The slicer is unreachable.** Check that the app and the slicer share the `platehouse-slicer`
  network and that `SLICER_URL` names the slicer's container and port
  (`http://platehouse-slicer:8080` in the example).

OrcaSlicer refusals, shown on the plate with OrcaSlicer's own message behind **Details**:

| Code     | Shown                                                                                | In plain words                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| -62      | The filaments on this plate need print temperatures too far apart to print together. | The plate mixes filaments, such as PLA and PETG, whose temperatures OrcaSlicer will not print together. It is a real limit of the file on that printer, not a fault in Platehouse. |
| -101     | The slicer found print paths on this plate that would collide.                       | OrcaSlicer found moves that would crash the print head into the print. Usually the file needs changing in the slicer.                                                              |
| -18      | The slicer could not slice this plate.                                               | The file holds settings with values OrcaSlicer will not accept on your printer. Details shows "invalid values in the 3mf".                                                         |
| -16      | This file cannot be switched to the selected printer.                                | The file is limited to other printers.                                                                                                                                             |
| -17      | This file's print settings do not fit the selected printer.                          | The file's process cannot run on your printer.                                                                                                                                     |
| -52      | The plate is too big for this printer's bed.                                         | Objects sit outside your printer's bed.                                                                                                                                            |
| -58      | Slicing took too long and was stopped.                                               | Raise `SLICE_PLATE_SECONDS` on both the app and the slicer if your plates are just slow.                                                                                           |
| -66, -68 | This plate needs a different nozzle or extruder setup than the selected printer has. | For example a dual-nozzle file on a single-nozzle printer.                                                                                                                         |

Any other code shows "The slicer could not slice this plate." with OrcaSlicer's message under
**Details**.

## Renders and STEP files

- **OpenSCAD renders are refused because the sandbox self-test failed**: the host
  kernel is older than Linux 6.12 (Landlock ABI 6), or the slicer's settings were changed from the
  example. Slicing and STEP files still work. The slicer's log says which.
- **"The slicer is not answering. The render will need to be started again."**: the slicer was down
  for over 2 hours. Bring it back and upload or replace the file again.
- **"Storage is not answering..."** or **"Storage refused this file..."**: the bucket was down, or
  refused the request (wrong key permissions, missing bucket). Check the storage settings.
- **A render error with OpenSCAD's own message**: the `.scad` file itself has a problem; the message
  is OpenSCAD's.

## Downloads and slicer links

- **"This file is unavailable right now"** (503): the bucket could not be reached, or the stored
  object is not the size Platehouse recorded, for example after restoring an older version by hand.
- **A slicer link gives 403**: it has expired (links last 10 minutes), was changed, or its file is
  in the trash. Press the button again for a fresh link.
- **The slicer cannot download the file**: the computer running the slicer must reach
  `PUBLIC_ORIGIN` over https and trust its certificate.
- **Downloads start slowly or stall**: the reverse proxy is buffering. See
  [Reverse proxy](./reverse-proxy/index.md#streamed-downloads).

## Settings shows a red versioning banner

"Bucket versioning is off." Turn versioning on at your storage provider (see
[Storage](./storage.md#turn-on-versioning)) and restart the app, which reads the setting when it
starts.
