-- Platehouse schema 0005: where a model's name came from, and the MakerWorld
-- design it came from (0.1.0: names from the 3mf title, the model page
-- rename, View on MakerWorld). Hand-written; every statement is read in
-- review (lesson 14). Never edit it once applied anywhere: a change is a new
-- file.
--
-- name_source says who named the model: 'file' (its file's name, the only
-- way a model was named before this file), 'title' (its .3mf's title) or
-- 'user' (a rename). Ingest and the "Use file titles" action rename a model
-- only while it is 'file', and a rename makes it 'user', so a name a person
-- set is never overwritten (AC-022). Every existing model starts as 'file';
-- the code also requires the name to still be one of its files' names before
-- it renames one, so a model renamed before this column existed keeps its
-- name.
--
-- makerworld_design_id is the design ID a MakerWorld .3mf carries
-- (<metadata name="DesignId">), digits only, from which the model page builds
-- https://makerworld.com/models/<id>. Filled like the other MakerWorld
-- fields: only while it is null. The check keeps anything but a design ID
-- out, so no URL text from a file is ever stored.
-- Additive only: no existing value changes.
alter table models
  add column name_source text not null default 'file'
    check (name_source in ('file', 'title', 'user')),
  add column makerworld_design_id text
    check (makerworld_design_id ~ '^[1-9][0-9]{0,14}$');
