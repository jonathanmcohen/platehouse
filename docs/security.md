# Security

Platehouse is built for your own network, for one person or a household. This page explains what
protects it and where the limits are.

## Keep it off the open internet

Run Platehouse on your home or office network, or reach it over a VPN. Sign-in protects every page,
but the fewer people who can reach the login page, the API and slicer links at all, the better.

### The IP allowlist idea

If your reverse proxy can be reached from outside your network, add an allowlist at the proxy so
only your own address ranges get through, for example your LAN and your VPN's range. Every
[reverse proxy guide](./reverse-proxy/index.md) has an optional allowlist block. Two rules:

- Match the connection's own address, not a header such as `X-Forwarded-For`, which a client can
  set to anything.
- Put the allowlist on the whole site. The API and slicer links do not use sign-in, so they rely
  on it most.

An allowlist is only as good as the address your proxy sees for each visitor, so check it after
setup:

- Open the site from a device outside your allowlisted networks, such as a phone off your Wi-Fi,
  and look at the client address the proxy logs for that request. It must be the visitor's real
  address, IPv6 included, not a Docker address. The device should get `403`.
- When the proxy runs in Docker, never allow Docker's bridge subnets (`172.16.0.0/12` and the like).
  Docker can rewrite a visitor's address to a bridge address, so allowing those ranges lets
  everyone in. Allow only your own networks, for example `192.168.1.0/24` for the LAN and
  `10.8.0.0/24` for the VPN (placeholders: use yours).
