// Sign out everywhere on the settings page (issue #322). Session-class
// /app/api routes, like the token routes: they need a signed-in session, and
// the one that changes state needs Origin to be PUBLIC_ORIGIN (the gate).
//
//   GET  /app/api/users           {users: [{subject, name, sessions, tokens, you}]}
//   POST /app/api/users/sign-out  {subject, revokeTokens} -> 200
//                                 {sessionsEnded, tokensRevoked} | 400
//
// - Platehouse has no user table: a user is an OIDC subject. The list is
//   everyone with a live session or a live API token they made (dbUserList),
//   each with how many of each, named by the display name of their newest
//   session that has one, else of their newest token that has one (null
//   when neither has). you marks the subject of the session asking.
// - Sign out ends every session of the subject, live or not, so every
//   browser they are signed in on is sent to the login page on its next
//   request. With revokeTokens it then revokes every live API token they
//   made. A token made before Platehouse recorded who made it has no maker
//   and is never revoked here; Settings lists it as made by an unknown user,
//   to revoke by hand. Sessions end first, so the user cannot make a new
//   token in between (a new token needs a fresh sign-in anyway). Both steps
//   can be repeated: a second press ends and revokes nothing more.
// - Who may use it: every signed-in user. Platehouse has no roles: everyone
//   in OIDC_GROUP has the same full access, and can already revoke any API
//   token and change every setting, so this adds no power anyone lacked. A
//   user can sign themselves out everywhere; their own session ends too.
// - The request log records no body (app.ts), so no subject is logged.
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import type { Tokens } from "../api/tokens.js";
import { sessionOf } from "../auth/gate.js";
import { MAX_SUBJECT_LENGTH } from "../auth/oidc.js";
import type { Sessions } from "../auth/sessions.js";
import type { DB } from "../db/types.js";
import { appApiScope, need } from "./settings.js";

/** One user as the list shows them. */
export interface KnownUser {
  /** Their OIDC subject (sub). */
  subject: string;
  /** Their latest recorded display name, or null. */
  name: string | null;
  /** Live sessions. */
  sessions: number;
  /** Live API tokens they made. */
  tokens: number;
}

export interface UsersApiDeps {
  /** Everyone with a live session or a live token they made, at now. */
  list(now: Date): Promise<KnownUser[]>;
  sessions: Pick<Sessions, "endAllFor">;
  tokens: Pick<Tokens, "revokeAllFrom">;
  /** The clock "live" is read on; the real one when left out. */
  now?: () => Date;
}

/**
 * The user list from the sessions and api_tokens tables: live sessions
 * (within both expiries) and live tokens with a known maker, grouped by
 * subject, named by the newest named session, else the newest named token.
 */
export function dbUserList(db: Kysely<DB>): (now: Date) => Promise<KnownUser[]> {
  return async (now) => {
    const { rows } = await sql<{
      subject: string;
      name: string | null;
      sessions: number;
      tokens: number;
    }>`
      with live_sessions as (
        select subject, display_name, created_at
        from sessions
        where expires_at > ${now} and idle_expires_at > ${now}
      ),
      live_tokens as (
        select created_by_subject as subject, created_by_name as display_name, created_at
        from api_tokens
        where revoked_at is null and created_by_subject is not null
      ),
      subjects as (
        select subject from live_sessions
        union
        select subject from live_tokens
      )
      select
        s.subject,
        coalesce(
          (select display_name from live_sessions l
            where l.subject = s.subject and l.display_name is not null
            order by l.created_at desc limit 1),
          (select display_name from live_tokens t
            where t.subject = s.subject and t.display_name is not null
            order by t.created_at desc limit 1)
        ) as name,
        (select count(*)::int from live_sessions l where l.subject = s.subject) as sessions,
        (select count(*)::int from live_tokens t where t.subject = s.subject) as tokens
      from subjects s
      order by s.subject
    `.execute(db);
    return rows.map((row) => ({
      subject: row.subject,
      name: row.name,
      sessions: row.sessions,
      tokens: row.tokens,
    }));
  };
}

const SIGN_OUT = {
  type: "object",
  properties: {
    // The same cap sign-in applies (auth/oidc.ts admit, MAX_SUBJECT_LENGTH,
    // issue #378), so every subject that can sign in can be signed out.
    // JSON Schema's maxLength counts code points, as admit() does.
    subject: { type: "string", minLength: 1, maxLength: MAX_SUBJECT_LENGTH },
    revokeTokens: { type: "boolean" },
  },
  required: ["subject", "revokeTokens"],
  additionalProperties: false,
} as const;

/** Registers the Sign out everywhere routes. */
export async function registerUsersApi(
  app: FastifyInstance,
  deps: UsersApiDeps | undefined,
): Promise<void> {
  await appApiScope(app, (scope) => {
    scope.get("/users", async (request) => {
      const { list } = need(deps);
      const now = (deps?.now ?? (() => new Date()))();
      const you = sessionOf(request)?.subject;
      const users = await list(now);
      return {
        users: users
          .map((user) => ({ ...user, you: user.subject === you }))
          .sort(
            (a, b) =>
              Number(b.you) - Number(a.you) ||
              (a.name ?? a.subject).localeCompare(b.name ?? b.subject) ||
              a.subject.localeCompare(b.subject),
          ),
      };
    });

    scope.post<{ Body: { subject: string; revokeTokens: boolean } }>(
      "/users/sign-out",
      { schema: { body: SIGN_OUT } },
      async (request) => {
        const { sessions, tokens } = need(deps);
        const { subject, revokeTokens } = request.body;
        const sessionsEnded = await sessions.endAllFor(subject);
        const tokensRevoked = revokeTokens ? await tokens.revokeAllFrom(subject) : 0;
        request.log.info({ sessionsEnded, tokensRevoked }, "app api: signed a user out everywhere");
        return { sessionsEnded, tokensRevoked };
      },
    );
  });
}
