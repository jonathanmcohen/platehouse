// Upgrade steps that share the one upgrade-queue job, run in order. The queue
// sends a job while pending() is true and runs it with run(): a result that
// is not RECONVERT_PAUSED ends the sending, so a step that finishes while a
// later one is still pending says RECONVERT_PAUSED instead, and the next job
// runs the next step.
import { RECONVERT_PAUSED } from "./reconvert.js";

export interface UpgradeStep {
  pending(): Promise<boolean>;
  run(stop?: () => boolean, signal?: AbortSignal): Promise<unknown>;
}

export function chainUpgradeSteps(steps: UpgradeStep[]): UpgradeStep {
  return {
    async pending() {
      for (const s of steps) if (await s.pending()) return true;
      return false;
    },
    async run(stop, signal) {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i] as UpgradeStep;
        if (!(await s.pending())) continue;
        const result = await s.run(stop, signal);
        // Another server holds it, or it stopped: nothing more to do now.
        if (result === null || result === RECONVERT_PAUSED) return result;
        for (const later of steps.slice(i + 1)) {
          if (await later.pending()) return RECONVERT_PAUSED;
        }
        return result;
      }
      return null;
    },
  };
}
