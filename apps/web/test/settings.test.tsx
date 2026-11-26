// @vitest-environment jsdom
// The settings, trash and organising pages: the versioning warning, My
// printers, rename, tags, collections, the trash and API tokens.
//
// Each page is rendered into jsdom inside a memory router and talks to a
// fake /app/api (fakeApi below) through the global fetch, which records
// every call. The fake answers the shapes the server's app API answers
// (apps/server/src/app-api); the server side is tested against Postgres and
// the bucket in apps/server/test/integration/app-api/settings.test.ts.
//
// Every dialog is the app's own themed one (role="dialog"); the tests spy
// on window.confirm, alert and prompt and expect none to be called. Every
// token here is made by the run, never written into this file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CollectionsPage } from "../src/collections/CollectionsPage";
import { CreatorsPage } from "../src/creators/CreatorsPage";
import { LibraryPage } from "../src/library/LibraryPage";
import { ConfirmDialog, Dialog } from "../src/settings/Dialog";
import { howLong, REREAD_SHOWS_CHANGE, WAITING_POLL_MS } from "../src/settings/PrinterMenu";
import { SettingsPage } from "../src/settings/SettingsPage";
import { VERSIONING_OFF_WARNING } from "../src/settings/VersioningBanner";
import { TagsPage } from "../src/tags/TagsPage";
import { EMPTYING_POLL_MS } from "../src/trash/TrashList";
import { TrashPage } from "../src/trash/TrashPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P1S = "Bambu Lab P1S 0.4 nozzle";
const P1S_06 = "Bambu Lab P1S 0.6 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
/** Each printer in full, as the server names it (estimates/display.ts printerName). */
const NAMES: Record<string, string> = {
  [P1S]: "Bambu Lab P1S, 0.4 mm nozzle",
  [P1S_06]: "Bambu Lab P1S, 0.6 mm nozzle",
  [X1C]: "Bambu Lab X1 Carbon, 0.4 mm nozzle",
  "Bambu Lab A1 0.4 nozzle": "Bambu Lab A1, 0.4 mm nozzle",
};
/** The printers the slicer's menu offers. */
const MENU_IDS = [P1S, P1S_06, X1C];
/** The server's 409 printers_changed sentence (app-api/settings.ts). */
const PRINTERS_CHANGED =
  "My printers or the default printer were changed somewhere else after this page read them, so nothing was saved.";

/** A fresh API token, made the way the server makes one: ph_ and 43 base64url characters. */
function freshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return ["ph", body].join("_");
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface FakeModel {
  id: string;
  name: string;
  creator: string | null;
  tags: string[];
  collections: string[];
  files: Array<{ id: string; name: string; kind: string }>;
}

interface FakeState {
  /** The default printer. */
  printerId: string;
  /** The version of My printers and the default; every save bumps it. */
  printersVersion: number;
  /** My printers, in order. */
  myPrinters: string[];
  /** Plate estimates each printer still has waiting. */
  waiting: Record<string, number>;
  /** How many plates the fake says it queued for each printer added. */
  addQueued: number;
  bucketVersioning: "enabled" | "suspended" | "off" | "unknown";
  tokens: Array<{
    id: string;
    name: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    /** Who made it; null for a token made before Platehouse recorded that (issue #322). */
    createdBy: { subject: string; name: string | null } | null;
  }>;
  /** Sign out everywhere's list (GET /app/api/users). */
  users: Array<{
    subject: string;
    name: string | null;
    sessions: number;
    tokens: number;
    you: boolean;
  }>;
  /** Live tokens with no recorded maker, as GET /app/api/users counts them. */
  unknownTokens: number;
  /** When true, a new token is refused because the session's sign-in is too old (issue #322). */
  signInRequired: boolean;
  /** When true, the token list and the user list cannot be read (500). */
  listsFail: boolean;
  /** When true, token creation and Sign out everywhere are over the session's limit (429). */
  rateLimited: boolean;
  trash: Array<{
    id: string;
    name: string;
    creator: string | null;
    trashedAt: string;
    purgeAt: string;
    purgeStarted: boolean;
  }>;
  /** The server's clock: GET /app/api/trash answers it as readAt. */
  now: string;
  models: FakeModel[];
  /** Tags and collections no model uses, listed with 0 as the server lists them (#312). */
  unusedTags: string[];
  unusedCollections: string[];
}

let state: FakeState;
const calls: Call[] = [];
/**
 * Answers held back: a call whose "METHOD path" is here waits for its
 * release before the fake acts on it, so a test can have two changes in
 * flight and choose which answers first.
 */
const held = new Map<string, Promise<void>>();

/** Holds the next answers to "METHOD path" until the returned release is called. */
function hold(key: string): () => Promise<void> {
  let release: () => void = () => {};
  held.set(
    key,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return async () => {
    held.delete(key);
    release();
    await settle();
  };
}

/**
 * Calls that fail: a call whose "METHOD path" is here answers 503, as the
 * server does when a dependency is down, without acting on it.
 */
const failing = new Set<string>();

/**
 * Whether the server's Empty trash job is running: GET /app/api/trash answers
 * it as emptying, and the models it has marked as purging.
 */
let emptying = false;
/**
 * When set, GET /app/api/settings answers printers: null, as the server does
 * when the slicer is unreachable, busy or refuses (apps/server/src/app-api/settings.ts).
 */
let slicerDown = false;
/**
 * When set, each GET /app/api/settings answer is built when asked and then
 * waits here, in request order, until the test calls it.
 */
let parked: Array<() => void> | null = null;
/**
 * When set, each GET /app/api/trash answer is built when asked and then
 * waits here, in request order, until the test calls it: a listing read
 * before Empty trash's answer can arrive after it.
 */
let parkedTrash: Array<() => void> | null = null;
/** Every token value the fake handed out. */
const issued: string[] = [];

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

/** What the server answers a session over its limit (apps/server/src/auth/limit.ts). */
function limited(): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "540" },
  });
}

/** What the server answers an act on other people from an older sign-in. */
const STALE_ANSWER = {
  error: "sign_in_required",
  message: "Sign in again first. Platehouse checks that you are still allowed in when you sign in.",
  code: "sign_in_required",
  signIn: "/auth/login?next=/settings",
};

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The name a tag or collection is stored under: one per name ignoring case,
 * and the first one written is kept, as the server's repositories do
 * (ON CONFLICT (lower(name)) DO NOTHING).
 */
function storedName(key: "tags" | "collections", typed: string): string {
  const name = typed.trim();
  for (const m of state.models) {
    const found = m[key].find((n) => sameName(n, name));
    if (found !== undefined) return found;
  }
  return name;
}

function counts(key: "tags" | "collections" | "creator") {
  const byName = new Map<string, number>();
  for (const m of state.models) {
    const names = key === "creator" ? (m.creator === null ? [] : [m.creator]) : m[key];
    for (const n of names) byName.set(n, (byName.get(n) ?? 0) + 1);
  }
  const unused =
    key === "tags" ? state.unusedTags : key === "collections" ? state.unusedCollections : [];
  for (const n of unused) if (!byName.has(n)) byName.set(n, 0);
  return [...byName].map(([name, models]) => ({ name, models }));
}

/**
 * DELETE /app/api/tags or /collections?name=: takes it off every model and
 * forgets it, as the server does (#312); 404 when no model and no unused
 * entry has it.
 */
function deleteLabel(key: "tags" | "collections", typed: string | null): Response {
  if (typed === null || typed.trim() === "") return json(400, { error: "bad_request" });
  const unusedKey = key === "tags" ? "unusedTags" : "unusedCollections";
  const known =
    state.models.some((m) => m[key].some((n) => sameName(n, typed))) ||
    state[unusedKey].some((n) => sameName(n, typed));
  if (!known) return json(404, { error: "not_found" });
  for (const m of state.models) m[key] = m[key].filter((n) => !sameName(n, typed));
  state[unusedKey] = state[unusedKey].filter((n) => !sameName(n, typed));
  return json(204);
}

/**
 * As the server's queueByPrinter: the slicer is one queue, and each
 * printer's work was queued after the work of the printers before it in
 * state.waiting (insertion order: what was there first, then each printer
 * added), so a printer is through after its own waiting plates and every
 * plate queued before them. 0 with nothing waiting.
 */
function throughOf(id: string): number {
  if ((state.waiting[id] ?? 0) === 0) return 0;
  let total = 0;
  for (const [printer, waiting] of Object.entries(state.waiting)) {
    total += waiting;
    if (printer === id) return total;
  }
  return 0;
}

/** The fake /app/api: the routes the pages call, answering as the server does. */
async function fakeApi(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input), "https://platehouse.test");
  const method = (init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const path = decodeURIComponent(url.pathname);
  calls.push({ method, path: `${path}${url.search}`, body });
  const gate = held.get(`${method} ${path}`);
  if (gate !== undefined) await gate;
  if (failing.has(`${method} ${path}`)) {
    return json(503, { error: "unavailable", message: "Down for a moment." });
  }
  const seg = path.split("/").slice(3); // after /app/api
  const model = (id: string | undefined) => state.models.find((m) => m.id === id);

  if (method === "GET" && path === "/app/api/settings") {
    // The answer is built now, from the state as it is when asked; a parked
    // answer is sent when the test releases it, so two reads can answer in
    // any order (#254).
    const answer = json(200, {
      printerId: state.printerId,
      printersVersion: state.printersVersion,
      myPrinters: state.myPrinters.map((id) => ({
        id,
        name: NAMES[id] ?? id,
        offered: slicerDown ? null : MENU_IDS.includes(id),
        waiting: state.waiting[id] ?? 0,
        through: throughOf(id),
      })),
      slicesPerMinute: 3,
      bucketVersioning: state.bucketVersioning,
      printers: slicerDown
        ? null
        : [
            {
              model: "Bambu Lab P1S",
              printers: [
                { id: P1S, nozzle: 0.4, name: NAMES[P1S] },
                { id: P1S_06, nozzle: 0.6, name: NAMES[P1S_06] },
              ],
            },
            {
              model: "Bambu Lab X1 Carbon",
              printers: [{ id: X1C, nozzle: 0.4, name: NAMES[X1C] }],
            },
          ],
    });
    if (parked === null) return answer;
    const queue = parked;
    return new Promise<Response>((resolve) => queue.push(() => resolve(answer)));
  }
  // The whole list at once, as the server's PUT /settings/printers: each
  // added printer has state.addQueued plates queued, a removed one's work stops.
  if (method === "PUT" && path === "/app/api/settings/printers") {
    // Saved from an older version (another window changed the list or the
    // default): refused, and nothing changes, as the server does.
    if (body.version !== state.printersVersion) {
      return json(409, { error: "printers_changed", message: PRINTERS_CHANGED });
    }
    state.printersVersion += 1;
    const next: string[] = body.printers;
    const added = next.filter((id) => !state.myPrinters.includes(id));
    if (added.some((id) => !MENU_IDS.includes(id))) {
      return json(400, {
        error: "unknown_printer",
        message: "That printer is not in the slicer's printer list.",
      });
    }
    const removed = state.myPrinters.filter((id) => !next.includes(id));
    state.myPrinters = [...next];
    state.printerId = body.defaultId;
    for (const id of added) state.waiting[id] = state.addQueued;
    for (const id of removed) delete state.waiting[id];
    return json(200, {
      added: added.map((printerId) => ({
        printerId,
        queued: state.addQueued,
        through: throughOf(printerId),
      })),
      removed,
    });
  }
  if (
    method === "GET" &&
    (path === "/app/api/tokens" || path === "/app/api/users") &&
    state.listsFail
  ) {
    return json(500, { error: "internal_error" });
  }
  if (method === "GET" && path === "/app/api/tokens") return json(200, { tokens: state.tokens });
  if (method === "POST" && path === "/app/api/tokens") {
    if (state.rateLimited) return limited();
    // A session signed in too long ago is refused, as the server does (issue #322).
    if (state.signInRequired) {
      return json(403, STALE_ANSWER);
    }
    const token = freshToken();
    issued.push(token);
    const row = {
      id: `t${state.tokens.length + 1}`,
      name: body.name,
      prefix: token.slice(0, 8),
      createdAt: "2026-11-12T10:00:00.000Z",
      lastUsedAt: null,
      createdBy: { subject: "subject-me", name: "Synthetic Me" },
    };
    state.tokens = [row, ...state.tokens];
    return json(201, { ...row, token });
  }
  if (method === "DELETE" && seg[0] === "tokens") {
    if (state.signInRequired) return json(403, STALE_ANSWER);
    // A token already revoked elsewhere is 404, as the server answers it.
    if (!state.tokens.some((t) => t.id === seg[1])) return json(404, { error: "not_found" });
    state.tokens = state.tokens.filter((t) => t.id !== seg[1]);
    return json(204);
  }
  if (method === "GET" && path === "/app/api/users")
    return json(200, { users: state.users, unknownTokens: state.unknownTokens });
  // Sign out everywhere, as the server does: every session of the user ends,
  // and with revokeTokens every live token they made is revoked.
  if (method === "POST" && path === "/app/api/users/sign-out") {
    if (state.rateLimited) return limited();
    // Revoking tokens with no maker needs a fresh sign-in for any target, yourself included.
    if (
      state.signInRequired &&
      (body.subject !== "subject-me" || body.revokeUnknownTokens === true)
    )
      return json(403, STALE_ANSWER);
    const user = state.users.find((u) => u.subject === body.subject);
    const sessionsEnded = user?.sessions ?? 0;
    const theirs = state.tokens.filter((t) => t.createdBy?.subject === body.subject);
    const tokensRevoked = body.revokeTokens === true ? theirs.length : 0;
    if (body.revokeTokens === true) {
      state.tokens = state.tokens.filter((t) => !theirs.includes(t));
    }
    state.users = state.users
      .map((u) =>
        u.subject === body.subject
          ? { ...u, sessions: 0, tokens: body.revokeTokens === true ? 0 : u.tokens }
          : u,
      )
      .filter((u) => u.sessions > 0 || u.tokens > 0);
    const unknownTokensRevoked = body.revokeUnknownTokens === true ? state.unknownTokens : 0;
    if (body.revokeUnknownTokens === true) {
      state.tokens = state.tokens.filter((t) => t.createdBy !== null);
      state.unknownTokens = 0;
    }
    return json(200, { sessionsEnded, tokensRevoked, unknownTokensRevoked });
  }
  if (method === "GET" && path === "/app/api/trash") {
    // Paged as the server pages it: newest first, 100 to a page, a page past
    // the end served as the last page.
    const pageSize = Number(url.searchParams.get("limit") ?? 100);
    const total = state.trash.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(Number(url.searchParams.get("page") ?? 1), 1), pageCount);
    const newestFirst = [...state.trash].sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
    const answer = json(200, {
      models: newestFirst.slice((page - 1) * pageSize, page * pageSize),
      readAt: state.now,
      page,
      pageSize,
      pageCount,
      total,
      emptying,
      purging: state.trash.filter((m) => m.purgeStarted).length,
    });
    if (parkedTrash === null) return answer;
    const queue = parkedTrash;
    return new Promise<Response>((resolve) => queue.push(() => resolve(answer)));
  }
  // Empty trash purges only the models trashed at or before the cutoff it is
  // sent, as the server does: a model trashed after the page read the list
  // stays. A cutoff that is not a time, or is later than the server's clock,
  // is refused.
  if (method === "POST" && path === "/app/api/trash/empty") {
    const cutoff = typeof body?.cutoff === "string" ? Date.parse(body.cutoff) : Number.NaN;
    if (Number.isNaN(cutoff) || cutoff > Date.parse(state.now)) {
      return json(400, { error: "bad_request" });
    }
    // The server marks the models and queues the job; it answers at once,
    // with its clock read after the marks commit, which every listing read
    // since then answers as readAt or later. Marking nothing queues no job.
    // The job is the test's to finish (finishEmptying).
    const asked = state.trash.filter((m) => Date.parse(m.trashedAt) <= cutoff);
    state.trash = state.trash.map((m) => (asked.includes(m) ? { ...m, purgeStarted: true } : m));
    if (asked.length > 0) emptying = true;
    state.now = new Date(Date.parse(state.now) + 1000).toISOString();
    return json(202, { queued: asked.length, at: state.now });
  }
  if (method === "POST" && seg[0] === "trash" && seg[2] === "restore") {
    if (!state.trash.some((m) => m.id === seg[1])) return json(404, { error: "not_found" });
    state.trash = state.trash.filter((m) => m.id !== seg[1]);
    return json(204);
  }
  if (method === "GET" && path === "/app/api/collections") {
    return json(200, { collections: counts("collections") });
  }
  if (method === "GET" && path === "/app/api/tags") return json(200, { tags: counts("tags") });
  if (method === "DELETE" && path === "/app/api/tags") {
    return deleteLabel("tags", url.searchParams.get("name"));
  }
  if (method === "DELETE" && path === "/app/api/collections") {
    return deleteLabel("collections", url.searchParams.get("name"));
  }
  if (method === "GET" && path === "/app/api/creators") {
    return json(200, { creators: counts("creator") });
  }
  if (method === "GET" && path === "/app/api/organise/models") {
    const tag = url.searchParams.get("tag");
    const collection = url.searchParams.get("collection");
    const creator = url.searchParams.get("creator");
    const models = state.models.filter(
      (m) =>
        (tag === null || m.tags.includes(tag)) &&
        (collection === null || m.collections.includes(collection)) &&
        (creator === null || m.creator === creator),
    );
    return json(200, { models, nextCursor: null });
  }
  // The library's routes, for the Show in the library link: the
  // creator filter is the exact name and the collection filter ignores case,
  // as the server's search does (apps/server/src/library/search.ts).
  if (method === "GET" && path === "/app/api/library/tags") return json(200, { tags: [] });
  if (method === "GET" && path === "/app/api/library") {
    const collection = url.searchParams.get("collection");
    const creator = url.searchParams.get("creator");
    const models = state.models
      .filter(
        (m) =>
          (collection === null || m.collections.some((c) => sameName(c, collection))) &&
          (creator === null || m.creator === creator),
      )
      .map((m) => ({
        id: m.id,
        name: m.name,
        creator: m.creator,
        tags: m.tags,
        plateCount: 0,
        thumbnail: null,
        fileKind: m.files[0]?.kind ?? null,
        timeSeconds: null,
        weightGrams: null,
        partial: false,
        numbersUnavailable: false,
      }));
    return json(200, {
      printer: P1S,
      printerName: NAMES[P1S],
      printers: [{ id: P1S, name: NAMES[P1S] }],
      models,
      nextCursor: null,
    });
  }
  if (method === "PATCH" && seg[0] === "models") {
    const m = model(seg[1]);
    if (m === undefined) return json(404, { error: "not_found" });
    m.name = body.name.trim();
    return json(204);
  }
  if (method === "PATCH" && seg[0] === "files") {
    for (const m of state.models) {
      const f = m.files.find((x) => x.id === seg[1]);
      if (f !== undefined) f.name = body.name.trim();
    }
    return json(204);
  }
  // A tag or collection name goes in the query, never the path: the URL
  // parser rewrites a path segment of "." or ".." (new URL above does too).
  if (seg[0] === "models" && seg[2] === "tags" && seg.length === 3) {
    const m = model(seg[1]);
    const tag = url.searchParams.get("name");
    if (m === undefined || tag === null) return json(404, { error: "not_found" });
    if (method === "PUT") {
      const name = storedName("tags", tag);
      if (!m.tags.some((t) => sameName(t, name))) m.tags.push(name);
      return json(200, { name });
    }
    if (method === "DELETE") m.tags = m.tags.filter((t) => !sameName(t, tag));
    return json(204);
  }
  if (seg[0] === "models" && seg[2] === "collections" && seg.length === 3) {
    const m = model(seg[1]);
    const name = url.searchParams.get("name");
    if (m === undefined || name === null) return json(404, { error: "not_found" });
    if (method === "PUT") {
      const stored = storedName("collections", name);
      if (!m.collections.some((c) => sameName(c, stored))) m.collections.push(stored);
      return json(200, { name: stored });
    }
    if (method === "DELETE") m.collections = m.collections.filter((c) => !sameName(c, name));
    return json(204);
  }
  if (method === "POST" && seg[0] === "models" && seg[2] === "trash") {
    if (model(seg[1]) === undefined) return json(404, { error: "not_found" });
    state.models = state.models.filter((m) => m.id !== seg[1]);
    return json(204);
  }
  return json(404, { error: "not_found" });
}

