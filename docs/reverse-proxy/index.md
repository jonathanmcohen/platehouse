---
description: What Platehouse needs from the reverse proxy in front of it, whichever proxy you use.
---

# Reverse proxy

Platehouse expects a reverse proxy in front of it. The proxy terminates TLS, adds the HSTS header,
and passes large uploads and downloads straight through.
This page lists what Platehouse needs from any proxy. The guides that follow give a complete
example for each of four servers:

- [nginx](./nginx.md)
- [Caddy](./caddy.md)
- [Traefik](./traefik.md)
- [Apache httpd](./apache.md)

Then use the [checklist](./checklist.md) to confirm your setup works.

:::warning Examples to adapt

Every snippet in this section is an example to adapt to your own setup, not a file to copy
unchanged. Only the Traefik setup has been run against a real deployment (the end-to-end tests run
a minimal Traefik with no middleware, not this guide's full setup). The nginx, Caddy and
Apache guides are written from each server's documentation and from what Platehouse needs, and
have not been run against a real Platehouse deployment. Run the [checklist](./checklist.md)
whichever you use.

:::

In the examples the app is reached at `platehouse:3000` (its container name on a shared Docker
network) or `127.0.0.1:3000` (a port published on the host), and the public address is
`https://platehouse.example.com`.

Platehouse needs a host name of its own, such as `platehouse.example.com`, and must be served at
its root. It cannot be served under a path such as `https://example.com/platehouse/`:
`PUBLIC_ORIGIN` takes no path, and the sign-in cookies are `__Host-` cookies, which are always set
for the whole site (`Path=/`).

## What Platehouse needs from a proxy

### TLS

Serve Platehouse over https only, and redirect http to https. `PUBLIC_ORIGIN` must be an https
address, and the sign-in cookies are Secure cookies, which browsers only keep over https. The
proxy talks plain http to the app on your own network.

### Security headers

Platehouse sends these response headers itself, on every answer, errors included:

| Header                    | Value            | Why                                                                                                                                                   |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy` | The policy below | The browser runs only Platehouse's own scripts and styles and connects only to Platehouse, and `frame-ancestors 'none'` stops other sites framing it. |
| `Referrer-Policy`         | `no-referrer`    | No Platehouse address, such as a slicer link, leaks to another site in a Referer header.                                                              |
| `X-Content-Type-Options`  | `nosniff`        | The browser keeps to the content type Platehouse names.                                                                                               |

The policy is:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

The proxy sets one header: `Strict-Transport-Security: max-age=31536000`, so browsers use https
for the site from then on. HSTS stays the proxy's job because only the proxy that terminates TLS
knows the site is served over https.

Do not set `Content-Security-Policy` at the proxy. Older versions of these guides set
`Content-Security-Policy: frame-ancestors 'none'` there; if your proxy still has that line, remove
it. Depending on the proxy, it would replace the app's policy or be sent as a second policy beside
it, and a browser enforces every policy it gets, so a second one can only narrow the app's. The
old `Referrer-Policy` line can go too, since the app sends the same value. The
[checklist](./checklist.md) shows what the headers should look like.

### Large uploads

An upload can be up to 512 MiB. The web app sends files in 5 MiB pieces, but an API client may
send a whole file in one request, as `curl` does. So:

- allow request bodies of at least 512 MiB (the examples use 600 MiB);
- pass request bodies straight through instead of buffering them to disk first, where the proxy
  can;
- make read timeouts long enough for your slowest large upload. The app itself allows one request
  about 72 minutes, a whole 512 MiB upload at 1 Mbit/s. The nginx and Apache examples use one
  hour, which is enough there because their timeouts are idle timeouts: each counts only a pause
  with no data, not the whole upload. Traefik's `readTimeout`, and Caddy's `read_body` if you set
  one, count the whole request instead, so the Traefik example uses 75 minutes, above the app's
  limit. Traefik v3's default read timeout is only 60 seconds.

### Streamed downloads

Downloads are streamed from the bucket through the app. On these paths, turn off response
buffering and compression:

| Path             | What it serves                 |
| ---------------- | ------------------------------ |
| `/s/`            | Slicer links                   |
| `/files/`        | File downloads in the browser  |
| `/blobs/`        | Thumbnails, renders and meshes |
| `/api/v1/files/` | File downloads through the API |

Downloads can be resumed: the app answers `Range` requests, and with the settings these guides
give, nginx, Caddy, Traefik and Apache all pass the `Range` header through by default.

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

| Requirement                                               | Source                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| https only, Secure cookies                                | The app's configuration and sign-in code                                                                                        |
| HSTS at the proxy, and no CSP at the proxy                | The app's responses: it sends its CSP, `Referrer-Policy` and `nosniff` itself, and not HSTS                                     |
| 512 MiB uploads, one-request uploads, the upload timeouts | The app's upload handler and server timeout                                                                                     |
| Its own host name, no subpath                             | `PUBLIC_ORIGIN` takes no path, and the sign-in cookies are `__Host-` cookies, set for `Path=/`                                  |
| Traefik's 60-second read timeout                          | Traefik's documentation                                                                                                         |
| No buffering or compression on the streaming paths        | The app streams these paths from the bucket as it reads them                                                                    |
| No login on `/api/v1/` and `/s/`                          | The app's route classes: both are cookieless                                                                                    |
| Encoded slashes in API paths                              | The API's tag and collection routes, and its own importer, which encodes `/` as `%2F`                                           |
| Path cleaning and origin-form targets                     | The app reads a slicer link's key from the path as sent, and logs paths; a full-address target would put a live link in its log |
| Forwarded headers are for logs only                       | The app's request log; it reads no forwarded header for addresses                                                               |
