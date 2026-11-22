-- Platehouse schema 0010: where a model's description came from, so a fix to
-- the MakerWorld converter can reach descriptions already stored (#357), and
-- a record of the one-time steps run on upgrade.
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- A stored description was converted from a .3mf once, at import, and never
-- again, so the 0.1.0 converter fixes reached only files imported after
-- them. Ingest now records, beside each description it writes:
--   description_sha256     the SHA-256, lowercase hex, of the description
--                          exactly as it wrote it;
--   description_converter  the converter version that wrote it
--                          (packages/makerworld CONVERTER_VERSION);
--   description_file_id    the .3mf it was converted from.
-- A description whose text still has that hash is untouched, and the
-- re-conversion (library/reconvert.ts) may write it again from that file;
-- one whose text does not, or that has no hash (written through the API,
-- or stored before this migration and not yet proved), is never
-- overwritten. The hash and the version are set together or not at all.
--
-- description_file_id has no foreign key on purpose. Deleting a model
-- deletes its files in the same statement, and a key from models to files,
-- with files already keyed to models, would make that delete order-
-- dependent (0001 defers files.blob_id for the same reason). A file id that
-- no longer names a file only means the description cannot be converted
-- again, which the re-conversion reports as could not be read.
--
-- upgrade_steps holds one row per one-time step that has finished, keyed by
-- the step's name (reconvert-descriptions-3 for the re-conversion with
-- converter 3), with what it did as JSON for the Activity page. A step
-- whose row exists is not run again.
--
-- Safe on a live database: three nullable columns with no default (no table
-- rewrite) and a new table; nothing existing changes.
alter table models
  add column description_sha256 text
    check (description_sha256 ~ '^[0-9a-f]{64}$'),
  add column description_converter smallint
    check (description_converter > 0),
  add column description_file_id uuid,
  add constraint models_description_source_complete
    check ((description_sha256 is null) = (description_converter is null));

create table upgrade_steps (
  name        text primary key check (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  finished_at timestamptz not null default now(),
  result      jsonb not null default '{}'::jsonb
);
