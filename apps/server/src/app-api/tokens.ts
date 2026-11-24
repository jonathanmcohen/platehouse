// API tokens for the settings page, where each API client gets its own token,
// shown once, and where any one of them can be revoked. These
// are session-class /app/api routes for the web UI, separate from the bearer
// API: they need a signed-in session, and the two that change state need Origin to
// be PUBLIC_ORIGIN (the route-class gate, auth/gate.ts).
//
//   GET    /app/api/tokens       {tokens: [{id, name, prefix, createdAt,
//                                lastUsedAt, createdBy}]}
//   POST   /app/api/tokens       {name} -> 201 {id, name, prefix, createdAt,
//                                lastUsedAt, createdBy, token} | 403
//                                sign_in_required | 429 rate_limited
//   DELETE /app/api/tokens/:id   204 | 403 sign_in_required | 404 unknown or
//                                already revoked
//
// - createdBy is who made the token (issue #322): {subject, name}, the OIDC
//   subject and the display name of the session that made it (name null
//   when the session had none), or null for a token made before Platehouse
//   recorded it, which the page shows as made by an unknown user.
// - A new token needs a fresh sign-in (issue #322). The group is checked
//   only at sign-in, and a session keeps nothing it could ask the issuer
//   with later, so a user removed from OIDC_GROUP keeps a working session
//   until it expires. A create from a session signed in more than
//   TOKEN_SIGN_IN_WINDOW_MS ago is refused, 403 sign_in_required with
//   signIn, the login URL that comes back to Settings; that sign-in checks
//   the group again, so someone who left it gets no fresh session and no
//   token. While the issuer cannot be reached the sign-in fails, so the
//   create stays refused: it is never let through unchecked. Revoking a
//   token someone else made, or one with no recorded maker, needs the same
//   fresh sign-in (auth/fresh.ts); revoking one you made needs a live
//   session only.
// - A create is checked twice. The gate's session must be fresh, as above;
//   then createTokenForSession (api/tokens.ts) reads that session's row again
//   under a lock, in the same transaction as the insert, and answers "stale",
//   the same 403 sign_in_required, when the row is gone or no longer fresh
//   (issue #414). Sign out everywhere deletes the rows and revokes the
//   tokens in one transaction, so the two wait for each other: a token asked
//   for while its maker is signed out everywhere with the revoke box ticked
//   is either refused or made and then revoked, never left live.
// - One session may make at most SESSION_LIMIT_MAX tokens in any
//   SESSION_LIMIT_WINDOW_MS (10 in 10 minutes, auth/limit.ts, issue #424);
//   the next answers 429 {error: "rate_limited"} with Retry-After in seconds,
//   and nothing is made. A create is counted once the fresh sign-in check has
//   passed, before the store is asked: a stale session gets the 403, which
//   says what to do, and uses up none of its count.
// - A token is made and revoked by createTokenForSession and revokeToken (api/tokens.ts). The
//   token itself is in the create answer only: it is never stored (only its
//   SHA-256 and first 8 characters are), never listed and never logged. The
//   request log records no body and no answer (app.ts, requestLogValue), and
//   every answer here is Cache-Control: no-store, so no cache keeps it.
// - The list is every live token, newest first, with the 8-character prefix
//   that tells tokens apart and when each was last used (the bearer check records it
//   at most once a minute). A revoked token is not listed.
// - The create answer is built from the list, read after the token is made.
//   If that read fails, the token is revoked before the 500, so a token whose
//   value was never shown does not stay live.
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { MAX_TOKEN_NAME_LENGTH, type Tokens } from "../api/tokens.js";
import { isFresh, refuseStale, TOKEN_SIGN_IN_URL, TOKEN_SIGN_IN_WINDOW_MS } from "../auth/fresh.js";
import { sessionOf } from "../auth/gate.js";
import {
  createSessionLimiter,
  refuseLimited,
  SESSION_LIMIT_MAX,
  SESSION_LIMIT_WINDOW_MS,
} from "../auth/limit.js";
import { cleanName } from "../auth/names.js";
import type { ApiToken, DB } from "../db/types.js";
import { appApiScope, need, refuse } from "./settings.js";

/** What a token name out of bounds says (400, code token_name_length). */
export const TOKEN_NAME_LENGTH_MESSAGE = `A token's name is 1 to ${MAX_TOKEN_NAME_LENGTH} characters.`;

export { TOKEN_SIGN_IN_URL, TOKEN_SIGN_IN_WINDOW_MS };

/** A live token as the list shows it: never the token itself. */
export type ListedToken = Pick<
  ApiToken,
  "id" | "name" | "prefix" | "createdAt" | "lastUsedAt" | "createdBySubject" | "createdByName"
>;

