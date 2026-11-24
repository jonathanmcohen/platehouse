// @vitest-environment jsdom
// The Activity page, /activity (the maintainer, 2026-11-19: one page that shows what
// Platehouse is doing and holds, so the user never has to read container logs).
//
// The page is rendered into jsdom inside a memory router and talks to a fake
// GET /app/api/activity (and the model page's existing retry route) through
// the global fetch, which records every call. The fake answers the shape the
// server's app API answers (apps/server/src/app-api/activity.ts); the server
// side is tested against Postgres and pg-boss in
// apps/server/test/integration/app-api/activity.test.ts.
//
// What it pins: the loading, empty, failed and signed-out states; the
// library numbers; a real, labelled progressbar for the estimates; the
// queues and scheduled jobs; the slicer's health; the events, newest first,
// with links to live models and the retry of a failed estimate; and the
// refresh: every POLL_WORKING_MS while work is pending, every POLL_IDLE_MS
// otherwise, none while the tab is hidden, and at once when it is shown.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ActivityPage,
  type ActivityView,
  POLL_IDLE_MS,
  POLL_WORKING_MS,
} from "../src/activity/ActivityPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P1S = "Bambu Lab P1S 0.4 nozzle";
const P1S_NAME = "Bambu Lab P1S, 0.4 mm nozzle";

function emptyView(): ActivityView {
  return {
    generatedAt: "2026-11-19T12:00:00.000Z",
    library: {
      models: { live: 0, trashed: 0 },
      files: { "3mf": 0, stl: 0, step: 0, scad: 0 },
      plates: 0,
      blobs: { count: 0, bytes: 0 },
      lastImportAt: null,
    },
    estimates: {
      printerId: P1S,
      printerName: P1S_NAME,
      orcaVersion: "2.5.0",
      done: 0,
      pending: 0,
      running: 0,
      failed: 0,
      total: 0,
      perMinute: null,
      secondsLeft: null,
    },
    queues: [
      { id: "ingest", label: "Ingest (new files)", waiting: 0, active: 0, failed: 0 },
      { id: "estimates", label: "Estimates (slicing)", waiting: 0, active: 0, failed: 0 },
      { id: "renders", label: "OpenSCAD renders", waiting: 0, active: 0, failed: 0 },
      { id: "step", label: "STEP conversion", waiting: 0, active: 0, failed: 0 },
      { id: "scheduled", label: "Scheduled jobs", waiting: 0, active: 0, failed: 0 },
    ],
    schedules: [],
    slicer: {
      reachable: true,
      busy: false,
      orca: "2.5.0",
      openscad: "2026.10.01",
      sandbox: "on",
      sandboxReason: null,
      unsandboxed: false,
      printerId: P1S,
      printerName: P1S_NAME,
    },
    events: { items: [], limit: 50, inboxReadable: true },
    working: false,
  };
}

const LIVE_MODEL = "0193a7c0-0000-7000-8000-000000000001";
const TRASHED_MODEL = "0193a7c0-0000-7000-8000-000000000002";
const ESTIMATE = "0193a7c0-0000-7000-8000-0000000000e1";

