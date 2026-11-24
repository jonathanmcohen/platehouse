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

- **Do not allow Docker's networks.** When Caddy runs in Docker, never put Docker's bridge
  subnets (`172.16.0.0/12` and the like) in the allowlist. A visitor whose connection Docker has
  rewritten shows up from a bridge address, so allowing those ranges lets everyone in. The ranges
  in this guide, `192.168.1.0/24` for a home network and `10.8.0.0/24` for a VPN, are placeholders:
  use your own.
- **Check the client address after setup.** Turn on Caddy's access log with a `log` directive in the site block and look at the `remote_ip` of a request from outside. The address must be the visitor's real one,
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
