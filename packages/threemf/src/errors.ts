/** What the app shows for a file readProject returns null for. */
export const NO_PLATE_DATA_MESSAGE = "No Bambu plate data in this file";

/**
 * The file could not be read right now (EIO, EACCES, ENOENT and the like).
 * This is never damage: the caller retries later and records nothing about
 * the file (Bambu Plates #4).
 */
export class ReadUnavailable extends Error {
  readonly code: string | undefined;

  constructor(cause: NodeJS.ErrnoException) {
    super(`The file could not be read right now (${cause.code ?? "unknown error"})`, { cause });
    this.name = "ReadUnavailable";
    this.code = cause.code;
  }
}

/** Internal: the file is over a ceiling or not a Bambu project. Becomes null. */
export class Damaged extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Damaged";
  }
}

/** A filesystem or system-call error, as opposed to a problem with the bytes. */
export function isSystemError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).syscall === "string" &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}
