// Issue #358, review finding #385: the queue of plate mesh builds. At most
// `running` run at once (the server passes PLATE_MESH_BUILDS, now 1; these
// tests pass their own sizes); at most a few wait; a request past that is
// told the server is busy. Opens of the same plate share one build. A waiting build
// whose callers have all gone is never started; a build already running
// finishes, so its mesh is still kept.
import { describe, expect, test } from "vitest";
import { BuildQueueBusy, createBuildQueue } from "../../src/plate-mesh/limit.js";

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
