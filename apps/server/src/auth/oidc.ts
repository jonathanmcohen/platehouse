// Login over OpenID Connect (build plan Task 15; AC-080, AC-081),
// with openid-client: the authorization code flow with PKCE S256, a state
// and a nonce, scopes openid email profile groups, and the client
// authenticating to the token endpoint with client_secret_basic.
//
// - redirect_uri is given (absoluteUrl('/auth/callback'), built from
//   PUBLIC_ORIGIN), and the callback URL handed to finish() is built on it
//   too, so no part of either comes from the request's Host or forwarded
//   headers (AC-091). openid-client sends the callback URL, less its query,
//   as the token request's redirect_uri.
// - Discovery happens on the first login, not at startup, so the server
//   starts and serves everything but login while the OIDC provider is down (AC-081).
//   A discovery that fails is not remembered: the next login tries again.
//   Every request to the issuer gives up after ISSUER_TIMEOUT_SECONDS.
// - A user is let in when the claims carry a subject of at most
//   MAX_SUBJECT_LENGTH (255) characters, the limit OpenID Connect Core sets
//   (issue #378), groups include
//   OIDC_GROUP, and email_verified is true or the string "true" (Parchment
//   dropped a string claim and login became an opaque "denied"). Groups and
//   email_verified are read from the ID token, and from userinfo when the ID
//   token leaves either out.
// - The group is checked at every login and only then. Sessions keep no
//   token from the issuer, so a session cannot ask the issuer again later;
//   what needs a current check, such as making an API token, needs a fresh
//   login instead (app-api/tokens.ts; issue #322).
// - finish also returns a display name for the session (displayNameOf: name,
//   else preferred_username, else email), which labels the API tokens the
//   session makes. It never decides who gets in.
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientSecretBasic,
  type Configuration,
  calculatePKCECodeChallenge,
  type DiscoveryRequestOptions,
  discovery,
  fetchUserInfo,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";

/** The scopes Platehouse asks for. */
export const OIDC_SCOPE = "openid email profile groups";

/** How long discovery and every other request to the issuer may take, in seconds. */
export const ISSUER_TIMEOUT_SECONDS = 5;

/** What the browser must bring back to the callback, kept in the login cookie. */
export interface LoginChecks {
  codeVerifier: string;
  state: string;
  nonce: string;
}

/**
 * Why a login did not end in a session: the issuer could not be reached, the
 * response did not check out, the subject is longer than OIDC allows, or the
 * user is not let in.
 */
export type LoginFailure =
  | "unavailable"
  | "failed"
  | "subject_too_long"
  | "not_in_group"
  | "email_not_verified";

/**
 * The longest OIDC subject (sub) Platehouse takes, in characters: OpenID
 * Connect Core limits sub to 255 ASCII characters (issue #378). admit()
 * refuses a longer one, so every column and index that stores a subject
 * (sessions.subject, api_tokens.created_by_subject; migration 0011) and the
 * Sign out everywhere body hold at most this many. Counted by code point,
 * as Postgres's char_length counts. 0.1.0 took any non-empty string, so
 * nothing else about a subject is refused.
 */
export const MAX_SUBJECT_LENGTH = 255;

/** How many characters a subject has, counted as char_length counts them. */
export function subjectLength(subject: string): number {
  return Array.from(subject).length;
}

export class LoginError extends Error {
  readonly failure: LoginFailure;
  /** For subject_too_long: how many characters the subject had, never the subject. */
  readonly subjectLength: number | undefined;

  constructor(
    failure: LoginFailure,
    message: string,
    options?: { cause?: unknown; subjectLength?: number },
  ) {
    super(message, options);
    this.name = "LoginError";
    this.failure = failure;
    this.subjectLength = options?.subjectLength;
  }
}

export interface OidcClient {
  /** The issuer's authorize URL for a new login, and the checks to keep. */
  begin(): Promise<{ url: URL; checks: LoginChecks }>;
  /**
   * Exchanges the code in callbackUrl and returns the subject let in, with
   * the display name the claims give (displayNameOf), or null.
   */
  finish(callbackUrl: URL, checks: LoginChecks): Promise<{ subject: string; name?: string | null }>;
}

/** The longest display name a session keeps (the schema's limit, migration 0011). */
export const MAX_DISPLAY_NAME = 200;

/** text with each control character (C0, DEL and C1) made a space. */
function spaceControls(text: string): string {
  return Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }).join("");
}

/**
 * The name to show for whoever signed in (issue #322): the first of the
 * name, preferred_username and email claims that is a string with something
 * in it once control characters are taken out and white space is trimmed
 * and collapsed, cut to MAX_DISPLAY_NAME characters; null when none is. It
 * only labels a session and the tokens it makes: nothing is let in or kept
 * out by it.
 */
export function displayNameOf(claims: Record<string, unknown>): string | null {
  for (const key of ["name", "preferred_username", "email"]) {
    const value = claims[key];
    if (typeof value !== "string") continue;
    const clean = spaceControls(value).replace(/\s+/g, " ").trim();
    if (clean !== "") return Array.from(clean).slice(0, MAX_DISPLAY_NAME).join("");
  }
  return null;
}

