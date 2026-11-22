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
//
// The process's memory gate (memoryGate, below; review of PR #409). Every
// job in the app whose memory the container budget counts runs through this
// one queue, so at most PLATE_MESH_BUILDS of them hold their peak at once:
// the plate mesh builds (plate-mesh.ts) and a STEP file's preview picture,
// which reads its whole stored mesh into memory (derived/preview.ts). A
// STEP preview shares the build's place, so with PLATE_MESH_BUILDS at 1 a
// preview and a plate build never hold their memory at the same time.
// test/compose-example.test.ts checks that one place fits the larger of
// the two peaks under the app's mem_limit.
//
// A STEP preview runs `first`: it goes ahead of the builds that wait, behind
// any other job run first, is never refused as busy and takes no waiting
// place from them, so the waiting rules above hold for the plate builds as
// they were. It waits only for the job running. That keeps its wait short:
// it waits on the slicer queue's one worker, which runs one slicer job at a
// time, so a long wait would hold up estimates. Neither side starves: a
// preview waits for at most the one job running, and the slicer queue sends
// previews one at a time, each after the last has finished with the slicer,
// so a waiting build is passed by at most one preview between its turns.

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
  /** Run first: ahead of the other waiting builds, never refused, not counted against `waiting`. */
  first: boolean;
  callers: number;
  done: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface RunOptions {
  /**
   * Run ahead of every waiting build not run first, behind those that are;
   * never refused with BuildQueueBusy, and not counted against `waiting`.
   * For a STEP preview's mesh read on the memory gate (see the file comment).
   */
  first?: boolean;
}

export interface BuildQueue {
  /**
   * The build of key: started now, queued, or joined if one of that key is
   * already running or waiting. Rejects with BuildQueueBusy when it would
   * have to wait and `waiting` already wait (never with options.first), and
   * with an AbortError as soon as signal aborts.
   */
  run<T>(
    key: string,
    task: () => Promise<T>,
    signal: AbortSignal,
    options?: RunOptions,
  ): Promise<T>;
  /** How many builds wait, not started, those run first included. */
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

  /** Waiting builds that count against `waiting`: those not run first. */
  const counted = (): number => queue.reduce((n, w) => (w.first ? n : n + 1), 0);

  const enqueue = (b: Build): void => {
    if (!b.first) {
      queue.push(b);
      return;
    }
    const at = queue.findIndex((w) => !w.first);
    if (at === -1) queue.push(b);
    else queue.splice(at, 0, b);
  };

  return {
    run<T>(
      key: string,
      task: () => Promise<T>,
      signal: AbortSignal,
      options: RunOptions = {},
    ): Promise<T> {
      if (signal.aborted) return Promise.reject(abandoned());
      const first = options.first === true;
      let b = builds.get(key);
      if (b === undefined) {
        if (!first && active >= sizes.running && counted() >= sizes.waiting) {
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
        b = { key, task, started: false, first, callers: 0, done, resolve, reject };
        builds.set(key, b);
        if (active < sizes.running) start(b);
        else enqueue(b);
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

/**
 * How many jobs the memory gate runs at once: plate mesh builds and STEP
 * previews' mesh reads together. One: a plate read's peak
 * (PLATE_MESH_READ_PEAK_MB in plate-mesh.ts, 1344 MiB) or a STEP preview's
 * (STEP_PREVIEW_PEAK_MB in derived/preview.ts, 512 MiB) leaves room for the
 * server itself under the 2 GiB mem_limit that examples/docker-compose.yml
 * gives it; two would not fit, and past mem_limit the kernel ends the whole
 * server (test/compose-example.test.ts checks it).
 */
export const PLATE_MESH_BUILDS = 1;

/** How many more plate builds may wait; an open past that is answered busy. */
export const PLATE_MESH_WAITING = 8;

/**
 * The process's one memory gate (see the file comment). plate-mesh.ts and
 * derived/derived.ts both use it unless a test hands them a queue of its own.
 */
export const memoryGate: BuildQueue = createBuildQueue({
  running: PLATE_MESH_BUILDS,
  waiting: PLATE_MESH_WAITING,
});
