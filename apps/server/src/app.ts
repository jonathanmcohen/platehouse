// The Fastify app (build plan Task 30). Not built yet: the failing tests come
// first.
import type { FastifyInstance } from "fastify";
import type { AuthHook, Uploads } from "./uploads/tus.js";
import { MAX_UPLOAD_BYTES } from "./uploads/tus.js";

/** Where the tus upload handler is mounted (Public API v1 contract, Task 9). */
export const UPLOAD_PREFIXES = Object.freeze({
  app: "/app/uploads",
  api: "/api/v1/uploads",
});

/** How long /healthz waits for the database before it answers 503. */
export const HEALTH_TIMEOUT_MS = 3_000;

/** The slow link a whole upload must fit through in one request: 1 Mbit/s. */
export const SLOW_LINK_BYTES_PER_SECOND = 125_000;

/** The HTTP request timeout: a 512 MiB single PATCH at SLOW_LINK_BYTES_PER_SECOND. */
export const REQUEST_TIMEOUT_MS = Math.ceil(MAX_UPLOAD_BYTES / SLOW_LINK_BYTES_PER_SECOND) * 1000;

export interface AppHealth {
  /** Resolves when the database answers a query. */
  database(): Promise<unknown>;
  /** True while pg-boss is started and the queues are worked. */
  queuesRunning(): boolean;
}

export interface AppDeps {
  health: AppHealth;
  /** The one upload store both mounts share (createUploads). */
  uploads: Uploads;
  /** Fastify's request log; off when left out. */
  logger?: boolean;
}

export const refuseUntilAuth: AuthHook = async () => {
  throw new Error("not implemented");
};

export async function buildApp(_deps: AppDeps): Promise<FastifyInstance> {
  throw new Error("not implemented");
}
