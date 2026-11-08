// Library search (build plan Task 14; AC-061, AC-062, AC-064): the search box
// on every page, the library listing and its tag, collection and creator
// filters, one page at a time. Trashed models never appear (AC-063).
//
// The query itself is the models repository's (repos/models.ts, searchRanked);
// this module adds the opaque cursor and the page shape.
import type { Kysely } from "kysely";
import { isUuid } from "../db/ids.js";
import type { DB } from "../db/types.js";
import type { Model } from "../repos/models.js";

const SEARCH_RANK_MAX = 1_000_000;

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

export function createSearch(_db: Kysely<DB>) {
  return {
    async search(_query: LibrarySearch): Promise<SearchPage> {
      throw new Error("not implemented: search");
    },
  };
}