- Where Docker's userland proxy applies, it can replace a visitor's address with the bridge
  gateway's, most often for IPv6. Set `"userland-proxy": false` in `/etc/docker/daemon.json`, turn
  on Docker's IPv6 support (`"ipv6": true` and `"ip6tables": true`), restart Docker and check
  again. The [proxy checklist](./reverse-proxy/checklist.md#7-the-proxy-sees-each-visitors-real-address)
  has the same check.

## Sign-in

Every page and file download needs a sign-in through your OIDC provider, limited to one group.
See [Sign-in](./sign-in.md). Every request that changes something must come from the Platehouse
page itself (its `Origin` must equal `PUBLIC_ORIGIN`), so another site cannot make your browser
change your library.

## API tokens

Each API client, such as a script or another tool on one computer, gets its own token.

- Create tokens in **Settings**. A token starts with `ph_` and is shown once, when it is made. Copy
  it then; Platehouse cannot show it again.
- Creating a token needs a sign-in from the last 5 minutes. Platehouse checks the group only at
  sign-in, so this is what stops someone removed from the group from making a token with a
  session they already had. If your sign-in is older, Settings asks you to sign in again; while
  your provider is down, no token can be made.
- A sign-in that Platehouse refuses because the person is no longer let in (the provider let them
  sign in, but they are not in the group, their email is not verified, or their user id is over
  255 characters) also ends the session the browser already had and clears its cookie, so a
  removed person who tries to sign in again is signed out of that browser at once. It ends only
  that browser's session; **Sign out everywhere** ends the rest. A refusal at the provider ends
  nothing: when the client is limited to the group at the provider, or the account is disabled
  there, the provider refuses the person before Platehouse sees a sign-in. A sign-in that fails
  because your provider is down, or whose answer from the provider does not check out, ends
  nothing either.
- Platehouse stores only a SHA-256 hash of each token and its first 8 characters, so you can tell
  tokens apart. A stolen database does not give working tokens.
- Each token records who made it: the user id (`sub`) your provider gave them and their name at
  the time, shown in **Settings**. Tokens made with Platehouse 0.1.0 show "Made by an unknown
  user".
- Revoke a token in **Settings** when a client no longer needs it, if it may have leaked, or when
  someone who made or used it is removed from the group: removing a person does not revoke their
  tokens. Revoking one leaves the others working. Each token shows when it was last used.
- **Sign out everywhere** in **Settings** ends every session of one person and can revoke every
  token they made in the same step. See [Sign-in](./sign-in.md#the-allowed-group) for how to cut
  someone off completely.
- A token is sent as `Authorization: Bearer <token>`. Cookies never count for the API, and tokens
  never appear in the app's log.
- A token can read the library, upload files and change tags and collections. It cannot delete,
  trash or purge anything, and it cannot see trashed models.
- Tokens keep working while your sign-in provider is down.
- The API sends no CORS headers, so a web page on another site cannot call it from a browser.

Treat a token like a password: keep it in a password manager or your tool's secret store, not in a
script you share.

## Rate limits

Platehouse limits two acts in Settings per session, that is per sign-in on one browser:

- making an API token, at most 10 in any 10 minutes;
- **Sign out everywhere**, at most 10 times in any 10 minutes, whoever it signs out.

The next one is refused with `429` and a `Retry-After` header that says how many seconds to wait.
A request that is refused first for another reason, such as a sign-in older than 5 minutes, is not
counted. Each limit is counted on its own, and a new sign-in starts a new count. The counts are
kept in the server's memory, so a restart clears them.

Platehouse does not limit requests per client address. If your sign-in pages can be reached by
people outside your household, limit them at your reverse proxy: everything under `/auth/` (the
login, the provider's return to Platehouse, and sign out). A sign-in takes two requests there, so
10 per minute per address leaves plenty of room. Leave the rest of the site, and above all the API
and slicer links, out of this limit.

With nginx, define the zone in the `http` block and add a location for `/auth/` beside the others
in the [nginx guide](./reverse-proxy/nginx.md):

```nginx
# In the http block: 10 requests per minute per client address.
limit_req_zone $binary_remote_addr zone=platehouse_auth:10m rate=10r/m;

# In the server block, beside location /:
location /auth/ {
    limit_req zone=platehouse_auth burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://platehouse;
}
```

With Traefik, add a second router for the `/auth/` path prefix with a `ratelimit` middleware,
next to the router in the [Traefik guide](./reverse-proxy/traefik.md). Its rule is longer, so
Traefik picks it over the main router for those paths. A router runs only its own middlewares, so
this chain repeats the main router's IP allowlist first; without it, `/auth/` would be outside the
allowlist. If you do not use the allowlist, take `platehouse-allowlist,` out of the chain:

```yaml
traefik.http.routers.platehouse-auth.rule: Host(`platehouse.example.com`) && PathPrefix(`/auth/`)
traefik.http.routers.platehouse-auth.entrypoints: websecure
traefik.http.routers.platehouse-auth.tls: "true"
traefik.http.routers.platehouse-auth.tls.certresolver: letsencrypt
traefik.http.routers.platehouse-auth.middlewares: platehouse-allowlist,platehouse-auth-limit,platehouse-headers
traefik.http.routers.platehouse-auth.service: platehouse
traefik.http.middlewares.platehouse-auth-limit.ratelimit.average: "10"
traefik.http.middlewares.platehouse-auth-limit.ratelimit.period: 1m
traefik.http.middlewares.platehouse-auth-limit.ratelimit.burst: "10"
```

Both examples count the connection's own address, which is the visitor's when nothing sits in
front of your proxy.

A per-address limit counts each IPv6 address on its own, and one home or office network usually
has a whole /64 block of IPv6 addresses, so one visitor can count as many. If your proxy supports
it, key the limit on the /64 instead. With Traefik, add this label to the ones above:

```yaml
traefik.http.middlewares.platehouse-auth-limit.ratelimit.sourceCriterion.ipStrategy.ipv6Subnet: "64"
```

nginx has no simple setting for this, so if your sign-in pages can be reached over IPv6, the
allowlist is the stronger guard there.

If another device, such as a load balancer or a tunnel, sits in front of your proxy, every
connection comes from that one device, so every visitor shares one limit (and one allowlist
entry). How to fix that depends on what kind of device it is:

- **An HTTP proxy that adds `X-Forwarded-For` itself.** Trust that header only on connections
  from the front proxy's own address, never from anyone else: from anyone else, it says whatever
  the client put in it. Do this only if you know the front proxy adds the visitor's address to the
  header on every request. With nginx, use the `realip` module: `set_real_ip_from` with the front
  proxy's address only, and `real_ip_header X-Forwarded-For`. With Traefik, list only the front
  proxy's address in the entrypoint's `forwardedHeaders.trustedIPs` (Traefik drops forwarded
  headers from any other address), then give the rate limit's `sourceCriterion.ipStrategy` and
  the allowlist's `ipStrategy` a `depth` of `1`, so they use the address the front proxy saw.
- **A TCP (layer 4) load balancer or tunnel.** It passes each request on unchanged, so an
  `X-Forwarded-For` header arriving through it is the client's own, and a client can claim any
  address in it, an address inside your allowlist included. Never trust the header behind such a
  device. Turn on the PROXY protocol on the device instead, which sends the visitor's address
  ahead of each connection, and accept it only from the device's address. With nginx, add
  `proxy_protocol` to the `listen` line, with `set_real_ip_from` set to the device's address and
  `real_ip_header proxy_protocol`. With Traefik, list only the device's address in the
  entrypoint's `proxyProtocol.trustedIPs`, and leave `ipStrategy.depth` and `excludedIPs` unset
  (`ipv6Subnet` may still be set), so the rate limit and the allowlist match the address the PROXY
  protocol gave.

Then check that visitors' own addresses are seen:

1. From one device, open `/auth/login` again and again until the proxy answers `429`. With the
   examples above that happens after about 10 requests in a minute.
2. Within the same minute, open it from a second device with a different address, as your proxy
   sees it, on a network the allowlist lets in, such as another device on your VPN. It should get
   through. If it gets `429` too, the proxy sees the front device's address for everyone, and all
   your visitors share one limit.
3. If you use the allowlist, open it from a device on a network outside it, such as a phone off
   your Wi-Fi. It should get `403` from the allowlist, which also shows the phone's own address was
   seen. If it gets through, or gets `429`, the allowlist is not matching visitors' own addresses.
   Without the allowlist, the phone should simply get through.
4. Check that a client cannot choose the address your proxy sees. Repeat steps 1 and 3 with an
   `X-Forwarded-For` header naming another address, such as one inside your allowlist in place of
   `192.0.2.10` here:

   ```sh
   curl -sI -H 'X-Forwarded-For: 192.0.2.10' https://platehouse.example.com/auth/login
   ```

   The header must change nothing: the device that got `429` in step 1 still gets `429` within the
   same minute, and the device outside the allowlist still gets `403`. If the header changes the
   answer, your proxy trusts `X-Forwarded-For` from anyone; trust it only from the front proxy's
   own address, as above.

## Slicer links

A slicer link opens one file for 10 minutes without a sign-in, because slicers send no cookies.
Its key is signed with a key derived from `LINK_SECRET`, so it cannot be forged or changed, and it
is checked before anything is looked up. A link to a file in the trash stops working.

Anyone who has a live link can download that one file until it expires. Platehouse's own log never
records links, but your reverse proxy's access log does, so limit who can read that log. Platehouse
sends `Referrer-Policy: no-referrer` on every answer, so a link never leaks in a Referer header.

## Browser cache

Source files, 3D meshes and STL previews are checked with Platehouse on each view: the browser
asks first, so a signed-out browser or a model in the trash is never served from its copy, and an
unchanged file is answered with a short `304 Not Modified`, not downloaded again. A browser may
still keep a copy on disk. Thumbnails and PNG previews are kept longer, because they never change.

Signing out asks the browser to clear its cache for Platehouse, including copies saved by earlier
versions, and browsers that support this do so. Not all do: Safari does not. Nothing is cleared
when a session expires, when you are signed out from another device, or when Platehouse is
served over plain HTTP. On a shared computer, sign out, then clear the browser's data for this
site yourself after use.

## Inbox folder

Anyone who can write to the inbox folder can:

- add files to the library without signing in;
- remove, rename or replace files other people put in the inbox or in `inbox/failed/`;
- read the reasons in `inbox/failed/`, which name the model that already holds a duplicate, so
  they tell whether a file is in the library;
- write reason text of their own, which the [Activity](./using/activity.md) page shows.

So share the folder only with people who could be members of your Platehouse. Share the inbox
folder itself, not a folder above it, and where your NAS or host allows it, mount the share with
`nodev`. Give the inbox its own mount or volume, with nothing else Platehouse writes on it (the
example Compose file's separate bind mount does this): someone who can swap folders in the inbox
can otherwise point some of Platehouse's moves at other folders on the same mount.

Platehouse treats what is in the folder as untrusted:

- It does not open a file in it through a symbolic link, and does not wait on a special file put
  there.
- It moves a file whose name holds a control character, such as a line break, to `failed/`.
- It still lists the whole folder at every pass, but looks at no more than 10,000 files in one
  pass, taking them in turn. It sweeps a holding folder (any folder named like the ones it makes)
  only when the folder was there when it started, including one someone else made, or it made
  the folder itself, and sweeps no more than 10,000 such folders and files in them in one pass.
- Before each step of that sweep, it checks that the holding folder is still the one it listed,
  and after each move into `failed/`, that the file moved is the one it listed. When the folder
  has changed it stops sweeping it; when the file moved is another, it moves that file back where
  it can, then stops. These checks narrow the gap but cannot fully prevent a swap made between a
  check and the move on a shared mount, which is why the inbox should have its own.
- The Activity page lists `inbox/failed/` by name, looks at no more than 10,000 of its entries, and
  shows a reason file only when it is an ordinary file with no other name (no symbolic or hard
  link), the same file it found when it listed the folder.

## The slicer sandbox

Platehouse slices, renders and converts files that came from the internet, and a crafted file could
try to exploit OrcaSlicer, OpenSCAD or the STEP converter. So those programs run in their own
container, the slicer, which is locked down.

**What it does:**

- **No internet.** The slicer sits on an internal Docker network shared only with the app, so it
  cannot open connections to the internet. You can confirm it: from the slicer,
  `docker exec platehouse-slicer getent hosts example.com` should fail, and so should a connection
  to an outside address. Depending on your Docker and firewall setup, an internal network may still
  reach ports the host itself listens on through the network's gateway address, so check that too
  and do not leave services on the host that trust any caller. To close that path, do one of these:
  - add a firewall rule on the host that drops traffic from the slicer network's subnet to the
    host's own addresses, or
  - create the slicer network with the bridge option `com.docker.network.bridge.inhibit_ipv4`,
    so the host has no address on it. Check your Docker version's bridge driver documentation for
    the option first. If you followed the install guide, the network already exists, so replace
    it, in the folder with your compose file:
    `docker compose down`, then `docker network rm platehouse-slicer`, then
    `docker network create --internal -o com.docker.network.bridge.inhibit_ipv4=true platehouse-slicer`,
    then `docker compose up -d`.
- **No credentials.** It holds no database password, bucket key, token or other secret. The app
  sends it a file and gets numbers or a render back.
- **Little it can change.** It runs as its own unprivileged user with every Linux capability
  dropped, a read-only system, and only an in-memory `/work` folder that it cannot run programs
  from. Each job's folder is deleted afterwards.
- **Limits.** It has a CPU and memory limit, a process limit, and runs one job at a time. Each plate
  has a time cap, and the slicer kills a job that runs over. After each job it also cleans up
  processes the job left behind, and it stops a job's programs at once when its client goes away.
  That clean-up runs only when the slicer image's own entrypoint is PID 1, so do not add an init
  in front of it (`init: true` in Compose, `--init` with `docker run`); the slicer logs at
  start-up when the clean-up is off.
- **Each program is boxed in further.** OpenSCAD, OrcaSlicer and the STEP converter each run under
  a Linux Landlock sandbox that lets them write only to their own job folder, so none can read or
  change another job's files, and that refuses them any TCP connection. The sandbox does not block
  UDP; the slicer's internal network is what keeps that from reaching anything (see below). Each
  may run its own programs and the system library helpers, and read only what it needs:
  - OpenSCAD reads fonts and the graphics and language settings it renders with.
  - OrcaSlicer reads its own files, the printer and filament profiles, and fonts.
  - The STEP converter reads the slicer's own code, which holds the converter.

  Each also runs with limits on CPU time, file size and processes, and OpenSCAD on memory too. The
  slicer reads a program's results only when each is an ordinary file of a limited size, never
  through a link. OrcaSlicer works in its own folder inside the job folder, and the slicer keeps
  the files it writes itself, such as the slice's time and memory report, in the job folder above
  it, out of OrcaSlicer's reach.
- **The sandbox is checked first.** At start-up the slicer checks that the sandbox really blocks a
  read outside the job folder, and runs no render, slice or STEP conversion until that check
  passes. It needs Linux 6.12 or newer (Landlock ABI 6). On an older kernel, or while the check
  fails, renders and STL pictures are off. Slices and STEP conversions are off too, unless
  `SLICER_ALLOW_UNSANDBOXED` is set on the slicer: then they run without the sandbox, with only
  the limits above and the container's own isolation. Without the sandbox, a slice or STEP
  conversion can also read and change other files the slicer's user can reach, including
  leftovers of earlier jobs, reach the app over the internal network and send signals to the
  slicer's own processes. A program that keeps running after its job can also read or change later
  jobs' files, other members' files included.

**What it does not do:**

- It does not make the slicer programs bug-free. A crafted file could still crash a slice, or
  produce wrong numbers for that plate.
- It is a container, not a virtual machine. It shares the host's kernel, so a kernel bug could
  still be used to escape it. Keep your host's kernel and Docker up to date.
- It does not get Ubuntu's security fixes the day they ship. The slicer image installs its Ubuntu
  packages from a fixed snapshot of the Ubuntu archive, so each build is repeatable. Once a month a
  workflow moves that snapshot forward in a pull request, and the published image gets the newer
  packages with its next build after that change is merged: a Platehouse release, a new OrcaSlicer
  version, or a build run by hand. The image builds scan for known high and critical problems with
  a fix available and report them without failing the build; the slicer's lack of internet access
  is why that is acceptable. A deployment pinned to a version tag gets the fixes with the next
  Platehouse release's version tag, so update Platehouse to get them: pulling the same version tag
  again gets nothing new.
- A new OrcaSlicer version that the slicer image workflow builds, other than the one the Dockerfile
  pins, takes its AppImage hash and profile commit from upstream as found, without a human review.
- Each program can still read the system libraries, fonts and programs it needs to run; the
  sandbox keeps it away from your data and other jobs' files, not from the operating system files
  inside its own container.
- Some limits are documented in the code as known: for example, the sandbox does not block UDP.
  The network isolation is what keeps the slicer from reaching anything with it.
- The app itself also reads untrusted files: it unpacks each `.3mf` to read its plates and
  thumbnails. That runs inside the app container, with size and count limits on everything it
  reads, and with the app's own CPU and memory limits from the example Compose file.

Keep the slicer settings from the example Compose file: the internal network, `read_only`, the
`/work` tmpfs with `noexec`, `cap_drop: ALL`, `no-new-privileges`, its own user and the limits.
`noexec` on `/work` is defence in depth, not a wall: a script there can still run through `bash` or
`node`, so the sandbox and the other settings are what hold.

## Secrets

- Keep `.env` readable only by you, out of version control and out of backups you share.
- The app's errors name a bad setting but never print its value.
- The bucket key stays on the server. Every download is streamed through the app, so no bucket
  address, key or signed URL reaches a browser or a slicer.
- If a secret may have leaked, change it: a new bucket key, a new OIDC client secret, a new
  `LINK_SECRET`, or revoke the API token.
