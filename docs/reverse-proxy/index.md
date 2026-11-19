# Reverse proxy

Platehouse expects a reverse proxy in front of it. The proxy terminates TLS, adds a few security
headers the app does not set itself, and passes large uploads and downloads straight through.
This page lists what Platehouse needs from any proxy. The guides that follow give a complete
example for each of four servers:

- [nginx](./nginx.md)
- [Caddy](./caddy.md)
- [Traefik](./traefik.md)
- [Apache httpd](./apache.md)

Then use the [checklist](./checklist.md) to confirm your setup works.

:::warning Examples to adapt

Every snippet in this section is an example to adapt to your own setup, not a file to copy
unchanged. Only the Traefik setup has been run against a real deployment. The nginx, Caddy and
Apache guides are written from each server's documentation and from what Platehouse needs, and
have not been run against a real Platehouse deployment. Run the [checklist](./checklist.md)
whichever you use.

:::

In the examples the app is reached at `platehouse:3000` (its container name on a shared Docker
network) or `127.0.0.1:3000` (a port published on the host), and the public address is
`https://platehouse.example.com`.

## What Platehouse needs from a proxy

### TLS

Serve Platehouse over https only, and redirect http to https. `PUBLIC_ORIGIN` must be an https
address, and the sign-in cookies are Secure cookies, which browsers only keep over https. The
proxy talks plain http to the app on your own network.

### Security headers

Platehouse does not set these response headers itself, so set them at the proxy:

| Header                      | Value                    | Why                                                                                      |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `Strict-Transport-Security` | `max-age=31536000`       | Browsers use https for the site from then on.                                            |
| `Referrer-Policy`           | `no-referrer`            | No Platehouse address, such as a slicer link, leaks to another site in a Referer header. |
| `Content-Security-Policy`   | `frame-ancestors 'none'` | No other site can show Platehouse inside a frame.                                        |

### Large uploads

An upload can be up to 512 MiB. The web app sends files in 5 MiB pieces, but an API client may
send a whole file in one request, as `curl` does. So:

- allow request bodies of at least 512 MiB (the examples use 600 MiB);
- pass request bodies straight through instead of buffering them to disk first, where the proxy
  can;
- make read timeouts long enough for your slowest large upload. The app itself allows a whole
  512 MiB upload at 1 Mbit/s, a little over an hour, and the examples use one hour. Traefik v3's
  default read timeout is only 60 seconds.

### Streamed downloads

Downloads are streamed from the bucket through the app. On these paths, turn off response
buffering and compression:

| Path             | What it serves                 |
| ---------------- | ------------------------------ |
| `/s/`            | Slicer links                   |
| `/files/`        | File downloads in the browser  |
| `/blobs/`        | Thumbnails, renders and meshes |
| `/api/v1/files/` | File downloads through the API |

Model files do not compress well anyway, and buffering a large file in the proxy delays the first
byte and uses its disk.

### No login in front of the app

Platehouse does its own sign-in. Do not put a login or forward-auth layer (such as an
authentication middleware) in front of it. Two route families in particular must reach the app
without a cookie, or they break:

- `/api/v1/`, which takes bearer tokens;
- `/s/`, slicer links, which a slicer opens with no cookie.

A login layer would answer them with a redirect to a login page, which an API client or a slicer
cannot follow.

### Paths passed through as sent

- **Encoded slashes.** The API puts tag and collection names in the path, so a tag such as `a/b`
  arrives as `/api/v1/models/<id>/tags/a%2Fb`. The proxy must pass `%2F` through without decoding
  it into `/`, or the request reaches the wrong route. Slicer links never contain an encoded
  slash: Platehouse replaces `/` and other unsafe characters in a link's file name with `_`.
- **Path cleaning on.** Keep your proxy's normal path checks (such as refusing `..` segments) on.
- **Origin-form requests to the app.** The proxy should send the app a request target like
  `/s/...`, not a full `https://host/s/...` address. Every common proxy does this by default.

### Forwarded headers

Send `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`, as every guide here does. The
app records `X-Forwarded-For` and `X-Forwarded-Proto` in its request log, which helps when you
read it.

Platehouse does not use these headers, or the `Host` header, to build any address: every link
comes from `PUBLIC_ORIGIN`. So there is no trusted-proxy setting to configure in Platehouse, and a
client that sends its own forwarded headers cannot change a link. Set `PUBLIC_ORIGIN` to the
address people actually use.

### Optional: an IP allowlist

Platehouse is meant for your own network. If the proxy is reachable from outside it, you can
restrict the site to your own address ranges at the proxy. Each guide has an optional allowlist
block. Match on the connection's own address, not on a header a client can set. See
[Security](../security.md).

## Where each requirement comes from

| Requirement                                                | Source                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| https only, Secure cookies                                 | The app's configuration and sign-in code                                              |
| The three security headers, set by the proxy               | The app sets none of them; the reference deployment sets them at the proxy            |
| 512 MiB uploads, one-request uploads, the one-hour timeout | The app's upload handler and server timeout                                           |
| Traefik's 60-second read timeout                           | Traefik's documentation                                                               |
| No buffering or compression on the streaming paths         | The reference deployment; `/api/v1/files/` added because the API streams the same way |
| No login on `/api/v1/` and `/s/`                           | The app's route classes: both are cookieless                                          |
| Encoded slashes in API paths                               | The API's tag and collection routes, and its own importer, which encodes `/` as `%2F` |
| Path cleaning and origin-form targets                      | The reference deployment's apply-time checks                                          |
| Forwarded headers are for logs only                        | The app's request log; it reads no forwarded header for addresses                     |
