// Pocket ID login over OpenID Connect (build plan Task 15; AC-080, AC-081).
// Not implemented yet: the failing tests come first.
import type { DiscoveryRequestOptions } from "openid-client";

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
 * response did not check out, or the user is not let in.
 */
export type LoginFailure = "unavailable" | "failed" | "not_in_group" | "email_not_verified";

export class LoginError extends Error {
  readonly failure: LoginFailure;

  constructor(failure: LoginFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LoginError";
    this.failure = failure;
  }
}

export interface OidcClient {
  /** The issuer's authorize URL for a new login, and the checks to keep. */
  begin(): Promise<{ url: URL; checks: LoginChecks }>;
  /** Exchanges the code in callbackUrl and returns the subject let in. */
  finish(callbackUrl: URL, checks: LoginChecks): Promise<{ subject: string }>;
}

export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** absoluteUrl('/auth/callback'): built from PUBLIC_ORIGIN, never a request. */
  redirectUri: string;
  /** The Pocket ID group a user must be in (OIDC_GROUP). */
  group: string;
  /** Passed to openid-client's discovery; the tests allow a plain-HTTP issuer here. */
  discovery?: DiscoveryRequestOptions;
}

/** True for an email_verified claim of true or the string "true". */
export function emailVerified(_value: unknown): boolean {
  throw new Error("emailVerified is not implemented yet");
}

/** The subject when claims let the user in; a LoginError when they do not. */
export function admit(_claims: Record<string, unknown>, _group: string): { subject: string } {
  throw new Error("admit is not implemented yet");
}

export function createOidc(_opts: OidcOptions): OidcClient {
  const missing = async (): Promise<never> => {
    throw new Error("the OIDC client is not implemented yet");
  };
  return { begin: missing, finish: missing };
}
