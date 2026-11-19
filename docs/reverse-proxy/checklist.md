# Proxy checklist

Run these checks after setting up any proxy, and again after changing its configuration. Replace
`platehouse.example.com` with your host name. Run them from a machine on the network your users
use, not from the server itself.

Some checks need an API token. Create one in **Settings**, then read it into your shell without
it showing on screen or landing in your shell history:

```bash
export PH=https://platehouse.example.com
read -rs PH_TOKEN && export PH_TOKEN
```

Paste the token and press Enter. Clear it when you are done with `unset PH_TOKEN`.

## 1. TLS and the security headers

```bash
curl -sSI "$PH/healthz"
```

Expect `HTTP/2 200` (or `HTTP/1.1 200`) and all three headers:

```text
strict-transport-security: max-age=31536000
referrer-policy: no-referrer
content-security-policy: frame-ancestors 'none'
```

And http should redirect to https:

```bash
curl -sSI "http://platehouse.example.com/" | head -n 3
```

Expect a 301 or 308 with a `location: https://...` header.

## 2. The API and slicer links get through without a cookie

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$PH/api/v1/models"
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $PH_TOKEN" "$PH/api/v1/models"
```

Expect `401` for the first and `200` for the second. A `302` or a login page means something in
front of the app is asking for a login; remove it.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$PH/s/not-a-real-link/file.3mf"
```

Expect `403` with an empty body: the app refused a bad link. A redirect means a login layer is in
the way.

## 3. A big upload completes

The quickest test is through the browser: drag your largest real file, ideally a few hundred MB,
onto the library and watch it finish.

To test a single-request upload, as an API client sends it, make a large but valid STL file of
blank triangles (about 300 MB) and upload it in one request:

```bash
python3 -c "import struct,sys; n=6_000_000; sys.stdout.buffer.write(bytes(80)+struct.pack('<I',n)+bytes(50*n))" > big-test.stl

SIZE=$(wc -c < big-test.stl | tr -d ' ')
NAME=$(printf 'big-test.stl' | base64)

# Create the upload, then send the whole file in one PATCH.
LOCATION=$(curl -sS -D - -o /dev/null -X POST "$PH/api/v1/uploads" \
  -H "Authorization: Bearer $PH_TOKEN" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $SIZE" -H "Upload-Metadata: filename $NAME" \
  | tr -d '\r' | awk 'tolower($1)=="location:" {print $2}')

curl -sS -o /dev/null -w 'PATCH answered %{http_code} after %{time_total}s\n' \
  -X PATCH "$PH$LOCATION" \
  -H "Authorization: Bearer $PH_TOKEN" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" \
  --data-binary @big-test.stl

curl -sS -H "Authorization: Bearer $PH_TOKEN" "$PH$LOCATION/result"
```

Expect `PATCH answered 204`, and the result to say `done` once the file is stored (ask again if it
says `pending`). A `413` means the proxy's body limit is too low; a `408`, `504` or a dropped
connection part way means a timeout is too short. Then move the test model to the trash in the
library.

## 4. An encoded slash reaches the app

Use the ID of any model (open it in the library: the ID is the last part of its address), add a tag
with a `/` in its name, then remove it:

```bash
MODEL=paste-a-model-id-here
curl -sS -o /dev/null -w '%{http_code}\n' -X PUT -H "Authorization: Bearer $PH_TOKEN" \
  "$PH/api/v1/models/$MODEL/tags/proxy%2Fcheck"
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $PH_TOKEN" \
  "$PH/api/v1/models/$MODEL/tags/proxy%2Fcheck"
```

Expect `204` both times, and the tag `proxy/check` to appear on the model between the two. A `404`
means the proxy decoded or refused the `%2F`.

## 5. A slicer link with a `/` in the file name works

In the library, rename a `.3mf` file so its name holds a slash, for example `left/right.3mf`. On its
model page, press **Open in OrcaSlicer**: the slicer should download and open the file. To test
it with curl instead, copy the address the button opens. It is `orcaslicer://open?file=` followed
by the link, percent-encoded; decode it, for example with
`python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' 'what-you-copied'`.
Platehouse replaces the `/` in the link's last part with `_`. Within 10 minutes:

```bash
curl -sS -o slicer-test.3mf -w '%{http_code} %{size_download} bytes\n' 'https://platehouse.example.com/s/...'
```

Expect `200` and the file's full size. Then rename the file back.

## 6. Downloads stream

With the same kind of link for a large file:

```bash
curl -sS -o /dev/null -w 'first byte %{time_starttransfer}s, done %{time_total}s\n' 'https://platehouse.example.com/s/...'
```

The first byte should arrive within a second or two, long before the download finishes. If the
first byte only arrives near the end, the proxy is buffering the response.

Check the response is not compressed:

```bash
curl -sS -o /dev/null -D - -H 'Accept-Encoding: gzip, br, zstd' 'https://platehouse.example.com/s/...' | grep -i '^content-encoding' || echo 'not compressed'
```

Expect `not compressed`.

## 7. Clean up

Delete `big-test.stl` and `slicer-test.3mf`, empty the test model from the trash if you like, and
`unset PH_TOKEN`. If you made a token only for these checks, revoke it in **Settings**.
