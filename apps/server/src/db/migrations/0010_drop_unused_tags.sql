-- Platehouse schema 0010: remove the tags no model has (issue #312).
-- Hand-written; every statement is read in review, since generated DDL can
-- hide a destructive change. Never edit it once applied anywhere: a change is
-- a new file.
--
-- Up to 0.1.0 a tag stayed in the database after its last model lost it, so
-- a library holds tags no model has. The Tags page never listed them and
-- nothing could delete them. From 0.1.1 the app removes a tag when its last
-- model loses it (repos/tags.ts), and this clears the ones left from before.
--
-- A tag a model in the trash has is kept: a restore brings the model back
-- with its tags. Collections are not touched, empty or not: the app never
-- removes a collection on its own, and an empty one is listed on the
-- Collections page, where it can be deleted. No model and no link changes;
-- a tag with no link has nothing pointing at it.
delete from tags t
where not exists (select 1 from model_tags mt where mt.tag_id = t.id);
