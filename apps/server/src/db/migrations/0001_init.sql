-- Platehouse schema 0001, from the Database schema contract of the 0.1.0 build
-- plan. Hand-written; every statement is read in review (lesson 14).
--
-- migrate.ts runs this whole file in one transaction and records its
-- SHA-256. Never edit it once applied anywhere: a change is a new file.
--
-- Ids are UUIDv7 made by the app (src/db/ids.ts); Postgres 17 has no
-- uuidv7() of its own, so no id column has a default. Timestamps are
-- timestamptz. A model's own rows (files, plates, estimates, blobs, tag and
-- collection links) go with it when its row is deleted; the purge deletes
-- the bucket objects first (build plan Task 14).

-- Trigram search on names, captions, creators and tags (AC-064).
create extension if not exists pg_trgm;

-- Creators: the sidebar's Creators list.
create table creators (
  id         uuid primary key,
  name       text not null unique check (name <> ''),
  created_at timestamptz not null default now()
);

-- Models. Metadata is fill-only (AC-022): an import or a parse writes a
-- field only while it is null or empty; that rule lives in the ingest code.
-- external_ref (manyfold:<id>) is unique across live and trashed models, so
-- a re-run import cannot recreate a model Jon trashed (Review Focus 4).
create table models (
  id             uuid primary key,
  name           text not null check (name <> ''),
  caption        text,
  description_md text,
  creator_id     uuid references creators (id),
  license_spdx   text,
  license_note   text,
  external_ref   text unique,
  trashed_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index models_creator_id on models (creator_id);
-- Trash listing and the 30-day purge look only at trashed models.
create index models_trashed_at on models (trashed_at) where trashed_at is not null;

-- Tags, unique regardless of case: "PLA" and "pla" are one tag.
create table tags (
  id   uuid primary key,
  name text not null check (btrim(name) <> '')
);

create unique index tags_name_lower on tags (lower(name));

create table model_tags (
  model_id uuid not null references models (id) on delete cascade,
  tag_id   uuid not null references tags (id) on delete cascade,
  primary key (model_id, tag_id)
);

create index model_tags_tag_id on model_tags (tag_id);

-- Collections are flat (Q17): there is no column through which a collection
-- could hold another collection.
create table collections (
  id   uuid primary key,
  name text not null check (btrim(name) <> '')
);

create unique index collections_name_lower on collections (lower(name));

create table collection_models (
  collection_id uuid not null references collections (id) on delete cascade,
  model_id      uuid not null references models (id) on delete cascade,
  primary key (collection_id, model_id)
);

create index collection_models_model_id on collection_models (model_id);

-- Blobs: the object of record for every object in the bucket. The key is
-- exactly models/<modelId>/<blobId> (Bucket key layout): no extension and no
-- user text, and the check below makes any other key impossible. A blob is
-- 'pending' from before its upload until the upload is verified, then
-- 'stored', which needs its size and a 32-byte SHA-256. Reconciliation
-- (AC-010) counts the 'stored' rows against the objects under models/.
create table blobs (
  id           uuid primary key,
  model_id     uuid not null references models (id) on delete cascade,
  key          text not null unique,
  kind         text not null
               check (kind in ('source', 'thumbnail', 'render_stl', 'render_png', 'mesh_glb')),
  size         bigint check (size >= 0),
  sha256       bytea check (length(sha256) = 32),
  content_type text not null,
  state        text not null default 'pending' check (state in ('pending', 'stored')),
  created_at   timestamptz not null default now(),
  constraint blobs_key_layout check (key = 'models/' || model_id::text || '/' || id::text),
  constraint blobs_stored_complete
    check (state = 'pending' or (size is not null and sha256 is not null))
);

create index blobs_model_id on blobs (model_id);

-- Files: what Jon sees on a model's Files tab. A rename changes name only;
-- original_name keeps the uploaded name and the blob key never changes
-- (AC-060). parse_status 'unavailable' is a store outage, never damage
-- (AC-012). derived_status and derived_message describe the OpenSCAD render
-- or STEP mesh (Task 13 sets their values).
--
-- Deleting a model deletes its blobs and its files in the same statement,
-- in an order Postgres picks. So the source blob reference is checked at
-- commit (deferrable initially deferred), and a derived blob reference is
-- cleared when that blob is deleted (on delete set null); either way a
-- cascade never trips over a row it is about to delete.
create table files (
  id                 uuid primary key,
  model_id           uuid not null references models (id) on delete cascade,
  blob_id            uuid not null references blobs (id) deferrable initially deferred,
  name               text not null check (name <> ''),
  original_name      text not null,
  kind               text not null check (kind in ('3mf', 'stl', 'step', 'scad')),
  size               bigint not null check (size >= 0),
  sha256             bytea not null check (length(sha256) = 32),
  external_ref       text,
  parse_status       text not null default 'pending'
                     check (parse_status in ('pending', 'ok', 'no_plate_data', 'unavailable')),
  derived_status     text,
  derived_message    text,
  mesh_blob_id       uuid references blobs (id) on delete set null,
  render_stl_blob_id uuid references blobs (id) on delete set null,
  render_png_blob_id uuid references blobs (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index files_model_id on files (model_id);
create index files_blob_id on files (blob_id);

-- The project's filament list from the .3mf.
create table file_filaments (
  file_id uuid not null references files (id) on delete cascade,
  slot    integer not null check (slot >= 1),
  type    text not null,
  color   text,
  primary key (file_id, slot)
);

-- Plates of a .3mf, numbered from 1 as Bambu Studio numbers them. The
-- thumbnail reference is cleared if its blob goes, as for files above.
create table plates (
  id                uuid primary key,
  file_id           uuid not null references files (id) on delete cascade,
  "index"           integer not null check ("index" >= 1),
  name              text,
  object_count      integer not null check (object_count >= 0),
  thumbnail_blob_id uuid references blobs (id) on delete set null,
  unique (file_id, "index")
);

-- Estimates: one row per plate, source, printer and slicer version.
-- source 'file' holds Bambu's own numbers from the .3mf, labelled with the
-- printer it was sliced for; 'platehouse' holds an OrcaSlicer estimate for
-- the selected printer. slicer_version is the Orca version that produced a
-- Platehouse estimate (AC-036); a file's own numbers may have no version, and
-- NULLS NOT DISTINCT keeps those unique too. A finished estimate has its
-- numbers and a failed one its reason, so every plate shows numbers or a
-- recorded reason (AC-032).
create table estimates (
  id                uuid primary key,
  plate_id          uuid not null references plates (id) on delete cascade,
  source            text not null check (source in ('file', 'platehouse')),
  printer_id        text not null,
  printer_model_id  text,
  nozzle            double precision check (nozzle > 0),
  slicer            text,
  slicer_version    text,
  process_profile   text,
  filament_profiles text[] not null default '{}',
  status            text not null default 'pending'
                    check (status in ('pending', 'running', 'ok', 'failed')),
  time_seconds      integer check (time_seconds >= 0),
  weight_grams      double precision check (weight_grams >= 0),
  failure_code      integer,
  failure_reason    text,
  failure_detail    text,
  attempts          integer not null default 0 check (attempts >= 0),
  created_at        timestamptz not null default now(),
  finished_at       timestamptz,
  constraint estimates_key unique nulls not distinct (plate_id, source, printer_id, slicer_version),
  constraint estimates_ok_has_numbers
    check (status <> 'ok' or (time_seconds is not null and weight_grams is not null)),
  constraint estimates_failed_has_reason
    check (status <> 'failed' or failure_reason is not null)
);

-- Grams per filament for one estimate.
create table estimate_filaments (
  estimate_id uuid not null references estimates (id) on delete cascade,
  slot        integer not null check (slot >= 1),
  type        text not null,
  color       text,
  grams       double precision check (grams >= 0),
  primary key (estimate_id, slot)
);

-- Settings: exactly one row. The id column can only be true, so a second row
-- is a duplicate key. The default printer is the P1S with a 0.4 mm nozzle
-- (AC-031); bucket_versioning is what the store last reported (AC-013).
create table settings (
  id                boolean primary key default true check (id),
  printer_id        text not null default 'Bambu Lab P1S 0.4 nozzle',
  last_orca_version text,
  bucket_versioning text not null default 'unknown'
                    check (bucket_versioning in ('enabled', 'suspended', 'off', 'unknown')),
  updated_at        timestamptz not null default now()
);

insert into settings default values;

-- API tokens (AC-083). The token itself is shown once and never stored: only
-- its first 8 characters, to tell tokens apart in the UI, and the SHA-256 of
-- the 32-byte random token.
create table api_tokens (
  id           uuid primary key,
  name         text not null check (name <> ''),
  prefix       text not null check (length(prefix) = 8),
  token_hash   bytea not null unique check (length(token_hash) = 32),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- Login sessions behind the __Host-ph_session cookie. The id is 32 random
-- bytes in unpadded base64url, which is always 43 characters.
create table sessions (
  id              text primary key check (id ~ '^[A-Za-z0-9_-]{43}$'),
  subject         text not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  idle_expires_at timestamptz not null
);

create index sessions_expires_at on sessions (expires_at);

-- Trigram indexes for search (AC-064). gin_trgm_ops serves ILIKE and
-- similarity() on these columns.
create index models_name_trgm on models using gin (name gin_trgm_ops);
create index models_caption_trgm on models using gin (caption gin_trgm_ops);
create index creators_name_trgm on creators using gin (name gin_trgm_ops);
create index tags_name_trgm on tags using gin (name gin_trgm_ops);
