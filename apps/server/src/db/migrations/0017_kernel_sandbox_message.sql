-- Platehouse schema 0017: the kernel "sandbox off" sentences stop naming a
-- version (0.1.2 step 4, #498). Hand-written; every statement is read in
-- review. Never edit it once applied anywhere: a change is a new file.
--
-- 0.1.1 stored "its kernel is older than Linux 6.12" for every kernel that
-- cannot give the slicer its sandbox, but a newer kernel can fail too
-- (Landlock off, a missing 2025 fix). The new sentences say only that the
-- kernel does not offer the sandbox and that Activity says why. This file
-- rewrites the exact old sentences already stored:
--
-- - files.derived_message, the sentence alone and after the "previous
--   renders" lead-in, for OpenSCAD and for STEP.
-- - files.preview_failure_message, the OpenSCAD sentence (0016 stored only
--   that one). preview_failure_reason keeps its code, sandbox_off_kernel.
-- - estimates.failure_detail.
--
-- The texts are frozen here on purpose: DERIVED_MESSAGES may change wording
-- again. Any other message, such as a program's own words that end with the
-- old sentence, is left as it is. No schema change.

update files set derived_message = case derived_message
  when 'Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.'
    then 'Pictures and OpenSCAD renders are off on this server: its kernel does not offer the sandbox they need. Activity says why.'
  when 'STEP previews are off on this server: its kernel is older than Linux 6.12.'
    then 'STEP previews are off on this server: its kernel does not offer the sandbox they need. Activity says why.'
  when 'OpenSCAD rejected the current version of this file, so the STL and preview shown are from an earlier version. Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.'
    then 'OpenSCAD rejected the current version of this file, so the STL and preview shown are from an earlier version. Pictures and OpenSCAD renders are off on this server: its kernel does not offer the sandbox they need. Activity says why.'
  when 'The STEP converter rejected the current version of this file, so the mesh shown is from an earlier version. STEP previews are off on this server: its kernel is older than Linux 6.12.'
    then 'The STEP converter rejected the current version of this file, so the mesh shown is from an earlier version. STEP previews are off on this server: its kernel does not offer the sandbox they need. Activity says why.'
end
where derived_message in (
  'Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.',
  'STEP previews are off on this server: its kernel is older than Linux 6.12.',
  'OpenSCAD rejected the current version of this file, so the STL and preview shown are from an earlier version. Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.',
  'The STEP converter rejected the current version of this file, so the mesh shown is from an earlier version. STEP previews are off on this server: its kernel is older than Linux 6.12.'
);

update files set preview_failure_message = case preview_failure_message
  when 'Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.'
    then 'Pictures and OpenSCAD renders are off on this server: its kernel does not offer the sandbox they need. Activity says why.'
end
where preview_failure_message in (
  'Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.'
);

update estimates set failure_detail = case failure_detail
  when 'Estimates are off on this server: its kernel is older than Linux 6.12.'
    then 'Estimates are off on this server: its kernel does not offer the sandbox they need. Activity says why.'
end
where failure_detail in (
  'Estimates are off on this server: its kernel is older than Linux 6.12.'
);
