// chainUpgradeSteps: the upgrade steps that share one queue job, run one
// after the other, a job at a time.
import { describe, expect, test } from "vitest";
import { RECONVERT_PAUSED } from "../../src/library/reconvert.js";
import { chainUpgradeSteps } from "../../src/library/upgrade-steps.js";

/** A step that is pending until its first run gives a result, which it then keeps giving up. */
function step(result: unknown) {
  let done = false;
  const runs: string[] = [];
  return {
    runs,
    pending: async () => !done,
    run: async () => {
      runs.push("run");
      if (result !== null && result !== RECONVERT_PAUSED) done = true;
      return result;
    },
  };
}

describe("chainUpgradeSteps", () => {
  test("runs the first pending step and then the next", async () => {
    const first = step({ n: 1 });
    const second = step({ n: 2 });
    const chain = chainUpgradeSteps([first, second]);
    expect(await chain.pending()).toBe(true);
    expect(await chain.run(() => false, new AbortController().signal)).toBe(RECONVERT_PAUSED);
    expect(first.runs).toEqual(["run"]);
    expect(second.runs).toEqual([]);
    expect(await chain.run(() => false, new AbortController().signal)).toEqual({ n: 2 });
    expect(first.runs).toEqual(["run"]);
    expect(second.runs).toEqual(["run"]);
  });

  test("returns paused when a step finishes and another is pending", async () => {
    const chain = chainUpgradeSteps([step({ n: 1 }), step({ n: 2 })]);
    expect(await chain.run(() => false, new AbortController().signal)).toBe(RECONVERT_PAUSED);
  });

  test("returns the step's own pause when it pauses", async () => {
    const chain = chainUpgradeSteps([step(RECONVERT_PAUSED), step({ n: 2 })]);
    expect(await chain.run(() => false, new AbortController().signal)).toBe(RECONVERT_PAUSED);
  });

  test("returns the last step's result when it finishes the chain", async () => {
    const first = step({ n: 1 });
    const second = step({ n: 2 });
    await first.run();
    const chain = chainUpgradeSteps([first, second]);
    expect(await chain.run(() => false, new AbortController().signal)).toEqual({ n: 2 });
  });

  test("returns null when the pending step is held elsewhere", async () => {
    const held = step(null);
    const later = step({ n: 2 });
    const chain = chainUpgradeSteps([held, later]);
    expect(await chain.run(() => false, new AbortController().signal)).toBeNull();
    expect(later.runs).toEqual([]);
  });

  test("is not pending once every step has finished", async () => {
    const first = step({ n: 1 });
    const second = step({ n: 2 });
    const chain = chainUpgradeSteps([first, second]);
    await first.run();
    await second.run();
    expect(await chain.pending()).toBe(false);
    expect(await chain.run(() => false, new AbortController().signal)).toBeNull();
  });
});
