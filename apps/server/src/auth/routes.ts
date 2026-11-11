// GET /auth/login, GET /auth/callback and POST /auth/logout (build plan
// Task 15). Not implemented yet: the failing tests come first.
import type { FastifyInstance } from "fastify";
import type { OidcClient } from "./oidc.js";
import type { Sessions } from "./sessions.js";

/** The cookie that carries a login's PKCE verifier, state and nonce. */
export const LOGIN_COOKIE = "__Host-ph_login";

/** How long a login may take, from /auth/login to /auth/callback. */
export const LOGIN_COOKIE_MS = 10 * 60 * 1000;

/** What /auth/login shows, with status 503, when the issuer cannot be reached. */
export const LOGIN_UNAVAILABLE = "Login is unavailable right now";

/** The key the login cookie is signed with, derived from LINK_SECRET. */
export function loginCookieKey(linkSecret: string): Buffer {
  return Buffer.from(linkSecret, "utf8");
}

export interface AuthRouteDeps {
  oidc: OidcClient;
  sessions: Sessions;
  absoluteUrl(path: string): string;
  group: string;
  now?: () => Date;
}

export async function registerAuthRoutes(
  _app: FastifyInstance,
  _deps: AuthRouteDeps,
): Promise<void> {}
