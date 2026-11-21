// Library search (build plan Task 14; AC-061, AC-062, AC-064): the search box
// on every page, the library listing and its tag, collection and creator
// filters, one page at a time. Trashed models never appear (AC-063).
//
// The query itself is the models repository's (repos/models.ts, searchRanked);
// this module adds the opaque cursor and the page shape.
import type { Kysely } from "kysely";
import { isUuid } from "../db/ids.js";
import type { DB } from "../db/types.js";
import { type Model, modelsRepo, SEARCH_RANK_MAX } from "../repos/models.js";

export interface LibrarySearch {
  /** Matched anywhere in name, caption, creator or a tag, ignoring case. Empty lists all. */
  q?: string | undefined;
  /** Only models with this tag (ignoring case). */
  tag?: string | undefined;
  /** Only models in this collection (ignoring case). */
  collection?: string | undefined;
  /** Only models by this creator (the exact name). */
  creator?: string | undefined;
  /** The nextCursor of the previous page. */
  cursor?: string | undefined;
  /** Models per page, 1 to 200; 50 when left out. */
  limit?: number | undefined;
}

export interface SearchPage {
  models: Model[];
  /** Pass as cursor for the next page; null on the last page. */
  nextCursor: string | null;
}

/** Where a page stopped: the last model's rank, name and id. */
export interface CursorPosition {
  rank: number;
  name: string;
  id: string;
}

/** The cursor was not made by search. The message never repeats the cursor. */
export class InvalidCursor extends Error {
  constructor() {
    super("The cursor is not valid");
    this.name = "InvalidCursor";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.rank, position.name, position.id])).toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): CursorPosition {
  if (!BASE64URL.test(cursor)) throw new InvalidCursor();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursor();
  }
  if (!Array.isArray(value) || value.length !== 3) throw new InvalidCursor();
  const [rank, name, id] = value as unknown[];
  if (
    typeof rank !== "number" ||
    !Number.isInteger(rank) ||
    rank < 0 ||
    rank > SEARCH_RANK_MAX ||
    typeof name !== "string" ||
    typeof id !== "string" ||
    !isUuid(id)
  ) {
    throw new InvalidCursor();
  }
  return { rank, name, id };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

// A blank filter, such as an empty tag= in a query string, is no filter.
function filter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function createSearch(db: Kysely<DB>) {
  const models = modelsRepo(db);
  return {
    async search(query: LibrarySearch): Promise<SearchPage> {
      const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const limit = pageSize(query.limit);
      // One row more than the page, to know whether another page follows.
      const rows = await models.searchRanked({
        q: query.q ?? "",
        tag: filter(query.tag),
        collection: filter(query.collection),
        creator: filter(query.creator),
        after,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last !== undefined
          ? encodeCursor({ rank: last.rank, name: last.name, id: last.id })
          : null;
      return { models: page.map(({ rank: _rank, ...model }) => model), nextCursor };
    },
  };
}
