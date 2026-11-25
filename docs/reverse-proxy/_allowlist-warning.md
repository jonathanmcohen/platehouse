- **Let the proxy see real addresses.** If the proxy runs in Docker and you use an allowlist, prefer
  `network_mode: host` (Docker Engine on Linux), or run it on the host. With host networking, point
  the proxy at the host upstream (`127.0.0.1:3000`, with the app's port published on loopback only
  by uncommenting the `ports:` lines in the example Compose file), and make sure nothing else the
  proxy listens on, such as Traefik's dashboard on 8080, is exposed. If every visitor, LAN and
  outside, shows the same address (Docker's bridge pools, Swarm's overlay pools in `10.0.0.0/8`, and
  Docker Desktop's `192.168.65.0/24`), do not add that address to the allowlist; the allowlist
  cannot work on this setup. That is the case on Docker Desktop (macOS and Windows), with rootless
  Docker's builtin port driver before RootlessKit 3.0, with rootless Podman and with Swarm ingress.
  Run the proxy on the host, or with `network_mode: host`. For rootless Docker, set
  `DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns` and
  `DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns`, or
  `DOCKERD_ROOTLESS_ROOTLESSKIT_NET=pasta` with `DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=implicit`
  (with RootlessKit 3.0 or newer, the default `builtin` driver with `"userland-proxy": false` also
  works). See the rootless mode troubleshooting page in Docker's documentation. For Swarm publish
  with `mode: host`. On Docker Desktop use a VPN rather than an allowlist.
- **Do not allow Docker's networks.** Never allow `172.16.0.0/12`, `192.168.0.0/16` or `10.0.0.0/8`
  whole: Docker's default pools lie inside them (Docker Desktop uses `192.168.65.0/24`). For IPv6
  never allow `fc00::/7` or `fd00::/8`; allow only your LAN's own /64. Allow only your own networks,
  such as `192.168.1.0/24` for a home network and `10.8.0.0/24` for a VPN (placeholders: use yours).
  Check that no entry overlaps a Docker network:

  ```bash
  docker network inspect $(docker network ls -q) -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{.Gateway}} {{end}}'
  ```
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
