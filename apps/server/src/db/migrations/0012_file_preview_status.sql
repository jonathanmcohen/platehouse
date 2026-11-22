-- Platehouse schema 0012: the preview picture's own status (issues #316,
-- #380 and #389). Hand-written; every statement is read in review (lesson
-- 14). Never edit it once applied anywhere: a change is a new file.
--
-- STL and STEP files get a rendered preview picture from 0.1.1. Its state is
-- kept here, apart from derived_status and derived_message, so those keep
-- their 0.1.0 meaning, which the public API answers as derivedStatus: the
-- OpenSCAD render of a .scad file and the mesh conversion of a STEP file,
-- and null for an STL.
--
-- Three columns hold facts, written as they happen:
-- - preview_source_blob_id: the source blob render_png_blob_id was made
--   from, so "a picture of the file's current source" is a comparison with
--   blob_id rather than a guess. No foreign key: it keeps naming a source
--   that has since been replaced and deleted, which is exactly what makes
--   the stored picture not current.
-- - preview_failure_source_blob_id and preview_failure_message: the source
--   the newest failed picture attempt was for, and why it failed.
--
-- preview_status and preview_message are worked out from those facts, the
-- file's blob_id and the picture jobs still queued or running, in the same
-- transaction as every change to them (previewState in
-- apps/server/src/derived/picture.ts): 'ok' when the picture is of the
-- current source, else 'pending' while a picture job for it is live, else
-- 'failed' with the reason when the newest attempt for it failed, else
-- null. preview_message is that reason, in the same form as
-- derived_message. Only STL and STEP files ever have one.
--
-- Every column starts null on every existing file, which is what 0.1.0's
-- files are: none has a picture yet. Nothing else changes.
alter table files
  add column preview_status text
    check (preview_status in ('pending', 'ok', 'failed')),
  add column preview_message text,
  add column preview_source_blob_id uuid,
  add column preview_failure_source_blob_id uuid,
  add column preview_failure_message text;
