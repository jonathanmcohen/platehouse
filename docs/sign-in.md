# Sign-in

Platehouse has no passwords of its own. Every page and file needs a sign-in through an OpenID
Connect (OIDC) provider you run, and only members of one group get in. Any standard OIDC
provider works. [Pocket ID](https://pocket-id.org) is known to work; Authentik, Keycloak,
Authelia, Zitadel and similar providers offer the same pieces.

The API and slicer links do not use sign-in: the API takes tokens, and a slicer link carries its
own short-lived key. See [Security](./security.md).

## What Platehouse asks of the provider

- **Flow:** authorization code with PKCE (S256), plus a state and a nonce.
- **Scopes:** `openid email profile groups`.
- **Client authentication:** a client secret sent with HTTP Basic (`client_secret_basic`).
- **Claims:** a subject, `email_verified` set to true (the string `"true"` is accepted too), and a
  `groups` claim that holds the group in `OIDC_GROUP`. Platehouse reads these from the ID token,
  and from the userinfo endpoint when the ID token leaves them out.
- **Discovery:** the provider must publish `/.well-known/openid-configuration` under its issuer
  URL.

## Set up the client

At your provider:

1. Create a confidential client (one with a secret) for Platehouse.
2. Set its **redirect URL** (also called callback URL) to your `PUBLIC_ORIGIN` followed by
   `/auth/callback`, exactly:

   ```text
   https://platehouse.example.com/auth/callback
   ```

   Platehouse builds this URL from `PUBLIC_ORIGIN` and never from the request, so it must match
   character for character: scheme, host, no trailing slash.
3. Allow the scopes `openid`, `email`, `profile` and `groups`. Some providers need the groups
   claim turned on, or mapped into the ID token or userinfo, before it is sent.
4. Create a group, `platehouse` by default, and add the people who may use Platehouse.
5. Copy the client ID and secret into `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, and the issuer
   URL into `OIDC_ISSUER`.

With Pocket ID, for example, the issuer is the address of your Pocket ID instance, the client is
an OIDC client with the callback URL above, and the group is a user group whose name you put in
`OIDC_GROUP`.

The app must be able to reach the provider over https from inside its container, for discovery
and for the token exchange.

## The allowed group

Only a user whose `groups` claim holds `OIDC_GROUP` exactly gets in. Everyone else sees a plain
page saying why they were refused. To let someone in, add them to the group at your provider;
to take access away, remove them. Removing someone stops their next sign-in, but a Platehouse
session they already have lasts until it expires (7 days without use, 30 days at most) or they
sign out. Platehouse 0.1.0 has no button to end another person's session.

Removing someone does not touch API tokens. A token belongs to the library, not to the person who
made it, never expires and is not checked against the group, so a token they made or used keeps
reading, uploading and tagging after they are removed. While their session lasts they can also
make new tokens in **Settings**. To cut someone off completely:

1. Remove them from the group at your provider.
2. End their sessions: in Platehouse's database, delete their rows from the `sessions` table with
   `delete from sessions where subject = '<their user id>';`, where the user id is the `sub` your
   provider gives them. Do this before step 3, or they can make a new token in the meantime.
3. In **Settings**, revoke every API token they made or had a copy of, and any token you cannot
   account for.

Platehouse 0.1.0 does not record who made a token or end someone's sessions for you; that is
planned ([#322](https://github.com/jonathanmcohen/platehouse/issues/322)).

Everyone who signs in sees and changes the same library. There are no roles.

## Sessions

- A session lasts 7 days without use and 30 days at most.
- The session cookie is `__Host-ph_session`: Secure, HttpOnly and SameSite=Lax. Platehouse stores
  only a hash of it.
- Sign out from the app. Signing out needs a request from the Platehouse page itself, so another
  site cannot sign you out.

## When the provider is down

Platehouse starts and keeps running while the provider is unreachable. People who are already
signed in keep working. A new sign-in shows "Login is unavailable right now" until the provider
answers again. API tokens keep working throughout.

If sign-in fails, see [Troubleshooting](./troubleshooting.md#sign-in).
