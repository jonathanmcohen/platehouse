-- Platehouse schema 0002: the purge marker (build plan Task 14, AC-063).
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- A purge sets purge_started_at, in a transaction of its own that commits
-- before it deletes any of the model's bucket objects. A purge that fails
-- after that leaves the model in the trash with the marker set, and restore
-- refuses it, because some of its objects may already be gone; the next
-- purge finishes it. A trashed model without the marker is restored whatever
-- the bucket holds: an object lost some other way shows as unavailable, it
-- does not make the model unrestorable. Only a trashed model can carry the
-- marker, and nothing clears it: a model whose purge began is only purged.
alter table models
  add column purge_started_at timestamptz,
  add constraint models_purge_only_trashed
    check (purge_started_at is null or trashed_at is not null);
