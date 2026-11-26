// The trash, on its own page
// and on the settings page. Each trashed model shows the day after which
// the daily purge deletes it for good (30 days after it was trashed) and a
// Restore button, which brings it back with its files, tags and
// collections. Empty trash asks after a themed confirmation that says how
// many, never the browser's own dialog. It sends the time the server read the
// list (readAt), not the models' ids, so its body stays small however long
// the trash is, and the server marks only the models trashed at or before that
// time: a model another tab or browser trashed after the list was read is not
// deleted unseen. The server answers at once (202, how many it queued) and
// deletes the models in a background job. A model that is marked cannot be
// restored, and says so. While the listing says the job is running (emptying)
// the page reads it again every few seconds, but not in a hidden tab, and the
// status line is written twice: once when the job is seen ("Emptying the
// trash"), once when it ends, with how many were deleted and, when some could
// not be, how many stay for the next purge. A page opened mid-job writes the
// same two lines, without taking focus. After a click, focus goes to the
// status line rather than back to the button, which has nothing left to do. No button here takes the disabled
// attribute, which would push a focused button's focus to the page body:
// Empty trash with nothing in the trash, a Restore that is running and the
// Restore of a model whose purge has begun are marked aria-disabled and
// ignore a press. When a restored model leaves the list, focus goes to the
// next model's Restore, else the previous one's, else the status line
// (useRowFocus in ../settings/focus).
// The server pages the trash, 100 models to a page, newest first. The page
// lives in the address (?page= on /trash, ?trashPage= in Settings, beside its
// own ?view=), and the library's Pager shows when there is more than one.
// After a restore or Empty trash the same page is read again; a page past
// the end comes back as the last page, and the address is changed to that
// page (replacing the entry, so Back does not return to the past-the-end
// one). When the pager loads another page the list and the pager unmount, so
// focus would fall to the page body: it goes to the status line instead,
// which then says "Page N of M". Restoring the last model of the last page
// keeps its row until the read again answers, so the trash never shows as
// empty for a moment. Empty trash's count is the whole
// trash, not the page on screen, because the cutoff covers every page.
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { ENGLISH_I18N, type I18n, useI18n } from "../i18n/I18n";
import { Pager } from "../library/Pager";
import { pageFrom } from "../library/paging";
import { appApi, segment, useAppApi, useErrorText } from "../settings/api";
import { ConfirmDialog } from "../settings/Dialog";
import { useRowFocus } from "../settings/focus";
import { useWhileVisible } from "../visibility";

export interface TrashedModel {
  id: string;
  name: string;
  creator: string | null;
  trashedAt: string;
  purgeAt: string;
  purgeStarted: boolean;
}

function deletedSentence(purged: number, i18n: Pick<I18n, "t"> = ENGLISH_I18N): string {
  return i18n.t("trash.deleted", { count: purged });
}

/** GET /app/api/trash: the trash, and the server's time when it read it. */
interface TrashListing {
  models: TrashedModel[];
  readAt: string;
  /** The page served (a page past the end is the last page). */
  page: number;
  pageCount: number;
  /** Every model in the trash, whichever page it is on. */
  total: number;
  /** Whether an Empty trash job is queued, retrying or running. */
  emptying: boolean;
  /** Trashed models already marked for deletion, on every page. */
  purging: number;
}

/** How often the listing is read again while an Empty trash job runs. */
export const EMPTYING_POLL_MS = 3000;

/**
 * pageParam names the address parameter that holds the page: "page" on the
 * trash's own page, another where the page shares its address (Settings).
 */
