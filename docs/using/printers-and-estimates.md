---
description: Where the print time, weight and filament numbers come from, and how My printers works.
---

# Printers and estimates

Every plate of every `.3mf` gets a print time, a weight and grams per filament for each printer in
**My printers**, even when the file was never sliced.

## My printers

**My printers**, in **Settings**, is the list of printers you own. Platehouse estimates every
plate for every printer in it. A new install starts with one printer, the P1S with a 0.4 mm
nozzle, as the default. Every printer is named in full, such as "Bambu Lab P1S, 0.4 mm nozzle".

- **Add a printer**: pick a printer and nozzle in the **Add a printer** menu and press **Add
  printer**. The menu lists every Bambu Lab printer and nozzle that the slicer's OrcaSlicer version
  has a profile for, grouped by printer model. Choosing in the menu saves nothing until you press
  **Add printer**.
- **Adding a printer queues the whole library.** Every plate in the library is queued for the new
  printer, except plates whose file already carries Bambu's own numbers for it. The slicer does one
  plate at a time, so a large library can take an hour or more. The page says how many plates were
  queued and about how long they will take, counting any other work already queued ahead of them.
  Each printer in the list shows the plates it still has waiting and about how long is left.
- **How the time is worked out**: from how fast your slicer works while it is busy. Platehouse
  records when each slice starts and finishes, and takes the 50 most recent successful slices: the
  rate is how many there are divided by the time the slicer spent on them. Time when the slicer
  was waiting for work is never counted, however long, and a slow plate always counts, however
  slow. Until 10 slices have been timed this way, the page assumes 6 plates a minute; slices from
  before 0.1.1 have no start time, so after an upgrade the page uses 6 a minute until 10 new ones
  have finished. In 0.1.0 the page always assumed 3 plates a minute, which made every time about 3
  times too long ([#317](https://github.com/jonathanmcohen/platehouse/issues/317)).
- **The order**: **Up** and **Down** move a printer in the list. The list order is the order the
  printer switch offers them in.
- **One default**: one printer is marked **Default**. Its numbers are shown first on the library
  and model pages, and the Activity page and the API answer for it. **Make default** on another
  printer changes it. Changing the order or the default starts no slicing.
- **Remove** asks first, in a dialog that says how many plates are still waiting for that printer.
  Removing a printer drops the estimates still waiting for it; numbers already made for it are
  kept. The default printer cannot be removed: make another printer the default first, so the list
  is never empty.

If you change My printers in another browser window while this one is open, a change from the
older window is refused and nothing is saved. The page reads the list again and says so; make the
change again from the list as it is now.

A printer in the list that the slicer no longer offers (for example after an OrcaSlicer update
renamed its profile) stays in the list, marked as one nothing can be estimated for.

## The printer switch

The library header and the model page's **Plates** tab say which printer the times and weights
are for. With more than one printer in My printers, that line is a menu, **Times and weights for**,
that switches the page to another printer's numbers. The switch only shows numbers that already
exist or are on their way; it never starts slicing. Your browser remembers the choice, so the
library and the model page show the same printer, and a reload keeps it. If the chosen printer is
removed from My printers, the pages go back to the default.

## Where the numbers come from

Each set of numbers on a plate says where it came from:

- **"Bambu, in the file"**: the file was sliced in Bambu Studio and carries its own numbers. They
  are labelled with the printer they were sliced for and the process. If that printer is not one
  the slicer knows, the label says "Sliced for another printer".
- **A Platehouse estimate**: when the file has no numbers for your printer, Platehouse slices the
  plate with OrcaSlicer. The estimate is labelled as an estimate, with the slicer and its version,
  the printer, the process and the filament preset used for each filament.

An estimate uses OrcaSlicer's built-in profile for your printer and nozzle, the file's own process
settings (layer height, walls, infill and the rest) and, for each filament, Bambu's own preset for
that filament type where one exists (PLA Basic, PETG HF, ABS, ASA, TPU 95A), else OrcaSlicer's
Generic preset for the type, else the file's own filament settings. Estimates are rough numbers,
good for comparing and planning, not exact.

## How estimating works

- Estimates run in the background, one plate at a time, after the upload has finished. A plate
  waiting for one shows "estimating", and its numbers appear on the model page without a reload.
- Each plate has a time cap, `SLICE_PLATE_SECONDS` (120 seconds by default). A plate that runs
  over is stopped and shows "Slicing took too long and was stopped."
- Every estimate records the OrcaSlicer version that made it. When the slicer is updated to a new
  OrcaSlicer version, the library is re-estimated in the background.
- No G-code is kept. A slice is used for its numbers and thrown away.

## When a plate cannot be sliced

The plate shows the reason in plain words, with OrcaSlicer's own message behind a **Details**
button (with file paths, network addresses and tokens taken out, as on the Activity page and in
the API), and a **Retry** button that slices it again from the stored file. The other plates still
get their numbers. The reasons are:

| Shown                                                                                                                          | Typical cause                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| This file's print settings do not fit the selected printer.                                                                    | The file's process cannot be used on your printer.                                                                        |
| This file cannot be switched to the selected printer.                                                                          | The file is limited to printers that do not include yours.                                                                |
| The plate is too big for this printer's bed.                                                                                   | Objects do not fit, or sit outside the printable area.                                                                    |
| This plate needs a different nozzle or extruder setup than the selected printer has.                                           | For example a dual-nozzle file on a single-nozzle printer.                                                                |
| The filaments on this plate need print temperatures too far apart to print together.                                           | OrcaSlicer code -62.                                                                                                      |
| The slicer found print paths on this plate that would collide.                                                                 | OrcaSlicer code -101.                                                                                                     |
| Slicing took too long and was stopped.                                                                                         | The plate hit the time cap.                                                                                               |
| The slicer could not slice this plate.                                                                                         | Anything else, such as code -18 (invalid values in the file). Details shows OrcaSlicer's message.                         |
| The slicer could not slice this plate. (**Details**: "Estimates are off on this server: its kernel is older than Linux 6.12.") | The slicer's sandbox is off because the host's kernel is too old. See [Troubleshooting](../troubleshooting.md#estimates). |
| The slicer could not slice this plate. (**Details**: "Estimates are off on this server: its sandbox check failed.")            | The slicer's sandbox is off because its check failed. See [Troubleshooting](../troubleshooting.md#estimates).             |

[Troubleshooting](../troubleshooting.md#estimates) has more on each.

## When the slicer is down

If the slicer is stopped or restarting, estimates wait for it rather than failing, and carry on
when it is back. A plate that cannot reach the slicer for about 2 minutes shows as failed, and is
queued again automatically within 10 minutes once the slicer answers. A slice that was lost part
way is not retried automatically, in case it is what stopped the slicer; press **Retry** to try it
again.