export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** absoluteUrl('/auth/callback'): built from PUBLIC_ORIGIN, never a request. */
  redirectUri: string;
  /** The OIDC provider group a user must be in (OIDC_GROUP). */
  group: string;
  /** Passed to openid-client's discovery; the tests allow a plain-HTTP issuer here. */
  discovery?: DiscoveryRequestOptions;
}

/** True for an email_verified claim of true or the string "true". */
export function emailVerified(value: unknown): boolean {
  return value === true || value === "true";
}

/** True when a groups claim (a list, or one name) holds group exactly. */
function inGroup(groups: unknown, group: string): boolean {
  if (Array.isArray(groups)) return groups.includes(group);
  return groups === group;
}

/** The subject when claims let the user in; a LoginError when they do not. */
export function admit(claims: Record<string, unknown>, group: string): { subject: string } {
  const subject = claims.sub;
  if (typeof subject !== "string" || subject === "") {
    throw new LoginError("failed", "The login response named no user");
  }
  const length = subjectLength(subject);
  if (length > MAX_SUBJECT_LENGTH) {
    throw new LoginError(
      "subject_too_long",
      `The user id is ${length} characters; OpenID Connect allows at most ${MAX_SUBJECT_LENGTH}`,
      { subjectLength: length },
    );
  }
  if (!inGroup(claims.groups, group)) {
    throw new LoginError("not_in_group", `The user is not in the ${group} group`);
  }
  if (!emailVerified(claims.email_verified)) {
    throw new LoginError("email_not_verified", "The user's email address is not verified");
  }
  return { subject };
}

const UNREACHABLE_CODE =
  /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR)/;

/**
 * True when error, or an error it wraps, says the issuer could not be
 * reached or could not answer: a failed fetch, a timeout, a socket error or
 * a 5xx answer.
 */
function unreachable(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < 6 && e !== null && typeof e === "object"; depth += 1) {
    const err = e as { name?: unknown; message?: unknown; code?: unknown; status?: unknown };
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    if (e instanceof TypeError && err.message === "fetch failed") return true;
    if (typeof err.code === "string" && UNREACHABLE_CODE.test(err.code)) return true;
    if (typeof err.status === "number" && err.status >= 500) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** A LoginError for whatever the issuer exchange threw. */
function asLoginError(error: unknown): LoginError {
  if (error instanceof LoginError) return error;
  if (unreachable(error)) {
    return new LoginError("unavailable", "The issuer could not be reached", { cause: error });
  }
  return new LoginError("failed", "The login response did not check out", { cause: error });
}

export function createOidc(opts: OidcOptions): OidcClient {
  let configuration: Promise<Configuration> | undefined;

  /** The issuer's configuration, discovered once; a failure is not kept. */
  function configured(): Promise<Configuration> {
    if (configuration === undefined) {
      const attempt = discovery(
        new URL(opts.issuer),
        opts.clientId,
        undefined,
        ClientSecretBasic(opts.clientSecret),
        { timeout: ISSUER_TIMEOUT_SECONDS, ...opts.discovery },
      ).catch((error: unknown) => {
        if (configuration === attempt) configuration = undefined;
        throw new LoginError("unavailable", "The issuer could not be discovered", {
          cause: error,
        });
      });
      configuration = attempt;
    }
    return configuration;
  }

  return {
    async begin() {
      const config = await configured();
      const checks: LoginChecks = {
        codeVerifier: randomPKCECodeVerifier(),
        state: randomState(),
        nonce: randomNonce(),
      };
      const url = buildAuthorizationUrl(config, {
        redirect_uri: opts.redirectUri,
        scope: OIDC_SCOPE,
        code_challenge: await calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: "S256",
        state: checks.state,
        nonce: checks.nonce,
      });
      return { url, checks };
    },

    async finish(callbackUrl, checks) {
      const config = await configured();
      try {
        const tokens = await authorizationCodeGrant(config, callbackUrl, {
          pkceCodeVerifier: checks.codeVerifier,
          expectedState: checks.state,
          expectedNonce: checks.nonce,
          idTokenExpected: true,
        });
        const claims: Record<string, unknown> = { ...tokens.claims() };
        const subject = claims.sub;
        if (
          typeof subject === "string" &&
          (!("groups" in claims) || !("email_verified" in claims))
        ) {
          const info: Record<string, unknown> = {
            ...(await fetchUserInfo(config, tokens.access_token, subject)),
          };
          // The name claims come along when userinfo is asked anyway; they
          // only label the session (displayNameOf), never decide entry.
          for (const key of ["groups", "email_verified", "name", "preferred_username", "email"]) {
            if (!(key in claims) && key in info) claims[key] = info[key];
          }
        }
        return { ...admit(claims, opts.group), name: displayNameOf(claims) };
      } catch (error) {
        throw asLoginError(error);
      }
    },
  };
}
