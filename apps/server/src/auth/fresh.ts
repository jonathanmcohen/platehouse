// How recent a session's sign-in must be for an act that reaches past the
// session's own user: making an API token, signing someone else out
// everywhere, or revoking a token someone else made.
//
// The sign-in group is checked only at sign-in, and a session keeps nothing
// it could ask the issuer with later, so a user removed from OIDC_GROUP
// keeps a working session until it expires. A fresh sign-in checks the group
// again, so the acts that can affect other people need one made within
// TOKEN_SIGN_IN_WINDOW_MS. While the issuer cannot be reached that sign-in
// fails, so the act stays refused: it is never let through unchecked. Acts on
// your own sessions and tokens need only a live session.
import type { FastifyReply } from "fastify";
import type { Session } from "../db/types.js";

/**
 * How recent a session's sign-in must be for an act on other people (issue
 * #322): long enough to act straight after the sign-in it asks for, short
 * enough that someone removed from the group cannot use an old session.
 */
export const TOKEN_SIGN_IN_WINDOW_MS = 5 * 60 * 1000;

/** Where a refused act sends the user: a fresh sign-in that comes back to Settings. */
export const TOKEN_SIGN_IN_URL = "/auth/login?next=/settings";

/** True when the session exists and was signed in at most the window before now. */
export function isFresh(session: Session | undefined, now: Date): boolean {
  return (
    session !== undefined && now.getTime() - session.createdAt.getTime() <= TOKEN_SIGN_IN_WINDOW_MS
  );
}

/** What a refused act says, in English (the web app shows the code in its own language). */
export const SIGN_IN_REQUIRED_MESSAGE =
  "Sign in again first. Platehouse checks that you are still allowed in when you sign in.";

/** The refusal of an act from an older sign-in: 403 sign_in_required, with where to sign in again. */
export function refuseStale(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({
    error: "sign_in_required",
    message: SIGN_IN_REQUIRED_MESSAGE,
    code: "sign_in_required",
    signIn: TOKEN_SIGN_IN_URL,
  });
}
