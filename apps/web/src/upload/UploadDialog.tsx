// The upload dialog (build plan Task 19, AC-020). It opens when files are
// dropped on the library (or, from Task 20, a model page) and from the top
// bar's Add. It lists every file with its own progress bar and state, and
// has the "Combine into one model" switch, off by default: off, each file
// becomes its own model; on, every file is sent with one batch id and
// combine, so they land in one model (Task 8's batch target). Into an
// existing model (modelId) there is nothing to combine, so the switch is
// not shown.
//
// It is a themed dialog in the page (role dialog, aria-modal), never a
// native browser dialog: focus moves into it when it opens, Tab stays inside
// it, Escape closes it, and focus goes back where it was. Escape and Tab are
// handled on the document while it is open, so they keep working wherever
// focus has gone, and Tab from outside it (the shell behind) goes back into
// it; pressing the backdrop keeps focus in the dialog. Closing while
// files are still sending only hides it: the uploads go on and their rows
// are there when it is opened again. Files that are not a supported type
// are listed with the reason and never sent.
//
// While it is open, files dropped on it or anywhere on its backdrop (which
// covers the page) are added to the list. It is rendered beside the routes,
// so a page's DropZone is under the backdrop and never sees the drop. Being
// mounted on every page, it also stops the browser's own handling of a file
// dropped where nothing takes it (the sidebar, the top bar, a page with no
// drop zone), which would otherwise open or download the file and leave the
// app. Text and links dragged over the page keep the browser's handling.
import { type DragEvent, type MouseEvent, useEffect, useId, useRef, useState } from "react";
import "./upload.css";
import {
  ACCEPT,
  type FetchResult,
  type StartUpload,
  type UploadItem,
  type UploadTarget,
  useTusUpload,
} from "./useTusUpload";

export interface UploadDialogProps {
  open: boolean;
  /** Files to add to the list: each new array is added once. */
  files: File[];
  /** Upload into this existing model instead of making new ones. */
  modelId?: string;
  onClose(): void;
  /** Runs when every file sent has finished, so the page can reload. */
  onUploaded?: () => void;
  /** The tus upload; tus-js-client's when left out. */
  start?: StartUpload;
  /** The result check; GET <upload>/result when left out. */
  fetchResult?: FetchResult;
  /** Wait between result checks, in ms. */
  resultDelayMs?: number;
}

function carriesFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes("Files");
}

/**
 * Stops a file drop no drop target took from leaving the app. Drop targets
 * handle the event first (React listens on the root, below window) and call
 * preventDefault; an untouched dragover is marked "none", so the pointer
 * shows the file cannot be dropped there.
 */
function guardFileDrops(): () => void {
  const onDragOver = (event: globalThis.DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "none";
  };
  const onDrop = (event: globalThis.DragEvent) => {
    if (carriesFiles(event)) event.preventDefault();
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
  };
}

function newBatchId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function percent(item: UploadItem): number {
  if (item.total <= 0) return 0;
  return Math.min(100, Math.round((item.sent / item.total) * 100));
}

function statusText(item: UploadItem): string {
  switch (item.status) {
    case "ready":
      return "Ready";
    case "unsupported":
      return item.message ?? "Not a supported file type";
    case "uploading":
      return `${percent(item)}%`;
    case "adding":
      return "Adding to the library";
    case "done":
      return "Added";
    case "failed":
      return item.message ?? "The upload failed.";
  }
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([hidden]), [href], [tabindex]:not([tabindex="-1"])';

export function UploadDialog({
  open,
  files,
  modelId,
  onClose,
  onUploaded,
  start,
  fetchResult,
  resultDelayMs,
}: UploadDialogProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<Element | null>(null);
  /** The current close(), for the document's key handler. */
  const closeRef = useRef<() => void>(() => {});
  const [combine, setCombine] = useState(false);
  const upload = useTusUpload({
    ...(start === undefined ? {} : { start }),
    ...(fetchResult === undefined ? {} : { fetchResult }),
    ...(resultDelayMs === undefined ? {} : { resultDelayMs }),
    onFinished: () => onUploaded?.(),
  });
  const { addFiles, items, busy } = upload;

  useEffect(() => {
    if (files.length > 0) addFiles(files);
  }, [files, addFiles]);

  useEffect(() => guardFileDrops(), []);

  // Focus moves into the dialog when it opens and back when it closes.
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement;
    dialog.current?.focus();
    return () => {
      const back = returnFocus.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [open]);

  // Escape and the Tab trap, on the document while the dialog is open: a
  // click on the backdrop or elsewhere can leave focus outside the dialog,
  // and the shell behind it is not inert.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const box = dialog.current;
      if (box === null) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (first === undefined || last === undefined) {
        event.preventDefault();
        box.focus();
        return;
      }
      if (!box.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === box)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  const ready = items.filter((i) => i.status === "ready").length;

  function close() {
    if (!busy) {
      upload.clearSettled();
      setCombine(false);
    }
    onClose();
  }
  closeRef.current = close;

  function send() {
    const target: UploadTarget =
      modelId !== undefined
        ? { kind: "model", modelId }
        : combine
          ? { kind: "batch", batch: newBatchId() }
          : { kind: "new" };
    upload.begin(target);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (dropped.length > 0) addFiles(dropped);
  }

  // Pressing the backdrop itself would move focus to the page behind the
  // dialog; it stays in the dialog instead.
  function onBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files and pressing the backdrop are pointer gestures only; Choose files is the keyboard route, and Escape and Tab are handled on the document.
    <div
      className="ph-dialog-backdrop"
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseDown={onBackdropMouseDown}
    >
      <div
        ref={dialog}
        className="ph-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId}>Add files</h2>
        <p className="studio-muted">
          {modelId !== undefined
            ? "The files are added to this model."
            : "Each file becomes its own model unless you combine them."}{" "}
          Supported: .3mf, .stl, .step, .stp and .scad.
        </p>

        {items.length === 0 ? (
          <p className="studio-empty">No files yet. Choose files, or drop them here.</p>
        ) : (
          <ul className="ph-upload-list" aria-label="Files">
            {items.map((item) => (
              <li key={item.key} className="ph-upload-row" data-upload={item.file.name}>
                <span className="ph-upload-name">{item.file.name}</span>
                {item.status === "unsupported" ? null : (
                  <progress
                    aria-label={`Upload progress for ${item.file.name}`}
                    value={item.sent}
                    max={item.total > 0 ? item.total : 1}
                  />
                )}
                <span
                  className={
                    item.status === "failed" || item.status === "unsupported"
                      ? "ph-upload-status ph-upload-status-bad"
                      : "ph-upload-status"
                  }
                >
                  {statusText(item)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="ph-dialog-controls">
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <button type="button" className="studio-button" onClick={() => picker.current?.click()}>
            Choose files
          </button>
          {modelId !== undefined ? null : (
            <label className="ph-switch">
              <input
                type="checkbox"
                role="switch"
                aria-checked={combine}
                checked={combine}
                disabled={busy}
                onChange={(event) => setCombine(event.currentTarget.checked)}
              />
              <span>Combine into one model</span>
            </label>
          )}
        </div>

        <div className="ph-dialog-actions">
          <button type="button" className="studio-button" onClick={close}>
            {busy ? "Hide" : "Close"}
          </button>
          <button
            type="button"
            className="studio-button studio-button-primary"
            disabled={ready === 0}
            onClick={send}
          >
            Upload {ready === 1 ? "1 file" : `${ready} files`}
          </button>
        </div>
      </div>
    </div>
  );
}
