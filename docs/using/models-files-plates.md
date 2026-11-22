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
There is no 3D view of a `.3mf`.

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
- An STL or STEP file gets a preview picture, rendered with OpenSCAD from the STL, or from the
  STEP file's mesh. It is the model's picture on its library card and shows in the **Files** tab.
  If it cannot be rendered, the card keeps the file-type icon and the **Files** tab says why; a
  STEP file's 3D view still works. Files added before Platehouse 0.1.1 get their preview in the
  background, a few at a time, after the upgrade.
- Replacing an OpenSCAD or STEP file renders it again. Until the new render is ready, or if it
  fails, the previous version's renders stay visible and the page says they are from an earlier
  version.

While a plate is being estimated or a file is being rendered, the page checks again every few
seconds, so the result appears without a reload.

## Turning a plate image

Under a `.3mf`'s large plate image are **Rotate left**, **Rotate right**, **Flip horizontal**,
**Flip vertical** and **Reset**, for thumbnails that show upside down or mirrored. The turn is on
your screen only: nothing is saved, and the image goes back to normal when you show another plate
or open the model again.
