-- Platehouse schema 0016: job and database fixes (0.1.1 step 6). Hand-written;
-- every statement is read in review. Never edit it once applied
-- anywhere: a change is a new file.
--
-- - Partial indexes on the blob references the delete and purge paths look up
--   (files, plates), and on the estimates the print-time rate is read from.
-- - files.preview_failure_reason: a code beside preview_failure_message, so
--   the server decides what to retry from the code and never from the words.
--   The backfill matches the 0.1.1-rc message texts, frozen here on purpose
--   (DERIVED_MESSAGES may change wording later; a database upgraded from an
--   rc still holds these sentences). Any other stored message is a render
--   failure.
-- - models.description_unproven_*: the description a re-conversion wrote
--   that is not yet proven to match its source (no foreign key, as
--   description_file_id in 0014).
-- - upgrade_leases: one holder at a time for a one-off upgrade run.
--
-- Additive only: new columns, indexes and a table; no existing value changes
-- except the new reason column's backfill.

create index files_mesh_blob_id on files (mesh_blob_id) where mesh_blob_id is not null;
create index files_render_stl_blob_id on files (render_stl_blob_id) where render_stl_blob_id is not null;
create index files_render_png_blob_id on files (render_png_blob_id) where render_png_blob_id is not null;
create index plates_thumbnail_blob_id on plates (thumbnail_blob_id) where thumbnail_blob_id is not null;
create index plates_mesh_blob_id on plates (mesh_blob_id) where mesh_blob_id is not null;
create index estimates_rate on estimates (finished_at desc)
  where status = 'ok' and source = 'platehouse' and started_at is not null;

alter table files
  add column preview_failure_reason text check (preview_failure_reason in (
    'slicer_down', 'store_down', 'queue_failed', 'temp_failed',
    'sandbox_off_kernel', 'sandbox_off_check', 'lost', 'render_failed'
  ));

update files set preview_failure_reason = case preview_failure_message
  when 'The slicer is not answering, so the preview picture could not be made. It will be tried again automatically.' then 'slicer_down'
  when 'Storage is not answering, so the preview picture could not be made. It will be tried again automatically.' then 'store_down'
  when 'The preview picture could not be queued. It will be tried again automatically.' then 'queue_failed'
  when 'Platehouse could not write a temporary file; it will be tried again automatically.' then 'temp_failed'
  when 'Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.' then 'sandbox_off_kernel'
  when 'Pictures and OpenSCAD renders are off on this server: its sandbox check failed.' then 'sandbox_off_check'
  when 'The render did not finish.' then 'lost'
  else 'render_failed'
end
where preview_failure_message is not null;

alter table files
  add constraint files_preview_failure_reason_set
  check ((preview_failure_message is null) = (preview_failure_reason is null));

alter table models
  add column description_unproven_file_id uuid,
  add column description_unproven_sha256 text check (description_unproven_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint models_description_unproven_complete
  check ((description_unproven_file_id is null) = (description_unproven_sha256 is null));

create table upgrade_leases (
  name text primary key check (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  holder text not null,
  expires_at timestamptz not null
);
