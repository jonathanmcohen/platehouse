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

## Slicer links

A slicer link opens one file for 10 minutes without a sign-in, because slicers send no cookies.
Its key is signed with a key derived from `LINK_SECRET`, so it cannot be forged or changed, and it
is checked before anything is looked up. A link to a file in the trash stops working.

Anyone who has a live link can download that one file until it expires. Platehouse's own log never
records links, but your reverse proxy's access log does, so limit who can read that log. The proxy
should also send `Referrer-Policy: no-referrer`, so a link never leaks in a Referer header.

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
  has a time cap, and the slicer kills a job that runs over, including any processes it started.
- **OpenSCAD is boxed in further.** OpenSCAD runs under a Linux Landlock sandbox that lets it write
  only to its own job folder and run only its own programs, with limits on CPU time, memory, file
  size and processes. Before the first render the slicer checks that the sandbox really blocks a
  read outside the job folder, and refuses to render until that check passes. It needs Linux 6.12
  or newer (Landlock ABI 6).

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
  is why that is acceptable. To get the fixes, pull your slicer image tag again when you update
  Platehouse.
- OpenSCAD can still read the system libraries, fonts and programs it needs to run; the sandbox
  keeps it away from your data, not from the operating system files inside its own container.
- Some limits are documented in the code as known: for example, the sandbox does not block UDP.
  The network isolation is what keeps the slicer from reaching anything with it.
- The app itself also reads untrusted files: it unpacks each `.3mf` to read its plates and
  thumbnails. That runs inside the app container, with size and count limits on everything it
  reads, and with the app's own CPU and memory limits from the example Compose file.

Keep the slicer settings from the example Compose file: the internal network, `read_only`, the
`/work` tmpfs with `noexec`, `cap_drop: ALL`, `no-new-privileges`, its own user and the limits.

## Secrets

- Keep `.env` readable only by you, out of version control and out of backups you share.
- The app's errors name a bad setting but never print its value.
- The bucket key stays on the server. Every download is streamed through the app, so no bucket
  address, key or signed URL reaches a browser or a slicer.
- If a secret may have leaked, change it: a new bucket key, a new OIDC client secret, a new
  `LINK_SECRET`, or revoke the API token.
