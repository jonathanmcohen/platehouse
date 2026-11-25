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
- **Claims:** a subject (`sub`) of at most 255 characters, the most OpenID Connect allows,
  `email_verified` set to true (the string `"true"` is accepted too), and a `groups` claim that
  holds the group in `OIDC_GROUP`. Platehouse reads these from the ID token, and from the
  userinfo endpoint when the ID token leaves them out. A longer subject is refused with a page
  that says so.
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
page saying they are not allowed to use this Platehouse; the page does not name the group. To let
someone in, add them to the group at your provider; to take access away, remove them. Platehouse
checks the group each time someone signs in, and only then, so removing someone stops their next
sign-in.

**What a refused sign-in ends.** When Platehouse itself refuses a sign-in (the provider let the
person sign in, but they are not in the group, their email is not verified, or their user id is
too long), the session that browser already had ends too, and they are signed out there at once.
A refusal at the provider ends nothing: if you also limit the client to the group at the provider
(Pocket ID's allowed user groups, an Authentik policy binding and the like), or disable the
account there, the provider refuses them before Platehouse sees a sign-in, and the session that
browser had carries on. A sign-in that fails because the provider is down never ends anyone's
session either. A Platehouse session they have in any other browser, or one a refusal did not
end, lasts until it expires (7 days without use, 30 days at most), they sign out, or someone uses
**Sign out everywhere** in **Settings** on them.

Creating an API token needs a recent sign-in: if you signed in more than 5 minutes ago, Settings
asks you to sign in again first, and that sign-in checks the group. So a removed person cannot
make a new token with a session they already had. Asking for a token ends nothing by itself; the
sign-in that follows ends a session only as described above. While your provider is down nobody
can make one.

Removing someone does not revoke API tokens. A token never expires and is not checked against
the group, so a token they made or had a copy of keeps reading, uploading and tagging after they
are removed, until it is revoked. Settings shows who made each token. A token made with
Platehouse 0.1.0, before it recorded that, shows "Made by an unknown user".

To cut someone off completely:

1. Remove them from the group at your provider. From then on, any sign-in they try is refused,
   and a refusal ends at most the session of the browser they tried from (see
   [What a refused sign-in ends](#the-allowed-group) above). Their other sessions carry on until
   the next step.
2. In **Settings**, under **Sign out everywhere**, press **Sign out** beside their name, tick
   **Also revoke the API tokens they made** in the dialog, and press **Sign out everywhere**
   (see [Settings](./using/settings.md#sign-out-everywhere)). Every session
   they have ends at once, and every token they made stops working, including one they were
   making at that moment: a token being made waits for Sign out everywhere, or Sign out
   everywhere waits for it and then revokes it, so it is never left working.
3. In the API token list, revoke any token they had a copy of but did not make, and any token
   made by an unknown user that you cannot account for.

Everyone who signs in sees and changes the same library. There are no roles: anyone in the group
can sign anyone out everywhere, themselves included, and revoke any token. Signing yourself out,
or revoking a token you made, needs only a live session. Signing someone else out, or revoking a
token someone else made (or one made by an unknown user), needs a sign-in in the last 5 minutes,
the same as making a token: otherwise Settings asks you to sign in again first, and nothing
changes. So a session kept by someone you removed from the group cannot be used to sign other
people out or to revoke their tokens.

### Cutting someone off by hand

If you cannot use Settings (for example, the provider is down, so you cannot make the fresh
sign-in that signing someone else out needs), run these against the Platehouse database, with the
person's user id (the `sub` claim your provider gives them) in place of `the-user-id`. The first
statement ends every session they have; the second revokes every token they made. A session is
checked on every request, so both take effect at once.

```sql
begin isolation level read committed;

delete from sessions where subject = 'the-user-id';

update api_tokens set revoked_at = now()
 where created_by_subject = 'the-user-id' and revoked_at is null;

commit;
```

The order matters: sessions first, then tokens. Ending the sessions first means a token being made
at that moment is either refused or made in time for the second statement to revoke it; the other
way round, a token made between the two statements would stay live. Run them as one transaction,
as above, or one after the other in this order.

Write the user id as a SQL string literal: inside single quotes, with any single quote in the id
itself doubled (`'` becomes `''`).

## Sessions

- A session lasts 7 days without use and 30 days at most.
- The session cookie is `__Host-ph_session`: Secure, HttpOnly and SameSite=Lax. Platehouse stores
  only a hash of it.
- Sign out from the app. Signing out needs a request from the Platehouse page itself, so another
  site cannot sign you out.
- **Sign out everywhere** in **Settings** ends every session of one person, on every browser, and
  can also revoke the API tokens they made. The list beside it shows everyone with a live session
  or a token they made. Each person is named by the name on their newest live session that has
  one; a person with no live session that has a name is named by the name recorded on their newest
  live token, and one with neither is shown by user id alone. The user id is always shown beside
  the name, since two people can have the same name. Names are cleaned when they are
  recorded and again when the list is shown, so one recorded by an earlier release is cleaned too:
  control characters and invisible text-direction characters are removed (the joiners some
  scripts need are kept). Settings also sets each name apart from the user id beside it, so a
  name written right to left does not reorder the text around it.
- Signing out or revoking refuses new requests at once. A request that is already running, such as
  a long upload, finishes.

## When the provider is down

Platehouse starts and keeps running while the provider is unreachable. People who are already
signed in keep working. A new sign-in shows "Login is unavailable right now" until the provider
answers again. API tokens keep working throughout, but no new one can be made: that needs a
fresh sign-in.

For the same reason, while the provider is down nobody can make a fresh sign-in, so nobody can sign
someone else out or revoke a token someone else made. Signing yourself out and revoking a token you
made still work. To cut someone off in the meantime, use the SQL in
[Cutting someone off by hand](#cutting-someone-off-by-hand).

If sign-in fails, see [Troubleshooting](./troubleshooting.md#sign-in).