export function TrashList({ pageParam = "page" }: { pageParam?: string }) {
  const errorText = useErrorText();
  const i18n = useI18n();
  const { t, rich } = i18n;
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const asked = pageFrom(params.get(pageParam));
  const trash = useAppApi<TrashListing>(asked > 1 ? `/trash?page=${asked}` : "/trash");
  const hrefFor = (page: number) => {
    const next = new URLSearchParams(params);
    if (page <= 1) next.delete(pageParam);
    else next.set(pageParam, String(page));
    const query = next.toString();
    return query === "" ? pathname : `${pathname}?${query}`;
  };
  /**
   * What Empty trash asks to delete, from when the dialog opened: how many
   * models the trash held and the time the list was read; null when closed.
   */
  const [asking, setAsking] = useState<{ count: number; cutoff: string } | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const emptyButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  /** Where focus goes when the dialog closes: the button, or the result after a success. */
  const emptyReturn = useRef<HTMLElement | null>(null);
  /** The models whose Restore is running. */
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(new Set());
  const models = trash.data?.models ?? [];
  const focus = useRowFocus(
    models.map((m) => m.id),
    statusLine,
  );
  /** Set when the pager is followed: the next page that arrives takes focus. */
  const pagerFollowed = useRef(false);
  // Each time new data arrives (not on a render that still holds the data of
  // the page just left).
  const arrived = trash.data;
  /**
   * The Empty trash job this page is following: how many models were marked
   * when it began. Null when none is.
   */
  const following = useRef<{ start: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per arrival of data; asked, t and the address are read as they are then.
  useEffect(() => {
    if (arrived === undefined) return;
    if (arrived.emptying && following.current === null) {
      // A page opened mid-job (or another tab's click): say so, and leave focus be.
      following.current = { start: arrived.purging };
      setStatus(t("trash.emptying"));
    } else if (!arrived.emptying && following.current !== null) {
      const left = arrived.purging;
      const deleted = deletedSentence(Math.max(0, following.current.start - left), i18n);
      following.current = null;
      setStatus(left > 0 ? `${deleted} ${t("trash.incomplete", { count: left })}` : deleted);
    }
    if (pagerFollowed.current) {
      pagerFollowed.current = false;
      setStatus(t("trash.pageOf", { page: arrived.page, count: arrived.pageCount }));
      statusLine.current?.focus();
    }
    // A page past the end was served as the last page: the address follows it.
    if (arrived.page < asked) navigate(hrefFor(arrived.page), { replace: true });
  }, [arrived]);

  // While the job runs, read the listing again. Not while the tab is hidden:
  // one read when it is shown again, then on.
  const emptying = trash.data?.emptying === true;
  const reload = trash.reload;
  useWhileVisible(
    (resumed) => {
      if (!emptying) return () => {};
      if (resumed) reload();
      const timer = setInterval(reload, EMPTYING_POLL_MS);
      return () => clearInterval(timer);
    },
    [emptying, reload],
  );

  function marking(id: string, on: boolean) {
    setRestoring((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function restore(model: TrashedModel) {
    if (model.purgeStarted || restoring.has(model.id)) return;
    marking(model.id, true);
    setError(undefined);
    setStatus("");
    try {
      await appApi("POST", `/trash/${segment(model.id)}/restore`);
      const leave = () =>
        trash.set((prev) => ({
          ...prev,
          models: prev.models.filter((m) => m.id !== model.id),
          total: prev.total - 1,
        }));
      setStatus(t("trash.restored"));
      if ((trash.data?.pageCount ?? 1) > 1) {
        // Another page's models move up into this one, and the last page may
        // go: keep the rows until the read answers, so the list never shows
        // empty meanwhile. If the read fails, the row still leaves.
        if (!(await trash.reload())) leave();
      } else {
        leave();
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      marking(model.id, false);
    }
  }

  async function emptyTrash() {
    if (asking === null) return;
    setStatus("");
    const answer = await appApi<{ queued: number }>("POST", "/trash/empty", {
      cutoff: asking.cutoff,
    });
    // The server has marked the models and queued the job; the page follows
    // it. The status line takes focus: Empty trash has nothing left to do.
    following.current = { start: answer.queued };
    emptyReturn.current = statusLine.current;
    setAsking(null);
    setStatus(t("trash.emptying"));
    trash.reload();
  }

  return (
    <div className="studio-panel">
      <p className="studio-muted">{t("trash.intro")}</p>
      <div className="studio-actions">
        <button
          ref={emptyButton}
          type="button"
          className="studio-button ph-button-danger"
          aria-disabled={models.length === 0}
          onClick={() => {
            if (trash.data === undefined || models.length === 0) return;
            emptyReturn.current = emptyButton.current;
            setAsking({ count: trash.data.total, cutoff: trash.data.readAt });
          }}
        >
          {t("trash.empty")}
        </button>
      </div>
      <p ref={statusLine} role="status" tabIndex={-1}>
        {status}
      </p>
      {error === undefined ? null : (
        <p role="alert" className="studio-alert studio-alert-alert">
          {error}
        </p>
      )}
      {trash.error === undefined ? null : (
        <p className="studio-alert studio-alert-alert">{trash.error}</p>
      )}
      {trash.data === undefined && trash.error === undefined ? (
        <p className="studio-muted">{t("trash.loading")}</p>
      ) : null}
      {trash.data !== undefined && models.length === 0 ? (
        <p className="studio-empty">{t("trash.isEmpty")}</p>
      ) : null}
      {models.length > 0 ? (
        <ul className="studio-list">
          {models.map((model) => (
            <li key={model.id} className="studio-list-item" onFocus={focus.focusIn(model.id)}>
              <div className="studio-row">
                <strong>{model.name}</strong>
                <button
                  ref={focus.control(model.id)}
                  type="button"
                  className="studio-button ph-small"
                  aria-label={t("trash.restoreLabel", { name: model.name })}
                  aria-disabled={model.purgeStarted || restoring.has(model.id)}
                  onClick={() => restore(model)}
                >
                  {t("trash.restore")}
                </button>
              </div>
              <span className="studio-muted">
                {model.creator === null ? null : `${t("trash.by", { creator: model.creator })} `}
                {model.purgeStarted
                  ? t("trash.purging")
                  : rich(
                      "trash.purgeAfter",
                      { date: i18n.fmt.date(model.purgeAt) },
                      { time: (children) => <time dateTime={model.purgeAt}>{children}</time> },
                    )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {trash.data !== undefined && trash.data.pageCount > 1 ? (
        <Pager
          page={trash.data.page}
          pageCount={trash.data.pageCount}
          hrefFor={hrefFor}
          onNavigate={() => {
            pagerFollowed.current = true;
          }}
        />
      ) : null}
      {asking !== null ? (
        <ConfirmDialog
          title={t("trash.confirmTitle")}
          message={t("trash.confirmMessage", { count: asking.count })}
          confirmLabel={t("trash.empty")}
          onConfirm={emptyTrash}
          onCancel={() => setAsking(null)}
          returnFocusTo={emptyReturn}
        />
      ) : null}
    </div>
  );
}
