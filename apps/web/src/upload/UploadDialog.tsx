// The upload dialog. It opens when files are
// dropped on the library or a model page and from the top
// bar's Add. It lists every file with its own progress bar and state, and
// has the "Combine into one model" switch, off by default: off, each file
// becomes its own model; on, every file is sent with one batch id and
// combine, so they land in one model (the server's batch target). The batch id
// is made at the first Upload with the switch on and kept until the dialog
// is closed or the switch is changed, so files added and sent while an
// earlier round is still uploading join the same model (ingest joins every
// later file of a batch to the model the first one made). Hiding the dialog
// while files are sending is closing it too: when that round finishes while
// it is hidden, the batch ends and the switch goes off, so a file added later
// is never joined to the earlier model, and the rows that went in are
// cleared. A row that failed keeps its reason, and a row not yet sent stays,
// until the dialog is next closed with nothing in flight. Into
// an existing model (modelId) there is nothing to combine, so the switch is
// not shown.
//
// It is a themed dialog in the page (role dialog, aria-modal), never a
// native browser dialog: focus moves into it when it opens, Tab stays inside
// it, Escape closes it, and focus goes back where it was. Escape and Tab are
// handled on the document while it is open, so they keep working wherever
// focus has gone, and Tab from outside it (the shell behind) goes back into
// it; pressing the backdrop keeps focus in the dialog. Closing while
// files are still sending only hides it: the uploads go on, and every row
// still sending, failed or not yet sent is there when it is opened again (a
// row that went in is cleared when its round ends while hidden). Files that
// are not a supported type are listed with the reason and never sent.
//
// While it is open, files dropped on it or anywhere on its backdrop (which
// covers the page) are added to the list. It is rendered beside the routes,
// so a page's DropZone is under the backdrop and never sees the drop. Being
// mounted on every page, it also stops the browser's own handling of a file
// dropped where nothing takes it (the sidebar, the top bar, a page with no
// drop zone), which would otherwise open or download the file and leave the
// app. Text and links dragged over the page keep the browser's handling.
//
// Duplicates (approved for 0.1.0 by the maintainer, 2026-11-19): the dialog says up
// front that a file already in the library is skipped. A file the server
// skips (its SHA-256 matches a file in a live model; a trashed one does not
// count) shows Skipped, names the model that holds it with a link to its
// page, and offers Import anyway, which sends that file again and stores it.
// The link moves within the app and hides the dialog, so uploads still
// sending carry on; outside a router (the tests) it is a plain link.
import {
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link, useInRouterContext } from "react-router";
import { ENGLISH_I18N, type I18n, useI18n } from "../i18n/I18n";
import "./upload.css";
import {
  ACCEPT,
  type DuplicateMatch,
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

function statusText(item: UploadItem, i18n: Pick<I18n, "t" | "fmt">): string {
  const { t } = i18n;
  switch (item.status) {
    case "ready":
      return t("upload.status.ready");
    case "unsupported":
      return item.message ?? t("upload.status.unsupported");
    case "uploading":
      return i18n.fmt.percent(percent(item));
    case "adding":
      return t("upload.status.adding");
    case "done":
      return t("upload.status.added");
    case "failed":
      return item.message ?? t("upload.failed");
    case "duplicate":
      return t("upload.status.skipped");
  }
}

/** Shown under the intro: what happens to a file already in the library. */
export const DUPLICATES_TEXT = ENGLISH_I18N.t("upload.duplicates");

/** The link to a model's page: in the app when there is a router, a plain link otherwise. */
function ModelLink({
  modelId,
  onFollow,
  children,
}: {
  modelId: string;
  onFollow(): void;
  children: ReactNode;
}) {
  const routed = useInRouterContext();
  const to = `/models/${modelId}`;
  if (!routed) return <a href={to}>{children}</a>;
  return (
    <Link to={to} onClick={onFollow}>
      {children}
    </Link>
  );
}

/** A skipped row's sentence: the first model that holds the file, linked, and how many others. */
function DuplicateNote({
  duplicates,
  onFollow,
}: {
  duplicates: readonly DuplicateMatch[];
  onFollow(): void;
}) {
  const { rich } = useI18n();
  const first = duplicates[0];
  if (first === undefined) return null;
  const others = new Set(duplicates.map((d) => d.modelId));
  others.delete(first.modelId);
  return (
    <span className="ph-upload-duplicate-text">
      {rich(
        "upload.duplicate.note",
        { name: first.modelName, others: others.size },
        {
          link: (children) => (
            <ModelLink modelId={first.modelId} onFollow={onFollow}>
              {children}
            </ModelLink>
          ),
        },
      )}
    </span>
  );
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
  const i18n = useI18n();
  const { t } = i18n;
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<Element | null>(null);
  /** The current close(), for the document's key handler. */
  const closeRef = useRef<() => void>(() => {});
  const [combine, setCombine] = useState(false);
  /** The combined batch's id, from its first Upload until close or a switch change. */
  const batch = useRef<string | null>(null);
  /** Whether the dialog is open, for a round that finishes while it is hidden. */
  const isOpen = useRef(open);
  isOpen.current = open;
  const upload = useTusUpload({
    ...(start === undefined ? {} : { start }),
    ...(fetchResult === undefined ? {} : { fetchResult }),
    ...(resultDelayMs === undefined ? {} : { resultDelayMs }),
    onFinished: () => {
      // Hidden while it was sending: the user has closed it, so the batch
      // ends here, as close() would have ended it. Only the rows that went
      // in are cleared: a failed row keeps its reason and an unsent row
      // stays, so they are there when the dialog is opened again.
      if (!isOpen.current) {
        upload.clearDone();
        setCombine(false);
        batch.current = null;
      }
      onUploaded?.();
    },
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
      batch.current = null;
    }
    onClose();
  }
  closeRef.current = close;

  function send() {
    if (modelId === undefined && combine && batch.current === null) batch.current = newBatchId();
    const target: UploadTarget =
      modelId !== undefined
        ? { kind: "model", modelId }
        : combine && batch.current !== null
          ? { kind: "batch", batch: batch.current }
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
        <h2 id={titleId}>{t("upload.title")}</h2>
        <p className="studio-muted">
          {modelId !== undefined ? t("upload.intro.model") : t("upload.intro.new")}{" "}
          {t("upload.supported")}
        </p>
        <p className="studio-muted">{t("upload.duplicates")}</p>

        {items.length === 0 ? (
          <p className="studio-empty">{t("upload.empty")}</p>
        ) : (
          <ul className="ph-upload-list" aria-label={t("model.tab.files")}>
            {items.map((item) => (
              <li key={item.key} className="ph-upload-row" data-upload={item.file.name}>
                <span className="ph-upload-name">{item.file.name}</span>
                {item.status === "unsupported" ? null : (
                  <progress
                    aria-label={t("upload.progress", { name: item.file.name })}
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
                  {statusText(item, i18n)}
                </span>
                {item.status === "duplicate" ? (
                  <div className="ph-upload-duplicate">
                    {/* close(), not onClose: following the link is a close, so the
                        settled rows clear and the combined batch ends as on Close. */}
                    <DuplicateNote duplicates={item.duplicates ?? []} onFollow={close} />
                    <button
                      type="button"
                      className="studio-button"
                      onClick={() => upload.importAnyway(item.key)}
                    >
                      {t("upload.importAnyway")}
                    </button>
                  </div>
                ) : null}
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
            {t("upload.choose")}
          </button>
          {modelId !== undefined ? null : (
            <label className="ph-switch">
              <input
                type="checkbox"
                role="switch"
                aria-checked={combine}
                checked={combine}
                disabled={busy}
                onChange={(event) => {
                  batch.current = null;
                  setCombine(event.currentTarget.checked);
                }}
              />
              <span>{t("upload.combine")}</span>
            </label>
          )}
        </div>

        <div className="ph-dialog-actions">
          <button type="button" className="studio-button" onClick={close}>
            {busy ? t("upload.hide") : t("upload.close")}
          </button>
          <button
            type="button"
            className="studio-button studio-button-primary"
            disabled={ready === 0}
            onClick={send}
          >
            {t("upload.send", { count: ready })}
          </button>
        </div>
      </div>
    </div>
  );
}