function busyView(): ActivityView {
  const v = emptyView();
  v.library = {
    models: { live: 171, trashed: 3 },
    files: { "3mf": 160, stl: 20, step: 4, scad: 2 },
    plates: 463,
    blobs: { count: 1200, bytes: 4_500_000_000 },
    lastImportAt: "2026-11-19T11:00:00.000Z",
  };
  v.estimates = {
    printerId: P1S,
    printerName: P1S_NAME,
    orcaVersion: "2.5.0",
    done: 300,
    pending: 119,
    running: 1,
    failed: 43,
    total: 463,
    perMinute: 2,
    secondsLeft: 3600,
  };
  v.queues[1] = {
    id: "estimates",
    label: "Estimates (slicing)",
    waiting: 119,
    active: 1,
    failed: 0,
  };
  v.queues[2] = { id: "renders", label: "OpenSCAD renders", waiting: 0, active: 0, failed: 2 };
  v.schedules = [
    {
      key: "purge-expired",
      label: "Trash purge (models trashed over 30 days ago)",
      schedule: "Daily at 03:30 (UTC)",
      lastRunAt: "2026-11-19T03:30:01.000Z",
      lastState: "completed",
    },
    {
      key: "poll-orca",
      label: "Slicer version check",
      schedule: "Every 10 minutes (UTC)",
      lastRunAt: "2026-11-19T11:50:00.000Z",
      lastState: "failed",
    },
    {
      key: "sweep-orphans",
      label: "Sweep of stored objects with no record",
      schedule: "Daily at 04:00 (UTC)",
      lastRunAt: null,
      lastState: null,
    },
  ];
  v.slicer = {
    reachable: true,
    busy: true,
    orca: "2.5.0",
    openscad: "2026.10.01",
    sandbox: "on",
    sandboxReason: null,
    unsandboxed: false,
    printerId: P1S,
    printerName: P1S_NAME,
  };
  v.events = {
    limit: 50,
    inboxReadable: true,
    items: [
      {
        type: "estimate_failed",
        at: "2026-11-19T11:59:00.000Z",
        estimateId: ESTIMATE,
        model: { id: LIVE_MODEL, name: "Air Dry - AMS" },
        plate: { index: 3, name: "Lid" },
        code: -51,
        reason: "The plate is too big for this printer's bed.",
        detail: "plate 3 exceeds bed, see [path]",
      },
      {
        type: "render_failed",
        at: "2026-11-19T11:58:00.000Z",
        kind: "scad",
        model: { id: LIVE_MODEL, name: "Air Dry - AMS" },
        file: { id: "f1", name: "Knob.scad" },
        message: 'ERROR: Parser error in file "[path]", line 3',
      },
      {
        type: "render_failed",
        at: "2026-11-19T11:57:00.000Z",
        kind: "step",
        model: { id: LIVE_MODEL, name: "Air Dry - AMS" },
        file: { id: "f2", name: "Bracket.step" },
        message: null,
      },
      {
        type: "inbox_failed",
        at: "2026-11-19T11:56:00.000Z",
        name: "Broken.3mf",
        reason: "No Bambu plate data in this file.",
      },
      {
        type: "model_imported",
        at: "2026-11-19T11:55:00.000Z",
        model: { id: LIVE_MODEL, name: "Air Dry - AMS", trashed: false },
        source: "upload",
      },
      {
        type: "model_imported",
        at: "2026-11-19T11:54:00.000Z",
        model: { id: TRASHED_MODEL, name: "Old Bin", trashed: true },
        source: "api",
      },
      {
        type: "model_imported",
        at: "2026-11-19T11:53:00.000Z",
        model: { id: "0193a7c0-0000-7000-8000-000000000003", name: "Mystery", trashed: false },
        source: "unknown",
      },
    ],
  };
  v.working = true;
  return v;
}

