---
description: How the Open in Bambu Studio and Open in OrcaSlicer buttons and their short-lived links work.
---

# Opening in a slicer

Every `.3mf` on a model page has two buttons: **Open in Bambu Studio** and **Open in OrcaSlicer**.
On a computer with that slicer installed, pressing one opens the file in it.

## What happens

1. Platehouse makes a slicer link for that one file. The link is an https address on your
   `PUBLIC_ORIGIN`, with no query string, ending in the file's name and extension, for example
   `https://platehouse.example.com/s/<key>/Benchy.3mf`.
2. The browser opens it in the slicer, through `orcaslicer://open?file=...` or Bambu Studio's
   equivalent.
3. The slicer downloads the file from the link and opens it.

The link works without signing in, because slicers send no cookies. Instead the link carries its
own key, which:

- opens that one file and nothing else;
- stops working after 10 minutes;
- stops working if any part of it is changed, or if the file is moved to the trash.

An expired, altered or unknown link gets an empty "403 Forbidden" and no bytes.

## Bambu Studio's warning

Bambu Studio trusts only MakerWorld's own download addresses. For a file from anywhere else,
Platehouse included, it asks "This file is not from a trusted site, do you want to open it
anyway?" That is expected; the model page says so too.

## File names in links

In the link's last part, characters that a proxy or a slicer could misread (`/ \ % ? # ;`,
control characters and invisible formatting characters) are replaced with `_`. The file the slicer
receives still carries its real name in the download headers.

## Your slicer's computer must reach Platehouse

The slicer downloads the file itself, so the computer running it must reach your
`PUBLIC_ORIGIN` over https and trust its certificate, just as the browser does.

## Slicer links and logs

A link is a working key for 10 minutes. Platehouse's own log never records it (it logs
`/s/[link]/[name]`), but your reverse proxy's access log will, so treat that log as sensitive for
10 minutes. See [Security](../security.md#slicer-links).
