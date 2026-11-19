// The library's Select mode toolbar (Jon, 2026-11-19), shown above the grid
// while Select is on:
//
// - The count, in a status line, so a screen reader hears it change.
// - Select all on this page (the cards shown, every one in View all), Select
//   all matching (every match's id for the search, filters and sort, from
//   GET /app/api/library/ids, capped at View all's 1000, which it says), and
//   Clear selection.
// - The actions, each marked aria-disabled and ignoring a press while
//   nothing is selected: Add tags (type tags or pick the library's, in a
//   ChipEditor; a tag typed but not yet added to the list is sent too; a
//   model's own tags are kept; at most MAX_TAGS, the server's limit, which
//   the dialog says once the list is full), Remove tag (one of the
//   library's tags), Add to collection (an existing one offered, or a new
//   name) and Move to trash (ConfirmDialog, the app's own, with the count;
//   the trash keeps a model 30 days and it can be restored there). Each is one
//   POST /app/api/bulk/* with the selected ids (at most MAX_SELECTED), and
//   the dialog stays open, showing any failure, until the server answers.
// - The answer is shown in words (describeBulk): what changed, what was
//   already so, and in an alert the models that failed and why. A failed
//   model leaves the selection, as does one moved to the trash, and the grid
//   reloads to show the change.
import { type FormEvent, useId, useRef, useState } from "react";
import { ChipEditor } from "../collections/ChipEditor";
import { AppApiError, appApi, errorText, useAppApi } from "../settings/api";
import { ConfirmDialog, Dialog } from "../settings/Dialog";
import {
  type BulkAction,
  type BulkAnswer,
  bulkBody,
  describeBulk,
  MAX_SELECTED,
  MAX_TAGS,
} from "./selection";
import { type MessageKey, useI18n } from "../i18n/I18n";

/** The selection: each id with its model's name, or null when the page never showed it. */
export type Selection = ReadonlyMap<string, string | null>;

export interface SelectBarProps {
  selected: Selection;
  /** The cards on the page now, for Select all on this page. */
  shown: Array<{ id: string; name: string }>;
  /** Matches for the search and filters, and whether that count is capped. */
  total: number;
  totalCapped: boolean;
  /** The search, filters and sort, as GET /app/api/library/ids takes them. */
  matching: URLSearchParams;
  /** The library's tags, to pick from. */
  tags: string[];
  /** Replaces the selection. */
  onChange(next: Map<string, string | null>): void;
  /** An action changed models: reload the grid. */
  onChanged(): void;
  /** A dialog opened or closed (Escape then belongs to the dialog). */
  onDialog(open: boolean): void;
}

type Open = "add-tags" | "remove-tag" | "add-to-collection" | "trash" | null;


/** The buttons under a dialog's fields: go ahead, and Cancel. */
function DialogActions({
  label,
  busy,
  blocked = false,
  onGo,
  onCancel,
}: {
  label: string;
  busy: boolean;
  blocked?: boolean;
  onGo(): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="studio-actions">
      <button
        type="button"
        className="studio-button studio-button-primary"
        aria-disabled={busy || blocked}
        onClick={onGo}
      >
        {label}
      </button>
      <button type="button" className="studio-button" aria-disabled={busy} onClick={onCancel}>
        {t("common.cancel")}
      </button>
    </div>
  );
}

/** Runs a change for a dialog: busy while it runs, its failure kept to show. */
function useRun(onCancel: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  async function run(change: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await change();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  }
  // A change in flight cannot be called back, so the dialog stays until it answers.
  const close = () => {
    if (!busy) onCancel();
  };
  const alert =
    error === undefined ? null : (
      <p role="alert" className="studio-alert studio-alert-alert">
        {error}
      </p>
    );
  return { busy, run, close, alert };
}

