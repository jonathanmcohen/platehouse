-- Platehouse schema 0011: who made each API token, the name each session
-- signed in with, and one length limit for every stored OIDC subject
-- (issues #322 and #378).
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- A user removed from the sign-in group (OIDC_GROUP) kept API access through
-- tokens they had made, and nothing said which tokens those were. Each new
-- token now records the OIDC subject of the session that made it and the
-- display name that session had, so Settings can show who made it and Sign
-- out everywhere can revoke one user's tokens.
--
-- A subject is at most 255 characters everywhere it is stored. OpenID Connect
-- Core limits sub to 255 ASCII characters, and sign-in refuses a longer one
-- (auth/oidc.ts admit, MAX_SUBJECT_LENGTH), so every subject that can sign in
-- fits these columns and their checks. It also keeps every entry of the two
-- btree indexes below far under Postgres's limit of about 2700 bytes: 255
-- characters are at most 1020 bytes in UTF-8. Characters are counted by
-- char_length, as admit() counts them. 0.1.0 had no limit, so:
--
-- - sessions.subject: every session whose subject is longer than 255
--   characters is deleted before the check is added. Only an issuer that
--   breaks OpenID Connect could have made one, and that user can no longer
--   sign in; their session would otherwise stop the check, and the index,
--   from being made. Every other session is kept as it is.
-- - api_tokens.created_by_subject: the OIDC subject (sub) that made the
--   token, 1 to 255 characters. Null for a token made before this migration:
--   its maker is unknown, and Settings says so.
-- - api_tokens.created_by_name: the maker's display name when the token was
--   made, at most 200 characters, or null when the session had none. Only
--   set together with a subject.
-- - sessions.display_name: the display name the issuer gave at sign-in
--   (name, else preferred_username, else email; auth/oidc.ts), at most 200
--   characters, or null. A new token copies it as created_by_name. Null for
--   a session started before this migration.
--
-- Safe on a live database: three nullable columns with no default, so no
-- row is rewritten and every existing value is kept. The only rows removed
-- are sessions with a subject over 255 characters, described above. The
-- sessions and api_tokens tables are small (a row per login and per token),
-- so the checks are validated and the indexes made in this file's
-- transaction (migrate.ts), not concurrently.
alter table api_tokens
  add column created_by_subject text
    check (created_by_subject <> '' and char_length(created_by_subject) <= 255),
  add column created_by_name text
    check (created_by_name <> '' and char_length(created_by_name) <= 200),
  add constraint api_tokens_name_needs_subject
    check (created_by_name is null or created_by_subject is not null);

create index api_tokens_created_by_subject
  on api_tokens (created_by_subject)
  where revoked_at is null;

delete from sessions where char_length(subject) > 255;

alter table sessions
  add constraint sessions_subject_length
    check (char_length(subject) <= 255),
  add column display_name text
    check (display_name <> '' and char_length(display_name) <= 200);

create index sessions_subject on sessions (subject);
