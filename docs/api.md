# The Platehouse API

Platehouse has an HTTP API for scripts and tools. With it you can:

- upload 3MF, STL, STEP and SCAD files, as new models or into a model you already have;
- search the library and read a model's files, plates and print estimates;
- download a file;
- add and remove tags, and put models in collections or take them out.

It is meant for automation: a script that files new downloads away, an AI coding assistant that
adds and finds files for you, or an import from another library. It cannot delete, trash
or purge anything, and a model in the trash is invisible to it, so a token that leaks can add
clutter but never lose your files.

Every operation, with its parameters, answers and examples, is in the API reference inside
Platehouse: open **Settings**, and follow the **API reference** link in the **API tokens**
section. This guide covers what the reference does not: how to get started, and how the pieces
fit together.

The examples use `https://platehouse.example.com` for your Platehouse address. Replace it with
your own.

## Contents

- [Tokens](#tokens)
- [Base URL and versioning](#base-url-and-versioning)
- [Errors](#errors)
- [Limits](#limits)
- [Paging](#paging)
- [Uploading files](#uploading-files)
- [Downloads and slicer links](#downloads-and-slicer-links)
- [Examples](#examples)
- [The OpenAPI document](#the-openapi-document)
- [Running Platehouse behind a proxy](#running-platehouse-behind-a-proxy)

## Tokens

Every request needs an API token. Make one for each script or machine that calls the API, so you
can revoke one without breaking the others.

1. Open **Settings** and find **API tokens**.
2. Type a name that says what the token is for, such as `Laptop script`, and press
   **Create token**.
3. Copy the token from the dialog. It starts with `ph_`, and this is the only time it is shown:
   Platehouse keeps only a hash of it. Store it somewhere safe, such as a password manager.

The list shows each token's name, its first 8 characters and when it was last used. **Revoke**
stops a token at once; anything still using it gets `401`.

Send the token on every request in the `Authorization` header, after the word `Bearer`:

```http
Authorization: Bearer <token>
```

The API never reads cookies, so being signed in to Platehouse in a browser does not let a page
call it, and it sends no CORS headers, so a web page on another site cannot read its answers.
A request without a live token (missing, malformed, unknown or revoked) gets `401` with
`WWW-Authenticate: Bearer`.

The examples below keep the address and the token in two shell variables. `stty -echo` turns
off echo while `read` asks for the token, so it stays out of your screen and your shell history.
The block runs in any POSIX shell, dash, bash and zsh included:

```sh
export PLATEHOUSE=https://platehouse.example.com
stty -echo; read -r PLATEHOUSE_TOKEN; stty echo; echo   # paste the token and press Enter
export PLATEHOUSE_TOKEN
```

If you interrupt it before pressing Enter and your typing stops showing, run `stty echo`.

## Base URL and versioning

Every path in this guide and in the reference is under:

```text
https://platehouse.example.com/api/v1
```

The address is the one Platehouse is configured with (its public origin), whatever address a
request arrives on.

The version is in the path. Within `v1`, Platehouse may add new operations and new fields to its
answers, so a client should ignore fields it does not know. A change that would break a `v1`
client would come under a new path, such as `/api/v2`. Request bodies are strict the other way:
a field the API does not know is refused with `400` rather than ignored, so a typo never goes
unnoticed.

## Errors

An error answers JSON with a short code word in `error` and, when there is more to say, a
sentence in `message`:

```json
{ "error": "bad_request", "message": "querystring/limit must be <= 200" }
```

| Status | `error`        | What it means                                                                                                                                            |
| ------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `bad_request`  | A parameter or field is outside its limits, a body field is unknown, the JSON does not parse, or a cursor is not one the API made. `message` says which. |
| 401    | `unauthorized` | No token, or not a live one.                                                                                                                             |
| 404    | `not_found`    | No such model, file or upload, or the model is in the trash.                                                                                             |
| 409    | `exists`       | `POST /models` with an `externalRef` another model already has. `trashed` says whether that model is in the trash.                                       |
| 413    | `bad_request`  | A JSON body over 1 MiB.                                                                                                                                  |
| 415    | `bad_request`  | A body that is not sent as `application/json`.                                                                                                           |
| 500    | `internal`     | Something unexpected. The cause is in Platehouse's log, never in the answer.                                                                             |
| 503    | `unavailable`  | The database or file store cannot be reached right now, or the token could not be checked. Nothing was changed; try again shortly.                       |

The upload routes follow the tus protocol, and tus's own errors answer plain text rather than
JSON, for example `409` with `Upload-Offset conflict`.
[What each answer means](#what-each-answer-means) lists every answer of the upload requests.

Two answers come from the server itself rather than from an API operation, and use its own
shape: a path under `/api/v1` that the API does not have answers `404` with
`{"error": "Not Found", "statusCode": 404}` (and `401` first, without a token), and a path
parameter, such as an id or a tag or collection name, over 100 characters once percent-decoded
answers `414` before the token is read:

```json
{ "error": "URI Too Long", "code": "FST_ERR_MAX_PARAM_LENGTH", "statusCode": 414 }
```

So a tag or collection name over 100 characters is this `414`, not a `400`; the `400` on those
routes is for a blank name.

Taking off a tag a model does not have, or taking a model out of a collection it is not in,
is not an error: it answers `204` like any other success.

## Limits

| What                                          | Limit                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| A JSON request body                           | 1 MiB                                                              |
| An uploaded file                              | 536870912 bytes (512 MiB)                                          |
| File types                                    | `.3mf`, `.stl`, `.step`, `.stp` and `.scad`, told by the file name |
| An uploaded file's name                       | 1024 characters, no control characters                             |
| Models per search page                        | 1 to 200, 50 by default                                            |
| The search text `q`                           | 200 characters                                                     |
| A model's name                                | 1 to 500 characters, not blank                                     |
| A tag or collection name                      | 1 to 100 characters, not blank; longer in a path is `414`          |
| Tags or collections given when making a model | 100 of each                                                        |
| One path parameter, such as an id             | 100 characters once decoded; a longer one is answered `414`        |
| One request                                   | about 72 minutes, enough to send 512 MiB at 1 Mbit/s               |
| An unfinished upload                          | removed after 24 hours untouched; its address then answers `404`   |
| A finished upload's address                   | removed 24 hours after its import; it then answers `404`           |
| An upload's result                            | kept for 24 hours                                                  |

There is no rate limit. Platehouse slices estimates and renders previews in the background one at
a time, so uploading many files at once is fine; their estimates arrive as the queue works
through them.

## Paging

`GET /models` answers one page at a time:

```json
{ "models": [ ... ], "nextCursor": "WzAsIkNhYmxlIGNsaXAiLCIwMTkzYTVjMiJd" }
```

To read the next page, send the same request with `cursor` set to `nextCursor`. On the last page
`nextCursor` is `null`. Keep the other parameters the same from page to page. A cursor is opaque:
do not build or change one, and a cursor the API did not make is `400`.

`limit` sets the page size, 1 to 200, 50 when left out. Results come best match first, then by
name. With no `q`, every model matches equally, so the list is by name.

```sh
cursor=""
while :; do
  if [ -n "$cursor" ]; then set -- --data-urlencode "cursor=$cursor"; else set --; fi
  page=$(curl -sS -G "$PLATEHOUSE/api/v1/models" \
    -H "Authorization: Bearer $PLATEHOUSE_TOKEN" \
    --data-urlencode "limit=200" "$@")
  printf '%s\n' "$page"
  cursor=$(printf '%s' "$page" | sed -n 's/.*"nextCursor":"\([^"]*\)".*/\1/p')
  [ -n "$cursor" ] || break
done
```

## Uploading files

Uploads use [tus 1.0.0](https://tus.io/protocols/resumable-upload), an open protocol for uploads
that can resume after a cut-off. A [tus client](#resumable-and-chunked-uploads-use-a-tus-client)
does all of this for you. With plain HTTP it takes three steps, and the first two can be one
request: `POST /uploads` can carry the whole file as its body, with
`Content-Type: application/offset+octet-stream`, as the [example](#upload-a-file) does.

1. **Start the upload.** `POST /uploads` with the file's size in `Upload-Length` and its name in
   `Upload-Metadata`. The answer is `201` with the upload's address in `Location`, such as
   `/api/v1/uploads/0193a5c2-8e11-7c42-a1b3-5d6e7f809a1b`.
2. **Send the bytes.** `PATCH` that address with `Upload-Offset: 0`,
   `Content-Type: application/offset+octet-stream` and the file as the body. The answer is `204`
   with the new `Upload-Offset`.
3. **Read the result.** `GET <address>/result` answers `pending` while the file is still
   arriving or being imported, then `done` with the `modelId` and `fileId`, or `failed` with a
   sentence saying why in `error`. Poll it every second or two.

`Upload-Metadata` is a list of `key value` pairs separated by commas, each value in base64:

| Key          | Meaning                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `filename`   | Required. The file's name; its extension says what the file is.                                                    |
| `modelId`    | Add the file to this existing model instead of making a new one.                                                   |
| `batch`      | Group several uploads: uploads that share a batch value (1 to 200 characters) arrive together.                     |
| `combine`    | With `batch`: `1` or `true` makes the batch one model, `0` or `false` (the default) makes each file its own model. |
| `duplicates` | `allow` (the default) or `skip`: what to do when the library already holds the same file.                          |

`modelId` cannot be sent with `batch` or `combine`. Without `modelId` or `batch`, the file becomes
a model of its own, named from the `.3mf`'s MakerWorld title when it has one, else from the
file's name. Every tus request carries `Tus-Resumable: 1.0.0`.

### Duplicates

A file is a duplicate when a live model already holds a file with the same bytes (the same
SHA-256); a file in the trash never counts. With `duplicates` left out or `allow`, the file is
stored anyway, and the `done` result lists the copies that were already there in `duplicates`
(empty when there were none). With `skip`, nothing is stored and the result is `failed` with
`code` `duplicate` and the matching files in `duplicates`, so a script can point at the model
that has it, or send the file again with `allow`:

```json
{
  "status": "failed",
  "error": "This file is already in the library, in the model \"Cable clip\" (id 0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f), so it was skipped; nothing was saved",
  "code": "duplicate",
  "duplicates": [
    {
      "modelId": "0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f",
      "modelName": "Cable clip",
      "fileId": "0193a5c2-7d52-7c10-8a11-2b3c4d5e6f70",
      "fileName": "cable-clip.3mf"
    }
  ]
}
```

`duplicates` lists at most 10 files, oldest first. Any other failure has no `code`.

### Resumable and chunked uploads: use a tus client

The [single-request example](#upload-a-file) below sends the whole file in the request that
creates the upload. That is all most scripts need. If a cut-off should resume rather than start
again, for a big file or a link that drops, use a tus client rather than writing the protocol by
hand. It sends the file in chunks, asks `HEAD` where to carry on after a cut-off, and retries for
you. Point it at the endpoint and give it the token header and the metadata; the client encodes
the metadata in base64 itself.

| What                    | Value                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| Endpoint                | `https://platehouse.example.com/api/v1/uploads`                                 |
| Header on every request | `Authorization: Bearer <token>` (the client adds `Tus-Resumable: 1.0.0`)        |
| Metadata                | `filename` (required), and `modelId`, `batch`, `combine`, `duplicates` as above |
| Size                    | at most 536870912 bytes (512 MiB)                                               |
| When it is done         | `GET <upload address>/result` for the model and file                            |

**JavaScript**, with [tus-js-client](https://github.com/tus/tus-js-client)
(`npm install tus-js-client`), in Node 18 or later:

```js
// upload.mjs: node upload.mjs cable-clip.3mf
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { Upload } from "tus-js-client";

const path = process.argv[2];
const headers = { Authorization: `Bearer ${process.env.PLATEHOUSE_TOKEN}` };

const upload = new Upload(createReadStream(path), {
  endpoint: `${process.env.PLATEHOUSE}/api/v1/uploads`,
  headers,
  metadata: { filename: basename(path) },
  uploadSize: statSync(path).size,
  chunkSize: 8 * 1024 * 1024,
  retryDelays: [0, 3000, 10000, 30000, 60000],
  removeFingerprintOnSuccess: true,
  onError(error) {
    console.error(`Upload failed: ${error.message}`);
    process.exitCode = 1;
  },
  async onSuccess() {
    // upload.url is the upload's address; its result says what became of it.
    for (;;) {
      const result = await (await fetch(`${upload.url}/result`, { headers })).json();
      if (result.status !== "pending") {
        console.log(result);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  },
});
upload.start();
```

**Python**, with [tuspy](https://github.com/tus/tus-py-client) (`pip install tuspy`):

```python
# upload.py: python3 upload.py cable-clip.3mf
import json
import os
import sys
import time
import urllib.request

from tusclient import client

path = sys.argv[1]
headers = {"Authorization": "Bearer " + os.environ["PLATEHOUSE_TOKEN"]}

tus = client.TusClient(os.environ["PLATEHOUSE"] + "/api/v1/uploads", headers=headers)
uploader = tus.uploader(
    path,
    chunk_size=8 * 1024 * 1024,
    metadata={"filename": os.path.basename(path)},
    retries=5,
    retry_delay=10,
)
uploader.upload()

# uploader.url is the upload's address; its result says what became of it.
while True:
    request = urllib.request.Request(uploader.url + "/result", headers=headers)
    result = json.load(urllib.request.urlopen(request))
    if result["status"] != "pending":
        print(result)
        break
    time.sleep(2)
```

Both examples were checked with tus-js-client 4.3.1 and tuspy 1.1.0. Each sent a 20 MiB file
in 8 MiB chunks, resumed from the right offset after a dropped connection and after a `502`,
and stopped on a `401`.

A browser client should keep `removeFingerprintOnSuccess: true` (or put the target, such as
`modelId`, into its fingerprint). Otherwise the same file dropped later onto another model
resumes the finished upload and stores nothing there.

### What each answer means

Every answer the upload requests can give, in the same words as the
[OpenAPI document](#the-openapi-document) and the API reference in Settings. tus's own answers
are plain text; Platehouse's are JSON.

| Request                    | Status | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /uploads`            | 201    | Created. Location is the upload's address, /api/v1/uploads/{id}; send the bytes there. With creation-with-upload, Upload-Offset says how many bytes were taken.                                                                                                                                                                                                                                                                                      |
| `POST /uploads`            | 400    | Upload-Length is missing, or Upload-Metadata is malformed, has no filename, has a duplicates other than skip or allow, or breaks a rule above. The body says which.                                                                                                                                                                                                                                                                                  |
| `POST /uploads`            | 401    | No token, or not a live one: missing, malformed, unknown or revoked. The answer carries WWW-Authenticate: Bearer. Cookies are never read.                                                                                                                                                                                                                                                                                                            |
| `POST /uploads`            | 404    | modelId names no live model: unknown, or in the trash                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /uploads`            | 412    | The Tus-Resumable header is missing                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /uploads`            | 413    | Upload-Length is over 536870912 bytes                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /uploads`            | 415    | The file name's extension is not one Platehouse takes                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /uploads`            | 500    | Something unexpected went wrong while handling the bytes. If the upload has an address, ask HEAD where to carry on; if not, start again.                                                                                                                                                                                                                                                                                                             |
| `POST /uploads`            | 501    | A tus extension Platehouse does not offer: Upload-Defer-Length or Upload-Concat                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /uploads`            | 503    | JSON: the model named by modelId, or the token, could not be checked (the database is unreachable); try again. Text: a creation that carried the whole file, where the last byte arrived but the import could not be queued: nothing was saved and the upload was removed, so send the file again as a new upload                                                                                                                                    |
| `HEAD /uploads/{id}`       | 200    | Upload-Offset and Upload-Length; no body                                                                                                                                                                                                                                                                                                                                                                                                             |
| `HEAD /uploads/{id}`       | 401    | No token, or not a live one: missing, malformed, unknown or revoked. The answer carries WWW-Authenticate: Bearer. Cookies are never read.                                                                                                                                                                                                                                                                                                            |
| `HEAD /uploads/{id}`       | 404    | No such upload: the id is unknown, the upload was removed after 24 hours untouched (or 24 hours after its import), or it was removed because its import could not be queued                                                                                                                                                                                                                                                                          |
| `HEAD /uploads/{id}`       | 410    | The import failed and nothing was saved. GET /uploads/{id}/result says why; send the file again as a new upload, unless that reason is about the file itself (an unsupported type, or a duplicate under duplicates skip)                                                                                                                                                                                                                             |
| `HEAD /uploads/{id}`       | 412    | The Tus-Resumable header is missing                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `HEAD /uploads/{id}`       | 414    | A path parameter is over 100 characters once percent-decoded. The server answers this before it reads the token, in its own error shape rather than the API's.                                                                                                                                                                                                                                                                                       |
| `HEAD /uploads/{id}`       | 500    | Something unexpected went wrong                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `HEAD /uploads/{id}`       | 503    | Platehouse cannot answer right now: its database or file store is unreachable, or the token could not be checked. Nothing was changed. Try again shortly.                                                                                                                                                                                                                                                                                            |
| `PATCH /uploads/{id}`      | 204    | Taken; Upload-Offset is the new offset                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PATCH /uploads/{id}`      | 400    | A tus header is malformed, or another request on this upload took it over (ask HEAD for the offset and carry on)                                                                                                                                                                                                                                                                                                                                     |
| `PATCH /uploads/{id}`      | 401    | No token, or not a live one: missing, malformed, unknown or revoked. The answer carries WWW-Authenticate: Bearer. Cookies are never read.                                                                                                                                                                                                                                                                                                            |
| `PATCH /uploads/{id}`      | 403    | Upload-Offset or the Content-Type application/offset+octet-stream is missing                                                                                                                                                                                                                                                                                                                                                                         |
| `PATCH /uploads/{id}`      | 404    | No such upload: the id is unknown, the upload was removed after 24 hours untouched (or 24 hours after its import), or it was removed because its import could not be queued                                                                                                                                                                                                                                                                          |
| `PATCH /uploads/{id}`      | 409    | Upload-Offset is not the number of bytes received; ask HEAD for it                                                                                                                                                                                                                                                                                                                                                                                   |
| `PATCH /uploads/{id}`      | 410    | The upload is over: it was imported, or its import failed with nothing saved. GET /uploads/{id}/result says which; if it failed, send the file again as a new upload, unless that reason is about the file itself (an unsupported type, or a duplicate under duplicates skip)                                                                                                                                                                        |
| `PATCH /uploads/{id}`      | 412    | The Tus-Resumable header is missing                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PATCH /uploads/{id}`      | 413    | The body runs past Upload-Length                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PATCH /uploads/{id}`      | 414    | A path parameter is over 100 characters once percent-decoded. The server answers this before it reads the token, in its own error shape rather than the API's.                                                                                                                                                                                                                                                                                       |
| `PATCH /uploads/{id}`      | 500    | Something unexpected went wrong while handling the bytes. If the upload has an address, ask HEAD where to carry on; if not, start again.                                                                                                                                                                                                                                                                                                             |
| `PATCH /uploads/{id}`      | 503    | Text: the last byte arrived but the import could not be queued: nothing was saved and the upload was removed, so send the file again as a new upload. JSON: the token could not be checked (the database is unreachable); try again.                                                                                                                                                                                                                 |
| `GET /uploads/{id}/result` | 200    | The upload's state. pending while it is arriving or being imported; done with the model and file, and duplicates: the files of live models that already held the same bytes (empty when none did); or failed with a message. A duplicate refused under duplicates skip is failed with code duplicate and the duplicates it matched, so the client can point at the model or send the file again with duplicates allow. Other failures carry no code. |
| `GET /uploads/{id}/result` | 401    | No token, or not a live one: missing, malformed, unknown or revoked. The answer carries WWW-Authenticate: Bearer. Cookies are never read.                                                                                                                                                                                                                                                                                                            |
| `GET /uploads/{id}/result` | 404    | No such upload, or its result is more than 24 hours old                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /uploads/{id}/result` | 414    | A path parameter is over 100 characters once percent-decoded. The server answers this before it reads the token, in its own error shape rather than the API's.                                                                                                                                                                                                                                                                                       |
| `GET /uploads/{id}/result` | 500    | Something unexpected went wrong. The cause is in Platehouse's log and never in the answer. Retrying may work.                                                                                                                                                                                                                                                                                                                                        |
| `GET /uploads/{id}/result` | 503    | The result cannot be read right now; try again shortly                                                                                                                                                                                                                                                                                                                                                                                               |

## Downloads and slicer links

`GET /files/{id}/content` downloads a file's bytes exactly as uploaded. `Content-Disposition`
carries the file's name with its real extension, and `HEAD` on the same path answers the same
headers with no body. File ids come from `GET /models/{id}`, which lists each model's files.

```sh
curl -sS -OJ "$PLATEHOUSE/api/v1/files/0193a5c2-7d52-7c10-8a11-2b3c4d5e6f70/content" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN"
```

`-OJ` saves the file under the name Platehouse gives it.

The **Open in Bambu Studio** and **Open in OrcaSlicer** buttons on a model page work differently.
A slicer opens a file from a URL and cannot send a token, so the web app makes a short-lived link
for the person signed in, `https://platehouse.example.com/s/<link>/<file name>`, that opens that
one file for 10 minutes. These links are a feature of the web app: an API token cannot make one.
To open a file in a slicer from a script, download it and open the saved file.

## Examples

### List models

```sh
curl -sS "$PLATEHOUSE/api/v1/models?limit=20" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN"
```

Search and filter with `q`, `tag`, `collection` and `creator`. `-G` with `--data-urlencode`
encodes the values for you:

```sh
curl -sS -G "$PLATEHOUSE/api/v1/models" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN" \
  --data-urlencode "q=cable clip" \
  --data-urlencode "tag=desk"
```

### Get one model

```sh
curl -sS "$PLATEHOUSE/api/v1/models/0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN"
```

The answer has the model's details, its files, each 3MF file's plates, and each plate's print
time, weight and filaments for the default printer of My printers (in Settings). Each set of
numbers names its printer in full in `printerName`, such as `Bambu Lab P1S, 0.4 mm nozzle`.

### Upload a file

This sends the whole file in the request that creates the upload (tus creation-with-upload),
then asks what became of it. It prints the status of the first request, which is `201` when the
file arrived; any other status means it did not, and
[What each answer means](#what-each-answer-means) says why. For a big file or a link that drops,
use a [tus client](#resumable-and-chunked-uploads-use-a-tus-client) instead, which resumes after a
cut-off.

```sh
FILE=cable-clip.3mf
SIZE=$(wc -c < "$FILE" | tr -d ' ')
NAME=$(printf '%s' "$FILE" | base64 | tr -d '\n')

# 1. Create the upload with the whole file as its body; no -L, so a redirect is reported.
STATUS=$(curl -sS -o /dev/null -D headers.txt -w '%{http_code}' -X POST "$PLATEHOUSE/api/v1/uploads" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $SIZE" \
  -H "Upload-Metadata: filename $NAME" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @"$FILE")
echo "HTTP $STATUS"

# 2. When it was 201, ask what became of it; run this again while it says pending.
if [ "$STATUS" = 201 ]; then
  LOCATION=$(tr -d '\r' < headers.txt | awk 'tolower($1) == "location:" { print $2 }')
  curl -sS "$PLATEHOUSE$LOCATION/result" -H "Authorization: Bearer $PLATEHOUSE_TOKEN"
fi
```

When the import is done, the result names the model and the file, and lists any copies of the
same file the library already held (see [Duplicates](#duplicates)):

```json
{
  "status": "done",
  "modelId": "0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f",
  "fileId": "0193a5c2-7d52-7c10-8a11-2b3c4d5e6f70",
  "duplicates": []
}
```

To add the file to a model you already have, add its id, in base64, to the metadata:

```sh
MODEL=$(printf '%s' 0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f | base64 | tr -d '\n')
# then, in step 1:  -H "Upload-Metadata: filename $NAME,modelId $MODEL"
```

### Add a tag

```sh
curl -sS -X PUT "$PLATEHOUSE/api/v1/models/0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f/tags/desk" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN"
```

The answer is `204` with no body. The tag is made if it is new, and a tag the model already has
is fine. `DELETE` on the same path takes it off. Collections work the same way:

```sh
curl -sS -X PUT "$PLATEHOUSE/api/v1/collections/Office/models/0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN"
```

A tag or collection name with spaces or other special characters goes in the path URL-encoded,
for example `Desk%20gear` for `Desk gear`.

## The OpenAPI document

The API describes itself in OpenAPI 3.0 at:

```text
GET https://platehouse.example.com/api/v1/openapi.json
```

It needs a token like every other request:

```sh
curl -sS "$PLATEHOUSE/api/v1/openapi.json" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN" -o platehouse-openapi.json
```

Load it into an OpenAPI tool to browse it or generate a client. The same document, as this
version of Platehouse serves it, is what the API reference in Settings shows, and it is in the
repository at `apps/web/src/api-docs/openapi.json`.

## Running Platehouse behind a proxy

The API takes tokens, not a login, so a reverse proxy in front of Platehouse must let requests to
`/api/v1/` through without a login or forward-auth step. A proxy that sends them to a login page
breaks every script, while the web app keeps working. Keep the API on a network you trust, such
as your LAN or a VPN; anyone who can reach it still needs a token.
