// The queue of plate mesh builds (issue #358, review finding #385). Each build
// copies a whole .3mf to a temp folder and holds its meshes and GLB in
// memory, so one process:
// - runs at most `running` builds at once, first come first served;
// - lets at most `waiting` more wait, and refuses a build past that with
//   BuildQueueBusy (the route answers 503, try again), starting nothing;
// - shares one build between every open of the same plate (the key), which
//   takes one place, running or waiting;
// - drops a waiting build once every caller of it has gone (each caller's
//   signal aborted), so a browser clicking through a file's plates leaves no
//   work behind it, and its place goes to the next build. A build that has
//   started runs to the end even when its callers go, so its mesh is still
//   kept for the next open, and a new caller of that plate joins it.
// A caller that goes is answered with an AbortError at once; the others are
// answered when the build ends. A build that fails frees its place like one
// that finishes, and every caller of it gets its error.

/** A build refused because `waiting` builds already wait. */
export class BuildQueueBusy extends Error {
  constructor() {
    super("too many plate meshes are waiting to be made");
    this.name = "BuildQueueBusy";
  }
}

function abandoned(): Error {
  const error = new Error("the caller stopped waiting for this build");
  error.name = "AbortError";
  return error;
}

interface Build {
  key: string;
  task: () => Promise<unknown>;
  started: boolean;
  callers: number;
  done: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface BuildQueue {
  /**
   * The build of key: started now, queued, or joined if one of that key is
   * already running or waiting. Rejects with BuildQueueBusy when it would
   * have to wait and `waiting` already wait, and with an AbortError as soon
   * as signal aborts.
   */
  run<T>(key: string, task: () => Promise<T>, signal: AbortSignal): Promise<T>;
  /** How many builds wait, not started. */
  waiting(): number;
}

export function createBuildQueue(sizes: { running: number; waiting: number }): BuildQueue {
  if (!Number.isSafeInteger(sizes.running) || sizes.running < 1) {
    throw new RangeError(
      `builds running at once must be a whole number from 1, not ${sizes.running}`,
    );
  }
  if (!Number.isSafeInteger(sizes.waiting) || sizes.waiting < 0) {
    throw new RangeError(`builds waiting must be a whole number from 0, not ${sizes.waiting}`);
  }
  let active = 0;
  const queue: Build[] = [];
  const builds = new Map<string, Build>();

  const forget = (b: Build): void => {
    if (builds.get(b.key) === b) builds.delete(b.key);
  };

  const start = (b: Build): void => {
    b.started = true;
    active++;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(b.task());
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(b.resolve, b.reject).finally(() => {
      active--;
      forget(b);
      next();
    });
  };

  const next = (): void => {
    while (active < sizes.running) {
      const b = queue.shift();
      if (b === undefined) return;
      start(b);
    }
  };

  const drop = (b: Build): void => {
    const at = queue.indexOf(b);
    if (at >= 0) queue.splice(at, 1);
    forget(b);
    b.reject(abandoned());
  };

  return {
    run<T>(key: string, task: () => Promise<T>, signal: AbortSignal): Promise<T> {
      if (signal.aborted) return Promise.reject(abandoned());
      let b = builds.get(key);
      if (b === undefined) {
        if (active >= sizes.running && queue.length >= sizes.waiting) {
          return Promise.reject(new BuildQueueBusy());
        }
        let resolve!: (value: unknown) => void;
        let reject!: (error: unknown) => void;
        const done = new Promise<unknown>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        // Every caller listens to done; this keeps a dropped build with no
        // caller left from being an unhandled rejection.
        done.catch(() => undefined);
        b = { key, task, started: false, callers: 0, done, resolve, reject };
        builds.set(key, b);
        if (active < sizes.running) start(b);
        else queue.push(b);
      }
      const build = b;
      build.callers++;
      return new Promise<T>((resolve, reject) => {
        const leave = (): void => {
          reject(abandoned());
          build.callers--;
          if (build.callers === 0 && !build.started) drop(build);
        };
        signal.addEventListener("abort", leave, { once: true });
        build.done.then(
          (value) => {
            signal.removeEventListener("abort", leave);
            resolve(value as T);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", leave);
            reject(error);
          },
        );
      });
    },
    waiting: () => queue.length,
  };
}
