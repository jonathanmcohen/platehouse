// The storage layer's errors. Every failure of an S3 call leaves the store as
// one of three types, built from fixed words, the S3 operation, an S3 error
// code that passed a strict pattern and the HTTP status. None keeps the SDK's
// error as its cause: that object carries the provider's reply and the
// request, and a log that walks it (util.inspect, pino) would print them. So
// no part of the configuration, the secret access key above all, can reach a
// message, a stack, an inspect or a JSON rendering.

// Socket-level codes that mean the store could not be reached or dropped the
// connection.
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
]);

// A gateway or the store itself saying the service is down or overloaded.
const UNAVAILABLE_STATUS = new Set([502, 503, 504]);

// S3 error codes are short CamelCase words (NoSuchKey, AccessDenied). Anything
// else from a provider is not copied into an error.
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;

/** The store could not be reached, timed out, or a gateway said it is down. */
export class StoreUnavailable extends Error {
  readonly operation: string;
  readonly reason: string;

  constructor(operation: string, reason: string) {
    super(`Storage is unavailable right now (${operation}: ${reason})`);
    this.name = "StoreUnavailable";
    this.operation = operation;
    this.reason = reason;
  }
}

/** The object does not exist (S3 404). Never thrown for an outage. */
export class BlobNotFound extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`No object with that key (${operation})`);
    this.name = "BlobNotFound";
    this.operation = operation;
  }
}

/** The store answered and refused, or a stored object failed its check. */
export class StoreError extends Error {
  readonly operation: string;
  readonly code: string;
  readonly status: number | undefined;

  constructor(operation: string, code: string, status?: number) {
    super(`S3 ${operation} failed: ${code}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "StoreError";
    this.operation = operation;
    this.code = code;
    this.status = status;
  }
}

interface Shape {
  name?: unknown;
  code?: unknown;
  errors?: unknown;
  cause?: unknown;
  Code?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

function shape(err: unknown): Shape {
  return typeof err === "object" && err !== null ? (err as Shape) : {};
}

function httpStatus(err: unknown): number | undefined {
  const status = shape(err).$metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

/** The S3 error code, when it is a plain code word; otherwise "Unknown". */
export function s3Code(err: unknown): string {
  const s = shape(err);
  for (const candidate of [s.Code, s.name]) {
    if (typeof candidate === "string" && CODE_PATTERN.test(candidate)) return candidate;
  }
  return "Unknown";
}

// Why the store counts as unreachable, or null when it answered. Looks through
// AggregateError (a dual-stack connect tries each address) and causes.
function unreachableReason(err: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  const s = shape(err);
  if (typeof s.code === "string" && NETWORK_CODES.has(s.code)) return s.code;
  if (s.name === "TimeoutError") return "TimeoutError";
  const status = httpStatus(err);
  if (status !== undefined && UNAVAILABLE_STATUS.has(status)) return `HTTP ${status}`;
  if (Array.isArray(s.errors)) {
    for (const inner of s.errors) {
      const reason = unreachableReason(inner, depth + 1);
      if (reason) return reason;
    }
  }
  if (s.cause !== undefined) return unreachableReason(s.cause, depth + 1);
  return null;
}

export function isUnavailable(err: unknown): boolean {
  return unreachableReason(err) !== null;
}

/**
 * Turns an SDK failure into one of the store's errors. A 404 becomes
 * BlobNotFound only where the caller says a missing object is possible.
 */
export function toStoreError(
  err: unknown,
  operation: string,
  opts: { notFound?: boolean } = {},
): Error {
  const reason = unreachableReason(err);
  if (reason !== null) return new StoreUnavailable(operation, reason);
  const status = httpStatus(err);
  if (opts.notFound && status === 404) return new BlobNotFound(operation);
  return new StoreError(operation, s3Code(err), status);
}
