// The idle limit of one transfer, shared by the Manyfold download and the
// Platehouse upload: the transfer fails when it makes no progress for the
// limit, never because the whole file takes longer (0.1.0 release review,
// issue #354).

/** Why an idle watch aborted: no progress for its limit. */
export class IdleTimeout extends Error {
  constructor(ms: number, words: string) {
    super(`${words} for ${ms / 1000} s`);
    this.name = "IdleTimeout";
  }
}

export interface IdleWatch {
  /** A fresh signal for one attempt, aborted after ms with no touch(). */
  arm(): AbortSignal;
  /** The current attempt's signal. */
  readonly signal: AbortSignal;
  /** The transfer moved: the clock starts again. */
  touch(): void;
  stop(): void;
}

/**
 * The idle limit of one transfer. Each attempt arms a new signal; each touch
 * restarts the clock, so only a stall aborts it. words name the stall in the
 * error ("no data" for a download): "<words> for <seconds> s".
 */
export function idleWatch(ms: number, words: string): IdleWatch {
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restart = () => {
    clearTimeout(timer);
    const current = controller;
    timer = setTimeout(() => current.abort(new IdleTimeout(ms, words)), ms);
  };
  return {
    arm() {
      controller = new AbortController();
      restart();
      return controller.signal;
    },
    get signal() {
      return controller.signal;
    },
    touch: restart,
    stop() {
      clearTimeout(timer);
    },
  };
}

/**
 * The idle limit's message when the watch is what stopped the request, else
 * null. Read from the watch, not the error, because how a fetch reports an
 * abort is up to the fetch.
 */
export function idleReason(watch: IdleWatch | undefined): string | null {
  const reason: unknown = watch?.signal.aborted === true ? watch.signal.reason : undefined;
  return reason instanceof IdleTimeout ? reason.message : null;
}
