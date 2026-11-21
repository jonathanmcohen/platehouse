# Platehouse

Platehouse is a self-hosted library for 3D print files. You run it on your own server with
Docker, sign in through your own identity provider, and keep the files in an S3-compatible
bucket you control.

It is built around Bambu Studio and OrcaSlicer project files (`.3mf`), and it also takes STL,
STEP and OpenSCAD files.

## What it does

- **Shows plates up front.** For every `.3mf`, Platehouse lists each plate with its thumbnail,
  name, filaments (type, colour and grams), print time and weight.
- **Estimates every plate.** When a file carries Bambu's own slice numbers, Platehouse shows
  them, labelled with the printer they were sliced for. When it does not, or when they were made
  for another printer, Platehouse slices the plate in the background with OrcaSlicer for each
  printer in **My printers** in Settings, and shows that estimate beside them.
- **Opens a file in your slicer.** Every `.3mf` has Open in Bambu Studio and Open in OrcaSlicer
  buttons. They work through a short-lived link, so the slicer needs no login.
- **Keeps the files in object storage.** Model files, thumbnails and renders live in an
  S3-compatible bucket. The server's disk holds only the database, an inbox folder and
  temporary files.
- **Takes files in three ways:** drag and drop in the browser, an inbox folder it watches, or
  its token API.
- **Organises the library** with tags, collections, creators, search, sorting and a trash with a
  30-day purge. Select mode tags, collects or trashes many models at once.
- **Speaks your language**: English, Spanish and French built in, and any other language you add
  to your server. See [Translations](./translations/index.md).
- **Shows STL, STEP and OpenSCAD files** in a 3D viewer. An OpenSCAD file is rendered to an STL
  and a preview image for you.
- **Works on a phone.** Every page works from 375 pixels wide, in dark, light or system theme.

## What it is not

- It is for one person, or one household sharing one library. There are no user accounts
  inside Platehouse: everyone who can sign in sees and changes the same library.
- It does not talk to printers: no sending jobs, no monitoring, no AMS mapping.
- It does not keep G-code. A slice is used for its numbers and then thrown away.
- It is not meant to face the open internet. Run it on your own network, or behind a VPN, and
  see [Security](./security.md).

## How it fits together

Platehouse runs as three containers:

| Container           | What it does                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `platehouse`        | The web app and its API, the background jobs and the inbox watcher.                                                              |
| `platehouse-slicer` | OrcaSlicer, OpenSCAD and a STEP converter. It opens untrusted files, so it runs locked down with no internet and no credentials. |
| `platehouse-db`     | Postgres 17, which holds everything except the file bytes.                                                                       |

A reverse proxy you already run (nginx, Caddy, Traefik, Apache or another) sits in front of the
app and handles TLS. Sign-in goes to an OpenID Connect provider you already run, such as Pocket
ID, Authentik, Keycloak or Authelia.

## Where to start

1. [Install](./install.md) Platehouse with Docker Compose.
2. Set the [configuration](./configuration.md) values.
3. Set up [sign-in](./sign-in.md) and the [storage](./storage.md) bucket.
4. Put it behind your [reverse proxy](./reverse-proxy/index.md).
5. Read [Using Platehouse](./using/index.md).
