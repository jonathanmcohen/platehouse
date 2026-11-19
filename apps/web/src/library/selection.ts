// The library's bulk actions as the web app sends and reports them (Jon,
// 2026-11-19): what each sends to /app/api/bulk/* (apps/server/src/app-api/
// organise.ts), what the server answers, and the plain sentences the library
// shows for an answer: what changed, what was already so, and which models
// failed and why. A failed model is named when the page knows its name (it
// was shown on a card); one it does not know is counted instead.

/** Most models one action takes: the server's MAX_BULK_IDS, as View all and Select all matching. */
export const MAX_SELECTED = 1000;

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
}

/** The request body for an action on these ids. */
export function bulkBody(action: BulkAction, ids: string[]): Record<string, unknown> {
  const { action: _name, ...rest } = action;
  return { ids, ...rest };
}

function models(n: number): string {
  return n === 1 ? "1 model" : `${n} models`;
}

/** A, B and C. */
function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const SHOWN_FAILURES = 5;

function failureText(failed: BulkFailure[], names: ReadonlyMap<string, string>): string | null {
  if (failed.length === 0) return null;
  const items: string[] = [];
  const unnamed = { in_trash: 0, not_found: 0 };
  for (const f of failed) {
    const name = names.get(f.id);
    if (name === undefined) unnamed[f.reason] += 1;
    else items.push(`${name} ${f.reason === "in_trash" ? "is in the trash" : "no longer exists"}`);
  }
  if (unnamed.in_trash > 0) {
    const n = unnamed.in_trash;
    items.push(`${n} other ${n === 1 ? "model is" : "models are"} in the trash`);
  }
  if (unnamed.not_found > 0) {
    const n = unnamed.not_found;
    items.push(`${n} other ${n === 1 ? "model no longer exists" : "models no longer exist"}`);
  }
  const shown = items.slice(0, SHOWN_FAILURES).join("; ");
  const more = items.length > SHOWN_FAILURES ? `, and ${items.length - SHOWN_FAILURES} more` : "";
  return `${models(failed.length)} could not be changed: ${shown}${more}.`;
}

/** The sentences for an answer: what was done, and the failures (null when none). */
export function describeBulk(
  action: BulkAction,
  answer: BulkAnswer,
  names: ReadonlyMap<string, string>,
): { done: string; failed: string | null } {
  const changed = answer.changed.length;
  const unchanged = answer.unchanged.length;
  let done: string;
  switch (action.action) {
    case "add-tags": {
      const tags = answer.tags ?? action.tags;
      const them = tags.length === 1 ? "it" : "them";
      done = `Added ${list(tags)} to ${models(changed)}.`;
      if (unchanged > 0) done += ` ${unchanged} already had ${them}.`;
      break;
    }
    case "remove-tag": {
      if (answer.tag === null) {
        done = `No model has the tag ${action.tag}.`;
        break;
      }
      done = `Removed ${answer.tag ?? action.tag} from ${models(changed)}.`;
      if (unchanged > 0) done += ` ${unchanged} did not have it.`;
      break;
    }
    case "add-to-collection": {
      done = `Added ${models(changed)} to ${answer.collection ?? action.collection}.`;
      if (unchanged > 0) done += ` ${unchanged} ${unchanged === 1 ? "was" : "were"} already in it.`;
      break;
    }
    case "trash":
      done =
        changed === 0
          ? "No model was moved to the trash."
          : `Moved ${models(changed)} to the trash. Restore ${changed === 1 ? "it" : "them"} from the trash within 30 days.`;
      break;
  }
  return { done, failed: failureText(answer.failed, names) };
}
