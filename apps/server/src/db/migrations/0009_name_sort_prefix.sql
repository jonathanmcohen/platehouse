-- Platehouse schema 0009: the name sort index holds a bounded prefix of the
-- name, so no name can make its row too large.
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- 0008's models_live_name held lower(name), name and id: two whole copies of
-- a name of up to 500 characters. A btree row may be at most 2704 bytes, and
-- 500 characters of CJK script (3 bytes each in UTF-8) or emoji (4 bytes)
-- went over it, so the insert or rename of such a model failed, and so did
-- the upload of a .3mf whose title was such a name. Text this varied does not
-- compress enough to fit.
--
-- The index now holds lower(left(name, 200)) and left(name, 200): at most
-- 800 bytes each, whatever the script, so a row always fits. The library's
-- name sort (repos/models.ts, NAME_SORT_CHARS) orders by those two first,
-- which the index serves in either direction, then by lower(name), name and
-- id, so names alike in their first 200 characters still sort by the rest.
-- The order shown is the same as before, except between two names whose
-- first 200 characters differ only in case or accents: those now sort by
-- that difference before anything after the 200th character.
--
-- Safe on a live database: no row or column changes, and the index is
-- dropped and made again under its own name in this file's transaction
-- (migrate.ts), so the name sort is never left without it after a commit.
-- The models table is small (one row per model), so this is a plain create
-- index, not concurrently.
drop index models_live_name;
create index models_live_name
  on models (lower(left(name, 200)), left(name, 200))
  where trashed_at is null;
