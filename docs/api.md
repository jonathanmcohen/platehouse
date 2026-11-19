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

The examples below keep the address and the token in two shell variables. `read -rs` asks for
the token without showing it, so it stays out of your screen and your shell history:

```sh
export PLATEHOUSE=https://platehouse.example.com
read -rs PLATEHOUSE_TOKEN   # paste the token and press Enter
export PLATEHOUSE_TOKEN
```

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
JSON, for example `409` with `Upload-Offset conflict`. Each upload operation in the reference
lists its answers.

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
| An unfinished upload                          | deleted after 24 hours without a byte                              |
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
that can resume after a cut-off. A tus client library does all of this for you; tus has one for
most languages, such as `tus-js-client` and `tuspy`. With plain HTTP it takes three steps.

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
a model of its own, named after the file. Every tus request carries `Tus-Resumable: 1.0.0`.

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

### Large files and chunking

One `PATCH` can carry the whole file, up to 512 MiB, and that is the simplest way to send one.
On a link that may drop, send it in chunks instead: each `PATCH` carries the next part of the
file, starting at the offset the last one ended at. If a request is cut off, ask where to carry
on with `HEAD <address>`, whose `Upload-Offset` header is the number of bytes Platehouse has, and
send the rest from there. Nothing is imported until the last byte has arrived.

Chunks can be any size. A few MiB each is a good balance between the number of requests and how
much a cut-off costs.

After the import, `HEAD` answers with `Upload-Offset` equal to `Upload-Length`, so a client that
retries never sends the file twice. If the import failed with nothing saved, `HEAD` answers `410`
and the file can be sent again from the start.

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
time, weight and filaments for the printer chosen in Settings.

### Upload a file

```sh
FILE=cable-clip.3mf
SIZE=$(wc -c < "$FILE" | tr -d ' ')
NAME=$(printf '%s' "$FILE" | base64 | tr -d '\n')

# 1. Start the upload; keep the address it answers in Location.
LOCATION=$(curl -sS -o /dev/null -D - -X POST "$PLATEHOUSE/api/v1/uploads" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $SIZE" \
  -H "Upload-Metadata: filename $NAME" \
  | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')

# 2. Send the whole file.
curl -sS -X PATCH "$PLATEHOUSE$LOCATION" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @"$FILE"

# 3. Ask what became of it; repeat while it says pending.
curl -sS "$PLATEHOUSE$LOCATION/result" \
  -H "Authorization: Bearer $PLATEHOUSE_TOKEN"
```

When it is done, the result names the model and the file, and lists any copies of the same file
the library already held (see [Duplicates](#duplicates)):

```json
{
  "status": "done",
  "modelId": "0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f",
  "fileId": "0193a5c2-7d52-7c10-8a11-2b3c4d5e6f70",
  "duplicates": []
}
```

To add the file to a model you already have, put the model's id, in base64, in the metadata of
step 1:

```sh
MODEL=$(printf '%s' 0193a5c2-7d4e-7b21-9f00-3c5a1e2b4d6f | base64 | tr -d '\n')
# then, in step 1:  -H "Upload-Metadata: filename $NAME,modelId $MODEL"
```

To send the same file in 8 MiB chunks, resuming after a dropped connection or a passing error,
replace step 2 with:

```sh
CHUNK=$((8 * 1024 * 1024))
while :; do
  HEAD=$(curl -sS -I "$PLATEHOUSE$LOCATION" \
    -H "Authorization: Bearer $PLATEHOUSE_TOKEN" \
    -H "Tus-Resumable: 1.0.0" | tr -d '\r')
  STATUS=$(printf '%s\n' "$HEAD" | awk 'NR == 1 { print $2 }')
  OFFSET=$(printf '%s\n' "$HEAD" | awk 'tolower($1) == "upload-offset:" { print $2 }')
  case "$STATUS" in
    404 | 410) echo "The upload is gone; start again." >&2; break ;;
    200) [ -n "$OFFSET" ] || { sleep 5; continue; } ;;
    *) sleep 5; continue ;; # no answer, or a passing error such as 503: ask again
  esac
  [ "$OFFSET" -lt "$SIZE" ] || break
  tail -c +"$((OFFSET + 1))" "$FILE" | head -c "$CHUNK" \
    | curl -sS -f -o /dev/null -X PATCH "$PLATEHOUSE$LOCATION" \
        -H "Authorization: Bearer $PLATEHOUSE_TOKEN" \
        -H "Tus-Resumable: 1.0.0" \
        -H "Upload-Offset: $OFFSET" \
        -H "Content-Type: application/offset+octet-stream" \
        --data-binary @- \
    || sleep 5
done
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