let container: HTMLDivElement;
let root: Root;
let dialogs: {
  confirm: ReturnType<typeof vi.spyOn>;
  alert: ReturnType<typeof vi.spyOn>;
  prompt: ReturnType<typeof vi.spyOn>;
};

beforeEach(() => {
  state = {
    printerId: P1S,
    printersVersion: 1,
    myPrinters: [P1S],
    waiting: {},
    // A library of 463 plates.
    addQueued: 463,
    bucketVersioning: "enabled",
    tokens: [
      {
        id: "t0",
        name: "Office desktop",
        prefix: "ph_Ab3dE",
        createdAt: "2026-11-01T09:00:00.000Z",
        lastUsedAt: "2026-11-11T08:30:00.000Z",
        createdBy: null,
      },
    ],
    users: [{ subject: "subject-me", name: "Synthetic Me", sessions: 1, tokens: 0, you: true }],
    unknownTokens: 0,
    signInRequired: false,
    listsFail: false,
    rateLimited: false,
    trash: [
      {
        id: "m-trashed-1",
        name: "Old benchy",
        creator: null,
        trashedAt: "2026-11-10T12:00:00.000Z",
        purgeAt: "2026-12-10T12:00:00.000Z",
        purgeStarted: false,
      },
      {
        id: "m-trashed-2",
        name: "Broken clip",
        creator: "Maker",
        trashedAt: "2026-11-11T12:00:00.000Z",
        purgeAt: "2026-12-11T12:00:00.000Z",
        purgeStarted: false,
      },
    ],
    now: "2026-11-12T09:00:00.000Z",
    models: [
      {
        id: "m1",
        name: "Cable clip",
        creator: "Maker",
        tags: ["PLA"],
        collections: ["Desk"],
        files: [{ id: "f1", name: "Cable clip.3mf", kind: "3mf" }],
      },
      {
        id: "m2",
        name: "Hook",
        creator: "Other",
        tags: [],
        collections: ["Desk", "Garage"],
        files: [{ id: "f2", name: "Hook.stl", kind: "stl" }],
      },
    ],
    unusedTags: [],
    unusedCollections: [],
  };
  calls.length = 0;
  issued.length = 0;
  held.clear();
  failing.clear();
  emptying = false;
  slicerDown = false;
  parked = null;
  parkedTrash = null;
  vi.stubGlobal("fetch", vi.fn(fakeApi));
  dialogs = {
    confirm: vi.spyOn(window, "confirm").mockImplementation(() => true),
    alert: vi.spyOn(window, "alert").mockImplementation(() => {}),
    prompt: vi.spyOn(window, "prompt").mockImplementation(() => null),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // No native browser dialog on any page, ever.
  expect(dialogs.confirm).not.toHaveBeenCalled();
  expect(dialogs.alert).not.toHaveBeenCalled();
  expect(dialogs.prompt).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Lets fetches resolve and React render what they bring. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Lets 3 seconds pass, so a poll fires, and lets what it reads render. */
async function pollOnce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(EMPTYING_POLL_MS);
  });
  await settle();
}

/**
 * The background job ends: the models it deleted leave the trash, and
 * stuck of the marked ones stay (still marked, as the server leaves them).
 */
function finishEmptying(stuck = 0): void {
  const marked = state.trash.filter((m) => m.purgeStarted);
  const kept = marked.slice(0, stuck);
  state.trash = state.trash.filter((m) => !m.purgeStarted || kept.includes(m));
  emptying = false;
}

async function show(path: string, page: ReactNode): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={path.split("?")[0]} element={page} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

/** A group page at path, with the library at / for its Show in the library link. */
async function showWithLibrary(path: string, page: ReactNode): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={path.split("?")[0]} element={page} />
          <Route path="/" element={<LibraryPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

/** The query of the last request for the library's cards. */
function lastLibraryQuery(): URLSearchParams {
  const last = calls
    .filter((c) => c.method === "GET" && /^\/app\/api\/library(?:\?|$)/.test(c.path))
    .at(-1);
  if (last === undefined) throw new Error("the library was never asked for");
  return new URL(last.path, "https://platehouse.test").searchParams;
}

/** The names on the library's cards. */
function libraryCards(): string[] {
  return [...document.querySelectorAll(".studio-grid .studio-card-title")].map(
    (el) => el.textContent ?? "",
  );
}

function text(): string {
  return document.body.textContent ?? "";
}

/** The button whose accessible name (aria-label, else its text) is name. */
function button(name: string, within: ParentNode = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  );
  if (found === undefined) throw new Error(`no button named ${JSON.stringify(name)}`);
  return found;
}

/** The form control a label with this text names. */
function labelled<T extends HTMLElement>(label: string): T {
  const el = [...document.querySelectorAll("label")].find((l) => l.textContent?.trim() === label);
  const id = el?.getAttribute("for");
  const control = id ? document.getElementById(id) : null;
  if (control === null) throw new Error(`no control labelled ${JSON.stringify(label)}`);
  return control as T;
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => el.click());
  await settle();
}

/** Types into a controlled input the way a user does, so React sees the change. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function press(el: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
  await settle();
}

/**
 * Where a browser sends the next key. jsdom leaves focus on a button that
 * has just been disabled, but Chromium applies the HTML focus fixup rule and
 * moves focus to the page body, where the dialog's key handling never sees
 * it. This does the same as Chromium before reading the focused element, so
 * a test that presses keys on focused() presses them where a user would.
 */
function focused(): Element {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches(":disabled")) active.blur();
  return document.activeElement ?? document.body;
}

async function submit(input: HTMLInputElement): Promise<void> {
  await act(async () => input.form?.requestSubmit());
  await settle();
}

function callsTo(method: string, path: string): Call[] {
  return calls.filter((c) => c.method === method && c.path === path);
}

/** What the page's role="alert" elements say, which a screen reader announces. */
function announced(): string {
  return [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent).join(" ");
}

/** What Sign out everywhere's live status line says after a change (role="status"). */
function signOutStatus(): string {
  return document.querySelector("[data-sign-out-status]")?.textContent ?? "";
}

