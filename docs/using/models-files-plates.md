# Models, files and plates

- A **model** is one thing in your library, such as a print project you downloaded. It has a
  name, and optionally a caption, creator, description, licence, tags and collections.
- A model holds one or more **files**: `.3mf` projects, STL, STEP or OpenSCAD files.
- A `.3mf` file holds one or more **plates**, each a separate print with its own objects and
  filaments.

## The model page

A model's page has its name at the top, with a **Rename** button (see
[Organising](./organising.md#renaming)), a large viewer on the left and three tabs on the right:
**Plates**, **Files** and **About**. On a narrow screen they stack. The tabs work with the arrow
keys, Home and End.

Pictures of prints (the large plate image, the plate strip, the Plates tab and the Files tab
preview) sit on a neutral grey backdrop, so a black or white print stays visible in both themes.

### View on MakerWorld

When a model's `.3mf` carries a MakerWorld design ID, the page shows a **View on MakerWorld** link
beside the creator and in the About tab. It opens the design's page on MakerWorld in a new tab.
The link is always built as `https://makerworld.com/models/<id>` from a checked ID; Platehouse
never uses any other address found in a file. A model with no design ID shows no link.

### Plates

Shown when the model has a `.3mf`. It lists every plate of every `.3mf`, in plate order, with:

- the thumbnail and the plate's name, or "Plate N";
- the filaments, with a colour swatch and grams for each;
- the print time and weight, and where those numbers came from (see
  [Printers and estimates](./printers-and-estimates.md)).

A `.3mf` shows its plate thumbnails large in the viewer, with a strip of plates to switch between.
Press **Show in 3D** under the picture, or click the picture, to see that plate's objects in the
3D viewer (see [A plate in 3D](#a-plate-in-3d)).

### Files

Lists the model's files, with **Open in Bambu Studio** and **Open in OrcaSlicer** for each `.3mf`
(see [Opening in a slicer](./open-in-slicer.md)) and a download for each file.

### About

Shows the caption, creator, the **View on MakerWorld** link when there is one, licence (with its
licence note, if any), tags, collections and the description. Descriptions are shown as formatted text. Links in them go only to web addresses,
and images in them show as links, so a description can never load anything from another site.

## The 3D viewer

STL files, STEP files and OpenSCAD files show in a 3D viewer you can rotate and zoom with the
pointer, or with the **Rotate**, **Zoom** and **Reset** buttons.

- A STEP file is converted to a mesh for the viewer.
- An OpenSCAD file is rendered to an STL and a preview image with OpenSCAD. Both can be viewed and
  downloaded. If the render fails, the page shows OpenSCAD's own message.
- Replacing an OpenSCAD or STEP file renders it again. Until the new render is ready, or if it
  fails, the previous version's renders stay visible and the page says they are from an earlier
  version.

While a plate is being estimated or a file is being rendered, the page checks again every few
seconds, so the result appears without a reload.

## A plate in 3D

**Show in 3D**, under a `.3mf`'s plate picture, or a click on the picture, shows only the objects
on that plate, placed as they sit on the plate, in the same 3D viewer as an STL. Each object is
coloured with its filament's colour when the file gives one, and grey when it does not. Choose
another plate in the strip to see that plate in 3D, and press **Show picture** to go back.

- The first time a plate is opened, Platehouse makes its 3D view from the file, which can take a
  few seconds for a large file; after that it opens at once. Your browser loads only that plate's
  objects, never the whole `.3mf`.
- Objects show in their filament's colour; colours painted onto parts of an object are not shown.
  Modifiers, negative parts and support blockers are left out, since they are not printed.
- When a plate cannot be shown in 3D (the file has no mesh Platehouse can read, the plate is empty,
  its objects are too large for the browser, or your browser cannot draw 3D), the picture stays
  and the page says why.

## Turning a plate image

Under a `.3mf`'s large plate image are **Rotate left**, **Rotate right**, **Flip horizontal**,
**Flip vertical** and **Reset**, for thumbnails that show upside down or mirrored. The turn is on
your screen only: nothing is saved, and the image goes back to normal when you show another plate
or open the model again.
