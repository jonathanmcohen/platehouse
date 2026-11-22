-- Platehouse schema 0010: who made each API token, and the name each session
-- signed in with (issue #322).
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- A user removed from the sign-in group (OIDC_GROUP) kept API access through
-- tokens they had made, and nothing said which tokens those were. Each new
-- token now records the OIDC subject of the session that made it and the
-- display name that session had, so Settings can show who made it and Sign
-- out everywhere can revoke one user's tokens.
--
-- - api_tokens.created_by_subject: the OIDC subject (sub) that made the
--   token, never empty. No length cap, like sessions.subject: sign-in takes
--   a subject of any length, so a cap here would make token creation fail
--   for a user who signed in. Null for a token made before this migration:
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
-- row is rewritten, every existing value is kept, and nothing else changes.
alter table api_tokens
  add column created_by_subject text
    check (created_by_subject <> ''),
  add column created_by_name text
    check (created_by_name <> '' and char_length(created_by_name) <= 200),
  add constraint api_tokens_name_needs_subject
    check (created_by_name is null or created_by_subject is not null);

create index api_tokens_created_by_subject
  on api_tokens (created_by_subject)
  where revoked_at is null;

alter table sessions
  add column display_name text
    check (display_name <> '' and char_length(display_name) <= 200);

create index sessions_subject on sessions (subject);
