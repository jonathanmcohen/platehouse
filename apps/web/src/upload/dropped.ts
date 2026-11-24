// What a drop hands over. A dropped folder arrives in dataTransfer.files as a
// File with no type and a few KiB of size, named for the folder, so it looks
// like a file with an odd name (and a folder named "Parts.stl" looks like a
// model). The browser says which entries are folders only through
// dataTransfer.items (webkitGetAsEntry), and only during the drop, so the
// drop is read here, once, and each folder's File is remembered. The upload
// list then says "Folders can't be uploaded" for it instead of "Not a
// supported file type". Reading a folder's files is not done: the answer is
// to drop the files inside it.

const folders = new WeakSet<File>();

/** Whether the file stands for a dropped folder. */
export function isFolder(file: File): boolean {
  return folders.has(file);
}

/** The files of a drop, with each dropped folder's File remembered as a folder. */
export function droppedFiles(transfer: DataTransfer | null | undefined): File[] {
  const files = Array.from(transfer?.files ?? []);
  // The "file" items are in the same order as the files.
  const items = Array.from(transfer?.items ?? []).filter((item) => item.kind === "file");
  if (items.length === files.length) {
    items.forEach((item, at) => {
      const file = files[at];
      if (file === undefined) return;
      try {
        if (item.webkitGetAsEntry?.()?.isDirectory === true) folders.add(file);
      } catch {
        // An item the browser will not describe is taken as a file.
      }
    });
  }
  return files;
}
