// Issue #358, review finding #385: the queue of plate mesh builds. At most
// `running` run at once (the server passes PLATE_MESH_BUILDS, now 1; these
// tests pass their own sizes); at most a few wait; a request past that is
// told the server is busy. Opens of the same plate share one build. A waiting build
// whose callers have all gone is never started; a build already running
// finishes, so its mesh is still kept.
import { describe, expect, test } from "vitest";
import {
  BuildQueueBusy,
  createBuildQueue,
  memoryGate,
  PLATE_MESH_BUILDS,
  PLATE_MESH_WAITING,
} from "../../src/memory/gate.js";

/** A build that runs until finish() is called, recording that it started. */
function held(value = "mesh") {
  let finish!: () => void;
  let starts = 0;
  const done = new Promise<string>((resolve) => {
    finish = () => resolve(value);
  });
  return {
    task: () => {
      starts++;
      return done;
    },
    get starts() {
      return starts;
    },
    finish: () => finish(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A caller's signal and the way to give up. */
function caller() {
  const c = new AbortController();
  return { signal: c.signal, leave: () => c.abort() };
}

describe("createBuildQueue", () => {
  test("a waiting preview takes no waiting place from the builds", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const running = held("running");
    const preview = held("preview");
    const next = held("next");
    const runs = [
      q.run("plate-running", running.task, caller().signal),
      q.run("step-preview:job-1", preview.task, caller().signal, { first: true }),
      q.run("plate-next", next.task, caller().signal),
    ];
    await settle();
    expect(q.waiting()).toBe(2);
    running.finish();
    preview.finish();
    next.finish();
    expect(await Promise.all(runs)).toEqual(["running", "preview", "next"]);
  });

  test("runs at most `running` builds at once and starts a waiting one when a place frees", async () => {
    const q = createBuildQueue({ running: 2, waiting: 8 });
    const builds = [held("a"), held("b"), held("c")];
    const runs = builds.map((b, i) => q.run(`plate-${i}`, b.task, caller().signal));
    await settle();
    expect(builds.map((b) => b.starts)).toEqual([1, 1, 0]);
    builds[0]?.finish();
    await expect(runs[0]).resolves.toBe("a");
    await settle();
    expect(builds[2]?.starts).toBe(1);
    builds[1]?.finish();
    builds[2]?.finish();
    expect(await Promise.all(runs)).toEqual(["a", "b", "c"]);
  });

  test("refuses a build past `waiting` with BuildQueueBusy, starting nothing", async () => {
    const q = createBuildQueue({ running: 2, waiting: 3 });
    const builds = Array.from({ length: 6 }, (_, i) => held(String(i)));
    const runs = builds.slice(0, 5).map((b, i) => q.run(`plate-${i}`, b.task, caller().signal));
    await settle();
    const refused = held("late");
    await expect(q.run("plate-late", refused.task, caller().signal)).rejects.toBeInstanceOf(
      BuildQueueBusy,
    );
    expect(refused.starts).toBe(0);
    expect(q.waiting()).toBe(3);
    for (const b of builds) b.finish();
    await Promise.all(runs);
  });

  test("opens of the same plate share one build and take one place", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const first = held("first");
    const shared = held("shared");
    const a = q.run("plate-1", first.task, caller().signal);
    const b = q.run("plate-2", shared.task, caller().signal);
    const c = q.run("plate-2", held("never").task, caller().signal);
    await settle();
    expect(q.waiting()).toBe(1);
    first.finish();
    shared.finish();
    expect(await Promise.all([a, b, c])).toEqual(["first", "shared", "shared"]);
    expect(shared.starts).toBe(1);
  });

  test("a waiting build whose callers have all gone is never started, and frees its place", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const blocker = held("blocker");
    const abandoned = held("abandoned");
    const next = held("next");
    const a = q.run("plate-1", blocker.task, caller().signal);
    const one = caller();
    const two = caller();
    const b1 = q.run("plate-2", abandoned.task, one.signal);
    const b2 = q.run("plate-2", abandoned.task, two.signal);
    one.leave();
    // The caller who left is answered at once.
    await expect(b1).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    // One caller still waits: the build keeps its place.
    expect(q.waiting()).toBe(1);
    two.leave();
    await expect(b2).rejects.toMatchObject({ name: "AbortError" });
    expect(q.waiting()).toBe(0);
    // Its place is free for another plate, which then runs.
    const c = q.run("plate-3", next.task, caller().signal);
    blocker.finish();
    await a;
    await settle();
    next.finish();
    await expect(c).resolves.toBe("next");
    expect(abandoned.starts).toBe(0);
  });

  test("a waiting build still runs for the caller who stayed", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const blocker = held();
    const build = held("kept");
    const a = q.run("plate-1", blocker.task, caller().signal);
    const gone = caller();
    const b1 = q.run("plate-2", build.task, gone.signal);
    const b2 = q.run("plate-2", build.task, caller().signal);
    gone.leave();
    await expect(b1).rejects.toMatchObject({ name: "AbortError" });
    blocker.finish();
    await a;
    await settle();
    expect(build.starts).toBe(1);
    build.finish();
    await expect(b2).resolves.toBe("kept");
  });

  test("a build already running finishes after its callers go, and a new caller joins it", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const build = held("cached");
    const gone = caller();
    const b1 = q.run("plate-1", build.task, gone.signal);
    await settle();
    expect(build.starts).toBe(1);
    gone.leave();
    await expect(b1).rejects.toMatchObject({ name: "AbortError" });
    const b2 = q.run("plate-1", held("second").task, caller().signal);
    build.finish();
    await expect(b2).resolves.toBe("cached");
    expect(build.starts).toBe(1);
  });

  test("after a waiting build was dropped, a new open of that plate starts a fresh one", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const blocker = held();
    const dropped = held("dropped");
    const fresh = held("fresh");
    const a = q.run("plate-1", blocker.task, caller().signal);
    const gone = caller();
    const b = q.run("plate-2", dropped.task, gone.signal);
    gone.leave();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    const again = q.run("plate-2", fresh.task, caller().signal);
    blocker.finish();
    await a;
    await settle();
    fresh.finish();
    await expect(again).resolves.toBe("fresh");
    expect(dropped.starts).toBe(0);
  });

  test("a caller who has already gone starts nothing and takes no place", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const gone = caller();
    gone.leave();
    const build = held();
    await expect(q.run("plate-1", build.task, gone.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await settle();
    expect(build.starts).toBe(0);
    expect(q.waiting()).toBe(0);
  });

  test("a failed build frees its place and passes its error to every caller", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const runs = [
      q.run("plate-1", () => Promise.reject(new Error("the store is down")), caller().signal),
      q.run("plate-1", () => Promise.resolve("never"), caller().signal),
    ];
    for (const r of runs) await expect(r).rejects.toThrow("the store is down");
    await expect(q.run("plate-2", async () => "next", caller().signal)).resolves.toBe("next");
  });

  test.each([
    [{ running: 0, waiting: 1 }],
    [{ running: 1, waiting: -1 }],
    [{ running: 1.5, waiting: 1 }],
  ])("refuses sizes %o", (sizes) => {
    expect(() => createBuildQueue(sizes)).toThrow(RangeError);
  });
});

