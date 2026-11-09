import { posix } from "node:path";
import { z } from "zod";

// The Configuration contract of the Platehouse build plan. Configuration comes
// from the environment only, and the server refuses to start when a required
// value is missing or any value is invalid.
//
// A ConfigError names the keys that failed and why, and never a value: its
// message, its properties and its stack carry no part of the environment.
// The reasons are fixed strings set beside each key below. zod's own issues
// and messages are not passed on: zod 4 leaves the input out of an issue only
// while reportInput is off, and its messages are not ours to keep value-free.

export class ConfigError extends Error {
  readonly keys: readonly string[];

  constructor(problems: ReadonlyArray<{ key: string; reason: string }>) {
    super(`Invalid configuration: ${problems.map((p) => `${p.key} ${p.reason}`).join("; ")}`);
    this.name = "ConfigError";
    this.keys = Object.freeze(problems.map((p) => p.key));
  }
}

export interface Config {
  /** The public origin, scheme and host only, with no trailing slash. */
  readonly publicOrigin: string;
  readonly databaseUrl: string;
  readonly port: number;
  readonly s3: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  };
  readonly oidc: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly group: string;
  };
  readonly linkSecret: string;
  readonly slicer: {
    readonly url: string;
    readonly plateSeconds: number;
  };
  readonly inbox: {
    readonly dir: string;
    readonly settleSeconds: number;
  };
  readonly tmpDir: string;
  /**
   * An absolute URL on the public origin for a path that starts with one "/".
   * It is built from PUBLIC_ORIGIN only, never from a request's Host header.
   */
  absoluteUrl(path: string): string;
}

const LINK_MIN_BYTES = 32;

function parsedUrl(value: string, protocols: readonly string[]): URL | null {
  const url = URL.parse(value);
  if (url === null || !protocols.includes(url.protocol) || url.hostname === "") return null;
  return url;
}

function isOrigin(value: string): boolean {
  const url = parsedUrl(value, ["https:"]);
  return (
    url !== null &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  );
}

function isIssuer(value: string): boolean {
  const url = parsedUrl(value, ["https:"]);
  return (
    url !== null &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

const text = z.string().min(1);
const origin = z
  .string()
  .refine(isOrigin)
  .transform((value) => new URL(value).origin);
const postgresUrl = z.string().refine((v) => parsedUrl(v, ["postgres:", "postgresql:"]) !== null);
const httpUrl = z.string().refine((v) => parsedUrl(v, ["http:", "https:"]) !== null);
const issuer = z.string().refine(isIssuer);
const flag = z.enum(["true", "false"]).transform((v) => v === "true");
const port = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));
const positiveInt = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().max(Number.MAX_SAFE_INTEGER));
const absolutePath = z.string().refine((v) => posix.isAbsolute(v));
const linkKey = z.string().refine((v) => Buffer.byteLength(v, "utf8") >= LINK_MIN_BYTES);

const NOT_EMPTY = "must not be empty";
const HTTP_URL = "must be an http or https URL";
const WHOLE = "must be a whole number of 1 or more";
const ABSOLUTE = "must be an absolute path";

// Each key carries the plain-words reason a ConfigError gives when its value
// is invalid. An empty value counts as unset, so "KEY=" in an env file is a
// missing key for a required value and the default for an optional one.
function required<T extends z.ZodType>(schema: T, reason: string) {
  return z.preprocess((v) => (v === "" ? undefined : v), schema).describe(reason);
}

function optional<T extends z.ZodType>(fallback: string, schema: T, reason: string) {
  return z.preprocess((v) => (v === undefined || v === "" ? fallback : v), schema).describe(reason);
}

// Keys in contract order; a ConfigError lists failures in this order.
const envSchema = z.object({
  PUBLIC_ORIGIN: required(
    origin,
    "must be an https origin with no path, query, fragment or credentials",
  ),
  DATABASE_URL: required(postgresUrl, "must be a postgres:// or postgresql:// URL"),
  PORT: optional("3000", port, "must be a whole number from 1 to 65535"),
  S3_ENDPOINT: required(httpUrl, HTTP_URL),
  S3_REGION: required(text, NOT_EMPTY),
  S3_BUCKET: required(text, NOT_EMPTY),
  S3_ACCESS_KEY_ID: required(text, NOT_EMPTY),
  S3_SECRET_ACCESS_KEY: required(text, NOT_EMPTY),
  S3_FORCE_PATH_STYLE: required(flag, "must be true or false"),
  OIDC_ISSUER: optional(
    "https://id.local.jonco.dev",
    issuer,
    "must be an https URL with no query, fragment or credentials",
  ),
  OIDC_CLIENT_ID: required(text, NOT_EMPTY),
  OIDC_CLIENT_SECRET: required(text, NOT_EMPTY),
  OIDC_GROUP: optional("platehouse", text, NOT_EMPTY),
  LINK_SECRET: required(linkKey, `must be at least ${LINK_MIN_BYTES} bytes`),
  SLICER_URL: optional("http://slicer:8080", httpUrl, HTTP_URL),
  // 120 s from the slicing gate: the worst plate took 55.31 s on Hades (run 4).
  SLICE_PLATE_SECONDS: optional("120", positiveInt, WHOLE),
  INBOX_DIR: optional("/data/inbox", absolutePath, ABSOLUTE),
  TMP_DIR: optional("/data/tmp", absolutePath, ABSOLUTE),
  INBOX_SETTLE_SECONDS: optional("15", positiveInt, WHOLE),
});

type EnvKey = keyof typeof envSchema.shape;

const KEYS = Object.keys(envSchema.shape) as EnvKey[];

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const failed = new Set(result.error.issues.map((issue) => issue.path[0]));
    const problems = KEYS.filter((key) => failed.has(key)).map((key) => ({
      key,
      reason:
        env[key] === undefined || env[key] === ""
          ? "is missing"
          : (envSchema.shape[key].description ?? "is invalid"),
    }));
    throw new ConfigError(problems);
  }
  const e = result.data;
  const publicOrigin = e.PUBLIC_ORIGIN;

  return Object.freeze({
    publicOrigin,
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    s3: Object.freeze({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    }),
    oidc: Object.freeze({
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      group: e.OIDC_GROUP,
    }),
    linkSecret: e.LINK_SECRET,
    slicer: Object.freeze({
      url: e.SLICER_URL,
      plateSeconds: e.SLICE_PLATE_SECONDS,
    }),
    inbox: Object.freeze({
      dir: e.INBOX_DIR,
      settleSeconds: e.INBOX_SETTLE_SECONDS,
    }),
    tmpDir: e.TMP_DIR,
    absoluteUrl(path: string): string {
      if (!path.startsWith("/") || path.startsWith("//")) {
        throw new TypeError("absoluteUrl takes a path that starts with a single /");
      }
      const url = `${publicOrigin}${path}`;
      if (URL.parse(url)?.origin !== publicOrigin) {
        throw new TypeError("absoluteUrl built a URL off the public origin");
      }
      return url;
    },
  });
}