interface Call {
  method: string;
  path: string;
}

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
/** What GET /app/api/activity answers next: a view, or a status with no view. */
let answer: () => ActivityView | number;
let retryStatus: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://platehouse.test");
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path: url.pathname });
      if (method === "GET" && url.pathname === "/app/api/activity") {
        const a = answer();
        return typeof a === "number" ? json({ error: "unavailable" }, a) : json(a);
      }
      if (method === "POST" && /^\/app\/api\/estimates\/[^/]+\/retry$/.test(url.pathname)) {
        if (retryStatus === 202) return json({ queued: true }, 202);
        // The route's own refusal (apps/server/src/app-api/model.ts); any
        // other status is a server that is down or failing.
        return retryStatus === 409
          ? json({ error: "not_retryable" }, 409)
          : json({ error: "unavailable" }, retryStatus);
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function gets(): number {
  return calls.filter((c) => c.method === "GET" && c.path === "/app/api/activity").length;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/activity"]}>
        <Routes>
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/models/:id" element={<p>Model page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function button(label: RegExp, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((b) => label.test(text(b)));
  if (found === undefined) throw new Error(`no button matching ${label}`);
  return found;
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

/** The section whose h2 reads name. */
function section(name: string): HTMLElement {
  const h = [...container.querySelectorAll("h2")].find((e) => text(e) === name);
  const s = h?.closest("section");
  if (!s) throw new Error(`no section ${name}`);
  return s as HTMLElement;
}

/** The dd beside the dt that reads label, inside scope. */
function stat(scope: ParentNode, label: string): string {
  const dt = [...scope.querySelectorAll("dt")].find((d) => text(d) === label);
  if (!dt) throw new Error(`no ${label}`);
  return text(dt.nextElementSibling);
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  calls = [];
  answer = () => busyView();
  retryStatus = 202;
  setHidden(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  stubServer();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("states", () => {
  test("says it is loading until the first answer, then shows the page", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return json(busyView());
      }),
    );
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/activity"]}>
          <ActivityPage />
        </MemoryRouter>,
      );
    });
    expect(text(container.querySelector("h1"))).toBe("Activity");
    expect(text(container)).toContain("Loading the activity");
    await act(async () => release());
    await settle();
    expect(text(container)).not.toContain("Loading");
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  test("a failed first load says so, and Try again loads it", async () => {
    answer = () => 503;
    await render();
    const alert = container.querySelector('[role="alert"]');
    expect(text(alert)).toContain("could not be loaded");
    answer = () => busyView();
    await click(button(/Try again/, alert as Element));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(stat(section("Library"), "Models")).toBe("171");
  });

  test("a signed-out answer says to sign in again", async () => {
    answer = () => 401;
    await render();
    expect(text(container.querySelector('[role="alert"]'))).toContain("signed out");
  });

  test("an empty library says so, in the library and the events", async () => {
    answer = () => emptyView();
    await render();
    expect(text(section("Library"))).toContain("The library is empty");
    expect(text(section("Recent events"))).toContain("No events yet");
    expect(text(section("Estimates"))).toContain("No estimates for this printer yet");
  });

  test("a failed refresh keeps the page and says it could not be refreshed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render();
    answer = () => 500;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_WORKING_MS);
    });
    await settle();
    expect(stat(section("Library"), "Models")).toBe("171");
    expect(text(container.querySelector('[role="alert"]'))).toContain("could not be refreshed");
  });
});

