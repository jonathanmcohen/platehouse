// A drop target for files (build plan Task 19, AC-020): the library page, and
// the model page (Task 20), wrap their content in it. Dropping files on it
// hands them to onFiles, which opens the upload dialog. While files are
// dragged over it, it is outlined in the accent colour. Text or links
// dragged over it are left alone, so the browser's own handling stays.
// Dropping is a pointer gesture; the dialog's Choose files button and the
// top bar's Add are the keyboard routes to the same dialog.
import { type DragEvent, type ReactNode, useRef, useState } from "react";

export interface DropZoneProps {
  onFiles(files: File[]): void;
  children?: ReactNode;
}

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes("Files");
}

export function DropZone({ onFiles, children }: DropZoneProps) {
  const [active, setActive] = useState(false);
  // dragenter and dragleave fire for every child crossed; count them.
  const depth = useRef(0);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target is a pointer gesture only; Add and the dialog's Choose files are the keyboard routes.
    <div
      className={active ? "ph-dropzone ph-dropzone-active" : "ph-dropzone"}
      data-dropzone=""
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setActive(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setActive(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
    </div>
  );
}