export interface TokensApiDeps {
  tokens: Pick<Tokens, "createTokenForSession" | "revokeToken">;
  /** Every live token, newest first. */
  list(): Promise<ListedToken[]>;
  /** The clock the sign-in window is measured on; the real one when left out. */
  now?: () => Date;
}

/**
 * The api_tokens table's live tokens, newest first; never the hash. Not paged:
 * a household has a handful of tokens.
 */
export function dbTokenList(db: Kysely<DB>): () => Promise<ListedToken[]> {
  return () =>
    db
      .selectFrom("apiTokens")
      .select([
        "id",
        "name",
        "prefix",
        "createdAt",
        "lastUsedAt",
        "createdBySubject",
        "createdByName",
      ])
      .where("revokedAt", "is", null)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .execute();
}

/** A list entry as JSON. */
function entry(row: ListedToken) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
    createdBy:
      row.createdBySubject === null
        ? null
        : {
            subject: row.createdBySubject,
            // A name recorded before names were cleaned is cleaned here too.
            name: row.createdByName === null ? null : cleanName(row.createdByName),
          },
  };
}

const NEW_TOKEN = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_TOKEN_NAME_LENGTH, pattern: "\\S" },
  },
  required: ["name"],
} as const;

const ID_PARAMS = {
  type: "object",
  properties: { id: { type: "string", maxLength: 100 } },
  required: ["id"],
} as const;

/** Registers the token routes. */
export async function registerTokensApi(
  app: FastifyInstance,
  deps: TokensApiDeps | undefined,
): Promise<void> {
  const clock = () => (deps?.now ?? (() => new Date()))();
  // Token creations per session, on the same clock as the sign-in window.
  const creations = createSessionLimiter({
    max: SESSION_LIMIT_MAX,
    windowMs: SESSION_LIMIT_WINDOW_MS,
    now: () => clock().getTime(),
  });
  await appApiScope(app, (scope) => {
    scope.get("/tokens", async () => {
      const { list } = need(deps);
      return { tokens: (await list()).map(entry) };
    });

    scope.post<{ Body: { name: string } }>(
      "/tokens",
      { schema: { body: NEW_TOKEN } },
      async (request, reply) => {
        const { tokens, list } = need(deps);
        // The gate let this request in with a session (session-class route).
        const session = sessionOf(request);
        const now = clock();
        if (session === undefined || !isFresh(session, now)) {
          return refuseStale(reply);
        }
        // Counted only once the session may make a token, and before any work.
        const limited = creations.take(session.id);
        if (!limited.ok) {
          request.log.warn("app api: token creation over the per-session limit");
          return refuseLimited(reply, limited.retryAfterSeconds);
        }
        let created: Awaited<ReturnType<TokensApiDeps["tokens"]["createTokenForSession"]>>;
        try {
          // The session is read again under a lock with the insert: one
          // signed out everywhere since the gate read it is "stale".
          created = await tokens.createTokenForSession(session.id, request.body.name, now);
        } catch (error) {
          if (error instanceof RangeError) {
            return refuse(reply, 400, "bad_request", TOKEN_NAME_LENGTH_MESSAGE, {
              code: "token_name_length",
              max: MAX_TOKEN_NAME_LENGTH,
            });
          }
          throw error;
        }
        if (created === "stale") return refuseStale(reply);
        const made = created;
        let row: ListedToken | undefined;
        try {
          row = (await list()).find((t) => t.id === made.id);
          if (row === undefined) throw new Error("the new token is not in the list");
        } catch (error) {
          // The token is made but this answer, the only place its value is
          // ever shown, cannot be built. Revoke it, so no live token is left
          // whose value nobody saw; the page says to try again.
          try {
            await tokens.revokeToken(made.id);
          } catch (revokeError) {
            request.log.error(
              { err: revokeError, tokenId: made.id },
              "app api: could not revoke a token whose create answer failed",
            );
          }
          throw error;
        }
        // The one answer that carries the token; no-store, like every answer here.
        return reply.code(201).send({ ...entry(row), token: made.token });
      },
    );

    scope.delete<{ Params: { id: string } }>(
      "/tokens/:id",
      { schema: { params: ID_PARAMS } },
      async (request, reply) => {
        const { tokens, list } = need(deps);
        const session = sessionOf(request);
        // A token someone else made, or one with no recorded maker, is an act
        // on another person and needs a fresh sign-in; one you made, only a
        // live session. An id no live token has is 404 either way.
        const token = (await list()).find((t) => t.id === request.params.id);
        const madeByCaller =
          token !== undefined &&
          session !== undefined &&
          token.createdBySubject === session.subject;
        if (token !== undefined && !madeByCaller) {
          if (!isFresh(session, (deps?.now ?? (() => new Date()))())) return refuseStale(reply);
        }
        if (!(await tokens.revokeToken(request.params.id))) {
          return refuse(reply, 404, "not_found");
        }
        return reply.code(204).send();
      },
    );
  });
}