describe("the page", () => {
  test("has one h1 and an h2 for each section, in order", async () => {
    await render();
    expect([...container.querySelectorAll("h1")].map(text)).toEqual(["Activity"]);
    expect([...container.querySelectorAll("h2")].map(text)).toEqual([
      "Library",
      "Estimates",
      "Queues",
      "Scheduled jobs",
      "Slicer",
      "Recent events",
    ]);
  });

  test("shows the library's numbers", async () => {
    await render();
    const lib = section("Library");
    expect(stat(lib, "Models")).toBe("171");
    expect(stat(lib, "In the trash")).toBe("3");
    expect(stat(lib, "Plates")).toBe("463");
    expect(stat(lib, "3MF files")).toBe("160");
    expect(stat(lib, "STL files")).toBe("20");
    expect(stat(lib, "STEP files")).toBe("4");
    expect(stat(lib, "SCAD files")).toBe("2");
    expect(stat(lib, "Stored objects")).toBe("1,200");
    expect(stat(lib, "Stored size")).toBe("4.5 GB");
    expect(stat(lib, "Last import")).not.toBe("");
  });

  test("shows the estimates as a labelled progressbar with counts and a time left", async () => {
    await render();
    const est = section("Estimates");
    const bar = est.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    const labelId = bar?.getAttribute("aria-labelledby") ?? "";
    expect(text(document.getElementById(labelId))).toContain(P1S_NAME);
    expect(bar?.getAttribute("aria-valuemin")).toBe("0");
    expect(bar?.getAttribute("aria-valuemax")).toBe("463");
    expect(bar?.getAttribute("aria-valuenow")).toBe("343");
    expect(bar?.getAttribute("aria-valuetext")).toBe("343 of 463 plates settled");
    expect(stat(est, "Done")).toBe("300");
    expect(stat(est, "Waiting")).toBe("119");
    expect(stat(est, "Slicing")).toBe("1");
    expect(stat(est, "Failed")).toBe("43");
    expect(text(est)).toContain("About 2 plates a minute");
    expect(text(est)).toContain("roughly 1h 0m left");
  });

  test("shows 100% only when every plate is settled (issue #238)", async () => {
    answer = () => {
      const v = busyView();
      v.estimates.done = 462;
      v.estimates.failed = 0;
      v.estimates.pending = 1;
      v.estimates.running = 0;
      v.estimates.total = 463;
      return v;
    };
    await render();
    const est = section("Estimates");
    expect(text(est)).toContain("462 of 463 plates settled (99%)");
    const fill = est.querySelector<HTMLElement>(".ph-activity-progress-fill");
    expect(fill?.style.width).toBe("99%");
  });

  test("rounds an exact percent to itself, not one below it", async () => {
    // 29 / 100 * 100 is 28.999... in floating point.
    answer = () => {
      const v = busyView();
      Object.assign(v.estimates, { done: 29, failed: 0, pending: 71, running: 0, total: 100 });
      return v;
    };
    await render();
    expect(text(section("Estimates"))).toContain("29 of 100 plates settled (29%)");
  });

  test("says when there is too little recent progress for a time left", async () => {
    answer = () => {
      const v = busyView();
      v.estimates.perMinute = null;
      v.estimates.secondsLeft = null;
      return v;
    };
    await render();
    expect(text(section("Estimates"))).toContain("Not enough recent progress");
  });

  test("lists every queue with waiting, running and failed counts", async () => {
    await render();
    const rows = [...section("Queues").querySelectorAll("tbody tr")].map((tr) =>
      [...tr.children].map(text),
    );
    expect(rows).toEqual([
      ["Ingest (new files)", "0", "0", "0"],
      ["Estimates (slicing)", "119", "1", "0"],
      ["OpenSCAD renders", "0", "0", "2"],
      ["STEP conversion", "0", "0", "0"],
      ["Scheduled jobs", "0", "0", "0"],
    ]);
    const headers = [...section("Queues").querySelectorAll("thead th")].map(text);
    expect(headers).toEqual(["Queue", "Waiting", "Running", "Failed"]);
    for (const th of section("Queues").querySelectorAll("thead th")) {
      expect(th.getAttribute("scope")).toBe("col");
    }
  });

  test("lists each scheduled job with its schedule and last run", async () => {
    await render();
    const items = [...section("Scheduled jobs").querySelectorAll("li")].map(text);
    expect(items[0]).toContain("Trash purge");
    expect(items[0]).toContain("Daily at 03:30 (UTC)");
    expect(items[0]).toContain("finished");
    expect(items[1]).toContain("Slicer version check");
    expect(items[1]).toContain("failed");
    expect(items[2]).toContain("No run recorded in the last 7 days");
  });

  test("shows the slicer's health, versions and the default printer in full", async () => {
    await render();
    const s = section("Slicer");
    expect(stat(s, "Status")).toBe("Reachable, slicing now");
    expect(stat(s, "OrcaSlicer")).toBe("2.5.0");
    expect(stat(s, "OpenSCAD")).toBe("2026.10.01");
    expect(stat(s, "Default printer")).toBe(P1S_NAME);
  });

  test("says plainly when the slicer cannot be reached", async () => {
    answer = () => {
      const v = busyView();
      v.slicer = {
        reachable: false,
        busy: null,
        orca: null,
        openscad: null,
        sandbox: null,
        sandboxReason: null,
        unsandboxed: null,
        printerId: P1S,
        printerName: P1S_NAME,
      };
      return v;
    };
    await render();
    const s = section("Slicer");
    expect(stat(s, "Status")).toBe("Not reachable");
    expect(stat(s, "OrcaSlicer")).toBe("Unknown");
    expect(text(s)).toContain("The slicer is not answering");
  });

  describe("sandbox", () => {
    const OFF_KERNEL =
      "Sandbox: off. This server's kernel is older than Linux 6.12, so pictures, OpenSCAD renders, STEP previews and estimates are off.";
    const OFF_CHECK =
      "Sandbox: off. Its check failed, so pictures, OpenSCAD renders, STEP previews and estimates are off.";
    const UNSANDBOXED =
      "Estimates and STEP previews run without the sandbox, because SLICER_ALLOW_UNSANDBOXED is set. Pictures and OpenSCAD renders are off.";

    async function renderWith(sandbox: Partial<ActivityView["slicer"]>) {
      answer = () => {
        const v = busyView();
        v.slicer = { ...v.slicer, ...sandbox };
        return v;
      };
      await render();
      return text(section("Slicer"));
    }

    test("says it is on", async () => {
      const t = await renderWith({ sandbox: "on" });
      expect(t).toContain("Sandbox: on");
      expect(t).not.toContain("Sandbox: off");
    });

    test("says it is being checked", async () => {
      expect(await renderWith({ sandbox: "checking" })).toContain("Sandbox: checking");
    });

    test("says it is off for an old kernel, and nothing more when not allowed", async () => {
      const t = await renderWith({
        sandbox: "off",
        sandboxReason: "old_kernel",
        unsandboxed: false,
      });
      expect(t).toContain(OFF_KERNEL);
      expect(t).not.toContain("SLICER_ALLOW_UNSANDBOXED");
    });

    test("says it is off for a failed check", async () => {
      const t = await renderWith({
        sandbox: "off",
        sandboxReason: "check_failed",
        unsandboxed: false,
      });
      expect(t).toContain(OFF_CHECK);
    });

    test("says what still runs when the slicer is allowed to run without it", async () => {
      const t = await renderWith({
        sandbox: "off",
        sandboxReason: "old_kernel",
        unsandboxed: true,
      });
      expect(t).toContain(OFF_KERNEL);
      expect(t).toContain(UNSANDBOXED);
    });

    test("says nothing about it when the slicer did not answer", async () => {
      const t = await renderWith({
        reachable: false,
        busy: null,
        sandbox: null,
        sandboxReason: null,
        unsandboxed: null,
      });
      expect(t).not.toContain("Sandbox");
    });
  });
});

