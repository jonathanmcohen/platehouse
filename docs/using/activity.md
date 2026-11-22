# Activity

The **Activity** page, in the sidebar between Trash and Settings, shows what Platehouse is doing and
what has gone wrong lately. It is the first place to look when an import, an estimate or a render
did not turn out as expected.

## What it shows

- **Library**: how many models are in the library and in the trash, files by kind, plates, the
  number and total size of stored objects, and when the last import happened.
- **Estimates**: progress for your default printer, as a progress bar with a rough time left.
- **Queues**: the background job queues (imports, the slicer queue and maintenance) and what is
  waiting or running in each.
- **Scheduled jobs**: the daily and regular jobs, such as the trash purge and the cleanup, with
  their last runs. After an upgrade from 0.1.0 or 0.1.1-rc.1, "MakerWorld description
  re-conversion (until it finishes)" is listed too while stored MakerWorld descriptions are being converted again; it
  goes once the re-conversion has finished.
- **Slicer**: whether the slicer is healthy, and its OrcaSlicer and OpenSCAD versions.
- **Recent events**: the newest 50 events: models added, inbox files that failed, estimates that
  failed (with the same **Retry** as on the model page), renders and STEP conversions that
  failed, and "MakerWorld descriptions converted again", which says how many stored descriptions
  the re-conversion changed, how many were already right, how many it left as they were because
  they were edited or not written from their file, and how many files it could not read.

The page builds everything from what the database, the job queues and the inbox's `failed` folder
record. It shows no log lines, and it takes file paths, network addresses and tokens out of any
stored error text before showing it.

## Refreshing

The page refreshes itself every 5 seconds while work is pending and every 30 seconds otherwise.
It stops refreshing while its browser tab is hidden.
