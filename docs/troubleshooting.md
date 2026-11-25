---
description: What Platehouse's error messages mean and what to do about each.
---

# Troubleshooting

Start with the app's log: `docker compose logs platehouse`. Platehouse logs what went wrong in plain words,
and never logs a secret, token or slicer link.

## The app will not start

- **`Invalid configuration: KEY is missing`** or **`KEY must be ...`**: a setting in `.env` is
  missing or wrong. The message names the key and why. See [Configuration](./configuration.md).
- **`DATABASE_URL must be a postgres:// or postgresql:// URL`** when the URL does start with
  `postgres://`: the database password holds `/`, `#` or `?`, which ends the URL early. Use a
  password of letters and digits, or percent-encode it; see
  [the database password](./configuration.md#the-database-password).
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
- **A file was skipped in the upload dialog**: the library already holds the same file, and the
  dialog links to the model that has it. Press **Import anyway** to store a second copy. See
  [Duplicate files](./using/adding-files.md#duplicate-files).
- **A file is refused**: only `.3mf`, `.stl`, `.step`, `.stp` and `.scad` are taken, up to 512 MiB,
  and the contents must match the extension.
- **"The upload could not be confirmed"**: the file was sent, but the dialog could not learn how
  its import ended. Usually the import is still queued behind other files, or ran long: an import
  may take up to an hour, and the dialog waits up to 70 minutes while the server says it is still
  working. It also stops after five failed checks in a row (the server or the connection was
  away), or when the server no longer knows the upload. Look for the model in the library before
  sending the file again: it often appears once the import finishes. If it is still missing after
  an hour, press **Retry**.
- **"The server is out of room for uploads"**: the server refused the upload with 507, because
  the total of unfinished uploads, the 10,000 uploads or the free disk or inodes under `TMP_DIR`
  ran out (the rules are in [Upload limits](./storage.md#upload-limits)). Nothing was saved. A 507
  can come while the disk still shows room, because the free space counts the bytes other
  unfinished uploads are still to receive. The server logs each refusal with the session or token
  it was for:
  - For `UPLOAD_TEMP_MAX_BYTES`, the line also names the three users holding the most bytes.
    Free space on that disk or raise `UPLOAD_TEMP_MAX_BYTES` in `.env`, or wait for their uploads
    to finish or be removed. A `docker-compose.yml` copied before the example passed this setting
    on, such as the one shipped with 0.1.1, ignores it in `.env`: add
    `UPLOAD_TEMP_MAX_BYTES: ${UPLOAD_TEMP_MAX_BYTES:-4294967296}` under the `platehouse` service's
    `environment:` first (see [Configuration](./configuration.md)).
  - For the 10,000 uploads, it names the three users holding the most uploads. Finished uploads
    are kept for a day after their import, so this clears as they age out.
  - For the free space or inodes, it names no one: free space on the disk under `TMP_DIR`.

  **Retry** may also work once other uploads have finished.
- **"Too many of your uploads are unfinished"**: the server refused the upload with 429, because
  your session already has 20 uploads that have not finished (see
  [Upload limits](./storage.md#upload-limits)). Nothing was saved. The dialog sends three at a
  time, so the others are usually in another tab or were left by an earlier batch that stopped
  part way. Let the others finish, then press **Retry**.
- **"You have sent a great many files recently"**: the server refused the upload with 429,
  because your session or API token already has 2,000 uploads on the server, finished ones
  included (see [Upload limits](./storage.md#upload-limits)). This clears by itself: try again
  tomorrow. Nothing was saved. Whoever runs Platehouse can see it in the server's log, which names
  the session or token refused.
- **"No Bambu plate data in this file"**: the `.3mf` was stored, but Platehouse could not read plate
  data from it. It may be damaged, not a Bambu or OrcaSlicer project, or over one of the safety
  limits (for example more than 128 plates).

## The inbox

A file that cannot be imported moves to `inbox/failed/`, with `name.reason.txt` beside it saying
why. The file is one line: a stable code, a colon, then the reason in English, for example
`changed: This file changed while Platehouse was importing it, ...`. The code lets a script tell
the reasons apart without reading the sentence. The codes are changed, unconfirmed, unremoved, unchecked, swapped, put_back_failed, still_writing, held, non_utf8, control_chars, too_large, unsupported_type, model_not_found, duplicate, retries_exhausted and failed. An older reason
file has the sentence alone. The [Activity](./using/activity.md) page lists failed
inbox files too. The common reasons:

| Reason                                                                                    | What to do                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This file is already in the library, in the model named in the reason, so it was skipped. | The library already holds these exact bytes (see [Duplicate files](./using/adding-files.md#duplicate-files)). Delete it from `failed/`, or upload it in the browser and press **Import anyway** to store a second copy. |
| The file type or contents are not supported.                                              | Only `.3mf`, `.stl`, `.step`, `.stp` and `.scad`, with matching contents.                                                                                                                                               |
| The file is larger than the upload limit (512 MiB).                                       | Split or shrink it.                                                                                                                                                                                                     |
| The file name is not valid UTF-8.                                                         | Rename it.                                                                                                                                                                                                              |
| The file name has a control character in it, such as a line break.                        | Rename it.                                                                                                                                                                                                              |
| The import failed three times in a row; the reason quotes the error.                      | Read the error. Move the file back into the inbox to try again.                                                                                                                                                         |
| The file was still being written.                                                         | Something was still writing it when it was taken. Move it back once the copy has finished.                                                                                                                              |
| It could not be put back under its name, or another file took its name.                   | A file with the same name arrived during the import. Check both files.                                                                                                                                                  |
| A model was made, but the file changed during the import.                                 | The library has the version that was imported. Compare it with the file before deleting either.                                                                                                                         |
| It was stored but could not be removed from the inbox.                                    | The model is probably in the library already; check before importing it again.                                                                                                                                          |
| Platehouse could not check whether it is the imported file or a newer one.                | Compare it with the model in the library before deleting it.                                                                                                                                                            |

If the database, the bucket or the temporary folder is down, files are not moved to `failed`: the
inbox waits and tries again, and the log says an outage started and ended.

## Estimates

- **Plates stay "estimating"**: the slicer may be down or busy. Check `docker compose ps` shows it
  healthy and `docker compose logs platehouse-slicer`. Estimates run one plate at a time, so a
  large library takes a while after you add a printer or the slicer is updated. Changing the
  default printer or the order of My printers starts no slicing.
- **"The slicer could not slice this plate."** after several tries: the app could not reach the
  slicer, or the slice was lost. Check the slicer, then press **Retry**.
- **The slicer image is older than the app**, for example a 0.1.0 slicer with a 0.1.1 app. The app
  cannot read the slicer's answers, so:
  - new files get no estimates, and the app's log has a line such as
    `queues: after ingesting file <id>: The slicer's answer is not one slicer contract 2 allows`;
  - the **Slicer** section of the [Activity](./using/activity.md#the-slicer-section) page says
    **Not reachable**, with no sandbox line, and **My printers** in Settings says "The slicer
    cannot be reached, so no printer can be added right now.";
  - a plate that was already waiting for an estimate fails with "The slicer could not slice this
    plate.", with "The slicer's answer is not one slicer contract 2 allows" under **Details**.

  Set both image tags in `docker-compose.yml` to the same version, then pull and recreate both, as
  [Upgrading](./backups-and-upgrades.md#upgrading) shows.
- **The slicer is unreachable.** Check that the app and the slicer share the `platehouse-slicer`
  network and that `SLICER_URL` names the slicer's container and port
  (`http://platehouse-slicer:8080` in the example), or the slicer image may be older than the app
  (see above).
- **"Estimates are off on this server: its kernel is older than Linux 6.12."** or **"Estimates are
  off on this server: its sandbox check failed."**: If the host already runs Linux 6.12 or newer,
  see [The sandbox is off on a new kernel](#the-sandbox-is-off-on-a-new-kernel) first. The
  slicer's sandbox is off, so it refused to slice. The plate is recorded as failed once, with that
  sentence under **Details**, and is not tried again while the sandbox stays off. Otherwise,
  upgrade the host's kernel to Linux 6.12 or newer, or, if you accept slicing without the sandbox,
  set `SLICER_ALLOW_UNSANDBOXED=true` on the slicer. Once the slicer reports its sandbox on (or
  allowed without it), the plates it refused are estimated again automatically, at most 50 on each
  Orca version check; no need to press **Retry**.

OrcaSlicer refusals, shown on the plate with OrcaSlicer's own message behind **Details**:

| Code      | Shown                                                                                | In plain words                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| -62       | The filaments on this plate need print temperatures too far apart to print together. | The plate mixes filaments, such as PLA and PETG, whose temperatures OrcaSlicer will not print together. It is a real limit of the file on that printer, not a fault in Platehouse.                                                                                                          |
| -101      | The slicer found print paths on this plate that would collide.                       | OrcaSlicer found moves that would crash the print head into the print. Usually the file needs changing in the slicer.                                                                                                                                                                       |
| -18       | The slicer could not slice this plate.                                               | The file holds settings with values OrcaSlicer will not accept on your printer. Details shows "invalid values in the 3mf".                                                                                                                                                                  |
| -16       | This file cannot be switched to the selected printer.                                | The file is limited to other printers.                                                                                                                                                                                                                                                      |
| -17       | This file's print settings do not fit the selected printer.                          | The file's process cannot run on your printer.                                                                                                                                                                                                                                              |
| -52, -102 | The plate is too big for this printer's bed.                                         | Objects sit outside your printer's bed.                                                                                                                                                                                                                                                     |
| -50       | The plate is too big for this printer's bed.                                         | Nothing on the plate sits inside your printer's bed. A plate laid out for a bigger printer needs its objects moved onto your bed in your slicer app first. An empty plate, a plate whose contents cannot be read, or a slicer crash shows "The slicer could not slice this plate." instead. |
| -58       | Slicing took too long and was stopped.                                               | Raise `SLICE_PLATE_SECONDS` on both the app and the slicer if your plates are just slow.                                                                                                                                                                                                    |
| -66, -68  | This plate needs a different nozzle or extruder setup than the selected printer has. | For example a dual-nozzle file on a single-nozzle printer.                                                                                                                                                                                                                                  |

Any other code shows "The slicer could not slice this plate." with OrcaSlicer's message under
**Details**. File paths, network addresses and tokens are taken out of that message before it is
shown. The [Activity](./using/activity.md) page lists failed estimates with the same **Retry**.

## Renders and STEP files

- **"Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12."**:
  If the host already runs Linux 6.12 or newer, see
  [The sandbox is off on a new kernel](#the-sandbox-is-off-on-a-new-kernel) first. The slicer's
  sandbox is off because the slicer found no Landlock ABI 6 or newer, on an old kernel or for one
  of the reasons in that section, so the slicer refuses STL pictures, STEP files' preview pictures
  and OpenSCAD renders, and the files keep their icon. Otherwise, upgrade the host to Linux 6.12 or
  newer and restart the slicer. The files are picked up again by themselves once the slicer
  reports its sandbox on. `SLICER_ALLOW_UNSANDBOXED` does not cover these.
- **"Pictures and OpenSCAD renders are off on this server: its sandbox check failed."**: the
  kernel is new enough, but the slicer's check of its sandbox failed, for example because the
  slicer's container settings were changed from the example. The slicer's log says what failed,
  and it checks again by itself, after a minute at first and then less often. Restore the example's
  settings; the files are picked up again once the check passes.
- **"STEP previews are off on this server: its kernel is older than Linux 6.12."**: If the host
  already runs Linux 6.12 or newer, see
  [The sandbox is off on a new kernel](#the-sandbox-is-off-on-a-new-kernel) first. The same kernel
  limit, for converting a STEP file to the mesh its 3D preview and picture are made from.
  Otherwise, upgrade the host's kernel to Linux 6.12 or newer, or, if you accept converting STEP
  files without the sandbox, set `SLICER_ALLOW_UNSANDBOXED=true` on the slicer (see
  [Security](./security.md#the-slicer-sandbox) for what that gives up). The files are picked up
  again once conversions can run.
- **"STEP previews are off on this server: its sandbox check failed."**: the same as the sandbox
  check above, for a STEP file. First check you kept the example's hardening settings for the
  slicer, and restore them. Only if you accept converting STEP files without the sandbox, set
  `SLICER_ALLOW_UNSANDBOXED=true` on the slicer (see
  [Security](./security.md#the-slicer-sandbox)).
- **"The slicer is not answering. The render will need to be started again."**: the slicer was down
  for over 2 hours. Bring it back and upload the file again.
- **"The slicer is not answering, so the preview picture could not be made. It will be tried again
  automatically."** (or the same for storage): an STL's or STEP file's preview picture waited over
  2 hours, or could not be queued. Nothing to do once the slicer or storage is back: the background
  job tries it again. With a slicer image older than the app, update the slicer image.
- **"The preview picture could not be queued. It will be tried again automatically."**: the job
  for an STL's or STEP file's preview picture could not be queued, for example while the database
  was down. Nothing to do: the background job queues it again.
- **"Platehouse could not write a temporary file; it will be tried again automatically."**: an STL's
  or STEP file's preview picture could not be written to the app's temp folder (`TMP_DIR`) on every
  try, usually because the disk is full or the folder is read-only or missing. Free space or fix
  the folder's permissions; the background job tries the picture again.
- **"Storage is not answering..."** or **"Storage refused this file..."**: the bucket was down, or
  refused the request (wrong key permissions, missing bucket). Check the storage settings.
- **A render error with OpenSCAD's own message**: the `.scad` file itself has a problem; the message
  is OpenSCAD's.

## The sandbox is off on a new kernel

The slicer turns its sandbox off when the Landlock ABI it finds is below 6. On a kernel of Linux
6.12 or newer that has three causes, each below with how to recognise it and the fix.

### Landlock is turned off in the kernel

The kernel's list of security modules lacks `landlock`. Check on the host:

```sh
cat /sys/kernel/security/lsm
```

If `landlock` is not in the list, add `lsm=landlock,...` to the kernel command line, keeping the
modules already listed, and reboot. Or use a kernel that turns it on. When it works, `dmesg` shows
"landlock: Up and running".

### Docker blocks Landlock

Docker Engine older than 20.10.18 has a default seccomp profile that blocks the three Landlock
calls, and so does a custom seccomp profile that leaves them out. Upgrade Docker, or fix the
profile. The example Compose file sets no seccomp option, so remove one you added. Do not use
`seccomp=unconfined` or `privileged` to get around it: add the three `landlock_*` calls
(`landlock_create_ruleset`, `landlock_add_rule` and `landlock_restrict_self`) to your seccomp
profile, or remove the custom profile.

### A kernel without the 2025 Landlock fix

The sandbox needs a Landlock fix from 2025. It is in Linux 6.12.24, 6.13.12, 6.14.3 and 6.15 or
newer. The slicer finds ABI 5 on 6.12 before 6.12.24, 6.13 before 6.13.12 and 6.14 before 6.14.3.
Update the kernel. A distribution kernel, such as Ubuntu's, keeps a base version like `6.14.0-...`
and carries fixes in its own updates, so `uname -r` cannot tell you; the slicer's log can.

### Which case it is

Read the slicer's self-test line:

```sh
docker logs platehouse-slicer 2>&1 | grep 'sandbox self-test'
```

It names the Landlock ABI. ABI 0 is one of the first two cases: run `cat /sys/kernel/security/lsm`
on the host, and if it lacks `landlock` the kernel has it turned off, otherwise Docker is blocking
it. ABI 5 is the third case. `dmesg | grep landlock` on the host shows whether the kernel started
Landlock. After the fix, restart the slicer; the files it refused are picked up again by themselves.

## Downloads and slicer links

- **"This file is unavailable right now"** (503): the bucket could not be reached, the stored
  object is missing, the store refused the read (an `AccessDenied` answer, for example), or the
  stored object is not the size Platehouse recorded, for example after restoring an older version
  by hand.
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
