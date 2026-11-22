# Traefik

Written against Traefik 3.7. This is the one proxy setup that has run against a real Platehouse
deployment. The end-to-end tests run a minimal Traefik 3.7 with no middleware, which proves the
cookieless routes (`/api/v1/` and `/s/`) get through a Traefik router; they do not exercise this
guide's timeouts, headers or encoded-slash settings. It is still an example to adapt: your
entrypoint names, certificate resolver and network will differ.

The setup has two parts: the static configuration of the entrypoint, and labels on the app
container.

## 1. The entrypoint (static configuration)

In your Traefik static configuration (for example `traefik.yml`), give the https entrypoint
timeouts long enough for big uploads, and add no entrypoint-level middlewares to it:

```yaml
# Traefik static configuration. An example to adapt.
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        # The whole request, body included, must arrive within this.
        # Traefik's default is 60s, too short for a large upload.
        readTimeout: 1h
        writeTimeout: 0s # the default: no limit, so long downloads finish
        idleTimeout: 180s
    http:
      # Both are Traefik's defaults; shown so they are not turned off.
      sanitizePath: true
      encodedCharacters:
        allowEncodedSlash: true
    # No "middlewares:" here. Anything listed at the entrypoint runs in front
    # of every router, including the API and slicer links.

providers:
  docker:
    exposedByDefault: false
```

## 2. Labels on the app

Add these labels to the `platehouse` service in your `docker-compose.yml`. Put the app on the network
Traefik uses (`proxy` in the example Compose file). Change the host name and the certificate
resolver to yours.

```yaml
services:
  platehouse:
    # ... the rest of the platehouse service from the example ...
    labels:
      traefik.enable: "true"
      traefik.docker.network: proxy
      traefik.http.routers.platehouse.rule: Host(`platehouse.example.com`)
      traefik.http.routers.platehouse.entrypoints: websecure
      traefik.http.routers.platehouse.tls: "true"
      traefik.http.routers.platehouse.tls.certresolver: letsencrypt
      traefik.http.routers.platehouse.middlewares: platehouse-headers
      traefik.http.routers.platehouse.service: platehouse
      traefik.http.services.platehouse.loadbalancer.server.port: "3000"
      # Security headers. Platehouse sets none of them itself.
      traefik.http.middlewares.platehouse-headers.headers.stsSeconds: "31536000"
      traefik.http.middlewares.platehouse-headers.headers.referrerPolicy: no-referrer
      traefik.http.middlewares.platehouse-headers.headers.contentSecurityPolicy: "frame-ancestors 'none'"
```

### Optional: an IP allowlist

To allow only your own networks, add an allowlist middleware and put it first in the router's
chain:

```yaml
traefik.http.middlewares.platehouse-allowlist.ipallowlist.sourcerange: "192.168.0.0/16,172.16.0.0/12"
traefik.http.routers.platehouse.middlewares: platehouse-allowlist,platehouse-headers
```

With no `ipStrategy`, Traefik matches the connection's own address, not a header a client can
set. Keep it that way unless another proxy sits in front of Traefik.

## Why it looks like this

- **The middleware chain is written out**, the headers and optionally the allowlist, and nothing
  else. Never add an authentication middleware (such as forward-auth or an OIDC plugin): the API
  and slicer links are cookieless and would be sent to a login page.
- **No `compress` and no `buffering` middleware.** Traefik streams bodies and does not compress
  unless you add them. The streamed downloads on `/s/`, `/files/`, `/blobs/` and `/api/v1/files/`
  need it that way, and with no `buffering` middleware there is no body-size limit in Traefik, so
  512 MiB uploads go through.
- **`readTimeout: 1h`.** Traefik v3 limits reading the whole request, body included, to 60
  seconds by default. A large upload on an ordinary connection takes longer.
- **`sanitizePath` and `allowEncodedSlash`** are Traefik's defaults in 3.7. Path cleaning stays
  on, and an encoded slash in an API path reaches the app. If you have set
  `allowEncodedSlash: false` on the entrypoint, tags and collections with a `/` in their name
  cannot be changed through the API.
- **Forwarded headers.** Traefik sets `X-Forwarded-Proto`, `X-Forwarded-Host` and
  `X-Forwarded-For` itself, and sends the app origin-form request targets. Platehouse uses the
  headers only in its log; every link comes from `PUBLIC_ORIGIN`.

## With the file provider

If you configure routers in files instead of labels, the same router in dynamic configuration
looks like this:

```yaml
http:
  routers:
    platehouse:
      rule: Host(`platehouse.example.com`)
      entryPoints: [websecure]
      tls:
        certResolver: letsencrypt
      middlewares: [platehouse-headers]
      service: platehouse
  middlewares:
    platehouse-headers:
      headers:
        stsSeconds: 31536000
        referrerPolicy: no-referrer
        contentSecurityPolicy: "frame-ancestors 'none'"
  services:
    platehouse:
      loadBalancer:
        servers:
          - url: http://platehouse:3000
```
