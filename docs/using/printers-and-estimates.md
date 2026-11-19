# Printers and estimates

Every plate of every `.3mf` gets a print time, a weight and grams per filament for the printer you
picked, even when the file was never sliced.

## Picking your printer

In **Settings**, pick your printer and nozzle and press **Save printer**. The menu lists every
Bambu Lab printer and nozzle that the slicer's OrcaSlicer version has a profile for, grouped by
printer. The default is the P1S with a 0.4 mm nozzle.

Saving a new printer re-estimates the whole library in the background. Until a plate's new
estimate is ready, its old numbers stay on screen, marked as made for the previous printer.

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

| Shown                                                                                | Typical cause                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| This file's print settings do not fit the selected printer.                          | The file's process cannot be used on your printer.                                                |
| This file cannot be switched to the selected printer.                                | The file is limited to printers that do not include yours.                                        |
| The plate is too big for this printer's bed.                                         | Objects do not fit, or sit outside the printable area.                                            |
| This plate needs a different nozzle or extruder setup than the selected printer has. | For example a dual-nozzle file on a single-nozzle printer.                                        |
| The filaments on this plate need print temperatures too far apart to print together. | OrcaSlicer code -62.                                                                              |
| The slicer found print paths on this plate that would collide.                       | OrcaSlicer code -101.                                                                             |
| Slicing took too long and was stopped.                                               | The plate hit the time cap.                                                                       |
| The slicer could not slice this plate.                                               | Anything else, such as code -18 (invalid values in the file). Details shows OrcaSlicer's message. |

[Troubleshooting](../troubleshooting.md#estimates) has more on each.

## When the slicer is down

If the slicer is stopped or restarting, estimates wait for it rather than failing, and carry on
when it is back. A plate that cannot reach the slicer for about 2 minutes shows as failed, and is
queued again automatically within 10 minutes once the slicer answers. A slice that was lost part
way is not retried automatically, in case it is what stopped the slicer; press **Retry** to try it
again.
