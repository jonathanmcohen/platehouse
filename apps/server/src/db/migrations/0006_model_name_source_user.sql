-- Platehouse schema 0006: mark as the user's every existing model a person
-- named before name_source existed (0.1.0, PR #247 review). Hand-written;
-- every statement is read in review (lesson 14). Never edit it once applied
-- anywhere: a change is a new file.
--
-- 0005 started every existing model as 'file'. Before 0005 a file gave a
-- model one name only: its raw stem, the base name without its last
-- extension, trimmed (ingest.ts modelNameOf before 0.1.0, names.ts rawStem
-- now). The code that renames a 'file' model from a title also takes a
-- file's cleaned name (names.ts fileStems: Desk_cable_clip.3mf gives "Desk
-- cable clip"), so a model a person renamed to that cleaned form before 0005,
-- through the collections page or in Manyfold before import, would pass as
-- named by its file and could be renamed by "Use file titles" or by a .3mf
-- added later. AC-022 says a name a person set is never changed.
--
-- So a 'file' model whose name is none of its files' raw stems becomes
-- 'user'. The raw stem here is rawStem in SQL: the part after the last / or
-- \, trimmed (the whole original name when that is blank), then everything
-- before the last dot when the dot is not the first character, trimmed (the
-- base name when that is blank). Where this differs from JavaScript's trim
-- it only ever marks more models 'user', never fewer, so it errs towards
-- keeping a name. A model with no files has no raw stem and becomes 'user'.
-- 'title' and 'user' models are not touched.
--
-- On a database where 0005 ran and new models were ingested before this
-- file, a model named from its cleaned file name since then also becomes
-- 'user' when that differs from its raw stem: it keeps its name and is no
-- longer renamed from a title. That too errs towards keeping a name.
-- Only name_source changes; no name and no updated_at changes.
update models m
set name_source = 'user'
where m.name_source = 'file'
  and not exists (
    select 1
    from files f
    cross join lateral (
      select coalesce(
        nullif(regexp_replace(regexp_replace(f.original_name, '^.*[/\\]', ''),
                              '^\s+|\s+$', '', 'g'), ''),
        f.original_name) as base
    ) b
    cross join lateral (
      select coalesce(
        nullif(regexp_replace(regexp_replace(b.base, '^(.+)\.[^.]*$', '\1'),
                              '^\s+|\s+$', '', 'g'), ''),
        b.base) as stem
    ) s
    where f.model_id = m.id
      and s.stem = m.name
  );
