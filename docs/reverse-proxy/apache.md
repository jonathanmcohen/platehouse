---
description: An example Apache httpd site for Platehouse, and why each setting is there.
mdx:
  format: mdx
---

import AllowlistWarning from "./_allowlist-warning.md";

# Apache httpd

Written against Apache httpd 2.4. It has not been run against a real Platehouse deployment, so
treat it as an example to adapt and run the [checklist](./checklist.md) after.

You need these modules: `ssl`, `proxy`, `proxy_http`, `headers` and `setenvif`. On Debian and
Ubuntu:

```bash
sudo a2enmod ssl proxy proxy_http headers setenvif
```

Then add a site, such as `/etc/apache2/sites-available/platehouse.conf`. Change the host name, the
certificate paths and the upstream address to yours. Apache usually runs on the host, so the
example uses `127.0.0.1:3000`, the port the example Compose file can publish on the loopback
address.

```apacheconf
# Platehouse behind Apache httpd. An example to adapt.

<VirtualHost *:80>
    ServerName platehouse.example.com
    Redirect permanent / https://platehouse.example.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName platehouse.example.com

    SSLEngine on
    SSLCertificateFile    /etc/ssl/platehouse/fullchain.pem
    SSLCertificateKeyFile /etc/ssl/platehouse/privkey.pem
    SSLProtocol           -all +TLSv1.2 +TLSv1.3

    # HSTS. Platehouse sends its own Content-Security-Policy, Referrer-Policy
    # and X-Content-Type-Options; do not set those here.
    Header always set Strict-Transport-Security "max-age=31536000"

    # Keep an encoded slash (%2F) encoded and pass it on as sent. Needs
    # "nocanon" on ProxyPass below. Set it here: it is not inherited from
    # the main server configuration.
    AllowEncodedSlashes NoDecode

    # Uploads of up to 512 MiB (600 MiB here), with time for slow links.
    LimitRequestBody 629145600
    Timeout          3600
    ProxyTimeout     3600

    # No compression on the streamed paths.
    SetEnvIf Request_URI "^/(s|files|blobs|api/v1/files)/" no-gzip=1 no-brotli=1

    # Optional: allow only your own networks. Uncomment and change the ranges.
    # <Location "/">
    #     Require ip 192.168.1.0/24 10.8.0.0/24
    # </Location>

    ProxyRequests     Off
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"

    ProxyPass        "/" "http://127.0.0.1:3000/" nocanon flushpackets=on
    ProxyPassReverse "/" "http://127.0.0.1:3000/"
</VirtualHost>
```

Enable it and reload:

```bash
sudo a2ensite platehouse
sudo apachectl configtest && sudo systemctl reload apache2
```

:::warning The allowlist only works on the address Apache really sees

- **Check the client address after setup.** Add `%a` to your `LogFormat` (it is the address `Require
  ip` checks, after any `mod_remoteip`); the default `combined` format logs `%h`. Then read the `%a`
  of a request from outside. The address must be the device's public address, and the device must
  get `403`. Any address of your own (router, `127.0.0.1` or `::1`, Docker) means the allowlist is
  not seeing visitors. Test from a device outside your networks, such as a phone off your Wi-Fi.

<AllowlistWarning />

:::

## Why it looks like this

- **Only HSTS is set here.** Platehouse sends its own `Content-Security-Policy`, with
  `frame-ancestors 'none'`, and its own `Referrer-Policy` and `X-Content-Type-Options`, on every
  answer, and `mod_proxy` passes them through. If your site has a
  `Header always set Content-Security-Policy` line from an older version of this guide, remove
  it: Apache would send it beside the app's policy, or in place of it, and either way it can only
  narrow or replace the app's. The old `Referrer-Policy` line can go as well.
- **`AllowEncodedSlashes NoDecode` with `nocanon`.** By default Apache refuses any path with
  `%2F` in it with a 404. `NoDecode` lets it through without decoding it, and `nocanon` makes
  `mod_proxy` pass the path to the app exactly as it arrived. Both are needed for API paths with
  a tag or collection name that holds `/`.
- **`LimitRequestBody`** allows 600 MiB, above the 512 MiB upload limit. Apache 2.4.53 and newer
  default to 1 GiB, so this mostly documents the need.
- **Request bodies are passed through.** `mod_proxy_http` sends a body that arrives with a
  `Content-Length` header, as the web app's and `curl`'s uploads do, on to the app with that length.
  Apache spools a body to disk only in cases this setup avoids, such as a large chunked body that
  must be sent on with a `Content-Length`, or a body an input filter changes.
- **`Timeout` and `ProxyTimeout`** give large uploads and downloads an hour. Apache's
  `mod_reqtimeout`, if loaded, also requires a request body to keep arriving at 500 bytes per
  second by default, which any real upload does.
- **`flushpackets=on`** sends each chunk of a streamed download to the client as it arrives from
  the app, instead of collecting it first.
- **`no-gzip` and `no-brotli`** stop `mod_deflate` and `mod_brotli` from compressing the streamed
  paths, if either is enabled.
- **Forwarded headers.** `mod_proxy` adds `X-Forwarded-For` and `X-Forwarded-Host` itself, and the
  example sets `X-Forwarded-Proto`. `ProxyPreserveHost On` keeps the original host name. Platehouse
  uses these only in its log; every link comes from `PUBLIC_ORIGIN`.
- **The allowlist** uses `Require ip`, which matches the connection's own address unless you have
  set up `mod_remoteip`.
- **No authentication directives** (`AuthType`, `Require valid-user`, an OIDC module) in front of
  Platehouse: the API and slicer links must reach the app without a cookie.

Apache sends the app origin-form request targets and keeps its own path checks on, so nothing
else is needed for those.
