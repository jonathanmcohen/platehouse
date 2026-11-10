-- Platehouse schema 0003: which filament preset produced each filament's
-- grams (build plan Task 12, AC-032; the slicer's Bambu presets, PR #55).
-- Hand-written; every statement is read in review (lesson 14). Never edit it
-- once applied anywhere: a change is a new file.
--
-- A Platehouse estimate's grams per filament come from a slice that loaded,
-- for each filament slot, Bambu's own preset for the selected printer, else
-- Orca's Generic preset, else the file's own filament. profile is the preset
-- the slicer reported for the slot (null where it kept the file's own) and
-- profile_source says which of the three it was, so the plate can name the
-- preset beside its numbers. Both stay null on a file's own numbers (source
-- 'file'), which Bambu Studio produced with presets the file does not name.
-- Additive only: no existing row or column changes.
alter table estimate_filaments
  add column profile        text,
  add column profile_source text
    check (profile_source in ('bambu', 'generic', 'file'));