/** The link whose text is name. */
function link(name: string): HTMLAnchorElement {
  const found = [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no link named ${JSON.stringify(name)}`);
  return found;
}

describe("the settings page", () => {
  test("versioning off shows the warning", async () => {
    state.bucketVersioning = "off";
    await show("/settings", <SettingsPage />);
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(VERSIONING_OFF_WARNING);
    expect(alert?.className).toContain("studio-alert-alert");
    expect(VERSIONING_OFF_WARNING).toBe(
      "Bucket versioning is off. Turn it on at your storage provider and keep old versions for 30 days.",
    );
  });

  test("suspended versioning shows the same warning, and enabled shows none", async () => {
    state.bucketVersioning = "suspended";
    await show("/settings", <SettingsPage />);
    expect(text()).toContain(VERSIONING_OFF_WARNING);

    await act(async () => root.unmount());
    root = createRoot(container);
    state.bucketVersioning = "enabled";
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Settings");
    expect(text()).not.toContain(VERSIONING_OFF_WARNING);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  /** The My printers list as it reads: each printer's name line, in order. */
  function myPrinters(): string[] {
    return [...document.querySelectorAll("[data-my-printer]")].map(
      (li) => li.querySelector(".ph-printer-name")?.textContent ?? "",
    );
  }

  function putBodies(): unknown[] {
    return callsTo("PUT", "/app/api/settings/printers").map((c) => c.body);
  }

  // The maintainer, 2026-11-19: the closed menu showed only "0.4 mm nozzle", so the
  // chosen printer could not be told apart.
  test("the printer menu names every printer in full, closed or open, and stays grouped", async () => {
    await show("/settings", <SettingsPage />);
    const select = labelled<HTMLSelectElement>("Add a printer");
    const groups = [...select.querySelectorAll("optgroup")].map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll("option")].map((o) => [o.value, o.textContent]),
    }));
    expect(groups).toEqual([
      {
        label: "Bambu Lab P1S",
        options: [
          [P1S, "Bambu Lab P1S, 0.4 mm nozzle"],
          [P1S_06, "Bambu Lab P1S, 0.6 mm nozzle"],
        ],
      },
      { label: "Bambu Lab X1 Carbon", options: [[X1C, "Bambu Lab X1 Carbon, 0.4 mm nozzle"]] },
    ]);
    // A closed select shows its chosen option's text: the printer in full.
    await choose(select, X1C);
    expect(select.selectedOptions[0]?.textContent).toBe("Bambu Lab X1 Carbon, 0.4 mm nozzle");
    // A printer already in My printers is not offered twice.
    const p1s = [...select.querySelectorAll("option")].find((o) => o.value === P1S);
    expect(p1s?.disabled).toBe(true);
  });

  test("My printers lists each printer in full, in order, with the default marked", async () => {
    state.myPrinters = [X1C, P1S];
    state.printerId = P1S;
    await show("/settings", <SettingsPage />);
    expect(myPrinters()).toEqual([
      "Bambu Lab X1 Carbon, 0.4 mm nozzle",
      "Bambu Lab P1S, 0.4 mm nozzle",
    ]);
    const items = [...document.querySelectorAll("[data-my-printer]")];
    expect(items[1]?.textContent).toContain("Default");
    expect(items[0]?.textContent).not.toContain("Default");
    expect(text()).toContain(
      "Times and weights are estimated for every printer here. The default is shown first",
    );
  });

  test("adding a printer saves the list, and says how many plates it queued and how long that takes", async () => {
    await show("/settings", <SettingsPage />);
    await choose(labelled<HTMLSelectElement>("Add a printer"), X1C);
    await click(button("Add printer"));
    expect(putBodies()).toEqual([{ printers: [P1S, X1C], defaultId: P1S, version: 1 }]);
    const status = document.querySelector('[role="status"]')?.textContent ?? "";
    // 463 plates at the slicer's measured 3 a minute is 154.3 minutes.
    expect(status).toBe(
      "Added Bambu Lab X1 Carbon, 0.4 mm nozzle. Platehouse is now estimating 463 plates " +
        "for it, one at a time, at about 3 plates a minute, so this takes about 2 hours and " +
        "35 minutes. Its numbers show on each plate as they land, and the other printers' " +
        "numbers stay as they are.",
    );
    expect(myPrinters()).toEqual([
      "Bambu Lab P1S, 0.4 mm nozzle",
      "Bambu Lab X1 Carbon, 0.4 mm nozzle",
    ]);
    // The queue shows that work on the printer's own line.
    expect(document.querySelectorAll("[data-my-printer]")[1]?.textContent).toContain(
      "463 plates waiting to be estimated",
    );
  });

  test("the waiting counts are read again every WAITING_POLL_MS while any are waiting, and a failed read does not stop it", async () => {
    // shouldAdvanceTime lets settle()'s zero-delay timers run; the poll is
    // stepped by hand.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      state.myPrinters = [P1S, X1C];
      state.waiting = { [X1C]: 463 };
      await show("/settings", <SettingsPage />);
      const line = () => document.querySelectorAll("[data-my-printer]")[1]?.textContent ?? "";
      const step = async () => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
        });
        await settle();
      };
      expect(line()).toContain("463 plates waiting to be estimated");
      for (const left of [400, 300]) {
        state.waiting[X1C] = left;
        await step();
        expect(line()).toContain(`${left} plates waiting to be estimated`);
      }
      // A read that fails is tried again on the next tick.
      failing.add("GET /app/api/settings");
      await step();
      failing.delete("GET /app/api/settings");
      state.waiting[X1C] = 200;
      await step();
      expect(line()).toContain("200 plates waiting to be estimated");
      // Once nothing is waiting the page stops asking.
      state.waiting[X1C] = 0;
      await step();
      const reads = callsTo("GET", "/app/api/settings").length;
      await step();
      await step();
      expect(callsTo("GET", "/app/api/settings")).toHaveLength(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the printer menu's poll pauses while the tab is hidden, and reads once and resumes when it is shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setVisibility = (value: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { value, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      state.myPrinters = [P1S, X1C];
      state.waiting = { [X1C]: 463 };
      await show("/settings", <SettingsPage />);
      const reads = () => callsTo("GET", "/app/api/settings").length;
      await act(async () => {
        setVisibility("hidden");
      });
      const hiddenAt = reads();
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
        });
        await settle();
      }
      expect(reads()).toBe(hiddenAt);
      await act(async () => {
        setVisibility("visible");
      });
      await settle();
      expect(reads()).toBe(hiddenAt + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
      });
      await settle();
      expect(reads()).toBe(hiddenAt + 2);
    } finally {
      setVisibility("visible");
      vi.useRealTimers();
    }
  });

  // Issue #254: every change sends the whole list, so a change made from a
  // list that does not have a just-added printer yet removes it (and cancels
  // its slices) with no confirm. The controls must wait for the list read
  // after a save, and an older read must not put the old list back.
  test("after a save the controls wait for the new list, so a click in between sends nothing", async () => {
    state.myPrinters = [P1S, X1C];
    await show("/settings", <SettingsPage />);
    parked = [];
    await choose(labelled<HTMLSelectElement>("Add a printer"), P1S_06);
    await click(button("Add printer"));
    expect(putBodies()).toEqual([{ printers: [P1S, X1C, P1S_06], defaultId: P1S, version: 1 }]);
    // The PUT has answered; the list read after it has not.
    expect(parked).toHaveLength(1);
    const makeDefault = button(`Make ${NAMES[X1C]} the default`);
    expect(makeDefault.getAttribute("aria-disabled")).toBe("true");
    await click(makeDefault);
    await click(button(`Move ${NAMES[X1C]} up`));
    expect(putBodies()).toHaveLength(1);

    await act(async () => parked?.[0]?.());
    await settle();
    expect(myPrinters()).toEqual([
      "Bambu Lab P1S, 0.4 mm nozzle",
      "Bambu Lab X1 Carbon, 0.4 mm nozzle",
      "Bambu Lab P1S, 0.6 mm nozzle",
    ]);
    expect(button(`Make ${NAMES[X1C]} the default`).getAttribute("aria-disabled")).toBe("false");
    await click(button(`Make ${NAMES[X1C]} the default`));
    expect(putBodies().at(-1)).toEqual({
      printers: [P1S, X1C, P1S_06],
      defaultId: X1C,
      version: 2,
    });
  });

  // PR #240 review, stale-list-put-removes-printer: the controls waiting for
  // the read after a save only covers this page. A page open in another
  // window still holds the list it read, and its next change would drop a
  // printer added in the other window, cancelling its slices with no confirm.
  test("a change made from a list another window has changed is refused, and the page reads the list again", async () => {
    state.myPrinters = [P1S, X1C];
    await show("/settings", <SettingsPage />);
    // Another window adds the 0.6 mm P1S; 463 plates are queued for it.
    state.myPrinters = [P1S, X1C, P1S_06];
    state.waiting = { [P1S_06]: 463 };
    state.printersVersion += 1;
    const move = button(`Move ${NAMES[X1C]} up`);
    move.focus();
    await click(move);
    expect(putBodies()).toEqual([{ printers: [X1C, P1S], defaultId: P1S, version: 1 }]);
    // Nothing was dropped, and the page now shows the list as stored.
    expect(state.myPrinters).toEqual([P1S, X1C, P1S_06]);
    expect(state.waiting[P1S_06]).toBe(463);
    expect(myPrinters()).toEqual([
      "Bambu Lab P1S, 0.4 mm nozzle",
      "Bambu Lab X1 Carbon, 0.4 mm nozzle",
      "Bambu Lab P1S, 0.6 mm nozzle",
    ]);
    // The list was read again, so the page says it now shows the change.
    expect(announced()).toContain(`${PRINTERS_CHANGED} ${REREAD_SHOWS_CHANGE}`);
    // The controls are back, and the next change is made from the new list.
    expect(button(`Move ${NAMES[X1C]} up`).getAttribute("aria-disabled")).toBe("false");
    await click(button(`Move ${NAMES[X1C]} up`));
    expect(putBodies().at(-1)).toEqual({
      printers: [X1C, P1S, P1S_06],
      defaultId: P1S,
      version: 2,
    });
    expect(state.myPrinters).toEqual([X1C, P1S, P1S_06]);
  });

  // Issue #272: the same when the other window changed only the default. A
  // save from this page would otherwise put the old default back.
  test("a change made after another window changed the default is refused, and the default stays", async () => {
    state.myPrinters = [P1S, X1C];
    await show("/settings", <SettingsPage />);
    // Another window makes the X1C the default; the list is the same.
    state.printerId = X1C;
    state.printersVersion += 1;
    await choose(labelled<HTMLSelectElement>("Add a printer"), P1S_06);
    await click(button("Add printer"));
    expect(putBodies()).toEqual([{ printers: [P1S, X1C, P1S_06], defaultId: P1S, version: 1 }]);
    // Nothing changed: the X1C is still the default, and no printer was added.
    expect(state.printerId).toBe(X1C);
    expect(state.myPrinters).toEqual([P1S, X1C]);
    expect(announced()).toContain(`${PRINTERS_CHANGED} ${REREAD_SHOWS_CHANGE}`);
    // The page shows the new default, and the next save keeps it.
    const items = [...document.querySelectorAll("[data-my-printer]")];
    expect(items[1]?.textContent).toContain("Default");
    await choose(labelled<HTMLSelectElement>("Add a printer"), P1S_06);
    await click(button("Add printer"));
    expect(putBodies().at(-1)).toEqual({
      printers: [P1S, X1C, P1S_06],
      defaultId: X1C,
      version: 2,
    });
    expect(state.printerId).toBe(X1C);
    expect(state.myPrinters).toEqual([P1S, X1C, P1S_06]);
  });

  test("a refused change whose list cannot be read again keeps the controls locked and says nothing was saved", async () => {
    state.myPrinters = [P1S, X1C];
    await show("/settings", <SettingsPage />);
    state.myPrinters = [P1S, X1C, P1S_06];
    state.printersVersion += 1;
    failing.add("GET /app/api/settings");
    await click(button(`Move ${NAMES[X1C]} up`));
    expect(putBodies()).toHaveLength(1);
    // One message, the page's own: the list on screen is still the old one,
    // so nothing may claim it now shows the change (#252).
    expect(announced()).toBe(
      "My printers or the default printer were changed somewhere else, so nothing was saved, and the list could not be read again, so the buttons wait until it is.Read the list again",
    );
    expect(text()).not.toContain(REREAD_SHOWS_CHANGE);
    expect(text()).not.toContain("The change was saved");
    await click(button(`Make ${NAMES[X1C]} the default`));
    expect(putBodies()).toHaveLength(1);

    failing.delete("GET /app/api/settings");
    await click(button("Read the list again"));
    expect(myPrinters()).toHaveLength(3);
    expect(button(`Move ${NAMES[X1C]} up`).getAttribute("aria-disabled")).toBe("false");
  });

  test("a waiting-count read sent before a save that answers after the save's own read is dropped", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      state.myPrinters = [P1S, X1C];
      state.waiting = { [X1C]: 463 };
      await show("/settings", <SettingsPage />);
      parked = [];
      // The poll asks while the list is still P1S and X1C...
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
      });
      expect(parked).toHaveLength(1);
      // ...then a printer is added, and the read after the save goes out.
      await choose(labelled<HTMLSelectElement>("Add a printer"), P1S_06);
      await click(button("Add printer"));
      expect(parked).toHaveLength(2);
      // The newer read answers first, then the older poll.
      await act(async () => parked?.[1]?.());
      await settle();
      await act(async () => parked?.[0]?.());
      await settle();
      expect(myPrinters()).toHaveLength(3);
      expect(myPrinters()[2]).toBe("Bambu Lab P1S, 0.6 mm nozzle");
      await click(button(`Move ${NAMES[X1C]} up`));
      expect(putBodies().at(-1)).toEqual({
        printers: [X1C, P1S, P1S_06],
        defaultId: P1S,
        version: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("when the list cannot be read after a save, the controls stay locked until it is read again", async () => {
    state.myPrinters = [P1S, X1C];
    await show("/settings", <SettingsPage />);
    failing.add("GET /app/api/settings");
    await choose(labelled<HTMLSelectElement>("Add a printer"), P1S_06);
    await click(button("Add printer"));
    expect(putBodies()).toHaveLength(1);
    expect(text()).toContain(
      "The change was saved, but the list could not be read again, so the buttons wait until it is.",
    );
    const makeDefault = button(`Make ${NAMES[X1C]} the default`);
    expect(makeDefault.getAttribute("aria-disabled")).toBe("true");
    await click(makeDefault);
    expect(putBodies()).toHaveLength(1);

    failing.delete("GET /app/api/settings");
    await click(button("Read the list again"));
    expect(myPrinters()).toHaveLength(3);
    expect(button(`Make ${NAMES[X1C]} the default`).getAttribute("aria-disabled")).toBe("false");
    expect(text()).not.toContain("the list could not be read again");
  });

  // PR #240 review, eta-ignores-shared-queue: one slicer does every
  // printer's plates one at a time, so a printer behind another's work
  // waits for it too. 463 + 463 plates at 3 a minute is 308.7 minutes.
  test("with two printers' work waiting, the second printer's time counts the plates ahead of it", async () => {
    state.myPrinters = [P1S, X1C, P1S_06];
    state.waiting = { [X1C]: 463, [P1S_06]: 463 };
    await show("/settings", <SettingsPage />);
    const lines = [...document.querySelectorAll("[data-my-printer]")].map((li) => li.textContent);
    expect(lines[1]).toContain(
      "463 plates waiting to be estimated, about 2 hours and 35 minutes left.",
    );
    expect(lines[2]).toContain(
      "463 plates waiting to be estimated, about 5 hours and 9 minutes left, counting 463 other plates and renders queued ahead of them.",
    );
  });

  test("a printer added behind another's queued work is told the whole wait", async () => {
    state.myPrinters = [P1S, X1C];
    state.waiting = { [X1C]: 463 };
    await show("/settings", <SettingsPage />);
    await choose(labelled<HTMLSelectElement>("Add a printer"), P1S_06);
    await click(button("Add printer"));
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Added Bambu Lab P1S, 0.6 mm nozzle. Platehouse is now estimating 463 plates for it, " +
        "one at a time, at about 3 plates a minute. The slicer has 463 other plates and " +
        "renders queued ahead of them, so this takes about 5 hours and 9 minutes. Its numbers " +
        "show on each plate as they land, and the other printers' numbers stay as they are.",
    );
  });

  test("how long a printer takes to estimate is said in plain words", () => {
    expect(howLong(463, 3)).toBe("about 2 hours and 35 minutes");
    expect(howLong(180, 3)).toBe("about 1 hour");
    expect(howLong(181, 3)).toBe("about 1 hour and 1 minute");
    expect(howLong(120, 3)).toBe("about 40 minutes");
    expect(howLong(1, 3)).toBe("about 1 minute");
  });

  test("a printer that adds no work says every plate already has its numbers", async () => {
    state.addQueued = 0;
    await show("/settings", <SettingsPage />);
    await choose(labelled<HTMLSelectElement>("Add a printer"), X1C);
    await click(button("Add printer"));
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Added Bambu Lab X1 Carbon, 0.4 mm nozzle. Every plate already has numbers for it.",
    );
  });

  test("moving through the add menu saves nothing until Add printer is pressed", async () => {
    // On Windows, an arrow key on a focused, closed select changes its value
    // and fires change at once, so a change alone must not add a printer and
    // queue hours of slicing.
    await show("/settings", <SettingsPage />);
    const select = labelled<HTMLSelectElement>("Add a printer");
    await choose(select, P1S_06);
    await choose(select, X1C);
    expect(putBodies()).toHaveLength(0);
    expect(select.value).toBe(X1C);
  });

  test("make default and moving a printer save the new order and default, and slice nothing", async () => {
    state.myPrinters = [P1S, X1C];
    await show("/settings", <SettingsPage />);
    await click(button(`Make ${NAMES[X1C]} the default`));
    expect(putBodies().at(-1)).toEqual({
      printers: [P1S, X1C],
      defaultId: X1C,
      version: 1,
    });
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Bambu Lab X1 Carbon, 0.4 mm nozzle is now the default printer. No slicing was started.",
    );
    await click(button(`Move ${NAMES[X1C]} up`));
    expect(putBodies().at(-1)).toEqual({
      printers: [X1C, P1S],
      defaultId: X1C,
      version: 2,
    });
    expect(myPrinters()).toEqual([
      "Bambu Lab X1 Carbon, 0.4 mm nozzle",
      "Bambu Lab P1S, 0.4 mm nozzle",
    ]);
    // Focus follows the printer it moved, so the keyboard user keeps their place.
    expect(focused()).toBe(button(`Move ${NAMES[X1C]} up`));
    // The first printer cannot move up and the last cannot move down.
    expect(button(`Move ${NAMES[X1C]} up`).getAttribute("aria-disabled")).toBe("true");
    expect(button(`Move ${NAMES[P1S]} down`).getAttribute("aria-disabled")).toBe("true");
    await click(button(`Move ${NAMES[P1S]} down`));
    expect(putBodies()).toHaveLength(2);
  });

  test("remove asks first, says the printer's waiting work stops, and the default cannot be removed", async () => {
    state.myPrinters = [P1S, X1C];
    state.waiting = { [X1C]: 120 };
    const confirm = vi.spyOn(window, "confirm");
    await show("/settings", <SettingsPage />);
    const removeDefault = button(`Remove ${NAMES[P1S]}`);
    expect(removeDefault.getAttribute("aria-disabled")).toBe("true");
    await click(removeDefault);
    expect(dialog()).toBeNull();
    expect(text()).toContain("Make another printer the default before removing this one.");

    await click(button(`Remove ${NAMES[X1C]}`));
    expect(dialog()?.textContent).toContain(
      "The 120 plates still waiting to be estimated for it are dropped. Numbers already made for it are kept.",
    );
    await click(button("Remove", dialog() ?? document.body));
    expect(putBodies()).toEqual([{ printers: [P1S], defaultId: P1S, version: 1 }]);
    expect(myPrinters()).toEqual(["Bambu Lab P1S, 0.4 mm nozzle"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("a save that fails puts the list back and announces the error", async () => {
    await show("/settings", <SettingsPage />);
    failing.add("PUT /app/api/settings/printers");
    await choose(labelled<HTMLSelectElement>("Add a printer"), X1C);
    const add = button("Add printer");
    add.focus();
    await click(add);
    expect(myPrinters()).toEqual(["Bambu Lab P1S, 0.4 mm nozzle"]);
    expect(announced()).toContain("This is unavailable right now.");
    expect(focusedNotBody()).toBe(add);
  });

  test("while a save runs, the controls ignore input and keep focus", async () => {
    await show("/settings", <SettingsPage />);
    const release = hold("PUT /app/api/settings/printers");
    const select = labelled<HTMLSelectElement>("Add a printer");
    await choose(select, X1C);
    const add = button("Add printer");
    add.focus();
    await click(add);
    expect(putBodies()).toHaveLength(1);
    expect(focused()).toBe(add);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(select.matches(":disabled")).toBe(false);
    await click(add);
    expect(putBodies()).toHaveLength(1);
    await release();
    expect(add.getAttribute("aria-disabled")).toBe("false");
  });

  test("with the slicer unreachable, My printers still show and adding says why", async () => {
    slicerDown = true;
    await show("/settings", <SettingsPage />);
    expect(myPrinters()).toEqual(["Bambu Lab P1S, 0.4 mm nozzle"]);
    expect(text()).toContain("The slicer cannot be reached, so no printer can be added right now.");
    for (const label of document.querySelectorAll("label")) {
      const id = label.getAttribute("for");
      if (id !== null) expect(document.getElementById(id), label.textContent ?? "").not.toBeNull();
    }
  });

  test("a listed printer the slicer no longer offers says so", async () => {
    const gone = "Bambu Lab A1 0.4 nozzle";
    state.myPrinters = [P1S, gone];
    await show("/settings", <SettingsPage />);
    expect(document.querySelectorAll("[data-my-printer]")[1]?.textContent).toContain(
      "The slicer no longer offers this printer, so nothing can be estimated for it.",
    );
  });

  test("new token is shown once and never again", async () => {
    await show("/settings", <SettingsPage />);
    await type(labelled<HTMLInputElement>("Token name"), "Build server script");
    await click(button("Create token"));
    expect(callsTo("POST", "/app/api/tokens")).toHaveLength(1);
    const token = issued[0] as string;

    // Shown once, in a themed dialog, with Copy.
    const shown = dialog();
    expect(shown).not.toBeNull();
    expect(shown?.getAttribute("aria-modal")).toBe("true");
    expect(shown?.textContent).toContain(token);
    expect(shown?.textContent).toContain("only time");
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await click(button("Copy", shown as HTMLElement));
    expect(writeText).toHaveBeenCalledWith(token);

    // Never again: gone once the dialog closes, and the list shows the prefix.
    await click(button("Done", shown as HTMLElement));
    expect(dialog()).toBeNull();
    expect(text()).not.toContain(token);
    expect(text()).not.toContain(token.slice(3));
    expect(text()).toContain("Build server script");
    expect(text()).toContain(token.slice(0, 8));
    expect(text()).toContain(", never used");
    expect(text()).not.toContain("Never used");

    // A fresh visit to the page still never shows it.
    await act(async () => root.unmount());
    root = createRoot(container);
    await show("/settings", <SettingsPage />);
    expect(text()).toContain(token.slice(0, 8));
    expect(text()).not.toContain(token);
  });

  test("the token list shows each token's prefix and last use, and revoke asks first", async () => {
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Office desktop");
    expect(text()).toContain("ph_Ab3dE");
    expect(document.querySelector('time[datetime="2026-11-11T08:30:00.000Z"]')).not.toBeNull();

    await click(button("Revoke Office desktop"));
    const ask = dialog();
    expect(ask?.textContent).toContain("Revoke");
    await click(button("Cancel", ask as HTMLElement));
    expect(callsTo("DELETE", "/app/api/tokens/t0")).toHaveLength(0);

    await click(button("Revoke Office desktop"));
    await click(button("Revoke", dialog() as HTMLElement));
    expect(callsTo("DELETE", "/app/api/tokens/t0")).toHaveLength(1);
    expect(text()).not.toContain("Office desktop");
  });

  test("a revoke in flight cannot be cancelled: Cancel and Escape wait for the answer", async () => {
    await show("/settings", <SettingsPage />);
    const release = hold("DELETE /app/api/tokens/t0");
    await click(button("Revoke Office desktop"));
    await click(button("Revoke", dialog() as HTMLElement));
    expect(callsTo("DELETE", "/app/api/tokens/t0")).toHaveLength(1);

    const cancel = button("Cancel", dialog() as HTMLElement);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    await click(cancel);
    await press(focused(), "Escape");
    expect(dialog()).not.toBeNull();

    await release();
    expect(dialog()).toBeNull();
    expect(text()).not.toContain("Office desktop");
  });

  test("a token already revoked elsewhere is done: it leaves the list with no error", async () => {
    await show("/settings", <SettingsPage />);
    await click(button("Revoke Office desktop"));
    state.tokens = [];
    await click(button("Revoke", dialog() as HTMLElement));
    expect(callsTo("DELETE", "/app/api/tokens/t0")).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(announced()).toBe("");
    expect(text()).not.toContain("Office desktop");
  });

  test("a token created while the first list is still loading is kept when the list lands", async () => {
    // The list's answer is read now, before the token exists, and arrives later.
    let arrive: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const answer = await fakeApi(input, init);
        const isList =
          (init.method ?? "GET").toUpperCase() === "GET" &&
          new URL(String(input), "https://platehouse.test").pathname === "/app/api/tokens";
        if (isList) await late;
        return answer;
      }),
    );
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Loading");
    await type(labelled<HTMLInputElement>("Token name"), "Quick script");
    await click(button("Create token"));
    await click(button("Done", dialog() as HTMLElement));
    await act(async () => arrive());
    await settle();
    expect(text()).toContain("Quick script");
    expect(text()).toContain("Office desktop");
  });

  // Issue #322: who made each token, a fresh sign-in for a new one, and
  // Sign out everywhere.
  test("each token says who made it, or that who made it is unknown", async () => {
    state.tokens.push(
      {
        id: "t5",
        name: "Named maker",
        prefix: "ph_Nm5aB",
        createdAt: "2026-11-03T09:00:00.000Z",
        lastUsedAt: null,
        createdBy: { subject: "subject-5", name: "Synthetic Maker" },
      },
      {
        id: "t6",
        name: "Nameless maker",
        prefix: "ph_Nl6cD",
        createdAt: "2026-11-04T09:00:00.000Z",
        lastUsedAt: null,
        createdBy: { subject: "subject-6", name: null },
      },
    );
    await show("/settings", <SettingsPage />);
    const row = (name: string) =>
      [...document.querySelectorAll("li")].find((li) => li.textContent?.includes(name));
    expect(row("Office desktop")?.textContent).toContain("Made by an unknown user");
    // A named maker is shown with their user id too, so two people with the
    // same name can be told apart (PR #364 review).
    expect(row("Named maker")?.textContent).toContain(
      "Made by \u2068Synthetic Maker\u2069 (user id subject-5)",
    );
    expect(row("Nameless maker")?.textContent).toContain("Made by subject-6");
  });

  test("a token list and a user list that cannot be read are announced as alerts", async () => {
    state.listsFail = true;
    await show("/settings", <SettingsPage />);
    const alerts = [...document.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) expect(alert.classList.contains("studio-alert-alert")).toBe(true);
  });

  test("a token refused for an old sign-in says to sign in again, with a link that comes back here", async () => {
    state.signInRequired = true;
    await show("/settings", <SettingsPage />);
    await type(labelled<HTMLInputElement>("Token name"), "Late script");
    await click(button("Create token"));
    expect(callsTo("POST", "/app/api/tokens")).toHaveLength(1);
    expect(dialog()).toBeNull();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("sign in again");
    const again = link("Sign in again");
    expect(again.getAttribute("href")).toBe("/auth/login?next=/settings");
  });

  test("a revoke refused for an old sign-in says to sign in again, and keeps the token", async () => {
    state.signInRequired = true;
    state.tokens = [
      {
        id: "t-stale",
        name: "Stale script",
        prefix: "ph_stale1",
        createdAt: "2026-11-01T10:00:00.000Z",
        lastUsedAt: null,
        createdBy: { subject: "subject-other", name: null },
      },
    ];
    await show("/settings", <SettingsPage />);
    await click(button("Revoke Stale script"));
    await click(button("Revoke", dialog() as HTMLElement));
    expect(callsTo("DELETE", "/app/api/tokens/t-stale")).toHaveLength(1);
    expect(text()).toContain("Stale script");
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("sign in again");
    expect(link("Sign in again").getAttribute("href")).toBe("/auth/login?next=/settings");
  });

  test("Sign out everywhere refused for an old sign-in says to sign in again", async () => {
    state.signInRequired = true;
    state.users.push({
      subject: "subject-gone",
      name: "Synthetic Gone",
      sessions: 2,
      tokens: 1,
      you: false,
    });
    await show("/settings", <SettingsPage />);
    await click(button("Sign out \u2068Synthetic Gone\u2069 (user id subject-gone) everywhere"));
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")).toHaveLength(1);
    expect(signOutStatus()).toBe("");
    const alert = document.querySelector("[data-sign-out-refused]");
    expect(alert?.textContent).toContain("sign in again");
    expect(link("Sign in again").getAttribute("href")).toBe("/auth/login?next=/settings");
  });

  test("a token refused for too many tries says to wait and try again later", async () => {
    state.rateLimited = true;
    await show("/settings", <SettingsPage />);
    await type(labelled<HTMLInputElement>("Token name"), "Busy script");
    await click(button("Create token"));
    expect(callsTo("POST", "/app/api/tokens")).toHaveLength(1);
    expect(dialog()).toBeNull();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "Too many tries from this sign-in. Wait a few minutes, then try again.",
    );
  });

  test("Sign out everywhere refused for too many tries says to wait and try again later", async () => {
    state.rateLimited = true;
    state.users.push({
      subject: "subject-busy",
      name: "Synthetic Busy",
      sessions: 1,
      tokens: 0,
      you: false,
    });
    await show("/settings", <SettingsPage />);
    await click(button("Sign out \u2068Synthetic Busy\u2069 (user id subject-busy) everywhere"));
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")).toHaveLength(1);
    expect(signOutStatus()).toBe("");
    expect(text()).toContain(
      "Too many tries from this sign-in. Wait a few minutes, then try again.",
    );
  });

  test("Sign out everywhere lists each user and asks before ending their sessions", async () => {
    state.users.push({
      subject: "subject-gone",
      name: "Synthetic Gone",
      sessions: 2,
      tokens: 1,
      you: false,
    });
    state.tokens.push({
      id: "t7",
      name: "Gone's script",
      prefix: "ph_Gn7eF",
      createdAt: "2026-11-05T09:00:00.000Z",
      lastUsedAt: null,
      createdBy: { subject: "subject-gone", name: "Synthetic Gone" },
    });
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Sign out everywhere");
    expect(text()).toContain("Synthetic Gone (user id subject-gone)");
    expect(text()).toContain("Synthetic Me (user id subject-me) (you)");

    await click(button("Sign out \u2068Synthetic Gone\u2069 (user id subject-gone) everywhere"));
    const ask = dialog();
    expect(ask?.textContent).toContain("\u2068Synthetic Gone\u2069 (user id subject-gone)");
    await click(button("Cancel", ask as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")).toHaveLength(0);

    await click(button("Sign out \u2068Synthetic Gone\u2069 (user id subject-gone) everywhere"));
    const box = (dialog() as HTMLElement).querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(false);
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")[0]?.body).toEqual({
      subject: "subject-gone",
      revokeTokens: false,
      revokeUnknownTokens: false,
    });
    expect(dialog()).toBeNull();
    expect(signOutStatus()).toContain(
      "Ended 2 sessions for \u2068Synthetic Gone\u2069 (user id subject-gone)",
    );
    // Its token was left alone.
    expect(text()).toContain("Gone's script");
  });

  test("Sign out everywhere shows each name inside a bdi, the user id outside it", async () => {
    state.users.push({
      subject: "subject-rtl",
      name: "\u05e9\u05dc\u05d5\u05dd Synthetic",
      sessions: 1,
      tokens: 0,
      you: false,
    });
    await show("/settings", <SettingsPage />);
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sign-out-status] ~ ul li strong"),
    );
    expect(rows).toHaveLength(2);
    const rtl = rows.find((row) => row.textContent?.includes("subject-rtl")) as HTMLElement;
    const wrapped = rtl.querySelectorAll("bdi");
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.textContent).toBe("\u05e9\u05dc\u05d5\u05dd Synthetic");
    expect(rtl.textContent).toBe("\u05e9\u05dc\u05d5\u05dd Synthetic (user id subject-rtl)");
    const mine = rows.find((row) => row.textContent?.includes("subject-me")) as HTMLElement;
    expect(mine.querySelector("bdi")?.textContent).toBe("Synthetic Me");
    expect(mine.textContent).toBe("Synthetic Me (user id subject-me) (you)");
  });

  test("Sign out everywhere isolates the name in the button label, dialog, status line and token list", async () => {
    state.users.push({
      subject: "subject-iso",
      name: "\u05e9\u05dc\u05d5\u05dd Synthetic",
      sessions: 1,
      tokens: 1,
      you: false,
    });
    state.tokens.push({
      id: "t9",
      name: "Iso script",
      prefix: "ph_Is0Ab",
      createdAt: "2026-11-05T09:00:00.000Z",
      lastUsedAt: null,
      createdBy: { subject: "subject-iso", name: "\u05e9\u05dc\u05d5\u05dd Synthetic" },
    });
    const isolated = "\u2068\u05e9\u05dc\u05d5\u05dd Synthetic\u2069 (user id subject-iso)";
    await show("/settings", <SettingsPage />);
    expect(text()).toContain(`Made by ${isolated}`);
    await click(button(`Sign out ${isolated} everywhere`));
    expect(dialog()?.textContent).toContain(isolated);
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(signOutStatus()).toContain(`for ${isolated}`);
  });

  test("Sign out everywhere can also revoke the user's tokens", async () => {
    state.users.push({
      subject: "subject-gone",
      name: "Synthetic Gone",
      sessions: 1,
      tokens: 1,
      you: false,
    });
    state.tokens.push({
      id: "t8",
      name: "Gone's script",
      prefix: "ph_Gn8gH",
      createdAt: "2026-11-05T09:00:00.000Z",
      lastUsedAt: null,
      createdBy: { subject: "subject-gone", name: "Synthetic Gone" },
    });
    await show("/settings", <SettingsPage />);
    await click(button("Sign out \u2068Synthetic Gone\u2069 (user id subject-gone) everywhere"));
    const box = (dialog() as HTMLElement).querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box).not.toBeNull();
    await click(box as HTMLInputElement);
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")[0]?.body).toEqual({
      subject: "subject-gone",
      revokeTokens: true,
      revokeUnknownTokens: false,
    });
    expect(signOutStatus()).toContain("revoked 1 API token");
    // The token list is read again, so the revoked token is gone from it.
    expect(text()).not.toContain("Gone's script");
  });

  test("Sign out everywhere tells apart two people with the same name by their user id", async () => {
    state.users.push(
      { subject: "subject-twin-a", name: "Synthetic Twin", sessions: 1, tokens: 1, you: false },
      { subject: "subject-twin-b", name: "Synthetic Twin", sessions: 1, tokens: 0, you: false },
    );
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Synthetic Twin (user id subject-twin-a)");
    expect(text()).toContain("Synthetic Twin (user id subject-twin-b)");

    await click(button("Sign out \u2068Synthetic Twin\u2069 (user id subject-twin-b) everywhere"));
    expect(dialog()?.textContent).toContain("\u2068Synthetic Twin\u2069 (user id subject-twin-b)");
    expect(dialog()?.textContent).not.toContain("subject-twin-a");
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")[0]?.body).toEqual({
      subject: "subject-twin-b",
      revokeTokens: false,
      revokeUnknownTokens: false,
    });
  });

  test("Sign out everywhere names a person with no name by their user id alone", async () => {
    state.users.push({
      subject: "subject-nameless",
      name: null,
      sessions: 1,
      tokens: 0,
      you: false,
    });
    await show("/settings", <SettingsPage />);
    expect(() => button("Sign out subject-nameless everywhere")).not.toThrow();
  });

  test("signing yourself out everywhere says so and offers to sign in again", async () => {
    await show("/settings", <SettingsPage />);
    await click(button("Sign out \u2068Synthetic Me\u2069 (user id subject-me) (you) everywhere"));
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")[0]?.body).toEqual({
      subject: "subject-me",
      revokeTokens: false,
      revokeUnknownTokens: false,
    });
    expect(signOutStatus()).toContain("You are signed out everywhere");
    expect(link("Sign in").getAttribute("href")).toBe("/auth/login");
  });

  test("Sign out everywhere offers the second box only when tokens have no recorded maker", async () => {
    await show("/settings", <SettingsPage />);
    await click(button("Sign out \u2068Synthetic Me\u2069 (user id subject-me) (you) everywhere"));
    expect(dialog()?.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(dialog()?.textContent).not.toContain("made by an unknown user");
  });

  test("Sign out everywhere shows the second box unticked, labelled with the count, and unticked again on reopening", async () => {
    state.unknownTokens = 2;
    await show("/settings", <SettingsPage />);
    const open = "Sign out \u2068Synthetic Me\u2069 (user id subject-me) (you) everywhere";
    await click(button(open));
    const boxes = (dialog() as HTMLElement).querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    const second = boxes[1] as HTMLInputElement;
    expect(second.checked).toBe(false);
    expect(boxes[0]?.id).not.toBe(second.id);
    const label = (dialog() as HTMLElement).querySelector(`label[for="${second.id}"]`);
    expect(label?.textContent).toBe(
      "Also revoke the 2 API tokens made by an unknown user (made before Platehouse 0.1.1; any member may have made them, so a shared script may stop working)",
    );
    await click(second);
    expect(second.checked).toBe(true);
    await click(button("Cancel", dialog() as HTMLElement));
    await click(button(open));
    const again = (dialog() as HTMLElement).querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(again[1]?.checked).toBe(false);
  });

  test("Sign out everywhere sends revokeUnknownTokens false when the second box is not ticked", async () => {
    state.unknownTokens = 1;
    state.users.push({
      subject: "subject-gone",
      name: "Synthetic Gone",
      sessions: 1,
      tokens: 0,
      you: false,
    });
    await show("/settings", <SettingsPage />);
    await click(button("Sign out \u2068Synthetic Gone\u2069 (user id subject-gone) everywhere"));
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")[0]?.body).toEqual({
      subject: "subject-gone",
      revokeTokens: false,
      revokeUnknownTokens: false,
    });
  });

  test("Sign out everywhere sends revokeUnknownTokens true when the second box is ticked", async () => {
    state.unknownTokens = 1;
    state.users.push({
      subject: "subject-gone",
      name: "Synthetic Gone",
      sessions: 1,
      tokens: 0,
      you: false,
    });
    await show("/settings", <SettingsPage />);
    await click(button("Sign out \u2068Synthetic Gone\u2069 (user id subject-gone) everywhere"));
    const boxes = (dialog() as HTMLElement).querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    await click(boxes[1] as HTMLInputElement);
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")[0]?.body).toEqual({
      subject: "subject-gone",
      revokeTokens: false,
      revokeUnknownTokens: true,
    });
  });

  test("Sign out everywhere names both counts for someone else and reads the token list again for unknown tokens alone", async () => {
    state.unknownTokens = 1;
    state.users.push({
      subject: "subject-gone",
      name: "Synthetic Gone",
      sessions: 1,
      tokens: 0,
      you: false,
    });
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Office desktop");
    const tokenReads = callsTo("GET", "/app/api/tokens").length;
    await click(button("Sign out \u2068Synthetic Gone\u2069 (user id subject-gone) everywhere"));
    const boxes = (dialog() as HTMLElement).querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    await click(boxes[1] as HTMLInputElement);
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(signOutStatus()).toContain("Ended 1 session for \u2068Synthetic Gone\u2069");
    expect(signOutStatus()).toContain("revoked 0 API tokens they made");
    expect(signOutStatus()).toContain("revoked 1 API token made by an unknown user");
    expect(callsTo("GET", "/app/api/tokens").length).toBeGreaterThan(tokenReads);
    expect(text()).not.toContain("Office desktop");
  });

  test("Sign out everywhere refused for yourself with the second box ticked asks to sign in again", async () => {
    state.signInRequired = true;
    state.unknownTokens = 1;
    await show("/settings", <SettingsPage />);
    await click(button("Sign out \u2068Synthetic Me\u2069 (user id subject-me) (you) everywhere"));
    const boxes = (dialog() as HTMLElement).querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    await click(boxes[1] as HTMLInputElement);
    await click(button("Sign out everywhere", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/users/sign-out")[0]?.body).toEqual({
      subject: "subject-me",
      revokeTokens: false,
      revokeUnknownTokens: true,
    });
    const alert = document.querySelector("[data-sign-out-refused]");
    expect(alert?.textContent).toContain(
      "To revoke tokens made by an unknown user, sign in again first.",
    );
    expect(link("Sign in again").getAttribute("href")).toBe("/auth/login?next=/settings");
    expect(signOutStatus()).toBe("");
    expect(text()).toContain("Office desktop");
  });

  test("the settings page holds the trash", async () => {
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Old benchy");
    expect(() => button("Empty trash")).not.toThrow();
  });
});

describe("the trash", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("each model shows its purge date, and restore brings it back", async () => {
    await show("/trash", <TrashPage />);
    expect(document.querySelector("h1")?.textContent).toBe("Trash");
    expect(document.querySelector('time[datetime="2026-12-10T12:00:00.000Z"]')).not.toBeNull();
    expect(document.querySelector('time[datetime="2026-12-11T12:00:00.000Z"]')).not.toBeNull();
    await click(button("Restore Old benchy"));
    expect(callsTo("POST", "/app/api/trash/m-trashed-1/restore")).toHaveLength(1);
    expect(text()).not.toContain("Old benchy");
    expect(text()).toContain("Broken clip");
  });

  /** The pager's link to page n, found by the label a screen reader reads. */
  function pageLink(n: number): HTMLAnchorElement {
    const found = document.querySelector<HTMLAnchorElement>(
      `nav.ph-pager a[aria-label="Page ${n}"]`,
    );
    if (found === null) throw new Error(`no pager link to page ${n}`);
    return found;
  }

  /** n trashed models, model 0 the newest, each a minute older than the last. */
  function trashOf(n: number): FakeState["trash"] {
    return Array.from({ length: n }, (_, i) => ({
      id: `0190f7a2-0000-7000-8000-${String(i).padStart(12, "0")}`,
      name: `Model ${i}`,
      creator: null,
      trashedAt: new Date(Date.parse("2026-11-10T12:00:00.000Z") - i * 60_000).toISOString(),
      purgeAt: "2026-12-10T12:00:00.000Z",
      purgeStarted: false,
    }));
  }

  test("the trash shows a pager when there is more than one page, and page 2 lists the next models", async () => {
    state.trash = trashOf(101);
    await show("/trash", <TrashPage />);
    expect(text()).toContain("Model 0");
    expect(text()).toContain("Model 99");
    expect(text()).not.toContain("Model 100");
    const pager = document.querySelector("nav.ph-pager");
    expect(pager).not.toBeNull();
    expect(pageLink(2).getAttribute("href")).toBe("/trash?page=2");
    await click(pageLink(2));
    expect(callsTo("GET", "/app/api/trash?page=2")).toHaveLength(1);
    expect(text()).toContain("Model 100");
    expect(text()).not.toContain("Model 0");
    expect(pageLink(1).getAttribute("href")).toBe("/trash");
  });

  test("after the pager loads another page, focus is on the page line, not the body", async () => {
    state.trash = trashOf(101);
    await show("/trash", <TrashPage />);
    await click(pageLink(2));
    const active = document.activeElement as HTMLElement;
    expect(active.tabIndex).toBe(-1);
    expect(active.getAttribute("role")).toBe("status");
    expect(active.textContent).toBe("Page 2 of 2");
  });

  test("restoring the last model of the last page never flashes the empty trash, and the address follows the page served", async () => {
    state.trash = trashOf(101);
    await show("/trash?page=2", <TrashPage />);
    expect(text()).toContain("Model 100");
    let flashed = false;
    const watcher = new MutationObserver(() => {
      if (text().includes("The trash is empty.")) flashed = true;
    });
    watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
    await click(button("Restore Model 100"));
    watcher.disconnect();
    expect(flashed).toBe(false);
    expect(text()).toContain("Model 99");
    expect(text()).not.toContain("The trash is empty.");
    expect(callsTo("GET", "/app/api/trash")).toHaveLength(1);
  });

  test("the trash shows no pager when everything fits on one page", async () => {
    await show("/trash", <TrashPage />);
    expect(document.querySelector("nav.ph-pager")).toBeNull();
  });

  test("the pager in Settings keeps the settings address and uses its own parameter", async () => {
    state.trash = trashOf(101);
    await show("/settings", <SettingsPage />);
    expect(pageLink(2).getAttribute("href")).toBe("/settings?trashPage=2");
  });

  test("a restore on page 2 reloads page 2, and Empty trash counts every page", async () => {
    state.trash = trashOf(102);
    await show("/trash?page=2", <TrashPage />);
    expect(text()).toContain("Model 100");
    await click(button("Restore Model 100"));
    expect(text()).not.toContain("Model 100");
    expect(callsTo("GET", "/app/api/trash?page=2").length).toBeGreaterThan(1);
    expect(text()).toContain("Model 101");
    await click(button("Empty trash"));
    expect(dialog()?.textContent).toContain(
      "All 101 models in the trash, on every page, are deleted for good",
    );
    await click(button("Empty trash", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/trash/empty").map((c) => c.body)).toEqual([
      { cutoff: "2026-11-12T09:00:00.000Z" },
    ]);
  });

  test("empty trash uses a themed dialog", async () => {
    await show("/trash", <TrashPage />);
    const empty = button("Empty trash");
    await click(empty);
    const ask = dialog();
    expect(ask).not.toBeNull();
    expect(ask?.getAttribute("aria-modal")).toBe("true");
    expect(dialogs.confirm).not.toHaveBeenCalled();
    expect(callsTo("POST", "/app/api/trash/empty")).toHaveLength(0);

    // Escape cancels and puts focus back on the button.
    await press(ask as HTMLElement, "Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(empty);
    expect(callsTo("POST", "/app/api/trash/empty")).toHaveLength(0);

    await click(empty);
    await click(button("Empty trash", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/trash/empty")).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(dialogs.confirm).not.toHaveBeenCalled();
  });

  test("after confirming Empty trash, the dialog closes and focus is on the status line, which says it is emptying", async () => {
    await show("/trash", <TrashPage />);
    await click(button("Empty trash"));
    await click(button("Empty trash", dialog() as HTMLElement));
    expect(dialog()).toBeNull();
    const status = document.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent).toBe(
      "Emptying the trash. Models are deleted one at a time and leave this list as they go.",
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(status);
    // The models stay listed, marked as being deleted.
    expect(text()).toContain("Old benchy");
    expect(text()).toContain("Broken clip");
    expect(text().split("It is being deleted now and cannot be restored.")).toHaveLength(3);
  });

  test("an Empty trash in flight cannot be cancelled", async () => {
    await show("/trash", <TrashPage />);
    const release = hold("POST /app/api/trash/empty");
    await click(button("Empty trash"));
    await click(button("Empty trash", dialog() as HTMLElement));

    const cancel = button("Cancel", dialog() as HTMLElement);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    await press(focused(), "Escape");
    await click(cancel);
    expect(dialog()).not.toBeNull();

    await release();
    expect(dialog()).toBeNull();
  });

  test("two restores in flight both stay restored when the first one sent answers last", async () => {
    await show("/trash", <TrashPage />);
    const release = hold("POST /app/api/trash/m-trashed-1/restore");
    await click(button("Restore Old benchy"));
    await click(button("Restore Broken clip"));
    expect(text()).not.toContain("Broken clip");
    await release();
    expect(callsTo("POST", "/app/api/trash/m-trashed-1/restore")).toHaveLength(1);
    expect(text()).not.toContain("Old benchy");
    expect(text()).not.toContain("Broken clip");
  });

  test("empty trash deletes only the models trashed before the page read the list, and says how many", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await show("/trash", <TrashPage />);
    // Another tab or browser trashes a model after the page read the list.
    state.now = "2026-11-12T12:00:05.000Z";
    state.trash = [
      ...state.trash,
      {
        id: "m-trashed-later",
        name: "Unseen bracket",
        creator: null,
        trashedAt: "2026-11-12T12:00:00.000Z",
        purgeAt: "2026-12-12T12:00:00.000Z",
        purgeStarted: false,
      },
    ];
    await click(button("Empty trash"));
    expect(dialog()?.textContent).toContain(
      "All 2 models in the trash, on every page, are deleted for good",
    );
    await click(button("Empty trash", dialog() as HTMLElement));
    // It sends the time the server read the list, not the models' ids.
    expect(callsTo("POST", "/app/api/trash/empty").map((c) => c.body)).toEqual([
      { cutoff: "2026-11-12T09:00:00.000Z" },
    ]);
    // The job leaves the model nobody confirmed in the trash, still restorable.
    expect(text()).toContain("Unseen bracket");
    finishEmptying();
    await pollOnce();
    expect(text()).toContain("Deleted 2 models for good.");
    expect(text()).toContain("Unseen bracket");
    expect(text()).not.toContain("Old benchy");
  });

  test("after a restore, Empty trash still sends when the list was read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await show("/trash", <TrashPage />);
    await click(button("Restore Old benchy"));
    await click(button("Empty trash"));
    expect(dialog()?.textContent).toContain("The 1 model in the trash is deleted for good");
    await click(button("Empty trash", dialog() as HTMLElement));
    expect(callsTo("POST", "/app/api/trash/empty").map((c) => c.body)).toEqual([
      { cutoff: "2026-11-12T09:00:00.000Z" },
    ]);
    finishEmptying();
    await pollOnce();
    expect(text()).toContain("Deleted 1 model for good.");
  });

  test("a large trash sends the same small body", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.trash = Array.from({ length: 3000 }, (_, i) => ({
      id: `0190f7a2-0000-7000-8000-${String(i).padStart(12, "0")}`,
      name: `Model ${i}`,
      creator: null,
      trashedAt: "2026-11-10T12:00:00.000Z",
      purgeAt: "2026-12-10T12:00:00.000Z",
      purgeStarted: false,
    }));
    await show("/trash", <TrashPage />);
    await click(button("Empty trash"));
    expect(dialog()?.textContent).toContain(
      "All 3000 models in the trash, on every page, are deleted for good",
    );
    await click(button("Empty trash", dialog() as HTMLElement));
    const sent = callsTo("POST", "/app/api/trash/empty").map((c) => c.body);
    expect(sent).toEqual([{ cutoff: "2026-11-12T09:00:00.000Z" }]);
    // Far under the server's 64 KiB body limit, however long the list.
    expect(JSON.stringify(sent[0]).length).toBeLessThan(100);
    finishEmptying();
    await pollOnce();
    expect(text()).toContain("Deleted 3000 models for good.");
  });

  test("empty trash reads the trash again after it answers", async () => {
    await show("/trash", <TrashPage />);
    expect(callsTo("GET", "/app/api/trash")).toHaveLength(1);
    await click(button("Empty trash"));
    await click(button("Empty trash", dialog() as HTMLElement));
    expect(callsTo("GET", "/app/api/trash")).toHaveLength(2);
  });

  describe("following the job", () => {
    const EMPTYING =
      "Emptying the trash. Models are deleted one at a time and leave this list as they go.";
    const setVisibility = (value: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { value, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const statusLine = () => document.querySelector<HTMLElement>('[role="status"]');
    const reads = () => callsTo("GET", "/app/api/trash").length;
    async function confirmEmpty() {
      await click(button("Empty trash"));
      await click(button("Empty trash", dialog() as HTMLElement));
    }
    /** Records the status line's text each time it changes, as React renders it. */
    function recordStatus(): { seen: string[]; stop: () => void } {
      const seen: string[] = [statusLine()?.textContent ?? ""];
      const observer = new MutationObserver(() => {
        const now = statusLine()?.textContent ?? "";
        if (seen.at(-1) !== now) seen.push(now);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return { seen, stop: () => observer.disconnect() };
    }

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      setVisibility("visible");
      vi.useRealTimers();
    });

    test("it reads the listing again every 3 seconds while emptying, and stops when it is not", async () => {
      await show("/trash", <TrashPage />);
      await confirmEmpty();
      const afterConfirm = reads();
      await pollOnce();
      expect(reads()).toBe(afterConfirm + 1);
      await pollOnce();
      expect(reads()).toBe(afterConfirm + 2);
      finishEmptying();
      await pollOnce();
      const done = reads();
      expect(done).toBe(afterConfirm + 3);
      await pollOnce();
      await pollOnce();
      expect(reads()).toBe(done);
    });

    test("it does not read while the tab is hidden, and reads once when it is shown", async () => {
      await show("/trash", <TrashPage />);
      await confirmEmpty();
      await act(async () => {
        setVisibility("hidden");
      });
      const hiddenAt = reads();
      await pollOnce();
      await pollOnce();
      expect(reads()).toBe(hiddenAt);
      await act(async () => {
        setVisibility("visible");
      });
      await settle();
      expect(reads()).toBe(hiddenAt + 1);
    });

    test("the final line says how many were deleted, written once, after the emptying line", async () => {
      await show("/trash", <TrashPage />);
      const recorded = recordStatus();
      await confirmEmpty();
      await pollOnce();
      await pollOnce();
      finishEmptying();
      await pollOnce();
      await pollOnce();
      recorded.stop();
      expect(recorded.seen).toEqual(["", EMPTYING, "Deleted 2 models for good."]);
      expect(text()).toContain("The trash is empty.");
    });

    test("with one model left, the final line says so", async () => {
      await show("/trash", <TrashPage />);
      await confirmEmpty();
      finishEmptying(1);
      await pollOnce();
      expect(statusLine()?.textContent).toBe(
        "Deleted 1 model for good. 1 model could not be deleted and stays in the trash; the next purge tries again.",
      );
      expect(text()).toContain("Old benchy");
      expect(text()).not.toContain("Broken clip");
    });

    test("a page opened while the job runs shows it without taking focus, and ends with the right counts", async () => {
      state.trash = state.trash.map((m) => ({ ...m, purgeStarted: true }));
      emptying = true;
      await show("/trash", <TrashPage />);
      const recorded = recordStatus();
      expect(statusLine()?.textContent).toBe(EMPTYING);
      expect(document.activeElement).toBe(document.body);
      await pollOnce();
      expect(reads()).toBe(2);
      finishEmptying(1);
      await pollOnce();
      recorded.stop();
      expect(recorded.seen).toEqual([
        EMPTYING,
        "Deleted 1 model for good. 1 model could not be deleted and stays in the trash; the next purge tries again.",
      ]);
      expect(document.activeElement).toBe(document.body);
    });

    test("a listing read before Empty trash answered, arriving after it, does not end the job", async () => {
      state.trash = trashOf(101);
      await show("/trash", <TrashPage />);
      const recorded = recordStatus();
      // A restore reads the page again; that listing, read before Empty
      // trash marks anything, says no job is running and is held back.
      parkedTrash = [];
      await click(button("Restore Model 0"));
      expect(parkedTrash).toHaveLength(1);
      await confirmEmpty();
      // The read that follows Empty trash's answer is held back too.
      expect(parkedTrash).toHaveLength(2);
      await act(async () => parkedTrash?.[0]?.());
      await settle();
      expect(statusLine()?.textContent).toBe(EMPTYING);
      await act(async () => parkedTrash?.[1]?.());
      await settle();
      parkedTrash = null;
      expect(statusLine()?.textContent).toBe(EMPTYING);
      finishEmptying();
      await pollOnce();
      recorded.stop();
      expect(recorded.seen.filter((line) => line.startsWith("Deleted"))).toEqual([
        "Deleted 100 models for good.",
      ]);
      expect(statusLine()?.textContent).toBe("Deleted 100 models for good.");
    });

    test("when the read right after Empty trash fails, a later read still ends the job", async () => {
      await show("/trash", <TrashPage />);
      failing.add("GET /app/api/trash");
      await confirmEmpty();
      expect(statusLine()?.textContent).toBe(EMPTYING);
      failing.delete("GET /app/api/trash");
      const failedAt = reads();
      await pollOnce();
      expect(reads()).toBe(failedAt + 1);
      expect(statusLine()?.textContent).toBe(EMPTYING);
      finishEmptying();
      await pollOnce();
      expect(statusLine()?.textContent).toBe("Deleted 2 models for good.");
    });

    test("when Empty trash marked nothing, it says so, follows no job and reads the list once", async () => {
      await show("/trash", <TrashPage />);
      const recorded = recordStatus();
      // Another tab restores everything after the page read the list.
      state.trash = [];
      await confirmEmpty();
      const afterConfirm = reads();
      await pollOnce();
      await pollOnce();
      recorded.stop();
      expect(recorded.seen).toEqual([
        "",
        "Nothing was deleted: the models listed had already left the trash.",
      ]);
      expect(document.activeElement).toBe(statusLine());
      expect(text()).toContain("The trash is empty.");
      expect(reads()).toBe(afterConfirm);
      expect(callsTo("GET", "/app/api/trash")).toHaveLength(2);
    });

    test("a page opened with no job running says nothing", async () => {
      await show("/trash", <TrashPage />);
      await pollOnce();
      expect(statusLine()?.textContent).toBe("");
      expect(reads()).toBe(1);
    });
  });

  test("a Restore button says why it is unavailable while its model is being deleted", async () => {
    state.trash = state.trash.map((m) =>
      m.id === "m-trashed-1" ? { ...m, purgeStarted: true } : m,
    );
    await show("/trash", <TrashPage />);
    const describedBy = (b: HTMLElement) => {
      const id = b.getAttribute("aria-describedby");
      return id === null ? null : document.getElementById(id)?.textContent;
    };
    const marked = button("Restore Old benchy");
    expect(marked.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(marked)).toBe("It is being deleted now and cannot be restored.");
    expect(button("Restore Broken clip").hasAttribute("aria-describedby")).toBe(false);
  });

  test("the dialog keeps focus inside it", async () => {
    await show("/trash", <TrashPage />);
    await click(button("Empty trash"));
    const ask = dialog() as HTMLElement;
    expect(ask.contains(document.activeElement)).toBe(true);
    const focusable = [...ask.querySelectorAll<HTMLElement>("button")];
    (focusable[focusable.length - 1] as HTMLElement).focus();
    await press(document.activeElement as Element, "Tab");
    expect(document.activeElement).toBe(focusable[0]);
  });
  test("while a change runs, focus stays on a control inside the dialog", async () => {
    await show("/trash", <TrashPage />);
    const release = hold("POST /app/api/trash/empty");
    await click(button("Empty trash"));
    const confirm = button("Empty trash", dialog() as HTMLElement);
    confirm.focus();
    await click(confirm);
    const active = focused();
    expect(active).not.toBe(document.body);
    expect(dialog()?.contains(active)).toBe(true);
    // Pressing it again while the change runs sends nothing more.
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await click(confirm);
    expect(callsTo("POST", "/app/api/trash/empty")).toHaveLength(1);
    await release();
  });

  test("after a failed change, the error is announced, Tab cycles and Escape closes", async () => {
    failing.add("POST /app/api/trash/empty");
    await show("/trash", <TrashPage />);
    const release = hold("POST /app/api/trash/empty");
    const empty = button("Empty trash");
    await click(empty);
    const ask = dialog() as HTMLElement;
    const confirm = button("Empty trash", ask);
    const cancel = button("Cancel", ask);
    confirm.focus();
    await click(confirm);
    expect(ask.contains(focused())).toBe(true);
    await release();

    const alert = ask.querySelector('[role="alert"]');
    expect(alert?.textContent).toBeTruthy();
    expect(confirm.getAttribute("aria-disabled")).toBe("false");
    expect(focused()).toBe(confirm);
    await press(focused(), "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    await press(focused(), "Tab");
    expect(document.activeElement).toBe(confirm);
    await press(focused(), "Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(empty);
  });

  test("Shift+Tab from the dialog's panel itself goes to its last control", async () => {
    await show("/trash", <TrashPage />);
    await click(button("Empty trash"));
    const ask = dialog() as HTMLElement;
    ask.focus();
    await press(ask, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(button("Cancel", ask));
  });

  test("a press on the backdrop does not take focus out of the dialog", async () => {
    await show("/trash", <TrashPage />);
    await click(button("Empty trash"));
    const backdrop = dialog()?.parentElement as HTMLElement;
    let kept = false;
    await act(async () => {
      kept = !backdrop.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    expect(kept).toBe(true);
  });
});

describe("the organising pages", () => {
  test("collections list with counts, and a collection shows its models", async () => {
    await show("/collections", <CollectionsPage />);
    expect(document.querySelector("h1")?.textContent).toBe("Collections");
    expect(text()).toContain("Desk");
    expect(text()).toContain("Garage");
    await act(async () => root.unmount());
    root = createRoot(container);
    await show("/collections?name=Desk", <CollectionsPage />);
    expect(calls.some((c) => c.path === "/app/api/organise/models?collection=Desk")).toBe(true);
    expect(text()).toContain("Cable clip");
    expect(text()).toContain("Hook");
  });

  test("inline rename uses a themed input and saves on Enter", async () => {
    await show("/tags?name=PLA", <TagsPage />);
    await click(button("Rename Cable clip"));
    const input = labelled<HTMLInputElement>("New name for Cable clip");
    expect(input.className).toContain("studio-input");
    await type(input, "Cable clip v2");
    await submit(input);
    expect(callsTo("PATCH", "/app/api/models/m1")).toEqual([
      { method: "PATCH", path: "/app/api/models/m1", body: { name: "Cable clip v2" } },
    ]);
    expect(text()).toContain("Cable clip v2");
  });

  test("a file is renamed the same way", async () => {
    await show("/creators?name=Maker", <CreatorsPage />);
    await click(button("Rename Cable clip.3mf"));
    const input = labelled<HTMLInputElement>("New name for Cable clip.3mf");
    await type(input, "Clip.3mf");
    await submit(input);
    expect(callsTo("PATCH", "/app/api/files/f1")).toHaveLength(1);
    expect(text()).toContain("Clip.3mf");
  });

  test("Escape leaves a rename without saving", async () => {
    await show("/tags?name=PLA", <TagsPage />);
    await click(button("Rename Cable clip"));
    const input = labelled<HTMLInputElement>("New name for Cable clip");
    await type(input, "Nope");
    await press(input, "Escape");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(document.activeElement).toBe(button("Rename Cable clip"));
  });

  test("a rename that is saving cannot be cancelled: Cancel and Escape wait for the answer", async () => {
    await show("/tags?name=PLA", <TagsPage />);
    const release = hold("PATCH /app/api/models/m1");
    await click(button("Rename Cable clip"));
    const input = labelled<HTMLInputElement>("New name for Cable clip");
    await type(input, "Cable clip v2");
    const save = button("Save", input.form as HTMLFormElement);
    const cancel = button("Cancel", input.form as HTMLFormElement);
    save.focus();
    await click(save);
    expect(callsTo("PATCH", "/app/api/models/m1")).toHaveLength(1);

    // Focus stays in the form, and nothing in it can leave or save again.
    expect(input.form?.contains(focused())).toBe(true);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    await click(cancel);
    await press(input, "Escape");
    await submit(input);
    expect(input.isConnected).toBe(true);
    expect(callsTo("PATCH", "/app/api/models/m1")).toHaveLength(1);

    await release();
    expect(input.isConnected).toBe(false);
    expect(text()).toContain("Cable clip v2");
    expect(document.activeElement).toBe(button("Rename Cable clip v2"));
  });

  test("a rename that fails shows its error in the open form, and the next rename starts clean", async () => {
    await show("/tags?name=PLA", <TagsPage />);
    const release = hold("PATCH /app/api/models/m1");
    await click(button("Rename Cable clip"));
    const input = labelled<HTMLInputElement>("New name for Cable clip");
    await type(input, "Cable clip v2");
    await submit(input);
    // Gone on the server before the rename lands, so the rename fails.
    state.models = state.models.filter((m) => m.id !== "m1");
    await press(input, "Escape");
    await release();

    expect(input.isConnected).toBe(true);
    const alert = input.form?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("That is no longer there. Reload the page to see the latest.");

    await press(input, "Escape");
    expect(input.isConnected).toBe(false);
    await click(button("Rename Cable clip"));
    const again = labelled<HTMLInputElement>("New name for Cable clip");
    expect(again.form?.querySelector('[role="alert"]')).toBeNull();
    expect(again.form?.textContent).not.toContain("no longer there");
  });

  test("tag and collection chips can be added and removed", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    await type(labelled<HTMLInputElement>("Add a tag to Hook"), "PETG");
    await submit(labelled<HTMLInputElement>("Add a tag to Hook"));
    expect(callsTo("PUT", "/app/api/models/m2/tags?name=PETG")).toHaveLength(1);
    expect(() => button("Remove tag PETG from Hook")).not.toThrow();

    await click(button("Remove tag PLA from Cable clip"));
    expect(callsTo("DELETE", "/app/api/models/m1/tags?name=PLA")).toHaveLength(1);

    await type(labelled<HTMLInputElement>("Add Cable clip to a collection"), "Garage");
    await submit(labelled<HTMLInputElement>("Add Cable clip to a collection"));
    expect(callsTo("PUT", "/app/api/models/m1/collections?name=Garage")).toHaveLength(1);

    await click(button("Remove Hook from collection Garage"));
    expect(callsTo("DELETE", "/app/api/models/m2/collections?name=Garage")).toHaveLength(1);
  });

  test("a chip remove in flight keeps focus on its button, then focus goes to the add input", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("DELETE /app/api/models/m1/tags");
    const input = labelled<HTMLInputElement>("Add a tag to Cable clip");
    const remove = button("Remove tag PLA from Cable clip");
    const add = button("Add tag", input.form as HTMLFormElement);
    remove.focus();
    await click(remove);
    expect(callsTo("DELETE", "/app/api/models/m1/tags?name=PLA")).toHaveLength(1);

    // No disabled attribute while it runs, so focus stays on the pressed
    // button; a second press, or an add, is ignored until it answers.
    expect(focused()).toBe(remove);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await click(remove);
    await type(input, "PETG");
    await submit(input);
    expect(callsTo("DELETE", "/app/api/models/m1/tags?name=PLA")).toHaveLength(1);
    expect(callsTo("PUT", "/app/api/models/m1/tags?name=PETG")).toHaveLength(0);

    await release();
    expect(remove.isConnected).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(add.getAttribute("aria-disabled")).toBe("false");
  });

  test("a chip remove that fails leaves focus on its button", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("DELETE /app/api/models/m1/tags");
    const remove = button("Remove tag PLA from Cable clip");
    remove.focus();
    await click(remove);
    // Gone on the server before the remove lands, so the remove fails.
    state.models = state.models.filter((m) => m.id !== "m1");
    await release();
    expect(remove.isConnected).toBe(true);
    expect(focused()).toBe(remove);
    expect(remove.getAttribute("aria-disabled")).toBe("false");
    expect(text()).toContain("no longer there");
    expect(announced()).toContain("no longer there");
  });

  test("an Add pressed from the keyboard keeps focus while the add runs", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("PUT /app/api/models/m2/tags");
    const input = labelled<HTMLInputElement>("Add a tag to Hook");
    const add = button("Add tag", input.form as HTMLFormElement);
    await type(input, "PETG");
    add.focus();
    await click(add);
    expect(callsTo("PUT", "/app/api/models/m2/tags?name=PETG")).toHaveLength(1);
    expect(focused()).toBe(add);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await release();
    expect(focused()).toBe(add);
    expect(add.getAttribute("aria-disabled")).toBe("false");
    expect(() => button("Remove tag PETG from Hook")).not.toThrow();
  });

  test("text typed while an add runs is kept when the add answers", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("PUT /app/api/models/m2/tags");
    const input = labelled<HTMLInputElement>("Add a tag to Hook");
    await type(input, "PETG");
    await submit(input);
    expect(callsTo("PUT", "/app/api/models/m2/tags?name=PETG")).toHaveLength(1);
    // The next name, typed before the server answers the first.
    await type(input, "Silk");
    await release();
    expect(() => button("Remove tag PETG from Hook")).not.toThrow();
    expect(input.value).toBe("Silk");

    // An add whose text is still in the box when it answers clears the box.
    await submit(input);
    expect(callsTo("PUT", "/app/api/models/m2/tags?name=Silk")).toHaveLength(1);
    expect(input.value).toBe("");
  });

  test('a tag or collection named "." or ".." can be added and removed', async () => {
    // The URL parser rewrites a path segment of "." or "..", %2E too, so
    // DELETE /models/m1/tags/.. would go out as DELETE /models/m1. The
    // public API v1 and the Manyfold importer can store such names.
    const [clip] = state.models as [FakeModel];
    clip.tags = ["PLA", ".."];
    clip.collections = ["Desk", "."];
    await show("/collections?name=Desk", <CollectionsPage />);

    await click(button("Remove tag .. from Cable clip"));
    expect(callsTo("DELETE", "/app/api/models/m1/tags?name=..")).toHaveLength(1);
    expect(clip.tags).toEqual(["PLA"]);
    expect(() => button("Remove tag .. from Cable clip")).toThrow();

    await click(button("Remove Cable clip from collection ."));
    expect(callsTo("DELETE", "/app/api/models/m1/collections?name=.")).toHaveLength(1);
    expect(clip.collections).toEqual(["Desk"]);

    await type(labelled<HTMLInputElement>("Add a tag to Hook"), ".");
    await submit(labelled<HTMLInputElement>("Add a tag to Hook"));
    expect(callsTo("PUT", "/app/api/models/m2/tags?name=.")).toHaveLength(1);
    expect(() => button("Remove tag . from Hook")).not.toThrow();

    await type(labelled<HTMLInputElement>("Add Hook to a collection"), "..");
    await submit(labelled<HTMLInputElement>("Add Hook to a collection"));
    expect(callsTo("PUT", "/app/api/models/m2/collections?name=..")).toHaveLength(1);
    expect(() => button("Remove Hook from collection ..")).not.toThrow();
    expect(text()).not.toContain("no longer there");
  });

  test("a tag or collection name with ?, # or & goes to the server whole", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    await type(labelled<HTMLInputElement>("Add a tag to Hook"), "a&b?c#d e+f");
    await submit(labelled<HTMLInputElement>("Add a tag to Hook"));
    const put = calls.filter(
      (c) => c.method === "PUT" && c.path.startsWith("/app/api/models/m2/tags?"),
    );
    expect(put).toHaveLength(1);
    expect(new URLSearchParams(put[0]?.path.split("?")[1]).get("name")).toBe("a&b?c#d e+f");
    expect(() => button("Remove tag a&b?c#d e+f from Hook")).not.toThrow();
  });

  test.each([
    ["Creators", "/creators?name=Other", () => <CreatorsPage />],
    ["Collections", "/collections?name=Garage", () => <CollectionsPage />],
    ["Tags", "/tags?name=PETG", () => <TagsPage />],
  ])(
    "on the %s page, a tag or collection added in other capitals shows the stored name",
    async (_page, path, page) => {
      // "pla" and "Shelf" exist already, on Cable clip; Hook has neither.
      const [clip, hook] = state.models as [FakeModel, FakeModel];
      clip.tags = ["pla"];
      clip.collections = ["Desk", "Shelf"];
      hook.tags = ["PETG"];
      await show(path, page());

      await type(labelled<HTMLInputElement>("Add a tag to Hook"), "PLA");
      await submit(labelled<HTMLInputElement>("Add a tag to Hook"));
      expect(callsTo("PUT", "/app/api/models/m2/tags?name=PLA")).toHaveLength(1);
      expect(() => button("Remove tag pla from Hook")).not.toThrow();
      expect(() => button("Remove tag PLA from Hook")).toThrow();

      await type(labelled<HTMLInputElement>("Add Hook to a collection"), "SHELF");
      await submit(labelled<HTMLInputElement>("Add Hook to a collection"));
      expect(callsTo("PUT", "/app/api/models/m2/collections?name=SHELF")).toHaveLength(1);
      expect(() => button("Remove Hook from collection Shelf")).not.toThrow();
      expect(() => button("Remove Hook from collection SHELF")).toThrow();
    },
  );

  test("a change that answers last keeps a change that answered first", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("POST /app/api/models/m1/trash");
    await click(button("Move Cable clip to the trash"));
    await click(button("Rename Hook"));
    const input = labelled<HTMLInputElement>("New name for Hook");
    await type(input, "Wall hook");
    await submit(input);
    expect(text()).toContain("Wall hook");
    await release();
    expect(text()).not.toContain("Cable clip.3mf");
    expect(text()).toContain("Wall hook");
  });

  test("two chips added to one model at once both stay", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("PUT /app/api/models/m2/tags");
    await type(labelled<HTMLInputElement>("Add a tag to Hook"), "PETG");
    await submit(labelled<HTMLInputElement>("Add a tag to Hook"));
    await type(labelled<HTMLInputElement>("Add Hook to a collection"), "Shed");
    await submit(labelled<HTMLInputElement>("Add Hook to a collection"));
    expect(() => button("Remove Hook from collection Shed")).not.toThrow();
    await release();
    expect(() => button("Remove tag PETG from Hook")).not.toThrow();
    expect(() => button("Remove Hook from collection Shed")).not.toThrow();
  });

  test("a model can be moved to the trash", async () => {
    await show("/creators?name=Other", <CreatorsPage />);
    await click(button("Move Hook to the trash"));
    expect(callsTo("POST", "/app/api/models/m2/trash")).toHaveLength(1);
    expect(text()).not.toContain("Hook.stl");
  });
});

/** The focused element, as focused() reads it, checked never to be the page body. */
function focusedNotBody(): Element {
  const active = focused();
  expect(active).not.toBe(document.body);
  return active;
}

function statusLine(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="status"]');
  if (found === null) throw new Error("no status line");
  return found;
}

// Every place on these pages where a focused control is disabled, removed
// or replaced, one category at a time: a busy control, a success that
// removes the control, a failure, the last row of a list leaving, and a
// dialog closing. Focus must land on a sensible element, never the body.
describe("keyboard focus when a control is busy, removed or replaced", () => {
  test("busy: while Move to trash runs, focus stays on it and a second press sends nothing", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("POST /app/api/models/m1/trash");
    const trash = button("Move Cable clip to the trash");
    trash.focus();
    await click(trash);
    expect(focusedNotBody()).toBe(trash);
    expect(trash.matches(":disabled")).toBe(false);
    expect(trash.getAttribute("aria-disabled")).toBe("true");
    await click(trash);
    expect(callsTo("POST", "/app/api/models/m1/trash")).toHaveLength(1);
    await release();
  });

  test("busy: while a Restore runs, focus stays on it and a second press sends nothing", async () => {
    await show("/trash", <TrashPage />);
    const release = hold("POST /app/api/trash/m-trashed-1/restore");
    const restore = button("Restore Old benchy");
    restore.focus();
    await click(restore);
    expect(focusedNotBody()).toBe(restore);
    expect(restore.matches(":disabled")).toBe(false);
    expect(restore.getAttribute("aria-disabled")).toBe("true");
    await click(restore);
    expect(callsTo("POST", "/app/api/trash/m-trashed-1/restore")).toHaveLength(1);
    await release();
    expect(text()).not.toContain("no longer there");
  });

  test("busy and failure: Create token keeps focus while it runs and after it fails", async () => {
    await show("/settings", <SettingsPage />);
    failing.add("POST /app/api/tokens");
    const release = hold("POST /app/api/tokens");
    const input = labelled<HTMLInputElement>("Token name");
    await type(input, "Build server script");
    const create = button("Create token");
    create.focus();
    await click(create);
    expect(focusedNotBody()).toBe(create);
    expect(create.matches(":disabled")).toBe(false);
    expect(create.getAttribute("aria-disabled")).toBe("true");
    // A second press, or Enter in the name, sends nothing while it runs.
    await click(create);
    await submit(input);
    expect(callsTo("POST", "/app/api/tokens")).toHaveLength(1);

    await release();
    expect(dialog()).toBeNull();
    expect(text()).toContain("This is unavailable right now. Try again in a moment.");
    expect(announced()).toContain("This is unavailable right now. Try again in a moment.");
    expect(focusedNotBody()).toBe(create);
    expect(create.getAttribute("aria-disabled")).toBe("false");
  });

  test("success: after Move to trash, focus goes to the next model's Move to trash", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const trash = button("Move Cable clip to the trash");
    trash.focus();
    await click(trash);
    expect(trash.isConnected).toBe(false);
    expect(focusedNotBody()).toBe(button("Move Hook to the trash"));
    expect(statusLine().textContent).toContain("Moved Cable clip to the trash.");
  });

  test("success: after a Restore, focus goes to the next model's Restore", async () => {
    await show("/trash", <TrashPage />);
    const restore = button("Restore Old benchy");
    restore.focus();
    await click(restore);
    expect(restore.isConnected).toBe(false);
    expect(focusedNotBody()).toBe(button("Restore Broken clip"));
  });

  test("success: after a revoke, focus goes to the next token's Revoke", async () => {
    state.tokens.push({
      id: "t9",
      name: "Backup job",
      prefix: "ph_Zy9xW",
      createdAt: "2026-11-02T09:00:00.000Z",
      lastUsedAt: null,
      createdBy: null,
    });
    await show("/settings", <SettingsPage />);
    const revoke = button("Revoke Office desktop");
    revoke.focus();
    await click(revoke);
    await click(button("Revoke", dialog() as HTMLElement));
    expect(dialog()).toBeNull();
    expect(revoke.isConnected).toBe(false);
    expect(focusedNotBody()).toBe(button("Revoke Backup job"));
  });

  test("success: after a chip remove, focus goes to the next chip's remove button", async () => {
    const [clip] = state.models as [FakeModel];
    clip.tags = ["PLA", "PETG"];
    await show("/collections?name=Desk", <CollectionsPage />);
    const remove = button("Remove tag PLA from Cable clip");
    remove.focus();
    await click(remove);
    expect(remove.isConnected).toBe(false);
    expect(focusedNotBody()).toBe(button("Remove tag PETG from Cable clip"));
  });

  test("last row: trashing the bottom model moves focus to the one above", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const trash = button("Move Hook to the trash");
    trash.focus();
    await click(trash);
    expect(focusedNotBody()).toBe(button("Move Cable clip to the trash"));
  });

  test("last row: trashing the only model on the page moves focus to the status line", async () => {
    await show("/creators?name=Other", <CreatorsPage />);
    const trash = button("Move Hook to the trash");
    trash.focus();
    await click(trash);
    expect(text()).toContain("No models here.");
    const status = statusLine();
    expect(status.textContent).toContain("Moved Hook to the trash.");
    expect(focusedNotBody()).toBe(status);
  });

  test("last row: restoring the last model in the trash moves focus to the status line", async () => {
    await show("/trash", <TrashPage />);
    const first = button("Restore Old benchy");
    first.focus();
    await click(first);
    const last = button("Restore Broken clip");
    expect(focusedNotBody()).toBe(last);
    await click(last);
    expect(text()).toContain("The trash is empty.");
    const status = statusLine();
    expect(status.textContent).toContain("Restored.");
    expect(focusedNotBody()).toBe(status);
  });

  test("last row: revoking the only token moves focus to Create token", async () => {
    await show("/settings", <SettingsPage />);
    const revoke = button("Revoke Office desktop");
    revoke.focus();
    await click(revoke);
    await click(button("Revoke", dialog() as HTMLElement));
    expect(text()).toContain("No API tokens yet.");
    expect(focusedNotBody()).toBe(button("Create token"));
  });

  test("last chip: removing the tag a page is about keeps the row, and focus goes to its add input", async () => {
    // On the PLA tag page, Cable clip stays listed after losing PLA until
    // the page is read again, so its own controls keep focus.
    await show("/tags?name=PLA", <TagsPage />);
    const remove = button("Remove tag PLA from Cable clip");
    remove.focus();
    await click(remove);
    expect(callsTo("DELETE", "/app/api/models/m1/tags?name=PLA")).toHaveLength(1);
    expect(text()).toContain("Cable clip.3mf");
    expect(focusedNotBody()).toBe(labelled<HTMLInputElement>("Add a tag to Cable clip"));
  });

  test("row leaves: a model that leaves the page while focus is on its chips moves focus to the next row", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const trashing = hold("POST /app/api/models/m1/trash");
    const removing = hold("DELETE /app/api/models/m1/tags");
    await click(button("Move Cable clip to the trash"));
    const remove = button("Remove tag PLA from Cable clip");
    remove.focus();
    await click(remove);
    expect(focusedNotBody()).toBe(remove);

    // The trash answers first and takes the whole row, chips and all, off the page.
    await trashing();
    expect(remove.isConnected).toBe(false);
    expect(focusedNotBody()).toBe(button("Move Hook to the trash"));
    await removing();
    expect(focusedNotBody()).toBe(button("Move Hook to the trash"));
  });

  test("row leaves: focus the user has moved out of the list is left where it is", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("POST /app/api/models/m1/trash");
    const trash = button("Move Cable clip to the trash");
    trash.focus();
    await click(trash);
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "Show in the library",
    ) as HTMLAnchorElement;
    link.focus();
    await release();
    expect(trash.isConnected).toBe(false);
    expect(focusedNotBody()).toBe(link);
  });

  test("failure: a Move to trash that fails leaves focus on its button", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    const release = hold("POST /app/api/models/m1/trash");
    const trash = button("Move Cable clip to the trash");
    trash.focus();
    await click(trash);
    // Gone on the server before the trash lands, so it fails.
    state.models = state.models.filter((m) => m.id !== "m1");
    await release();
    expect(trash.isConnected).toBe(true);
    expect(text()).toContain("That is no longer there.");
    expect(announced()).toContain("That is no longer there.");
    expect(focusedNotBody()).toBe(trash);
    expect(trash.getAttribute("aria-disabled")).toBe("false");
  });

  test("failure: a Restore that fails leaves focus on its button", async () => {
    await show("/trash", <TrashPage />);
    const release = hold("POST /app/api/trash/m-trashed-1/restore");
    const restore = button("Restore Old benchy");
    restore.focus();
    await click(restore);
    // Purged on the server before the restore lands, so it fails.
    state.trash = state.trash.filter((m) => m.id !== "m-trashed-1");
    await release();
    expect(restore.isConnected).toBe(true);
    expect(text()).toContain("That is no longer there.");
    expect(announced()).toContain("That is no longer there.");
    expect(focusedNotBody()).toBe(restore);
    expect(restore.getAttribute("aria-disabled")).toBe("false");
  });

  test("dialog: Cancel on a revoke puts focus back on that Revoke button", async () => {
    await show("/settings", <SettingsPage />);
    const revoke = button("Revoke Office desktop");
    revoke.focus();
    await click(revoke);
    await click(button("Cancel", dialog() as HTMLElement));
    expect(dialog()).toBeNull();
    expect(focusedNotBody()).toBe(revoke);
  });

  test("dialog: closing the new token dialog puts focus on Create token", async () => {
    await show("/settings", <SettingsPage />);
    await type(labelled<HTMLInputElement>("Token name"), "Build server script");
    const create = button("Create token");
    create.focus();
    await click(create);
    const shown = dialog() as HTMLElement;
    expect(shown.contains(focusedNotBody())).toBe(true);
    await press(focused(), "Escape");
    expect(dialog()).toBeNull();
    expect(focusedNotBody()).toBe(create);
  });

  test("dialog: a revoke that fails keeps focus in the dialog, and Cancel returns it to Revoke", async () => {
    await show("/settings", <SettingsPage />);
    failing.add("DELETE /app/api/tokens/t0");
    const revoke = button("Revoke Office desktop");
    revoke.focus();
    await click(revoke);
    const ask = dialog() as HTMLElement;
    const confirm = button("Revoke", ask);
    confirm.focus();
    await click(confirm);
    expect(ask.querySelector('[role="alert"]')?.textContent).toContain("unavailable right now");
    expect(ask.contains(focusedNotBody())).toBe(true);
    await click(button("Cancel", ask));
    expect(focusedNotBody()).toBe(revoke);
  });

  test("an empty trash marks Empty trash aria-disabled, not disabled, and a press opens nothing", async () => {
    state.trash = [];
    await show("/trash", <TrashPage />);
    const empty = button("Empty trash");
    expect(empty.matches(":disabled")).toBe(false);
    expect(empty.getAttribute("aria-disabled")).toBe("true");
    empty.focus();
    await click(empty);
    expect(dialog()).toBeNull();
    expect(focusedNotBody()).toBe(empty);
  });

  test("a model whose purge has begun shows Restore aria-disabled, and a press sends nothing", async () => {
    const [first] = state.trash as [FakeState["trash"][number]];
    first.purgeStarted = true;
    await show("/trash", <TrashPage />);
    const restore = button("Restore Old benchy");
    expect(restore.matches(":disabled")).toBe(false);
    expect(restore.getAttribute("aria-disabled")).toBe("true");
    restore.focus();
    await click(restore);
    expect(callsTo("POST", "/app/api/trash/m-trashed-1/restore")).toHaveLength(0);
    expect(focusedNotBody()).toBe(restore);
  });

  // The Creators and Collections pages link a name to the library filtered
  // by it (?creator= or ?collection=), which the library page reads.
  const libraryLinks = [
    {
      title: "Creators",
      path: "/creators",
      page: () => <CreatorsPage />,
      filter: "creator",
      label: "Creator",
      name: "Other",
      models: ["Hook"],
    },
    {
      title: "Collections",
      path: "/collections",
      page: () => <CollectionsPage />,
      filter: "collection",
      label: "Collection",
      name: "Desk",
      models: ["Cable clip", "Hook"],
    },
  ] as const;

  test.each(libraryLinks)(
    "Show in the library from $title asks the library for that $filter and shows its models",
    async ({ path, page, filter, label, name, models }) => {
      state.models.push({
        id: "m3",
        name: "Shelf bracket",
        creator: "Third",
        tags: [],
        collections: [],
        files: [{ id: "f3", name: "Shelf bracket.stl", kind: "stl" }],
      });
      await showWithLibrary(`${path}?${new URLSearchParams({ name })}`, page());
      await click(link("Show in the library"));
      expect(lastLibraryQuery().get(filter)).toBe(name);
      expect(libraryCards()).toEqual(models);
      expect(document.querySelector('[aria-label="Library filters"]')?.textContent).toContain(
        `${label}: ${name}`,
      );

      // Clearing the filter returns to the full library.
      await click(link(`Clear ${filter} filter`));
      expect(lastLibraryQuery().has(filter)).toBe(false);
      expect(libraryCards()).toEqual(["Cable clip", "Hook", "Shelf bracket"]);
      expect(document.querySelector('[aria-label="Library filters"]')).toBeNull();
    },
  );

  test.each(libraryLinks)(
    "Show in the library from $title keeps a name with spaces, an ampersand and non-ASCII characters intact",
    async ({ path, page, filter, label }) => {
      // Built from code points, so this file stays ASCII.
      const name = [
        "R",
        String.fromCodePoint(0xe9),
        "my & ",
        String.fromCodePoint(0x5c71, 0x7530),
        " ",
        String.fromCodePoint(0x1f9f0),
      ].join("");
      state.models.push({
        id: "m3",
        name: "Odd one",
        creator: name,
        tags: [],
        collections: [name],
        files: [{ id: "f3", name: "Odd one.stl", kind: "stl" }],
      });
      await showWithLibrary(`${path}?${new URLSearchParams({ name })}`, page());
      expect(document.querySelector("h2")?.textContent).toBe(name);
      await click(link("Show in the library"));
      expect(lastLibraryQuery().get(filter)).toBe(name);
      expect(libraryCards()).toEqual(["Odd one"]);
      expect(document.querySelector('[aria-label="Library filters"]')?.textContent).toContain(
        `${label}: ${name}`,
      );
    },
  );

  // The Creators, Collections and Tags pages swap one view for the other in
  // place: a name in the list opens its models, and All goes back to the
  // list. The link that was pressed leaves with the old view, so focus goes
  // to the new view's heading.
  const groupPages = [
    { title: "Creators", path: "/creators", page: () => <CreatorsPage />, name: "Maker" },
    { title: "Collections", path: "/collections", page: () => <CollectionsPage />, name: "Desk" },
    { title: "Tags", path: "/tags", page: () => <TagsPage />, name: "PLA" },
  ];

  test.each(groupPages)(
    "view swap: opening a name on $title puts focus on its heading",
    async ({ path, page, name }) => {
      await show(path, page());
      const open = link(name);
      open.focus();
      await click(open);
      expect(open.isConnected).toBe(false);
      const heading = focusedNotBody();
      expect(heading.tagName).toBe("H2");
      expect(heading.textContent).toBe(name);
      expect(heading.getAttribute("tabindex")).toBe("-1");
    },
  );

  test.each(groupPages)(
    "view swap: All on $title goes back to the list with focus on its heading",
    async ({ title, path, page, name }) => {
      await show(`${path}?${new URLSearchParams({ name })}`, page());
      const all = link(`All ${title.toLowerCase()}`);
      all.focus();
      await click(all);
      expect(all.isConnected).toBe(false);
      expect(link(name).isConnected).toBe(true);
      const heading = focusedNotBody();
      expect(heading.tagName).toBe("H1");
      expect(heading.textContent).toBe(title);
      expect(heading.getAttribute("tabindex")).toBe("-1");
    },
  );
});

// Issue #312: a tag is deleted from the Tags page, a collection from the
// Collections page or its own page. A Delete asks first, naming how many
// models still use it, when any do; one no model uses goes at once.
/** Moves to the PLA tag's page by other means than a click on its link. */
function Go() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/tags?name=PLA")}>
      go
    </button>
  );
}

describe("deleting a tag or a collection", () => {
  /** The names the list shows, in order. */
  function listed(): string[] {
    return [...document.querySelectorAll(".studio-list-item .studio-row a")].map(
      (a) => a.textContent ?? "",
    );
  }

  test("a tag that models still have asks first, naming how many, then comes off them", async () => {
    state.models[1]?.tags.push("PLA");
    await show("/tags", <TagsPage />);
    await click(button("Delete tag PLA"));
    const box = dialog();
    expect(box?.querySelector("h2")?.textContent).toBe("Delete the tag PLA?");
    expect(box?.textContent).toContain(
      "2 models still have this tag. Deleting the tag takes it off them; the models themselves are not changed.",
    );
    expect(callsTo("DELETE", "/app/api/tags?name=PLA")).toHaveLength(0);
    await click(button("Delete tag", box as HTMLElement));
    expect(callsTo("DELETE", "/app/api/tags?name=PLA")).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(listed()).not.toContain("PLA");
    expect(state.models.every((m) => !m.tags.includes("PLA"))).toBe(true);
    expect(statusLine().textContent).toBe("Deleted the tag PLA.");
  });

  test("one model is named in the singular", async () => {
    await show("/tags", <TagsPage />);
    await click(button("Delete tag PLA"));
    expect(dialog()?.textContent).toContain(
      "1 model still has this tag. Deleting the tag takes it off that model; the model itself is not changed.",
    );
  });

  test("Cancel deletes nothing", async () => {
    await show("/tags", <TagsPage />);
    const opener = button("Delete tag PLA");
    opener.focus();
    await click(opener);
    await click(button("Cancel", dialog() as HTMLElement));
    expect(dialog()).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(listed()).toContain("PLA");
    expect(document.activeElement).toBe(opener);
  });

  test("a tag no model has is deleted without asking", async () => {
    state.unusedTags = ["qa-t28"];
    await show("/tags", <TagsPage />);
    expect(text()).toContain("0 models");
    await click(button("Delete tag qa-t28"));
    expect(dialog()).toBeNull();
    expect(callsTo("DELETE", "/app/api/tags?name=qa-t28")).toHaveLength(1);
    expect(listed()).toEqual(["PLA"]);
    expect(statusLine().textContent).toBe("Deleted the tag qa-t28.");
  });

  test("after a delete, focus goes to the next row's Delete, else the status line", async () => {
    state.unusedTags = ["Alpha", "Beta"];
    await show("/tags", <TagsPage />);
    const alpha = button("Delete tag Alpha");
    alpha.focus();
    await click(alpha);
    expect(document.activeElement).toBe(button("Delete tag Beta"));
    await click(button("Delete tag Beta"));
    expect(document.activeElement).toBe(button("Delete tag PLA"));
    await click(button("Delete tag PLA"));
    await click(button("Delete tag", dialog() as HTMLElement));
    expect(document.activeElement).toBe(statusLine());
  });

  test("a delete that fails says why in the dialog and keeps the tag", async () => {
    failing.add("DELETE /app/api/tags");
    await show("/tags", <TagsPage />);
    await click(button("Delete tag PLA"));
    await click(button("Delete tag", dialog() as HTMLElement));
    expect(dialog()).not.toBeNull();
    expect(announced()).toContain("This is unavailable right now.");
    expect(listed()).toContain("PLA");
  });

  test("a delete without a dialog that fails says why and keeps the tag", async () => {
    state.unusedTags = ["qa-t28"];
    failing.add("DELETE /app/api/tags");
    await show("/tags", <TagsPage />);
    await click(button("Delete tag qa-t28"));
    expect(announced()).toContain("This is unavailable right now.");
    expect(listed()).toContain("qa-t28");
  });

  test("a collection is deleted from the Collections page, and its models stay", async () => {
    state.unusedCollections = ["QA check"];
    await show("/collections", <CollectionsPage />);
    expect(listed()).toEqual(["Desk", "Garage", "QA check"]);
    await click(button("Delete collection QA check"));
    expect(callsTo("DELETE", "/app/api/collections?name=QA%20check")).toHaveLength(1);

    await click(button("Delete collection Garage"));
    const box = dialog();
    expect(box?.querySelector("h2")?.textContent).toBe("Delete the collection Garage?");
    expect(box?.textContent).toContain(
      "1 model is still in this collection. Deleting the collection takes that model out of it; the model itself is not changed.",
    );
    await click(button("Delete collection", box as HTMLElement));
    expect(callsTo("DELETE", "/app/api/collections?name=Garage")).toHaveLength(1);
    expect(listed()).toEqual(["Desk"]);
    expect(state.models.map((m) => m.name)).toEqual(["Cable clip", "Hook"]);
    expect(state.models[1]?.collections).toEqual(["Desk"]);
    expect(statusLine().textContent).toBe("Deleted the collection Garage.");
  });

  test("a collection is deleted from its own page, which then shows the list", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    await click(button("Delete collection Desk"));
    const box = dialog();
    expect(box?.textContent).toContain("2 models are still in this collection.");
    await click(button("Delete collection", box as HTMLElement));
    expect(callsTo("DELETE", "/app/api/collections?name=Desk")).toHaveLength(1);
    expect(document.querySelector("h1")?.textContent).toBe("Collections");
    expect(listed()).toEqual(["Garage"]);
    expect(statusLine().textContent).toBe("Deleted the collection Desk.");
  });

  test("on its own page, a collection whose count did not load still asks, then deletes", async () => {
    failing.add("GET /app/api/collections");
    await show("/collections?name=Desk", <CollectionsPage />);
    const opener = button("Delete collection Desk");
    expect(opener.getAttribute("aria-disabled")).toBe("false");
    await click(opener);
    const box = dialog();
    expect(box?.textContent).toContain(
      "How many models are in this collection could not be checked. Deleting the collection takes any models out of it; the models themselves are not changed.",
    );
    expect(callsTo("DELETE", "/app/api/collections?name=Desk")).toHaveLength(0);
    failing.delete("GET /app/api/collections");
    await click(button("Delete collection", box as HTMLElement));
    expect(callsTo("DELETE", "/app/api/collections?name=Desk")).toHaveLength(1);
    expect(document.querySelector("h1")?.textContent).toBe("Collections");
    expect(statusLine().textContent).toBe("Deleted the collection Desk.");
  });

  test("a name with spaces or dots goes in the query", async () => {
    state.unusedTags = [".."];
    state.unusedCollections = ["Desk gear & more"];
    await show("/tags", <TagsPage />);
    await click(button("Delete tag .."));
    expect(callsTo("DELETE", "/app/api/tags?name=..")).toHaveLength(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await show("/collections", <CollectionsPage />);
    await click(button("Delete collection Desk gear & more"));
    expect(callsTo("DELETE", "/app/api/collections?name=Desk%20gear%20%26%20more")).toHaveLength(1);
  });

  test("a tag already deleted in another tab is done: the row goes, with no error", async () => {
    state.unusedTags = ["qa-t28"];
    await show("/tags", <TagsPage />);
    state.unusedTags = [];
    await click(button("Delete tag qa-t28"));
    expect(callsTo("DELETE", "/app/api/tags?name=qa-t28")).toHaveLength(1);
    expect(announced()).toBe("");
    expect(listed()).not.toContain("qa-t28");
    expect(statusLine().textContent).toBe("Deleted the tag qa-t28.");
  });

  test("a tag that models had, gone in another tab, is done from the dialog too", async () => {
    await show("/tags", <TagsPage />);
    await click(button("Delete tag PLA"));
    const box = dialog();
    state.models[0]?.tags.splice(0);
    await click(button("Delete tag", box as HTMLElement));
    expect(dialog()).toBeNull();
    expect(announced()).toBe("");
    expect(listed()).not.toContain("PLA");
  });

  test("a collection gone in another tab is done from its own page, which then shows the list", async () => {
    await show("/collections?name=Garage", <CollectionsPage />);
    state.models[1]?.collections.splice(1);
    await click(button("Delete collection Garage"));
    const box = dialog();
    if (box !== null) await click(button("Delete collection", box));
    expect(announced()).toBe("");
    expect(document.querySelector("h1")?.textContent).toBe("Collections");
    expect(statusLine().textContent).toBe("Deleted the collection Garage.");
  });

  test("a modifier-click on a row link is left to the browser: the view does not swap", async () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      await act(async () => root.unmount());
      root = createRoot(container);
      await show(
        "/tags",
        <>
          <TagsPage />
          <Go />
        </>,
      );
      const row = link("PLA");
      await act(async () => {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
      });
      // The page stays on the list; a later move by other means is not a swap
      // the link asked for, so focus is not pulled to the new heading.
      expect(document.querySelector("h1")?.textContent).toBe("Tags");
      await click(button("go"));
      expect(document.querySelector("h2")?.textContent).toBe("PLA");
      expect(document.activeElement).toBe(document.body);
    }
  });

  test("a plain click on a row link still moves focus to the new heading", async () => {
    await show("/tags", <TagsPage />);
    await click(link("PLA"));
    expect(document.activeElement).toBe(document.querySelector("h2"));
  });

  test("creators cannot be deleted, and a tag's own page has no Delete", async () => {
    await show("/creators", <CreatorsPage />);
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Delete",
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await show("/tags?name=PLA", <TagsPage />);
    expect(() => button("Delete tag PLA")).toThrow();
  });
});

describe("the pages' stylesheet", () => {
  test("organise.css writes no colour of its own, only studio.css's tokens", () => {
    // A path, not a URL: this file runs under jsdom, whose URL is not Node's.
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "../src/settings/organise.css"), "utf8");
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i);
    expect(rules).not.toMatch(/\b(?:black|white)\b/i);
  });
});

function Harness({ nested }: { nested: boolean }) {
  return (
    <div id="outside-sibling">
      <Dialog title="Outer" onClose={() => {}}>
        <button type="button">Outer button</button>
        {nested ? (
          <ConfirmDialog
            title="Inner"
            message="Sure?"
            confirmLabel="Go"
            onConfirm={async () => {}}
            onCancel={() => {}}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

const escaped: string[] = [];

function Pair({ inner }: { inner: boolean }) {
  return (
    <Dialog title="Outer" onClose={() => escaped.push("outer")}>
      <button type="button">Outer button</button>
      {inner ? (
        <Dialog title="Inner" onClose={() => escaped.push("inner")}>
          <button type="button">Inner button</button>
        </Dialog>
      ) : null}
    </Dialog>
  );
}
describe("an open dialog isolates the rest of the page", () => {
  function inertCount(): number {
    return document.querySelectorAll("[inert]").length;
  }

  test("an open dialog makes the rest of the page inert, and closing it restores it", async () => {
    const before = document.createElement("div");
    before.id = "page-before";
    document.body.prepend(before);
    await act(async () => root.render(<Harness nested={false} />));
    expect(before.hasAttribute("inert")).toBe(true);
    expect(container.hasAttribute("inert")).toBe(false);
    expect(document.querySelector(".ph-dialog")?.closest("[inert]")).toBeNull();
    await act(async () => root.render(<div id="outside-sibling" />));
    expect(inertCount()).toBe(0);
    before.remove();
  });

  test("an element that was already inert stays inert after the dialog closes", async () => {
    const other = document.createElement("div");
    other.setAttribute("inert", "");
    document.body.prepend(other);
    await act(async () => root.render(<Harness nested={false} />));
    await act(async () => root.render(<div />));
    expect(other.hasAttribute("inert")).toBe(true);
    other.remove();
  });

  test("a dialog opened from inside another keeps the outer isolation when it closes", async () => {
    const before = document.createElement("div");
    document.body.prepend(before);
    await act(async () => root.render(<Harness nested={false} />));
    const outerButton = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Outer button",
    ) as HTMLButtonElement;
    await act(async () => root.render(<Harness nested />));
    // The inner dialog is usable; the outer dialog's own content is inert behind it.
    const dialogs = document.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(2);
    expect(outerButton.closest("[inert]")).not.toBeNull();
    expect(dialogs[1]?.closest("[inert]")).toBeNull();
    await act(async () => root.render(<Harness nested={false} />));
    expect(before.hasAttribute("inert")).toBe(true);
    expect(outerButton.closest("[inert]")).toBeNull();
    await act(async () => root.render(<div />));
    expect(inertCount()).toBe(0);
    before.remove();
  });

  test("an inner and an outer dialog mounted in the same commit release cleanly", async () => {
    const before = document.createElement("div");
    document.body.prepend(before);
    await act(async () => root.render(<Harness nested />));
    expect(before.hasAttribute("inert")).toBe(true);
    await act(async () => root.render(<Harness nested={false} />));
    expect(before.hasAttribute("inert")).toBe(true);
    await act(async () => root.render(<div />));
    expect(inertCount()).toBe(0);
    before.remove();
  });

  test("under StrictMode nothing is left inert after the dialog closes", async () => {
    const before = document.createElement("div");
    document.body.prepend(before);
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness nested={false} />
        </StrictMode>,
      ),
    );
    expect(before.hasAttribute("inert")).toBe(true);
    await act(async () =>
      root.render(
        <StrictMode>
          <div />
        </StrictMode>,
      ),
    );
    expect(inertCount()).toBe(0);
    before.remove();
  });

  test("a live region with nothing to focus stays readable; one with a control goes inert", async () => {
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const live = document.createElement("div");
    live.setAttribute("aria-live", "polite");
    live.append(document.createElement("button"));
    document.body.prepend(status, live);
    await act(async () => root.render(<Harness nested={false} />));
    expect(status.hasAttribute("inert")).toBe(false);
    expect(live.hasAttribute("inert")).toBe(true);
    await act(async () => root.render(<div />));
    expect(inertCount()).toBe(0);
    status.remove();
    live.remove();
  });

  test("a quiet live region that gains a control while the dialog is open goes inert", async () => {
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    document.body.prepend(status);
    await act(async () => root.render(<Harness nested={false} />));
    expect(status.hasAttribute("inert")).toBe(false);
    await act(async () => {
      status.append(document.createElement("button"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(status.hasAttribute("inert")).toBe(true);
    await act(async () => root.render(<div />));
    expect(inertCount()).toBe(0);
    status.remove();
  });

  test("an element added beside the dialog while it is open is inert, and freed on close", async () => {
    await act(async () => root.render(<Harness nested={false} />));
    const late = document.createElement("div");
    await act(async () => {
      document.body.prepend(late);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(late.hasAttribute("inert")).toBe(true);
    await act(async () => root.render(<div />));
    expect(late.hasAttribute("inert")).toBe(false);
    late.remove();
  });

  test("focus returns to the opener even when the browser blurs it as it goes inert", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.prepend(opener);
    opener.focus();
    // An engine that drops focus from an element the moment it becomes inert.
    const set = Element.prototype.setAttribute;
    const spy = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
      this: Element,
      name: string,
      value: string,
    ) {
      set.call(this, name, value);
      if (name === "inert" && this.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
    });
    await act(async () => root.render(<Harness nested={false} />));
    spy.mockRestore();
    await act(async () => root.render(<div />));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test("Escape with focus on the body closes the dialog; with two open only the inner one", async () => {
    escaped.length = 0;
    await act(async () => root.render(<Pair inner />));
    (document.activeElement as HTMLElement | null)?.blur();
    await press(document.body, "Escape");
    expect(escaped).toEqual(["inner"]);
    await act(async () => root.render(<Pair inner={false} />));
    (document.activeElement as HTMLElement | null)?.blur();
    await press(document.body, "Escape");
    expect(escaped).toEqual(["inner", "outer"]);
  });
});
