// The shape the Creators, Collections and Tags pages share. Without ?name= the page lists every creator that has live models,
// and every collection or tag but one only trashed models use, with how
// many live models (issue #312: one no model uses shows 0). With ?name= it
// shows that one's models, each ready to organise (ModelRows), and a link
// to the library filtered by it. ModelRows stays on the page once the models are in, even when the
// last one is moved to the trash, so its status line can say so and take
// focus. The name lives in the query string, so the page path stays the one
// shell page the server answers (SHELL_PAGES) and a reload or a shared link
// shows the same thing.
//
// Following a name in the list, or the All link back, swaps one view for the
// other in place, and the link that was pressed leaves with the old view.
// So, as the shell does after a menu link, focus then goes to the new view's
// heading (the name's heading, or the page heading for the list), each
// focusable with tabIndex -1, rather than falling to the page body.
//
// Deleting (issue #312). A tag is deleted from the Tags list, a collection
// from the Collections list or from its own page. When live models still
// use it, Delete asks first in the app's ConfirmDialog, saying how many and
// that the models themselves are not changed; one no model uses goes at
// once. The server takes it off every model, trashed ones too. The list
// shows every tag and collection but one only trashed models use, so one no
// model uses is listed with 0 models and can be deleted. After a delete the
// status line says what went, and focus goes to the next row's Delete, else
// the previous row's, else the status line (useRowFocus). A delete from a
// collection's own page goes back to the list, which says what went; the
// list then drops that note from the history entry, so a reload does not
// say it again. Creators cannot be deleted: a creator is read from a
// model's details.
import { type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { type I18n, type MessageKey, useI18n } from "../i18n/I18n";
import { appApi, nameQuery, useAppApi, useErrorText } from "../settings/api";
import { ConfirmDialog } from "../settings/Dialog";
import { focusFirst, focusLost, useRowFocus } from "../settings/focus";
import { ModelRows, type OrganiseModel } from "./ModelRows";
import "../settings/organise.css";

export interface GroupPageProps {
  /** The page's heading, such as "Collections". */
  title: string;
  /** The app API list, such as "/collections". */
  listPath: "/creators" | "/collections" | "/tags";
  /** The key of the list in the answer, and the library filter: creator, collection or tag. */
  filter: "creator" | "collection" | "tag";
  /** What the list says when there is nothing in it. */
  emptyText: string;
}

/** The All link back to each list. */
const ALL_KEYS: Readonly<Record<GroupPageProps["filter"], MessageKey>> = {
  creator: "groups.creators.all",
  collection: "groups.collections.all",
  tag: "groups.tags.all",
};

/** The words of a Delete, for the two kinds that can be deleted. */
interface DeleteWords {
  /** The row button's name: "Delete tag {name}". */
  label: MessageKey;
  title: MessageKey;
  /** How many live models still use it, and that they are not changed. */
  message: MessageKey;
  /** The dialog's button, and the own page's: "Delete tag". */
  confirm: MessageKey;
  /** The status line after: "Deleted the tag {name}." */
  deleted: MessageKey;
}

const DELETE_WORDS: Readonly<Partial<Record<GroupPageProps["filter"], DeleteWords>>> = {
  tag: {
    label: "groups.tags.deleteLabel",
    title: "groups.tags.deleteTitle",
    message: "groups.tags.deleteMessage",
    confirm: "groups.tags.deleteConfirm",
    deleted: "groups.tags.deleted",
  },
  collection: {
    label: "groups.collections.deleteLabel",
    title: "groups.collections.deleteTitle",
    message: "groups.collections.deleteMessage",
    confirm: "groups.collections.deleteConfirm",
    deleted: "groups.collections.deleted",
  },
};

/** What a delete from a collection's own page hands the list it goes back to. */
interface DeletedState {
  deleted: string;
}

function deletedName(state: unknown): string | null {
  const deleted = (state as Partial<DeletedState> | null)?.deleted;
  return typeof deleted === "string" ? deleted : null;
}

interface Group {
  name: string;
  models: number;
}

/** Deletes a tag or collection on the server: DELETE /app/api/tags?name= or /collections?name=. */
function deleteGroup(listPath: GroupPageProps["listPath"], name: string): Promise<void> {
  return appApi("DELETE", `${listPath}${nameQuery(name)}`);
}

function confirmText(i18n: Pick<I18n, "t">, words: DeleteWords, group: Group) {
  return {
    title: i18n.t(words.title, { name: group.name }),
    message: i18n.t(words.message, { count: group.models }),
    confirmLabel: i18n.t(words.confirm),
  };
}

interface ViewProps {
  /** The view's heading, which takes focus after a swap. */
  heading: Ref<HTMLHeadingElement>;
  /** Called when a link that swaps the view is followed. */
  onSwap: () => void;
}

function GroupList({
  title,
  listPath,
  filter,
  emptyText,
  heading,
  onSwap,
}: GroupPageProps & ViewProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const errorText = useErrorText();
  const location = useLocation();
  const key = listPath.slice(1) as "creators" | "collections" | "tags";
  const list = useAppApi<Record<string, Group[]>>(listPath);
  const groups = list.data?.[key] ?? [];
  const words = DELETE_WORDS[filter];
  const statusLine = useRef<HTMLParagraphElement>(null);
  const focus = useRowFocus(
    groups.map((g) => g.name),
    statusLine,
  );
  // A collection deleted from its own page is named here, where the page went.
  const [status, setStatus] = useState(() => {
    const name = deletedName(location.state);
    return words === undefined || name === null ? "" : t(words.deleted, { name });
  });
  const navigate = useNavigate();
  useEffect(() => {
    if (deletedName(location.state) !== null) navigate(".", { replace: true, state: null });
  }, [location.state, navigate]);
  const [error, setError] = useState<string | undefined>(undefined);
  /** The group whose Delete dialog is open, or null. */
  const [asking, setAsking] = useState<Group | null>(null);
  /** Where focus goes when the dialog closes: its Delete, or the next row's after a delete. */
  const dialogReturn = useRef<HTMLElement | null>(null);
  /** The groups whose Delete, with no dialog, is running. */
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());

  async function remove(group: Group, deletable: DeleteWords) {
    await deleteGroup(listPath, group.name);
    list.set((prev) => ({
      ...prev,
      [key]: (prev[key] ?? []).filter((g) => g.name !== group.name),
    }));
    setStatus(t(deletable.deleted, { name: group.name }));
  }

  async function press(group: Group, deletable: DeleteWords) {
    if (deleting.has(group.name)) return;
    setError(undefined);
    setStatus("");
    if (group.models > 0) {
      dialogReturn.current = focus.get(group.name);
      setAsking(group);
      return;
    }
    // No model uses it, so there is nothing to ask.
    setDeleting((prev) => new Set(prev).add(group.name));
    try {
      await remove(group, deletable);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(group.name);
        return next;
      });
    }
  }

  return (
    <>
      <div className="studio-page-head">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
      </div>
      {words === undefined ? null : (
        <p ref={statusLine} role="status" tabIndex={-1}>
          {status}
        </p>
      )}
      {error === undefined ? null : (
        <p role="alert" className="studio-alert studio-alert-alert">
          {error}
        </p>
      )}
      {list.error === undefined ? null : (
        <p className="studio-alert studio-alert-alert">{list.error}</p>
      )}
      {list.data === undefined && list.error === undefined ? (
        <p className="studio-muted">{t("groups.loading")}</p>
      ) : null}
      {list.data !== undefined && groups.length === 0 ? (
        <p className="studio-empty">{emptyText}</p>
      ) : null}
      {groups.length > 0 ? (
        <ul className="studio-list">
          {groups.map((group) => (
            <li key={group.name} className="studio-list-item" onFocus={focus.focusIn(group.name)}>
              <div className="studio-row">
                <Link to={`?${new URLSearchParams({ name: group.name })}`} onClick={onSwap}>
                  {group.name}
                </Link>
                <span className="studio-muted">
                  {t("library.count.models", { count: group.models })}
                </span>
                {words === undefined ? null : (
                  <button
                    ref={focus.control(group.name)}
                    type="button"
                    className="studio-button ph-small ph-button-danger"
                    aria-label={t(words.label, { name: group.name })}
                    aria-disabled={deleting.has(group.name)}
                    onClick={() => void press(group, words)}
                  >
                    {t("groups.delete")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {asking === null || words === undefined ? null : (
        <ConfirmDialog
          {...confirmText(i18n, words, asking)}
          onConfirm={async () => {
            await remove(asking, words);
            dialogReturn.current = focus.after(asking.name);
            setAsking(null);
          }}
          onCancel={() => setAsking(null)}
          returnFocusTo={dialogReturn}
        />
      )}
    </>
  );
}

/**
 * A collection's own page's Delete. It reads how many live models the
 * collection holds from the Collections list (the page's own rows stop at
 * the first 100), asks first when any do, and once it is deleted goes back
 * to the list, which says so. When the list fails to load, the count is
 * unknown, so it asks first all the same, saying the count could not be
 * checked (PR #367 review), rather than staying disabled with no reason.
 */
function DeleteCollection({
  listPath,
  name,
  onSwap,
}: {
  listPath: GroupPageProps["listPath"];
  name: string;
  onSwap: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const errorText = useErrorText();
  const navigate = useNavigate();
  const words = DELETE_WORDS.collection as DeleteWords;
  const list = useAppApi<{ collections: Group[] }>("/collections");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // The page's name is the stored one when it came from the list's link;
  // a typed address may differ in capitals.
  const listed = list.data?.collections ?? [];
  const lower = name.toLowerCase();
  const found =
    listed.find((c) => c.name === name) ?? listed.find((c) => c.name.toLowerCase() === lower);
  const group: Group = { name, models: found?.models ?? 0 };
  const loading = list.data === undefined && list.error === undefined;
  const countUnknown = list.data === undefined && list.error !== undefined;

  async function remove() {
    await deleteGroup(listPath, name);
    const state: DeletedState = { deleted: name };
    onSwap();
    navigate(".", { state });
  }

  async function press() {
    if (busy || loading) return;
    setError(undefined);
    if (countUnknown || group.models > 0) {
      setAsking(true);
      return;
    }
    setBusy(true);
    try {
      await remove();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="studio-button ph-small ph-button-danger"
        aria-label={t(words.label, { name })}
        aria-disabled={busy || loading}
        onClick={() => void press()}
      >
        {t(words.confirm)}
      </button>
      {error === undefined ? null : (
        <p role="alert" className="studio-alert studio-alert-alert">
          {error}
        </p>
      )}
      {asking ? (
        <ConfirmDialog
          {...confirmText(i18n, words, group)}
          {...(countUnknown ? { message: t("groups.collections.deleteMessageUnknown") } : {})}
          onConfirm={remove}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </>
  );
}

function GroupModels({
  title,
  listPath,
  filter,
  name,
  heading,
  onSwap,
}: GroupPageProps & ViewProps & { name: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const rows = useAppApi<{ models: OrganiseModel[]; nextCursor: string | null }>(
    `/organise/models?${new URLSearchParams({ [filter]: name })}`,
  );
  const models = rows.data?.models ?? [];
  return (
    <>
      <div className="studio-page-head">
        <h1>{title}</h1>
        <Link to="." onClick={onSwap}>
          {t(ALL_KEYS[filter])}
        </Link>
        {filter === "collection" ? (
          <DeleteCollection listPath={listPath} name={name} onSwap={onSwap} />
        ) : null}
      </div>
      <div className="ph-section">
        <div className="studio-row">
          <h2 ref={heading} tabIndex={-1}>
            {name}
          </h2>
          <Link to={`/?${new URLSearchParams({ [filter]: name })}`}>
            {t("groups.showInLibrary")}
          </Link>
        </div>
        {rows.error === undefined ? null : (
          <p className="studio-alert studio-alert-alert">{rows.error}</p>
        )}
        {rows.data === undefined && rows.error === undefined ? (
          <p className="studio-muted">{t("groups.loadingModels")}</p>
        ) : null}
        {rows.data === undefined ? null : (
          <ModelRows
            models={models}
            update={(change) => rows.set((prev) => ({ ...prev, models: change(prev.models) }))}
          />
        )}
        {rows.data?.nextCursor ? (
          <p className="studio-muted">{t("groups.firstOnly", { count: models.length })}</p>
        ) : null}
      </div>
    </>
  );
}

export function GroupPage(props: GroupPageProps) {
  const [params] = useSearchParams();
  const name = params.get("name")?.trim() ?? "";
  const heading = useRef<HTMLHeadingElement>(null);
  const swapping = useRef(false);
  const shown = useRef(name);

  // Once the view a link asked for is on the page, its heading takes focus,
  // unless the user has already put focus somewhere else on the page.
  useLayoutEffect(() => {
    if (shown.current === name) return;
    shown.current = name;
    if (!swapping.current) return;
    swapping.current = false;
    if (focusLost()) focusFirst([heading.current]);
  });

  const view = {
    heading,
    onSwap: () => {
      swapping.current = true;
    },
  };
  if (name === "") return <GroupList {...props} {...view} />;
  return <GroupModels {...props} {...view} name={name} />;
}
