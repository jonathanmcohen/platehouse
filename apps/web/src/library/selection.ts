// The library's bulk actions as the web app sends and reports them (Jon,
// 2026-11-19): what each sends to /app/api/bulk/* (apps/server/src/app-api/
// organise.ts), what the server answers, and the plain sentences the library
// shows for an answer: what changed, what was already so, and which models
// failed and why. The sentences come from the catalogs (packages/i18n),
// in the language shown. A failed model is named when the page knows its name (it
// was shown on a card); one it does not know is counted instead.

import { ENGLISH_I18N, type I18n } from "../i18n/I18n";

/** Most models one action takes: the server's MAX_BULK_IDS, as View all and Select all matching. */
export const MAX_SELECTED = 1000;

/** Most tags one Add tags action takes: the server's MAX_BULK_TAGS. */
export const MAX_TAGS = 20;

export type BulkAction =
  | { action: "add-tags"; tags: string[] }
  | { action: "remove-tag"; tag: string }
  | { action: "add-to-collection"; collection: string }
  | { action: "trash" };

export interface BulkFailure {
  id: string;
  reason: "not_found" | "in_trash";
}

/** What a bulk route answers. */
export interface BulkAnswer {
  changed: string[];
  unchanged: string[];
  failed: BulkFailure[];
  /** Add tags: the tags as stored. */
  tags?: string[];
  /** Remove tag: the tag as stored, or null when no tag has that name. */
  tag?: string | null;
  /** Add to collection: the collection as stored. */
  collection?: string;
  /**
   * Live models the server left alone because the view the request named
   * (its search and filters) no longer shows them. Always sent; left out
   * only by older answers, read as none.
   */
  notInView?: string[];
}

/**
 * The library view a bulk request names, from the page's search, filters,
 * printer and sort (LibraryPage's matching): the server changes only the
 * posted models this view shows when the action runs (Jon, 2026-11-20).
 * The sort and the paging do not change which models a view holds, so they
 * are not sent.
 */
export function viewOf(matching: URLSearchParams): Record<string, string> {
  const view: Record<string, string> = {};
  for (const key of ["q", "tag", "collection", "creator", "printer"]) {
    const value = matching.get(key);
    if (value !== null) view[key] = value;
  }
  return view;
}

/**
 * The selection cut down to the models the view can show (shown: the ids
 * GET /app/api/library/ids answers for the search, filters and sort, which
 * are exactly the matches the pages and View all reach), in the selection's
 * order with their names, and how many left it. The page keeps the
 * selection to what the view shows so its count is true (0.1.0-rc.2 live
 * check); that no action changes a model the view hides is the server's
 * guarantee (each bulk request names its view), not this one's.
 */
export function keepShown<T>(
  selected: ReadonlyMap<string, T>,
  shown: ReadonlySet<string>,
): { kept: Map<string, T>; left: number } {
  const kept = new Map([...selected].filter(([id]) => shown.has(id)));
  return { kept, left: selected.size - kept.size };
}

/** The request body for an action on these ids, made in this view (viewOf). */
export function bulkBody(
  action: BulkAction,
  ids: string[],
  view: Record<string, string>,
): Record<string, unknown> {
  const { action: _name, ...rest } = action;
  return { ids, ...rest, view };
}

/** Builds the sentences in a language; English when left out. */
type Words = Pick<I18n, "t">;

function models(i18n: Words, n: number): string {
  return i18n.t("library.count.models", { count: n });
}

/** A, B and C. */
function list(i18n: Words, names: string[]): string {
  if (names.length <= 1) return names.join("");
  return i18n.t("common.list.and", {
    first: names.slice(0, -1).join(", "),
    last: names.at(-1) as string,
  });
}

const SHOWN_FAILURES = 5;

