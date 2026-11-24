# nginx

Written against nginx 1.30, the stable line. It has not been run against a real Platehouse
deployment, so treat it as an example to adapt and run the [checklist](./checklist.md) after.

Put this in its own file, such as `/etc/nginx/conf.d/platehouse.conf`. Change the host name, the
certificate paths and the upstream address to yours. Use `platehouse:3000` when nginx runs in a
container on the same Docker network as the app, or `127.0.0.1:3000` when nginx runs on the host
and the app publishes its port there.

```nginx
# Platehouse behind nginx. An example to adapt.

upstream platehouse {
    server platehouse:3000;
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name platehouse.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name platehouse.example.com;

    ssl_certificate     /etc/nginx/certs/platehouse.example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/platehouse.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # HSTS. Platehouse sends its own Content-Security-Policy, Referrer-Policy
    # and X-Content-Type-Options; do not add those here.
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Uploads of up to 512 MiB, passed straight through, with time for slow links.
    client_max_body_size    600m;
    client_body_timeout     3600s;
    proxy_request_buffering off;
    proxy_read_timeout      3600s;
    proxy_send_timeout      3600s;
    send_timeout            3600s;

    # Optional: allow only your own networks. Uncomment and change the ranges.
    # allow 192.168.1.0/24;
    # allow 10.8.0.0/24;
    # deny  all;

    # Settings every location below shares.
    proxy_http_version 1.1;
    proxy_set_header Connection        "";
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

    # Streamed files: slicer links, downloads, thumbnails and API file
    # downloads. No response buffering and no compression.
    location ~ ^/(s|files|blobs|api/v1/files)/ {
        proxy_pass http://platehouse;
        proxy_buffering off;
        gzip off;
    }

    location / {
        proxy_pass http://platehouse;
    }
}
```

:::warning The allowlist only works on the address nginx really sees

- **Let the proxy see real addresses.** If the proxy runs in Docker and you use an allowlist, prefer
  `network_mode: host` (Docker Engine on Linux), or run it on the host. With host networking, point
  the proxy at the host upstream (`127.0.0.1:3000`, with the app's port published on loopback, as in
  the example Compose file), and make sure nothing else the proxy listens on, such as Traefik's
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
- **Check the client address after setup.** Read the first field of a request in nginx's access log
  (`$remote_addr` in the default format). The address must be the device's public address, and the
  device must get `403`. Any address of your own (router, `127.0.0.1` or `::1`, Docker) means the
  allowlist is not seeing visitors. Test from a device outside your networks, such as a phone off
  your Wi-Fi.
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

- **`proxy_pass http://platehouse;` has no path after the address.** With no path, nginx sends
  the request path to the app exactly as the client sent it, so an encoded slash (`%2F`) in an
  API path stays encoded. Adding a path, even a lone `/`, makes nginx decode and re-encode the
  path, which turns `%2F` into `/`.
- **`proxy_request_buffering off`** sends an upload to the app as it arrives, instead of writing
  it to disk first. `client_max_body_size 600m` leaves room above the 512 MiB limit.
- **`proxy_buffering off` and `gzip off`** on the streaming paths send downloads as they come
  from the bucket. Many distributions turn `gzip on` in `nginx.conf`; the location turns it off
  again for these paths.
- **`add_header ... always`** sets HSTS on error answers too. nginx only inherits `add_header`
  into a location that has none of its own, so if you add one inside a location, repeat the HSTS
  line there.
- **No `Content-Security-Policy` line.** Platehouse sends its own policy, with
  `frame-ancestors 'none'`, and its own `Referrer-Policy` and `X-Content-Type-Options`, on every
  answer, and nginx passes them through. If your configuration has an
  `add_header Content-Security-Policy` line from an older version of this guide, remove it:
  nginx would send it as a second policy, and a browser enforces both, so it can only narrow the
  app's. The old `Referrer-Policy` line can go as well.
- **The forwarded headers** are for the app's request log. Platehouse builds every link from
  `PUBLIC_ORIGIN`, not from these.
- **The allowlist** matches the client's own address. If something else sits in front of nginx,
  such as a load balancer, the address it sees is that device's, and you would need nginx's
  `realip` module set up to trust it.

nginx sends the app origin-form request targets and keeps its own path checks on, so nothing
else is needed for those.

## Certificates

nginx does not get certificates itself. Use a tool such as certbot or acme.sh, or a certificate
from your own CA for an internal name, and point `ssl_certificate` at it.

## If nginx runs in Docker

Put the nginx container on the same network as the app (`proxy` in the example Compose file), and
keep `server platehouse:3000;`. nginx resolves the name when it starts, so start the app first,
or reload nginx after the app is recreated with a new address.
