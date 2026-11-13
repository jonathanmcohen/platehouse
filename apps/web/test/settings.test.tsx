// @vitest-environment jsdom
// Build plan Task 21: the settings, trash and organising pages (AC-013
// warning, AC-031 menu UI, AC-060, AC-061, AC-062, AC-063 UI, AC-083 UI).
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
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CollectionsPage } from "../src/collections/CollectionsPage";
import { CreatorsPage } from "../src/creators/CreatorsPage";
import { SettingsPage } from "../src/settings/SettingsPage";
import { VERSIONING_OFF_WARNING } from "../src/settings/VersioningBanner";
import { TagsPage } from "../src/tags/TagsPage";
import { TrashPage } from "../src/trash/TrashPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P1S = "Bambu Lab P1S 0.4 nozzle";
const P1S_06 = "Bambu Lab P1S 0.6 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";

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
  printerId: string;
  bucketVersioning: "enabled" | "suspended" | "off" | "unknown";
  tokens: Array<{
    id: string;
    name: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
  }>;
  trash: Array<{
    id: string;
    name: string;
    creator: string | null;
    trashedAt: string;
    purgeAt: string;
    purgeStarted: boolean;
  }>;
  models: FakeModel[];
}

let state: FakeState;
const calls: Call[] = [];
/** Every token value the fake handed out. */
const issued: string[] = [];

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

function counts(key: "tags" | "collections" | "creator") {
  const byName = new Map<string, number>();
  for (const m of state.models) {
    const names = key === "creator" ? (m.creator === null ? [] : [m.creator]) : m[key];
    for (const n of names) byName.set(n, (byName.get(n) ?? 0) + 1);
  }
  return [...byName].map(([name, models]) => ({ name, models }));
}

