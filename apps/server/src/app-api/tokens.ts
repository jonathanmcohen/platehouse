// API tokens for the settings page (build plan Task 21; AC-083 UI). These
// are session-class /app/api routes for Jon's UI, separate from the bearer
// API: they need his session, and the two that change state need Origin to
// be PUBLIC_ORIGIN (Task 15's gate).
//
//   GET    /app/api/tokens       {tokens: [{id, name, prefix, createdAt, lastUsedAt}]}
//   POST   /app/api/tokens       {name} -> 201 {id, name, prefix, createdAt,
//                                lastUsedAt, token}
//   DELETE /app/api/tokens/:id   204 | 404 unknown or already revoked
//
// - A token is made and revoked by Task 16's createToken and revokeToken. The
//   token itself is in the create answer only: it is never stored (only its
//   SHA-256 and first 8 characters are), never listed and never logged. The
//   request log records no body and no answer (app.ts, requestLogValue), and
//   every answer here is Cache-Control: no-store, so no cache keeps it.
// - The list is every live token, newest first, with the 8-character prefix
//   that tells tokens apart and when each was last used (Task 16 records it
//   at most once a minute). A revoked token is not listed.
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { MAX_TOKEN_NAME_LENGTH, type Tokens } from "../api/tokens.js";
import type { ApiToken, DB } from "../db/types.js";
import { appApiScope, need, refuse } from "./settings.js";

/** A live token as the list shows it: never the token itself. */
export type ListedToken = Pick<ApiToken, "id" | "name" | "prefix" | "createdAt" | "lastUsedAt">;

export interface TokensApiDeps {
  tokens: Pick<Tokens, "createToken" | "revokeToken">;
  /** Every live token, newest first. */
  list(): Promise<ListedToken[]>;
}

/** The api_tokens table's live tokens, newest first; never the hash. */
export function dbTokenList(db: Kysely<DB>): () => Promise<ListedToken[]> {
  return () =>
    db
      .selectFrom("apiTokens")
      .select(["id", "name", "prefix", "createdAt", "lastUsedAt"])
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
        let created: Awaited<ReturnType<TokensApiDeps["tokens"]["createToken"]>>;
        try {
          created = await tokens.createToken(request.body.name);
        } catch (error) {
          if (error instanceof RangeError) {
            return refuse(
              reply,
              400,
              "bad_request",
              `A token's name is 1 to ${MAX_TOKEN_NAME_LENGTH} characters.`,
            );
          }
          throw error;
        }
        const row = (await list()).find((t) => t.id === created.id);
        if (row === undefined) throw new Error("the new token is not in the list");
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