// The 0.1.1 memory gate: a STEP preview's mesh read goes through the same
// queue as the plate builds (derived/derived.ts), run first. It waits only
// for the job that is running, never for the builds waiting, takes no
// waiting place from them and is never refused as busy.
describe("a job run first", () => {
  test("goes ahead of the waiting builds and runs as soon as the running one ends", async () => {
    const q = createBuildQueue({ running: 1, waiting: 8 });
    const running = held("running");
    const waitingA = held("a");
    const waitingB = held("b");
    const preview = held("preview");
    const order: string[] = [];
    const track = (name: string, b: ReturnType<typeof held>) => () => {
      order.push(name);
      return b.task();
    };
    const runs = [
      q.run("plate-1", track("running", running), caller().signal),
      q.run("plate-2", track("a", waitingA), caller().signal),
      q.run("plate-3", track("b", waitingB), caller().signal),
    ];
    const p = q.run("preview-1", track("preview", preview), caller().signal, { first: true });
    await settle();
    expect(order).toEqual(["running"]);
    running.finish();
    await settle();
    expect(order).toEqual(["running", "preview"]);
    preview.finish();
    await expect(p).resolves.toBe("preview");
    await settle();
    expect(order).toEqual(["running", "preview", "a"]);
    waitingA.finish();
    waitingB.finish();
    await Promise.all(runs);
    expect(order).toEqual(["running", "preview", "a", "b"]);
  });

  test("is never refused as busy and takes no waiting place from the builds", async () => {
    const q = createBuildQueue({ running: 1, waiting: 1 });
    const running = held();
    const waiting = held();
    const preview = held("preview");
    const a = q.run("plate-1", running.task, caller().signal);
    const b = q.run("plate-2", waiting.task, caller().signal);
    // The one waiting place is taken, so a build is refused...
    await expect(q.run("plate-3", held().task, caller().signal)).rejects.toBeInstanceOf(
      BuildQueueBusy,
    );
    // ...but a job run first still queues,
    const p = q.run("preview-1", preview.task, caller().signal, { first: true });
    await settle();
    expect(q.waiting()).toBe(2);
    // and the build refused above is refused the same way while it waits.
    await expect(q.run("plate-4", held().task, caller().signal)).rejects.toBeInstanceOf(
      BuildQueueBusy,
    );
    running.finish();
    await a;
    await settle();
    expect(preview.starts).toBe(1);
    expect(waiting.starts).toBe(0);
    preview.finish();
    await expect(p).resolves.toBe("preview");
    await settle();
    waiting.finish();
    await b;
  });

  test("two jobs run first keep their order, both ahead of the waiting builds", async () => {
    const q = createBuildQueue({ running: 1, waiting: 8 });
    const order: string[] = [];
    const quick = (name: string) => async () => {
      order.push(name);
      return name;
    };
    const blocker = held();
    const a = q.run("plate-1", blocker.task, caller().signal);
    const runs = [
      q.run("plate-2", quick("plate-2"), caller().signal),
      q.run("first-1", quick("first-1"), caller().signal, { first: true }),
      q.run("first-2", quick("first-2"), caller().signal, { first: true }),
    ];
    blocker.finish();
    await a;
    await Promise.all(runs);
    expect(order).toEqual(["first-1", "first-2", "plate-2"]);
  });

  test("a waiting build is passed by a job run first at most once for each job that runs", async () => {
    // Starvation check: jobs run first come one at a time (the slicer queue
    // runs one job at a time), each after the last has ended. The waiting
    // build still starts after the one job run first that queued ahead of it.
    const q = createBuildQueue({ running: 1, waiting: 8 });
    const order: string[] = [];
    const blocker = held();
    const build = held("build");
    const a = q.run("plate-1", blocker.task, caller().signal);
    const b = q.run(
      "plate-2",
      () => {
        order.push("build");
        return build.task();
      },
      caller().signal,
    );
    const first = held("first");
    const p1 = q.run(
      "first-1",
      () => {
        order.push("first-1");
        return first.task();
      },
      caller().signal,
      { first: true },
    );
    blocker.finish();
    await a;
    await settle();
    first.finish();
    await p1;
    // The next job run first arrives once the build has started: it waits.
    await settle();
    expect(order).toEqual(["first-1", "build"]);
    const next = held("next");
    const p2 = q.run(
      "first-2",
      () => {
        order.push("first-2");
        return next.task();
      },
      caller().signal,
      { first: true },
    );
    await settle();
    expect(order).toEqual(["first-1", "build"]);
    build.finish();
    await b;
    await settle();
    next.finish();
    await p2;
    expect(order).toEqual(["first-1", "build", "first-2"]);
  });
});

describe("the process's memory gate", () => {
  test("is one queue of PLATE_MESH_BUILDS jobs at once and PLATE_MESH_WAITING builds waiting", async () => {
    expect(PLATE_MESH_BUILDS).toBe(1);
    expect(PLATE_MESH_WAITING).toBe(8);
    const builds = Array.from({ length: 1 + PLATE_MESH_WAITING }, () => held());
    const runs = builds.map((b, i) => memoryGate.run(`gate-${i}`, b.task, caller().signal));
    await settle();
    expect(builds.map((b) => b.starts)).toEqual([1, ...Array(PLATE_MESH_WAITING).fill(0)]);
    await expect(memoryGate.run("gate-late", held().task, caller().signal)).rejects.toBeInstanceOf(
      BuildQueueBusy,
    );
    for (const b of builds) b.finish();
    await Promise.all(runs);
    expect(memoryGate.waiting()).toBe(0);
  });
});
