---
description: An example Traefik setup for Platehouse, and why each setting is there.
---

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
        # Traefik's default is 60s, too short for a large upload. 75m is
        # above the app's own limit for one request, about 72 minutes.
        readTimeout: 75m
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

- **Let the proxy see real addresses.** If the proxy runs in Docker and you use an allowlist, prefer
  `network_mode: host` (Docker Engine on Linux), or run it on the host. With host networking, point
  the proxy at the host upstream (`127.0.0.1:3000`, with the app's port published on loopback only by
  uncommenting the `ports:` lines in the example Compose file). With the file provider, use `http://127.0.0.1:3000`; the Docker labels
  need no change. Make sure nothing else the proxy listens on, such as Traefik's dashboard on 8080,
  is exposed. If every visitor, LAN and outside, shows the same address (Docker's
  bridge pools, Swarm's overlay pools in `10.0.0.0/8`, and Docker Desktop's `192.168.65.0/24`), do
  not add that address to the allowlist; the allowlist cannot work on this setup. That is the case
  on Docker Desktop (macOS and Windows), with rootless Docker's builtin port driver before
  RootlessKit 3.0, with rootless Podman and with Swarm ingress. Run the proxy on the host, or with
  `network_mode: host`. For rootless Docker, set `DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns` and
  `DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns`, or
  `DOCKERD_ROOTLESS_ROOTLESSKIT_NET=pasta` with `DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=implicit`
  (with RootlessKit 3.0 or newer, the default `builtin` driver with `"userland-proxy": false` also
  works). See the rootless mode troubleshooting page in Docker's documentation. For Swarm publish with `mode:
  host`. On Docker Desktop use a VPN rather than an allowlist.
- **Do not allow Docker's networks.** Never allow `172.16.0.0/12`, `192.168.0.0/16` or `10.0.0.0/8`
  whole: Docker's default pools lie inside them (Docker Desktop uses `192.168.65.0/24`). For IPv6
  never allow `fc00::/7` or `fd00::/8`; allow only your LAN's own /64. Allow only your own networks,
  such as `192.168.1.0/24` for a home network and `10.8.0.0/24` for a VPN (placeholders: use yours).
  Check that no entry overlaps a Docker network:

  ```bash
  docker network inspect $(docker network ls -q) -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{.Gateway}} {{end}}'
  ```
- **Check the client address after setup.** Set `accessLog.format: json` and read `ClientAddr` (the
  connection's own address and port). `ClientHost` shows `X-Forwarded-For` when that header is
  present. The address must be the device's public address, and the device must get `403`. Any
  address of your own (router, `127.0.0.1` or `::1`, Docker) means the allowlist is not seeing
  visitors. Test from a device outside your networks, such as a phone off your Wi-Fi.
- **Test IPv6 from the host's addresses, not from DNS.** On the host, run `ip -6 addr show scope
  global`. If it lists an address, test from outside even with no AAAA record:

  ```bash
  curl -6 -sI --resolve platehouse.example.com:443:[<host IPv6>] https://platehouse.example.com/
  ```

  Expect `403` or no connection.
- **Docker's userland proxy.** Where it applies, it can replace a visitor's address with the bridge
  gateway's: for IPv6 visitors when the proxy's Docker network has no IPv6, and for connections from
  the host itself. Set `"userland-proxy": false` in `/etc/docker/daemon.json` (rootless Docker: `~/.config/docker/daemon.json`). Real IPv6 addresses
  need Docker Engine 27 or newer, where `ip6tables` is on by default; upgrade an older engine first.
  Restart Docker, then recreate the proxy container (`docker compose up -d --force-recreate`, then
  the proxy's service name). The example Compose file's `proxy` network is IPv4 only. `enable_ipv6:
  true` applies only to networks Compose creates; the example's `proxy` network is external, so use
  `docker network create --ipv6 proxy` and reconnect the containers. A refused IPv6 connection after
  `"userland-proxy": false` without that step is expected and safe; it is not a reason to undo the
  change.

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
- **`readTimeout: 75m`.** Traefik v3 limits reading the whole request, body included, to 60
  seconds by default. A large upload on an ordinary connection takes longer. This is a cap on the
  whole request, not on a pause, so it is set above the app's own limit: about 72 minutes, a whole
  512 MiB upload at 1 Mbit/s. With `1h`, such a slow upload would be cut off before the app's
  limit.
- **`sanitizePath` and `allowEncodedSlash`** are both set explicitly in this configuration, so it
  does not depend on Traefik's own defaults (check Traefik's documentation for your version before
  leaving either out). Path cleaning stays on, and an encoded slash in an API path reaches the app.
  If you have set `allowEncodedSlash: false` on the entrypoint, tags and collections with a `/` in
  their name cannot be changed through the API.
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
      # Optional: leave platehouse-allowlist out if you use no allowlist.
      middlewares: [platehouse-allowlist, platehouse-headers]
      service: platehouse
  middlewares:
    platehouse-allowlist:
      ipAllowList:
        sourceRange: ["192.168.1.0/24", "10.8.0.0/24"]
    platehouse-headers:
      headers:
        stsSeconds: 31536000 # HSTS only; the app sends the other headers
  services:
    platehouse:
      loadBalancer:
        servers:
          - url: http://platehouse:3000
```
