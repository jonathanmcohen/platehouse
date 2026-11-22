-- Platehouse schema 0012: the GLB of a .3mf plate's 3D view (0.1.1, issue
-- #358). Hand-written; every statement is read in review (lesson 14). Never
-- edit it once applied anywhere: a change is a new file.
--
-- The model page shows a plate's objects in 3D. The server makes the plate's
-- GLB from the stored .3mf the first time the plate is opened
-- (plate-mesh/plate-mesh.ts), stores it as a blob of the model with the
-- existing kind 'mesh_glb' (a STEP file's mesh is the same kind of file), and
-- points the plate at it here, so every later open loads the same blob and
-- the .3mf is not read again. A plate with no mesh yet has null, which is
-- every plate when this runs, so nothing has to be backfilled.
--
-- The reference is cleared when its blob is deleted (on delete set null),
-- as plates.thumbnail_blob_id is, so deleting a model's blobs never trips
-- over it. A plate's mesh blob is the model's like any other, so a purge
-- deletes its object with the rest of models/<modelId>/.
--
-- Additive only: one nullable column, no existing row or value changes.
alter table plates
  add column mesh_blob_id uuid references blobs (id) on delete set null;
