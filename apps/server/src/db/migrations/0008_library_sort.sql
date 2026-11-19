-- Platehouse schema 0008: indexes for the library's sort orders (approved for
-- 0.1.0 by Jon, 2026-11-19; repos/models.ts LIBRARY_SORTS).
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- The library lists live models only, newest or oldest first (date added,
-- then id) or by name ignoring case (lower(name), then name, then id). Each
-- index below holds exactly one of those orders over live models, and a
-- btree is read backwards for the opposite direction, so both directions of
-- each are served. The time, weight and plate count orders total a model's
-- plates for the selected printer, which no index can hold; their lookups
-- already have one each (files_model_id, plates (file_id, index), and
-- estimates_key, which leads with plate_id and source).
-- Additive only: no existing row or column changes. migrate.ts runs each
-- file in a transaction, so these are plain create index, not concurrently;
-- the models table is small (one row per model).
create index models_live_created on models (created_at, id) where trashed_at is null;
create index models_live_name on models (lower(name), name, id) where trashed_at is null;
