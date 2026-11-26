---
description: An example Caddy site block for Platehouse, and why each setting is there.
mdx:
  format: mdx
---

import AllowlistWarning from "./_allowlist-warning.md";

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
		max_size 600MiB
	}

	# No "encode" directive here, so nothing is compressed.
	reverse_proxy platehouse:3000 {
		# Send every downloaded chunk on at once, for streamed files.
		flush_interval -1
	}
}
```

:::warning The allowlist only works on the address Caddy really sees

- **Check the client address after setup.** Turn on Caddy's access log with a `log` directive in the
  site block and read the `remote_ip` of a request from outside. The address must be the device's
  public address, and the device must get `403`. Any address of your own (router, `127.0.0.1` or
  `::1`, Docker) means the allowlist is not seeing visitors. Test from a device outside your
  networks, such as a phone off your Wi-Fi.

<AllowlistWarning />

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
  `read_body` and `write` at least 75 minutes: each counts a whole request, and the app allows one
  request about 72 minutes.
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
