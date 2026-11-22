// Issue #358: making a plate's mesh copies the whole .3mf to a temp folder
// and holds its meshes in memory, so one process makes only a few at once
// (plate-mesh/limit.ts) and the rest wait their turn.
import { describe, expect, test } from "vitest";
import { createLimit } from "../../src/plate-mesh/limit.js";

/** A task that runs until finish() is called, recording that it started. */
function held() {
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  let started = false;
  const done = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return {
    task: () => {
      started = true;
      return done;
    },
    get started() {
      return started;
    },
    finish: (value: string) => finish(value),
    fail: (error: Error) => fail(error),
  };
}

/** Lets every settled promise run its handlers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLimit", () => {
  test("runs at most size tasks at once and starts the next when one finishes", async () => {
    const limit = createLimit(2);
    const tasks = [held(), held(), held(), held()];
    const runs = tasks.map((t) => limit(t.task));
    await settle();
    expect(tasks.map((t) => t.started)).toEqual([true, true, false, false]);

    tasks[1]?.finish("b");
    await expect(runs[1]).resolves.toBe("b");
    await settle();
    expect(tasks.map((t) => t.started)).toEqual([true, true, true, false]);

    tasks[0]?.finish("a");
    tasks[2]?.finish("c");
    await settle();
    expect(tasks[3]?.started).toBe(true);
    tasks[3]?.finish("d");
    expect(await Promise.all(runs)).toEqual(["a", "b", "c", "d"]);
  });

  test("frees the place of a task that fails, and passes its error on", async () => {
    const limit = createLimit(1);
    const first = held();
    const second = held();
    const a = limit(first.task);
    const b = limit(second.task);
    first.fail(new Error("the store is down"));
    await expect(a).rejects.toThrow("the store is down");
    await settle();
    expect(second.started).toBe(true);
    second.finish("ok");
    await expect(b).resolves.toBe("ok");
  });

  test("frees the place of a task that throws before returning a promise", async () => {
    const limit = createLimit(1);
    await expect(
      limit(() => {
        throw new Error("no temp folder");
      }),
    ).rejects.toThrow("no temp folder");
    await expect(limit(async () => "next")).resolves.toBe("next");
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses a size of %s", (size) => {
    expect(() => createLimit(size)).toThrow(RangeError);
  });
});
