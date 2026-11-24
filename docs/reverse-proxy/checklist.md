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

Expect `HTTP/2 200` (or `HTTP/1.1 200`) and these four headers, each once. The first comes from
the proxy; Platehouse sends the other three itself:

```text
strict-transport-security: max-age=31536000
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
referrer-policy: no-referrer
x-content-type-options: nosniff
```

If `content-security-policy` is missing, shows only `frame-ancestors 'none'`, or appears twice,
the proxy is still setting its own policy, as older versions of these guides did: remove that line
from the proxy so the app's policy reaches the browser unchanged.

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

Removing a tag through the API takes it off the model but leaves the tag itself, because the API
never deletes anything. The leftover `proxy/check` is listed on the **Tags** page with 0 models,
where **Delete** removes it; it is not shown in the library's tag chips or the tag pickers. Each
run of this check reuses the same tag rather than adding another.

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

## 7. The proxy sees each visitor's real address

If you use an allowlist, this one matters most. From a device outside your allowlisted networks,
such as a phone off your Wi-Fi, open the site, then find that request in the proxy's access log
(turn the access log on first if your proxy does not write one). The client address it shows must
be that device's real address, over IPv4 and over IPv6 if you have it, not a Docker address such as
`172.17.0.1`. The device should also get `403` from the allowlist.

If the log shows a Docker address, the proxy is not seeing visitors' own addresses and the
allowlist does not do its job. When the proxy runs in Docker:

- Never allow Docker's bridge subnets (`172.16.0.0/12` and the like) in the allowlist; it lets in
  everyone Docker has rewritten. Allow only your own networks, such as `192.168.1.0/24` and
  `10.8.0.0/24` (placeholders: use yours).
- Where Docker's userland proxy applies, it can replace a visitor's address with the bridge
  gateway's, most often for IPv6. Set `"userland-proxy": false` in `/etc/docker/daemon.json`, turn
  on Docker's IPv6 support (`"ipv6": true` and `"ip6tables": true`), restart Docker and check
  again.

See [Security](../security.md#the-ip-allowlist-idea).

## 8. Clean up

Delete `big-test.stl` and `slicer-test.3mf`, empty the test model from the trash if you like, and
`unset PH_TOKEN`. If you made a token only for these checks, revoke it in **Settings**. The
`proxy/check` tag from check 4 stays in the database and is listed on the **Tags** page with 0 models, where **Delete** removes it (see check 4).