function failureText(
  i18n: Words,
  failed: BulkFailure[],
  names: ReadonlyMap<string, string>,
): string | null {
  if (failed.length === 0) return null;
  const { t } = i18n;
  const items: string[] = [];
  const unnamed = { in_trash: 0, not_found: 0 };
  for (const f of failed) {
    const name = names.get(f.id);
    if (name === undefined) unnamed[f.reason] += 1;
    else
      items.push(
        f.reason === "in_trash"
          ? t("library.bulk.fail.inTrash", { name })
          : t("library.bulk.fail.gone", { name }),
      );
  }
  if (unnamed.in_trash > 0) {
    items.push(t("library.bulk.fail.othersInTrash", { count: unnamed.in_trash }));
  }
  if (unnamed.not_found > 0) {
    items.push(t("library.bulk.fail.othersGone", { count: unnamed.not_found }));
  }
  const shown = items.slice(0, SHOWN_FAILURES).join("; ");
  const values = { models: models(i18n, failed.length), items: shown };
  return items.length > SHOWN_FAILURES
    ? t("library.bulk.failedMore", { ...values, more: items.length - SHOWN_FAILURES })
    : t("library.bulk.failed", values);
}

/**
 * The sentences for an answer: what was done, the failures (null when none)
 * and how many the server left alone because the view no longer shows them
 * (null when none).
 */
export function describeBulk(
  action: BulkAction,
  answer: BulkAnswer,
  names: ReadonlyMap<string, string>,
  i18n: Words = ENGLISH_I18N,
): { done: string; failed: string | null; notInView: string | null } {
  const { t } = i18n;
  const hidden = answer.notInView?.length ?? 0;
  const notInView = hidden === 0 ? null : t("library.bulk.notInView", { count: hidden });
  const changed = answer.changed.length;
  const unchanged = answer.unchanged.length;
  let done: string;
  // Nothing changed (issue #256): every model was already so ("All 2 models
  // already had PLA."), every one failed, or some were already so and the
  // rest failed. Trash has its own sentence for that below.
  if (
    changed === 0 &&
    action.action !== "trash" &&
    !(action.action === "remove-tag" && answer.tag === null)
  ) {
    if (unchanged === 0) done = t("library.bulk.changedNone");
    else if (answer.failed.length > 0) {
      // Some failed too, so "All 2 models" would read as if only 2 were
      // selected (issue #306): say nothing changed, then count what was
      // already so. No earlier sentence names the tag or collection here, so
      // the count sentence names it ("2 already had PLA."), not "it".
      const already =
        action.action === "add-tags"
          ? t("library.bulk.alreadyHadTags", {
              count: unchanged,
              tags: list(i18n, answer.tags ?? action.tags),
            })
          : action.action === "remove-tag"
            ? t("library.bulk.didNotHaveTag", { count: unchanged, tag: answer.tag ?? action.tag })
            : t("library.bulk.alreadyInCollection", {
                count: unchanged,
                collection: answer.collection ?? action.collection,
              });
      done = `${t("library.bulk.changedNone")} ${already}`;
    } else if (action.action === "add-tags") {
      done = t("library.bulk.allHad", {
        count: unchanged,
        tags: list(i18n, answer.tags ?? action.tags),
      });
    } else if (action.action === "remove-tag") {
      done = t("library.bulk.noneHad", { count: unchanged, tag: answer.tag ?? action.tag });
    } else {
      done = t("library.bulk.allIn", {
        count: unchanged,
        collection: answer.collection ?? action.collection,
      });
    }
    return { done, failed: failureText(i18n, answer.failed, names), notInView };
  }
  switch (action.action) {
    case "add-tags": {
      const tags = answer.tags ?? action.tags;
      done = t("library.bulk.addedTags", { tags: list(i18n, tags), models: models(i18n, changed) });
      if (unchanged > 0) {
        done += ` ${t("library.bulk.alreadyHad", { count: unchanged, tags: tags.length })}`;
      }
      break;
    }
    case "remove-tag": {
      if (answer.tag === null) {
        done = t("library.bulk.noTag", { tag: action.tag });
        break;
      }
      done = t("library.bulk.removedTag", {
        tag: answer.tag ?? action.tag,
        models: models(i18n, changed),
      });
      if (unchanged > 0) done += ` ${t("library.bulk.didNotHave", { count: unchanged })}`;
      break;
    }
    case "add-to-collection": {
      done = t("library.bulk.addedToCollection", {
        models: models(i18n, changed),
        collection: answer.collection ?? action.collection,
      });
      if (unchanged > 0) done += ` ${t("library.bulk.alreadyIn", { count: unchanged })}`;
      break;
    }
    case "trash":
      done =
        changed === 0
          ? t("library.bulk.trashedNone")
          : t("library.bulk.trashed", { models: models(i18n, changed), count: changed });
      break;
  }
  return { done, failed: failureText(i18n, answer.failed, names), notInView };
}
