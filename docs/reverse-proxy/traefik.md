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
      # Both are set explicitly, so this setup does not depend on Traefik's
      # own defaults.
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
      # HSTS. Platehouse sends its own Content-Security-Policy, Referrer-Policy
      # and X-Content-Type-Options; do not set those here.
      traefik.http.middlewares.platehouse-headers.headers.stsSeconds: "31536000"
```

### Optional: an IP allowlist

To allow only your own networks, add an allowlist middleware and put it first in the router's
chain:

```yaml
traefik.http.middlewares.platehouse-allowlist.ipallowlist.sourcerange: "192.168.1.0/24,10.8.0.0/24"
traefik.http.routers.platehouse.middlewares: platehouse-allowlist,platehouse-headers
```

With no `ipStrategy`, Traefik matches the connection's own address, not a header a client can
set. Keep it that way unless another proxy sits in front of Traefik; if one does, see
[Rate limits](../security.md#rate-limits) for trusting only that proxy's address.

:::warning The allowlist only works on the address Traefik really sees

- **Do not allow Docker's networks.** When Traefik runs in Docker, never put Docker's bridge
  subnets (`172.16.0.0/12` and the like) in the allowlist. A visitor whose connection Docker has
  rewritten shows up from a bridge address, so allowing those ranges lets everyone in. The ranges
  in this guide, `192.168.1.0/24` for a home network and `10.8.0.0/24` for a VPN, are placeholders:
  use your own.
- **Check the client address after setup.** Turn on Traefik's access log and look at the `ClientHost` field of a request from outside. The address must be the visitor's real one,
  IPv6 included, not a Docker address. Test from a device outside your networks, such as a phone
  off your Wi-Fi, over IPv4 and over IPv6 if you have it. If the log shows a Docker address, the
  allowlist is not seeing your visitors. Fix that before relying on it.
- **Docker's userland proxy.** Where it applies (a container with published ports, on a host that
  has not turned it off), Docker's userland proxy can replace a visitor's address with the bridge
  gateway's, most often for IPv6. Set `"userland-proxy": false` in `/etc/docker/daemon.json`,
  turn on Docker's IPv6 support (`"ipv6": true` and `"ip6tables": true`), restart Docker and check
  again.

:::

## Why it looks like this

- **The middleware chain is written out**, the HSTS header and optionally the allowlist, and
  nothing else. Never add an authentication middleware (such as forward-auth or an OIDC plugin): the API
  and slicer links are cookieless and would be sent to a login page.
- **The headers middleware sets HSTS only.** Platehouse sends its own `Content-Security-Policy`,
  with `frame-ancestors 'none'`, and its own `Referrer-Policy` and `X-Content-Type-Options`, on
  every answer, and Traefik passes them through. If your labels or files set
  `contentSecurityPolicy` from an older version of this guide, remove it: Traefik would replace
  the app's policy with that one. The old `referrerPolicy` can go as well.
- **No `compress` and no `buffering` middleware.** Traefik streams bodies and does not compress
  unless you add them. The streamed downloads on `/s/`, `/files/`, `/blobs/` and `/api/v1/files/`
  need it that way, and with no `buffering` middleware there is no body-size limit in Traefik, so
  512 MiB uploads go through.
- **`readTimeout: 1h`.** Traefik v3 limits reading the whole request, body included, to 60
  seconds by default. A large upload on an ordinary connection takes longer.
- **`sanitizePath` and `allowEncodedSlash`** are both set explicitly in this configuration, so it
  does not depend on Traefik's own defaults (check Traefik's documentation for your version before
  leaving either out). Path cleaning stays on, and an encoded slash in an API path reaches the app.
  If you have set
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
        stsSeconds: 31536000 # HSTS only; the app sends the other headers
  services:
    platehouse:
      loadBalancer:
        servers:
          - url: http://platehouse:3000
```