function AddTagsDialog({
  count,
  tags,
  onSubmit,
  onCancel,
}: {
  count: number;
  tags: string[];
  onSubmit(tags: string[]): Promise<void>;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<string[]>([]);
  /** Text typed in the tag input but not yet added to the list (issue #257). */
  const [draft, setDraft] = useState("");
  const { busy, run, close, alert } = useRun(onCancel);
  // Add tags sends the list and any tag still being typed, so typing PLA and
  // pressing Add tags adds PLA rather than doing nothing.
  const toSend = withTag(pending, draft);
  // The server takes at most MAX_TAGS a request and answers more with its
  // validator's text, so the list stops there and Add tags will not send more.
  const full = pending.length >= MAX_TAGS;
  const tooMany = toSend.length > MAX_TAGS;
  return (
    <Dialog title={t("library.select.addTagsTitle", { models: t("library.count.models", { count }) })} onClose={close}>
      <p>{t("library.select.addTagsIntro")}</p>
      <ChipEditor
        values={pending}
        addLabel={t("library.select.tagToAdd")}
        addButton={t("library.select.addToList")}
        removeLabel={(tag) => t("library.select.takeOff", { tag })}
        suggestions={tags}
        onDraft={setDraft}
        onAdd={async (tag) => {
          // Thrown, the ChipEditor keeps the typed tag and shows why it was not added.
          if (withTag(pending, tag).length > MAX_TAGS) {
            throw new AppApiError(0, t("library.select.listFull"));
          }
          setPending((list) => withTag(list, tag));
        }}
        onRemove={async (tag) => setPending((list) => list.filter((t) => t !== tag))}
      />
      {full ? (
        <p className="studio-muted">
          {t("library.select.tagsMax", { max: MAX_TAGS })}
        </p>
      ) : null}
      {alert}
      <DialogActions
        label={t("library.select.addTags")}
        busy={busy}
        blocked={toSend.length === 0 || tooMany}
        onGo={() => {
          if (toSend.length > 0 && !tooMany) void run(() => onSubmit(toSend));
        }}
        onCancel={close}
      />
    </Dialog>
  );
}

/** list with tag added, unless it is blank or already there ignoring capitals. */
function withTag(list: string[], tag: string): string[] {
  const name = tag.trim();
  if (name === "" || list.some((t) => t.toLowerCase() === name.toLowerCase())) return list;
  return [...list, name];
}

function RemoveTagDialog({
  count,
  tags,
  onSubmit,
  onCancel,
}: {
  count: number;
  tags: string[];
  onSubmit(tag: string): Promise<void>;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [tag, setTag] = useState(tags[0] ?? "");
  const { busy, run, close, alert } = useRun(onCancel);
  return (
    <Dialog
      title={t("library.select.removeTagTitle", { models: t("library.count.models", { count }) })}
      onClose={close}
    >
      {tags.length === 0 ? (
        <p>{t("library.select.noTags")}</p>
      ) : (
        <div className="ph-field">
          <label htmlFor={id}>{t("library.select.tagToRemove")}</label>
          <select
            id={id}
            className="ph-select"
            value={tag}
            onChange={(event) => setTag(event.currentTarget.value)}
          >
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}
      {alert}
      <DialogActions
        label={t("library.select.removeTag")}
        busy={busy}
        blocked={tag === ""}
        onGo={() => {
          if (tag !== "") void run(() => onSubmit(tag));
        }}
        onCancel={close}
      />
    </Dialog>
  );
}

function CollectionDialog({
  count,
  onSubmit,
  onCancel,
}: {
  count: number;
  onSubmit(collection: string): Promise<void>;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [name, setName] = useState("");
  const existing = useAppApi<{ collections: Array<{ name: string }> }>("/collections");
  const { busy, run, close, alert } = useRun(onCancel);
  const go = () => {
    const value = name.trim();
    if (value !== "") void run(() => onSubmit(value));
  };
  return (
    <Dialog
      title={t("library.select.collectionTitle", { models: t("library.count.models", { count }) })}
      onClose={close}
    >
      <form
        className="ph-field"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          go();
        }}
      >
        <label htmlFor={id}>{t("library.select.collectionLabel")}</label>
        <input
          id={id}
          className="studio-input"
          value={name}
          maxLength={100}
          autoComplete="off"
          list={`${id}-collections`}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <datalist id={`${id}-collections`}>
          {(existing.data?.collections ?? []).map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
      </form>
      {alert}
      <DialogActions
        label={t("library.select.addToCollection")}
        busy={busy}
        blocked={name.trim() === ""}
        onGo={go}
        onCancel={close}
      />
    </Dialog>
  );
}

export function SelectBar({
  selected,
  shown,
  total,
  totalCapped,
  matching,
  tags,
  onChange,
  onChanged,
  onDialog,
}: SelectBarProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const [open, setOpenState] = useState<Open>(null);
  const [result, setResult] = useState<{ done: string; failed: string | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const count = selected.size;
  const none = count === 0;

  function setOpen(next: Open, from?: HTMLButtonElement) {
    if (from !== undefined) opener.current = from;
    setOpenState(next);
    onDialog(next !== null);
  }

  function add(entries: Array<[string, string | null]>) {
    const next = new Map(selected);
    for (const [id, name] of entries) {
      if (!next.has(id) || (next.get(id) === null && name !== null)) next.set(id, name);
    }
    onChange(next);
  }

  async function selectMatching() {
    if (picking) return;
    setPicking(true);
    setNote(null);
    try {
      const answer = await appApi<{ ids: string[]; capped: boolean }>(
        "GET",
        `/library/ids?${matching}`,
      );
      const names = new Map(shown.map((c) => [c.id, c.name]));
      add(answer.ids.map((id) => [id, names.get(id) ?? null]));
      if (answer.capped) {
        setNote(
          t("library.select.capped", { count: answer.ids.length }),
        );
      }
    } catch (failure) {
      setNote(errorText(failure));
    } finally {
      setPicking(false);
    }
  }

  async function run(action: BulkAction) {
    const ids = [...selected.keys()];
    if (ids.length > MAX_SELECTED) {
      throw new AppApiError(
        0,
        t("library.select.tooMany", { max: MAX_SELECTED }),
      );
    }
    const answer = await appApi<BulkAnswer>(
      "POST",
      `/bulk/${action.action}`,
      bulkBody(action, ids),
    );
    const names = new Map([...selected].filter((e): e is [string, string] => e[1] !== null));
    setResult(describeBulk(action, answer, names, i18n));
    const gone = new Set(answer.failed.map((f) => f.id));
    if (action.action === "trash") for (const id of answer.changed) gone.add(id);
    onChange(new Map([...selected].filter(([id]) => !gone.has(id))));
    setOpen(null);
    onChanged();
  }

  function action(name: Exclude<Open, null>, label: MessageKey, danger = false) {
    return (
      <button
        type="button"
        className={`studio-button ph-small${danger ? " ph-button-danger" : ""}`}
        aria-disabled={none}
        onClick={(event) => {
          if (none) return;
          setResult(null);
          setOpen(name, event.currentTarget);
        }}
      >
        {t(label)}
      </button>
    );
  }

  const cancel = () => setOpen(null);
  const allLabel = totalCapped
    ? t("library.select.firstMatching", { count: total })
    : t("library.select.allMatching", { count: total });

  return (
    <section className="ph-select-bar" aria-label={t("library.select.label")}>
      <p id="ph-selection-count" role="status" className="ph-select-count">
        {none ? t("library.select.none") : t("library.select.count", { count })}
      </p>
      <div className="studio-actions">
        <button
          type="button"
          className="studio-button ph-small"
          onClick={() => add(shown.map((c) => [c.id, c.name]))}
        >
          {t("library.select.page")}
        </button>
        <button
          type="button"
          className="studio-button ph-small"
          aria-disabled={picking}
          onClick={selectMatching}
        >
          {allLabel}
        </button>
        <button
          type="button"
          className="studio-button ph-small"
          onClick={() => {
            onChange(new Map());
            setNote(null);
          }}
        >
          {t("library.select.clear")}
        </button>
      </div>
      <div className="studio-actions">
        {action("add-tags", "library.select.addTags")}
        {action("remove-tag", "library.select.removeTag")}
        {action("add-to-collection", "library.select.addToCollection")}
        {action("trash", "library.select.trash", true)}
      </div>
      {note === null ? null : <p className="studio-muted">{note}</p>}
      {result === null ? null : <p className="studio-muted">{result.done}</p>}
      {result?.failed ? (
        <p role="alert" className="studio-alert studio-alert-alert">
          {result.failed}
        </p>
      ) : null}
      {open === "add-tags" ? (
        <AddTagsDialog
          count={count}
          tags={tags}
          onSubmit={(list) => run({ action: "add-tags", tags: list })}
          onCancel={cancel}
        />
      ) : null}
      {open === "remove-tag" ? (
        <RemoveTagDialog
          count={count}
          tags={tags}
          onSubmit={(tag) => run({ action: "remove-tag", tag })}
          onCancel={cancel}
        />
      ) : null}
      {open === "add-to-collection" ? (
        <CollectionDialog
          count={count}
          onSubmit={(collection) => run({ action: "add-to-collection", collection })}
          onCancel={cancel}
        />
      ) : null}
      {open === "trash" ? (
        <ConfirmDialog
          title={t("library.select.trashTitle", { models: t("library.count.models", { count }) })}
          message={t("library.select.trashMessage", { count })}
          confirmLabel={t("library.select.trash")}
          onConfirm={() => run({ action: "trash" })}
          onCancel={cancel}
          returnFocusTo={opener}
        />
      ) : null}
    </section>
  );
}
