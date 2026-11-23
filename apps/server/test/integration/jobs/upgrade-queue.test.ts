// The upgrade queue (#412) is stately: a re-conversion job sent while one
// already waits collapses into it, so the schedule and the paused slices can
// never pile jobs up. Runs against a real pg-boss, so the policy is the one
// pg-boss enforces, not one a fake agrees to.
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createBoss } from "../../../src/jobs/boss.js";
import { QUEUE, queueSettings, UPGRADE_TASKS } from "../../../src/jobs/queues.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";

let pgc: TestPostgres;
let boss: PgBoss;

beforeAll(async () => {
  pgc = await startTestPostgres();
  const t = await pgc.freshDatabase();
  boss = createBoss({ databaseUrl: t.url });
  await boss.start();
  // No worker is started, so every job sent stays queued.
  const { upgrade } = queueSettings();
  await boss.createQueue(upgrade.name, upgrade.queue);
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await pgc?.stop();
});

describe("the upgrade queue", () => {
  test("is created with the stately policy", async () => {
    expect((await boss.getQueue(QUEUE.upgrade))?.policy).toBe("stately");
  });

  test("five re-conversion jobs sent while none runs leave at most one queued", async () => {
    for (let i = 0; i < 5; i += 1) {
      await boss.send(
        QUEUE.upgrade,
        { task: UPGRADE_TASKS.reconvertDescriptions },
        { retryLimit: 0 },
      );
    }
    const queued = await boss.findJobs(QUEUE.upgrade, { queued: true });
    expect(queued.length).toBeLessThanOrEqual(1);
    expect(queued.length).toBe(1);
  });
});