describe("recent events", () => {
  test("lists them newest first, each with its time", async () => {
    await render();
    const items = [...section("Recent events").querySelectorAll("ol > li")];
    expect(items).toHaveLength(7);
    const times = items.map((li) => li.querySelector("time")?.getAttribute("datetime") ?? "");
    expect([...times].sort().reverse()).toEqual(times);
    expect(text(items[0])).toContain("Estimate failed");
    expect(text(items[1])).toContain("OpenSCAD render failed");
    expect(text(items[2])).toContain("STEP conversion failed");
    expect(text(items[3])).toContain("Inbox file failed");
    expect(text(items[4])).toContain("Model added");
  });

  test("shows a failed estimate's model link, plate, code, reason and detail", async () => {
    await render();
    const li = [...section("Recent events").querySelectorAll("ol > li")][0] as HTMLElement;
    const link = li.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`/models/${LIVE_MODEL}`);
    expect(text(link)).toBe("Air Dry - AMS");
    expect(text(li)).toContain("plate 3 (Lid)");
    expect(text(li)).toContain("The plate is too big for this printer's bed.");
    expect(text(li)).toContain("Code -51");
    expect(text(li)).toContain("plate 3 exceeds bed, see [path]");
  });

  test("retries a failed estimate through the existing retry route, then refreshes", async () => {
    await render();
    const li = [...section("Recent events").querySelectorAll("ol > li")][0] as HTMLElement;
    const before = gets();
    await click(button(/^Retry$/, li));
    expect(calls).toContainEqual({ method: "POST", path: `/app/api/estimates/${ESTIMATE}/retry` });
    expect(gets()).toBe(before + 1);
  });

  test("a retry the server refuses as not retryable says why and asks for the list again", async () => {
    // 409 not_retryable is final: the estimate is no longer failed (retried
    // in another tab or on the model page), or its printer or plate is gone.
    // Usually the estimate is no longer failed, so the refreshed list leaves
    // its event out and the row, with its Retry, goes. The words must not go
    // with it: they are in the section's status line and name the plate.
    retryStatus = 409;
    await render();
    const events = section("Recent events");
    const li = [...events.querySelectorAll("ol > li")][0] as HTMLElement;
    expect(text(li)).toContain("Estimate failed");
    answer = () => {
      const v = busyView();
      v.events.items = v.events.items.filter((e) => e.type !== "estimate_failed");
      return v;
    };
    const before = gets();
    await click(button(/^Retry$/, li));
    expect(gets()).toBe(before + 1);
    expect(li.isConnected).toBe(false);
    expect(text(section("Recent events"))).not.toContain("Estimate failed");
    const status = text(section("Recent events").querySelector('[role="status"]'));
    expect(status).toBe(
      "Air Dry - AMS, plate 3 (Lid) can no longer be retried. It is already being estimated again, or its printer or file has changed.",
    );
  });

  test("the not-retryable line stays when the refreshed list still holds the event, and the next Retry clears it", async () => {
    retryStatus = 409;
    await render();
    const li = [...section("Recent events").querySelectorAll("ol > li")][0] as HTMLElement;
    await click(button(/^Retry$/, li));
    const status = () => text(section("Recent events").querySelector('[role="status"]'));
    expect(status()).toContain("plate 3 (Lid) can no longer be retried");
    expect(li.querySelector('[role="alert"]')).toBeNull();

    retryStatus = 202;
    await click(button(/^Retry$/, li));
    expect(status()).toBe("");
  });

  // The refusal's line is a one-shot notice (Events.tsx): it is shown by the
  // refresh the 409 asks for, whatever that refresh holds, and ended by the
  // next one, whatever that holds. The answers below are what the server
  // gives in each case.
  const NOT_RETRYABLE =
    "Air Dry - AMS, plate 3 (Lid) can no longer be retried. It is already being estimated again, or its printer or file has changed.";
  const statusLine = () => section("Recent events").querySelector('[role="status"]');

  /** The failed estimate's event is gone: retried elsewhere and estimating, or finished. */
  function withoutTheFailure(estimating: boolean): ActivityView {
    const v = busyView();
    v.events.items = v.events.items.filter((e) => e.type !== "estimate_failed");
    v.working = estimating;
    return v;
  }
  /** The same estimate failed again: its event is back, recorded later. */
  function failedAgainView(): ActivityView {
    const v = busyView();
    v.events.items = v.events.items.map((e) =>
      e.type === "estimate_failed" ? { ...e, at: "2026-11-19T12:05:00.000Z" } : e,
    );
    return v;
  }

  test.each([
    ["the plate estimating", () => withoutTheFailure(true)],
    ["the same failure", () => busyView()],
    ["a new failure of that estimate", failedAgainView],
  ])("the refresh the refusal asks for shows the line, whatever it holds: %s", async (_, next) => {
    retryStatus = 409;
    await render();
    const li = [...section("Recent events").querySelectorAll("ol > li")][0] as HTMLElement;
    answer = next;
    const before = gets();
    await click(button(/^Retry$/, li));
    expect(gets()).toBe(before + 1);
    expect(text(statusLine())).toBe(NOT_RETRYABLE);
  });

  test.each([
    ["the plate still estimating", () => withoutTheFailure(true)],
    ["the plate finished, with new numbers", () => withoutTheFailure(false)],
    ["the estimate failed again", failedAgainView],
  ])("the next refresh ends the line, whatever it holds: %s", async (_, next) => {
    retryStatus = 409;
    await render();
    const li = [...section("Recent events").querySelectorAll("ol > li")][0] as HTMLElement;
    answer = () => withoutTheFailure(true);
    await click(button(/^Retry$/, li));
    expect(text(statusLine())).toBe(NOT_RETRYABLE);

    answer = next;
    await click(button(/^Refresh$/));
    expect(text(statusLine())).toBe("");
  });

  test("a screen reader hears the whole sentence: the polite status region is there, empty, before it", async () => {
    retryStatus = 409;
    await render();
    const region = statusLine();
    if (region === null) throw new Error("no status region before the refusal");
    expect(text(region)).toBe("");
    expect(region.getAttribute("aria-live")).not.toBe("off");
    answer = () => withoutTheFailure(true);
    const li = [...section("Recent events").querySelectorAll("ol > li")][0] as HTMLElement;
    await click(button(/^Retry$/, li));
    // The same region, never replaced, now holds the sentence whole.
    expect(statusLine()).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(text(region)).toBe(NOT_RETRYABLE);
  });

  test("a retry that fails for another reason says what the server's answer means", async () => {
    retryStatus = 503;
    await render();
    const li = [...section("Recent events").querySelectorAll("ol > li")][0] as HTMLElement;
    const before = gets();
    await click(button(/^Retry$/, li));
    expect(text(li.querySelector('[role="alert"]'))).toBe(
      "This is unavailable right now. Try again in a moment.",
    );
    expect(gets()).toBe(before);
  });

  test("links a live model, and names a trashed one without a link", async () => {
    await render();
    const items = [...section("Recent events").querySelectorAll("ol > li")];
    const live = items[4] as HTMLElement;
    expect(live.querySelector("a")?.getAttribute("href")).toBe(`/models/${LIVE_MODEL}`);
    expect(text(live)).toContain("Uploaded (web or API)");
    const trashed = items[5] as HTMLElement;
    expect(trashed.querySelector("a")).toBeNull();
    expect(text(trashed)).toContain("Old Bin (in the trash)");
    expect(text(trashed)).toContain("From the API");
    expect(text(items[6])).toContain("Source not recorded");
  });

  test("shows a render's message and an inbox file's reason", async () => {
    await render();
    const items = [...section("Recent events").querySelectorAll("ol > li")];
    expect(text(items[1])).toContain('ERROR: Parser error in file "[path]", line 3');
    expect(text(items[1])).toContain("Knob.scad");
    expect(text(items[3])).toContain("Broken.3mf");
    expect(text(items[3])).toContain("No Bambu plate data in this file.");
  });

  test("says how many it shows and what it cannot tell", async () => {
    await render();
    const s = text(section("Recent events"));
    expect(s).toContain("newest 50");
    expect(s).toContain("Where a model came from");
  });

  // Issue #316: a failed STL or STEP preview picture is named as one.
  test("names a failed preview picture as one", async () => {
    answer = () => {
      const v = busyView();
      v.events.items = [
        {
          type: "render_failed",
          at: "2026-11-19T11:58:00.000Z",
          kind: "preview",
          model: { id: LIVE_MODEL, name: "Air Dry - AMS" },
          file: { id: "f3", name: "Hook.stl" },
          message: "The preview picture could not be rendered. OpenSCAD said: ERROR: bad STL",
        },
      ];
      return v;
    };
    await render();
    const li = section("Recent events").querySelector("ol > li") as HTMLElement;
    expect(text(li)).toContain("Preview picture failed");
    expect(text(li)).toContain("Hook.stl");
    expect(text(li)).not.toContain("STEP conversion failed");
  });

  test("warns when the inbox's failed folder could not be read", async () => {
    answer = () => {
      const v = busyView();
      v.events.inboxReadable = false;
      return v;
    };
    await render();
    expect(text(section("Recent events"))).toContain("inbox's failed folder could not be read");
  });
});

