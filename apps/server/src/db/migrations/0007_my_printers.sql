-- Platehouse schema 0007: My printers, the list of printers Jon owns.
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- Until now settings.printer_id held the one printer every estimate was made
-- for. Now Jon lists the printers he owns, in the order he wants them shown,
-- and Platehouse estimates every plate for each of them. settings.printer_id
-- stays, and means the default printer: the one the library and model pages
-- show first and the public API v1 answers for.
--
-- Safe on a live database:
-- - The printer selected today becomes the only entry, at position 1, and
--   stays the default, so nothing anyone sees changes until Jon adds one.
-- - Estimates are untouched. They were already keyed by printer_id (a text
--   copy of the Orca preset name, the same text stored here), so every
--   existing estimate stays valid for the printer it was made for.
-- - Additive only: one new table, one row copied into it, and one foreign
--   key on settings that the copied row already satisfies.
--
-- position orders the list. It is unique, and the check waits for the
-- commit, so a reorder can swap two printers inside one transaction. A
-- removal leaves a gap; the order is what matters, not the numbers.
--
-- The default printer must be in the list: settings.printer_id references
-- it. So the list is never empty, and removing the default printer is
-- refused unless the same transaction makes another printer the default.
-- The check waits for the commit for the same reason.
create table user_printers (
  printer_id text primary key check (btrim(printer_id) <> ''),
  position   integer not null check (position >= 1),
  added_at   timestamptz not null default now(),
  constraint user_printers_position_key unique (position) deferrable initially deferred
);

insert into user_printers (printer_id, position)
select printer_id, 1 from settings;

alter table settings
  add constraint settings_printer_in_my_printers
    foreign key (printer_id) references user_printers (printer_id)
    deferrable initially deferred;

-- printers_version counts the writes to My printers and the default. Every
-- save that changes either bumps it, and a save names the version it was
-- built from: one built from an older read (a Settings page open in another
-- window) is refused, so it cannot put back a removed printer, drop an added
-- one or restore an old default. A counter of its own, not updated_at, which
-- also moves when the Orca version or the bucket's versioning is recorded.
alter table settings
  add column printers_version integer not null default 1 check (printers_version >= 1);
