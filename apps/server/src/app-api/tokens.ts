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
//                                sign_in_required
//   DELETE /app/api/tokens/:id   204 | 404 unknown or already revoked
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
//   create stays refused: it is never let through unchecked.
// - A token is made and revoked by createToken and revokeToken (api/tokens.ts). The
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
import { sessionOf } from "../auth/gate.js";
import type { ApiToken, DB } from "../db/types.js";
import { appApiScope, need, refuse } from "./settings.js";

/** What a token name out of bounds says (400, code token_name_length). */
export const TOKEN_NAME_LENGTH_MESSAGE = `A token's name is 1 to ${MAX_TOKEN_NAME_LENGTH} characters.`;

/**
 * How recent a session's sign-in must be for it to make a new API token
 * (issue #322): long enough to make a token straight after the sign-in it
 * asks for, short enough that someone removed from the group cannot use an
 * old session to make one.
 */
export const TOKEN_SIGN_IN_WINDOW_MS = 5 * 60 * 1000;

/** Where a refused create sends the user: a fresh sign-in that comes back to Settings. */
export const TOKEN_SIGN_IN_URL = "/auth/login?next=/settings";

/** What a create from an older sign-in says (403, code sign_in_required). */
export const SIGN_IN_REQUIRED_MESSAGE =
  "To create an API token, sign in again first. Platehouse checks that you are still allowed in when you sign in.";

/** A live token as the list shows it: never the token itself. */
export type ListedToken = Pick<
  ApiToken,
  "id" | "name" | "prefix" | "createdAt" | "lastUsedAt" | "createdBySubject" | "createdByName"
>;

export interface TokensApiDeps {
  tokens: Pick<Tokens, "createToken" | "revokeToken">;
  /** Every live token, newest first. */
  list(): Promise<ListedToken[]>;
  /** The clock the sign-in window is measured on; the real one when left out. */
  now?: () => Date;
}

/** The api_tokens table's live tokens, newest first; never the hash. */
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
        : { subject: row.createdBySubject, name: row.createdByName },
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
        const at = (deps?.now ?? (() => new Date()))().getTime();
        if (session === undefined || at - session.createdAt.getTime() > TOKEN_SIGN_IN_WINDOW_MS) {
          return refuse(reply, 403, "sign_in_required", SIGN_IN_REQUIRED_MESSAGE, {
            code: "sign_in_required",
            signIn: TOKEN_SIGN_IN_URL,
          });
        }
        let created: Awaited<ReturnType<TokensApiDeps["tokens"]["createToken"]>>;
        try {
          created = await tokens.createToken(request.body.name, {
            subject: session.subject,
            name: session.displayName,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            return refuse(reply, 400, "bad_request", TOKEN_NAME_LENGTH_MESSAGE, {
              code: "token_name_length",
              max: MAX_TOKEN_NAME_LENGTH,
            });
          }
          throw error;
        }
        let row: ListedToken | undefined;
        try {
          row = (await list()).find((t) => t.id === created.id);
          if (row === undefined) throw new Error("the new token is not in the list");
        } catch (error) {
          // The token is made but this answer, the only place its value is
          // ever shown, cannot be built. Revoke it, so no live token is left
          // whose value nobody saw; the page says to try again.
          try {
            await tokens.revokeToken(created.id);
          } catch (revokeError) {
            request.log.error(
              { err: revokeError, tokenId: created.id },
              "app api: could not revoke a token whose create answer failed",
            );
          }
          throw error;
        }
        // The one answer that carries the token; no-store, like every answer here.
        return reply.code(201).send({ ...entry(row), token: created.token });
      },
    );

    scope.delete<{ Params: { id: string } }>(
      "/tokens/:id",
      { schema: { params: ID_PARAMS } },
      async (request, reply) => {
        const { tokens } = need(deps);
        if (!(await tokens.revokeToken(request.params.id))) {
          return refuse(reply, 404, "not_found");
        }
        return reply.code(204).send();
      },
    );
  });
}
