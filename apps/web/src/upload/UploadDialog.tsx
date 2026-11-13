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
// it, Escape closes it, and focus goes back where it was. Closing while
// files are still sending only hides it: the uploads go on and their rows
// are there when it is opened again. Files that are not a supported type
// are listed with the reason and never sent.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
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

  if (!open) return null;

  const ready = items.filter((i) => i.status === "ready").length;

  function close() {
    if (!busy) {
      upload.clearSettled();
      setCombine(false);
    }
    onClose();
  }

  function send() {
    const target: UploadTarget =
      modelId !== undefined
        ? { kind: "model", modelId }
        : combine
          ? { kind: "batch", batch: newBatchId() }
          : { kind: "new" };
    upload.begin(target);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab" || dialog.current === null) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialog.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="ph-dialog-backdrop">
      <div
        ref={dialog}
        className="ph-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>Add files</h2>
        <p className="studio-muted">
          {modelId !== undefined
            ? "The files are added to this model."
            : "Each file becomes its own model unless you combine them."}{" "}
          Supported: .3mf, .stl, .step, .stp and .scad.
        </p>

        {items.length === 0 ? (
          <p className="studio-empty">No files yet. Choose files, or drop them on the library.</p>
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
