// How many tasks run at once, for making plate meshes (issue #358): each
// run copies a whole .3mf to a temp folder and holds its meshes and GLB in
// memory, so a process makes only a few at once and the rest wait their
// turn, first come first served. A task that fails frees its place like
// one that finishes.

/** Runs task now if fewer than size are running, or when a place frees up. */
export type Limit = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimit(size: number): Limit {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`a limit must be a whole number from 1, not ${size}`);
  }
  let running = 0;
  const waiting: Array<() => void> = [];
  const done = (): void => {
    const next = waiting.shift();
    // The place passes straight to the next task, so running stays the same.
    if (next === undefined) running--;
    else next();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < size) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      done();
    }
  };
}
