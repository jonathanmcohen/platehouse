---
description: What the Activity page shows about the library, the background jobs, the slicer and recent events.
---

# Activity

The **Activity** page, in the sidebar between Trash and Settings, shows what Platehouse is doing and
what has gone wrong lately. It is the first place to look when an import, an estimate or a render
did not turn out as expected.

## What it shows

- **Library**: **Models**, **In the trash**, **Plates**, the files of each kind (**3MF files**,
  **STL files**, **STEP files** and **SCAD files**), **Stored objects**, **Stored size** and
  **Last import**.
- **Estimates**: progress for your default printer, named with the OrcaSlicer version that makes
  its estimates: a progress bar of the plates settled, counting failures, with a rough time left,
  and the counts **Done**, **Waiting**, **Slicing** and **Failed**.
- **Queues**: how many jobs are waiting, running and failed in each queue: **Ingest (new files)**,
  **Estimates (slicing)**, **OpenSCAD renders**, **STEP conversion** and **Scheduled jobs**, and
  **Other slicer work** while a slicer job of another kind is there. The preview pictures of STL
  and STEP files count as OpenSCAD renders. Failed jobs are kept for 7 days.
- **Scheduled jobs**: the daily and regular jobs, such as the trash purge, the cleanup and
  "Preview pictures for older STL and STEP files", with their last runs. After an upgrade from a version before 0.1.1, "MakerWorld descriptions
  and licences (until they finish)" is listed too while stored MakerWorld descriptions and missing licences are being
  read again; it goes once that has finished. On a new install the row can appear briefly.
- **Slicer**: see [The Slicer section](#the-slicer-section) below.
- **Recent events**: the newest 50 events: **Model added**, **Inbox file failed**, **Estimate
  failed** (with the same **Retry** as on the model page), **OpenSCAD render failed**, **STEP
  conversion failed**, **Preview picture failed**, and **MakerWorld descriptions converted
  again**, which says how many stored descriptions the re-conversion changed, how many were
  already right, how many it left as they were because they were edited or not written from their
  file, and how many files it could not read.

The page builds everything from what the database, the job queues and the inbox's `failed` folder
record. It shows no log lines, and it takes file paths, network addresses and tokens out of any
stored error text before showing it.

## The Slicer section

- **Status**: **Reachable, idle**, **Reachable, slicing now** or **Not reachable**. While the
  slicer is not reachable, a note says that estimates and renders wait until it is back.
- **OrcaSlicer** and **OpenSCAD**: the versions in the slicer image, or **Unknown**.
- **Default printer**: the printer the Estimates section and the API answer for, the default in
  [My printers](./printers-and-estimates.md#my-printers).
- **Sandbox**, the last entry of the list:
  - **On**: everything runs inside the slicer's sandbox, as it should.
  - **Checking**: the slicer has not finished checking its sandbox yet, as just after it starts.
  - **Off.** with the reason. When the cause is the kernel, Activity says which: the server's
    kernel is older than Linux 6.12; Landlock is turned off in the kernel or the container
    runtime blocks it; or the kernel lacks the 2025 Landlock fix. When the slicer cannot say
    which, the line says only that the kernel does not offer the sandbox it needs. Otherwise the sandbox check
    failed. Pictures, OpenSCAD renders, STEP previews and estimates are then off. With
    `SLICER_ALLOW_UNSANDBOXED=true` on the slicer, a line below the list says that estimates and
    STEP previews still run, without the sandbox, while pictures and OpenSCAD renders stay off.
    For a kernel cause, see
    [The sandbox is off on a new kernel](../troubleshooting.md#the-sandbox-is-off-on-a-new-kernel).

  The slicer reports itself healthy whether its sandbox is on or off, so this line, not
  `docker compose ps`, is where to check it. With no sandbox line, the slicer did not answer, or
  its answer could not be read; see [Troubleshooting](../troubleshooting.md#estimates). For a
  sandbox that is off, see [Troubleshooting](../troubleshooting.md#renders-and-step-files) and
  [Install](../install.md#what-you-need).

## Refreshing

The page refreshes itself every 5 seconds while work is pending and every 30 seconds otherwise.
It stops refreshing while its browser tab is hidden.
