-- Platehouse schema 0012: the preview picture's own status (issue #316).
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- STL and STEP files get a rendered preview picture from 0.1.1. Its state is
-- kept here, apart from derived_status and derived_message, so those keep
-- their 0.1.0 meaning, which the public API answers as derivedStatus: the
-- OpenSCAD render of a .scad file and the mesh conversion of a STEP file,
-- and null for an STL. preview_status is null until a picture is queued,
-- then 'pending', 'ok' or 'failed'; preview_message holds why it failed, in
-- the same form as derived_message. Only STL and STEP files ever have one.
--
-- Both columns start null on every existing file, which is what 0.1.0's
-- files are: none has a picture yet. Nothing else changes.
alter table files
  add column preview_status text
    check (preview_status in ('pending', 'ok', 'failed')),
  add column preview_message text;