/** The fake /app/api: the routes the pages call, answering as the server does. */
async function fakeApi(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input), "https://platehouse.test");
  const method = (init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const path = decodeURIComponent(url.pathname);
  calls.push({ method, path: `${path}${url.search}`, body });
  const seg = path.split("/").slice(3); // after /app/api
  const model = (id: string | undefined) => state.models.find((m) => m.id === id);

  if (method === "GET" && path === "/app/api/settings") {
    return json(200, {
      printerId: state.printerId,
      bucketVersioning: state.bucketVersioning,
      printers: [
        {
          model: "Bambu Lab P1S",
          printers: [
            { id: P1S, nozzle: 0.4 },
            { id: P1S_06, nozzle: 0.6 },
          ],
        },
        { model: "Bambu Lab X1 Carbon", printers: [{ id: X1C, nozzle: 0.4 }] },
      ],
    });
  }
  if (method === "PUT" && path === "/app/api/settings/printer") {
    state.printerId = body.printerId;
    return json(204);
  }
  if (method === "GET" && path === "/app/api/tokens") return json(200, { tokens: state.tokens });
  if (method === "POST" && path === "/app/api/tokens") {
    const token = freshToken();
    issued.push(token);
    const row = {
      id: `t${state.tokens.length + 1}`,
      name: body.name,
      prefix: token.slice(0, 8),
      createdAt: "2026-11-12T10:00:00.000Z",
      lastUsedAt: null,
    };
    state.tokens = [row, ...state.tokens];
    return json(201, { ...row, token });
  }
  if (method === "DELETE" && seg[0] === "tokens") {
    state.tokens = state.tokens.filter((t) => t.id !== seg[1]);
    return json(204);
  }
  if (method === "GET" && path === "/app/api/trash") return json(200, { models: state.trash });
  if (method === "POST" && path === "/app/api/trash/empty") {
    const purged = state.trash.length;
    state.trash = [];
    return json(200, { purged });
  }
  if (method === "POST" && seg[0] === "trash" && seg[2] === "restore") {
    state.trash = state.trash.filter((m) => m.id !== seg[1]);
    return json(204);
  }
  if (method === "GET" && path === "/app/api/collections") {
    return json(200, { collections: counts("collections") });
  }
  if (method === "GET" && path === "/app/api/tags") return json(200, { tags: counts("tags") });
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
  if (seg[0] === "models" && seg[2] === "tags") {
    const m = model(seg[1]);
    const tag = seg[3] as string;
    if (m === undefined) return json(404, { error: "not_found" });
    if (method === "PUT" && !m.tags.includes(tag)) m.tags.push(tag);
    if (method === "DELETE") m.tags = m.tags.filter((t) => t !== tag);
    return json(204);
  }
  if (seg[0] === "collections" && seg[2] === "models") {
    const m = model(seg[3]);
    const name = seg[1] as string;
    if (m === undefined) return json(404, { error: "not_found" });
    if (method === "PUT" && !m.collections.includes(name)) m.collections.push(name);
    if (method === "DELETE") m.collections = m.collections.filter((c) => c !== name);
    return json(204);
  }
  if (method === "POST" && seg[0] === "models" && seg[2] === "trash") {
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
    bucketVersioning: "enabled",
    tokens: [
      {
        id: "t0",
        name: "Claude Code on mba",
        prefix: "ph_Ab3dE",
        createdAt: "2026-11-01T09:00:00.000Z",
        lastUsedAt: "2026-11-11T08:30:00.000Z",
      },
    ],
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
  };
  calls.length = 0;
  issued.length = 0;
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

async function press(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await settle();
}

async function submit(input: HTMLInputElement): Promise<void> {
  await act(async () => input.form?.requestSubmit());
  await settle();
}

function callsTo(method: string, path: string): Call[] {
  return calls.filter((c) => c.method === method && c.path === path);
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

  test("the printer menu is grouped by model with nozzle choices", async () => {
    await show("/settings", <SettingsPage />);
    const select = labelled<HTMLSelectElement>("Printer");
    const groups = [...select.querySelectorAll("optgroup")].map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll("option")].map((o) => [o.value, o.textContent]),
    }));
    expect(groups).toEqual([
      {
        label: "Bambu Lab P1S",
        options: [
          [P1S, "0.4 mm nozzle"],
          [P1S_06, "0.6 mm nozzle"],
        ],
      },
      { label: "Bambu Lab X1 Carbon", options: [[X1C, "0.4 mm nozzle"]] },
    ]);
    expect(select.value).toBe(P1S);
  });

  test("changing printer queues re-estimation and the old numbers stay marked", async () => {
    await show("/settings", <SettingsPage />);
    await choose(labelled<HTMLSelectElement>("Printer"), X1C);
    expect(callsTo("PUT", "/app/api/settings/printer")).toEqual([
      { method: "PUT", path: "/app/api/settings/printer", body: { printerId: X1C } },
    ]);
    const status = document.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toContain(`Re-estimating the library for ${X1C}`);
    expect(status).toContain(`marked as for ${P1S}`);
    expect(labelled<HTMLSelectElement>("Printer").value).toBe(X1C);
  });

  test("new token is shown once and never again", async () => {
    await show("/settings", <SettingsPage />);
    await type(labelled<HTMLInputElement>("Token name"), "Claude Code on mini01");
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
    expect(text()).toContain("Claude Code on mini01");
    expect(text()).toContain(token.slice(0, 8));
    expect(text()).toContain("Never used");

    // A fresh visit to the page still never shows it.
    await act(async () => root.unmount());
    root = createRoot(container);
    await show("/settings", <SettingsPage />);
    expect(text()).toContain(token.slice(0, 8));
    expect(text()).not.toContain(token);
  });

  test("the token list shows each token's prefix and last use, and revoke asks first", async () => {
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Claude Code on mba");
    expect(text()).toContain("ph_Ab3dE");
    expect(document.querySelector('time[datetime="2026-11-11T08:30:00.000Z"]')).not.toBeNull();

    await click(button("Revoke Claude Code on mba"));
    const ask = dialog();
    expect(ask?.textContent).toContain("Revoke");
    await click(button("Cancel", ask as HTMLElement));
    expect(callsTo("DELETE", "/app/api/tokens/t0")).toHaveLength(0);

    await click(button("Revoke Claude Code on mba"));
    await click(button("Revoke", dialog() as HTMLElement));
    expect(callsTo("DELETE", "/app/api/tokens/t0")).toHaveLength(1);
    expect(text()).not.toContain("Claude Code on mba");
  });

  test("the settings page holds the trash", async () => {
    await show("/settings", <SettingsPage />);
    expect(text()).toContain("Old benchy");
    expect(() => button("Empty trash")).not.toThrow();
  });
});

describe("the trash", () => {
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
    expect(text()).toContain("The trash is empty.");
    expect(dialogs.confirm).not.toHaveBeenCalled();
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

  test("tag and collection chips can be added and removed", async () => {
    await show("/collections?name=Desk", <CollectionsPage />);
    await type(labelled<HTMLInputElement>("Add a tag to Hook"), "PETG");
    await submit(labelled<HTMLInputElement>("Add a tag to Hook"));
    expect(callsTo("PUT", "/app/api/models/m2/tags/PETG")).toHaveLength(1);
    expect(() => button("Remove tag PETG from Hook")).not.toThrow();

    await click(button("Remove tag PLA from Cable clip"));
    expect(callsTo("DELETE", "/app/api/models/m1/tags/PLA")).toHaveLength(1);

    await type(labelled<HTMLInputElement>("Add Cable clip to a collection"), "Garage");
    await submit(labelled<HTMLInputElement>("Add Cable clip to a collection"));
    expect(callsTo("PUT", "/app/api/collections/Garage/models/m1")).toHaveLength(1);

    await click(button("Remove Hook from collection Garage"));
    expect(callsTo("DELETE", "/app/api/collections/Garage/models/m2")).toHaveLength(1);
  });

  test("a model can be moved to the trash", async () => {
    await show("/creators?name=Other", <CreatorsPage />);
    await click(button("Move Hook to the trash"));
    expect(callsTo("POST", "/app/api/models/m2/trash")).toHaveLength(1);
    expect(text()).not.toContain("Hook.stl");
  });
});
