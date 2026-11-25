# Caddy

Written against Caddy 2.11. It has not been run against a real Platehouse deployment, so treat
it as an example to adapt and run the [checklist](./checklist.md) after.

Add this site block to your Caddyfile. Change the host name and the upstream address to yours.
Use `platehouse:3000` when Caddy runs in a container on the same Docker network as the app, or
`127.0.0.1:3000` when Caddy runs on the host and the app publishes its port there.

```caddy
# Platehouse behind Caddy. An example to adapt.

platehouse.example.com {
	# Optional: allow only your own networks. Uncomment and change the ranges.
	# @outside not remote_ip 192.168.1.0/24 10.8.0.0/24
	# respond @outside 403

	# HSTS. Platehouse sends its own Content-Security-Policy, Referrer-Policy
	# and X-Content-Type-Options; do not set those here.
	header Strict-Transport-Security "max-age=31536000"

	# Uploads of up to 512 MiB.
	request_body {
		max_size 600MB
	}

	# No "encode" directive here, so nothing is compressed.
	reverse_proxy platehouse:3000 {
		# Send every downloaded chunk on at once, for streamed files.
		flush_interval -1
	}
}
```

:::warning The allowlist only works on the address Caddy really sees

- **Let the proxy see real addresses.** If the proxy runs in Docker and you use an allowlist, prefer
  `network_mode: host` (Docker Engine on Linux), or run it on the host. With host networking, point
  the proxy at the host upstream (`127.0.0.1:3000`, with the app's port published on loopback only by
  uncommenting the `ports:` lines in the example Compose file), and make sure nothing else the proxy listens on, such as Traefik's
  dashboard on 8080, is exposed. If every visitor, LAN and outside, shows the same address (Docker's
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
- **Check the client address after setup.** Turn on Caddy's access log with a `log` directive in the
  site block and read the `remote_ip` of a request from outside. The address must be the device's
  public address, and the device must get `403`. Any address of your own (router, `127.0.0.1` or
  `::1`, Docker) means the allowlist is not seeing visitors. Test from a device outside your
  networks, such as a phone off your Wi-Fi.
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

- **Only HSTS is set here.** Platehouse sends its own `Content-Security-Policy`, with
  `frame-ancestors 'none'`, and its own `Referrer-Policy` and `X-Content-Type-Options`, on every
  answer, and `reverse_proxy` passes them through. If your site block sets
  `Content-Security-Policy` from an older version of this guide, remove that line: it would
  replace the app's policy, or be sent beside it and narrow it. The old `Referrer-Policy` line
  can go as well.
- **TLS is automatic.** Caddy gets and renews a certificate for the site name and redirects http
  to https. For an internal name with no public DNS, use `tls internal` or your own certificate
  with `tls /path/cert.pem /path/key.pem`.
- **No `encode`.** Caddy compresses only when you add `encode`. Leave it out, or if you want
  compression for the pages, exclude the streaming paths:

  ```caddy
  @compressible not path /s/* /files/* /blobs/* /api/v1/files/*
  encode @compressible gzip zstd
  ```

- **No buffering.** `reverse_proxy` streams request and response bodies by default; do not add
  `request_buffers` or `response_buffers`. `flush_interval -1` flushes each chunk of a download
  straight to the client.
- **Timeouts.** Caddy sets no read or write timeout on requests by default, so large uploads and
  downloads are not cut off. If your global options set `servers { timeouts { ... } }`, make
  `read_body` and `write` at least an hour.
- **Encoded slashes.** `reverse_proxy` passes the request path on as the client sent it, so
  `%2F` in an API path stays encoded. Check it with the [checklist](./checklist.md).
- **Forwarded headers.** Caddy sets `X-Forwarded-For`, `X-Forwarded-Proto` and
  `X-Forwarded-Host` itself. They are for the app's log; Platehouse builds every link from
  `PUBLIC_ORIGIN`.
- **The allowlist** uses `remote_ip`, the connection's own address, not a header. If something
  else sits in front of Caddy, set Caddy's `trusted_proxies` and use `client_ip` instead.
- **No `forward_auth`.** Do not put one in front of Platehouse; the API and slicer links must
  reach the app without a cookie.

Caddy sends the app origin-form request targets, so nothing else is needed for that.