describe("refreshing", () => {
  test(`asks again every ${POLL_WORKING_MS} ms while work is pending`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render();
    expect(gets()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_WORKING_MS - 100);
    });
    expect(gets()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await settle();
    expect(gets()).toBe(2);
  });

  test(`asks only every ${POLL_IDLE_MS} ms when nothing is pending`, async () => {
    answer = () => emptyView();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_IDLE_MS - 100);
    });
    expect(gets()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await settle();
    expect(gets()).toBe(2);
  });

  test("stops while the tab is hidden, and asks at once when it is shown again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render();
    expect(gets()).toBe(1);
    await act(async () => setHidden(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 4);
    });
    expect(gets()).toBe(1);
    await act(async () => setHidden(false));
    await settle();
    expect(gets()).toBe(2);
  });

  test("does not ask once the page is gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 2);
    });
    expect(gets()).toBe(1);
  });

  test("Refresh asks at once", async () => {
    await render();
    await click(button(/^Refresh$/));
    expect(gets()).toBe(2);
  });
});

// The description re-conversion on upgrade (#357) is an event of its own: how
// many MakerWorld descriptions it changed, and what it left alone and why.
describe("a description re-conversion", () => {
  function withRun(counts: {
    checked: number;
    changed: number;
    unchanged: number;
    kept: number;
    unreadable: number;
  }): ActivityView {
    const v = emptyView();
    v.events.items = [
      {
        type: "descriptions_reconverted",
        at: "2026-11-21T09:30:00.000Z",
        converter: 3,
        ...counts,
      },
    ];
    return v;
  }

  test("says how many descriptions it changed and what it left alone", async () => {
    answer = () => withRun({ checked: 120, changed: 66, unchanged: 40, kept: 12, unreadable: 2 });
    await render();
    const items = [...section("Recent events").querySelectorAll("ol > li")];
    expect(items).toHaveLength(1);
    const li = items[0] as HTMLElement;
    expect(li.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-21T09:30:00.000Z");
    expect(text(li)).toContain("MakerWorld descriptions converted again");
    expect(text(li)).toContain("66 descriptions changed, of 120 checked.");
    expect(text(li)).toContain(
      "40 already right. 12 left as they were: edited, or not written from their file. 2 whose files could not be read.",
    );
  });

  test("says one description in the singular", async () => {
    answer = () => withRun({ checked: 1, changed: 1, unchanged: 0, kept: 0, unreadable: 0 });
    await render();
    const li = section("Recent events").querySelector("ol > li");
    expect(text(li)).toContain("1 description changed, of 1 checked.");
  });

  // Issue #398: the second line's counts were put in raw, so a count of 1
  // read "1 left as they were ... their file".
  test("says one kept or unreadable description in the singular too", async () => {
    answer = () => withRun({ checked: 3, changed: 0, unchanged: 1, kept: 1, unreadable: 1 });
    await render();
    const li = section("Recent events").querySelector("ol > li");
    expect(text(li)).toContain(
      "1 already right. 1 left as it was: edited, or not written from its file. 1 whose file could not be read.",
    );
  });
});

// While the re-conversion has not finished, its schedule is listed (#382), so
// a step an outage has delayed shows on the page.
describe("an unfinished description re-conversion", () => {
  test("shows its schedule by name", async () => {
    answer = () => {
      const v = emptyView();
      v.schedules = [
        {
          key: "reconvert-descriptions",
          label: "MakerWorld description re-conversion (until it finishes)",
          schedule: "Every 5 minutes (UTC)",
          lastRunAt: null,
          lastState: null,
        },
      ];
      return v;
    };
    await render();
    expect(text(container)).toContain("MakerWorld description re-conversion (until it finishes)");
  });
});
