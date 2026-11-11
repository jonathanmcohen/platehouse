// The OpenAPI description of the Public API v1 (build plan Task 16; AC-085,
// AC-091). Interface only: the document lands with the tests' fix.
import type { FastifyInstance } from "fastify";

/** Registers the document's generator on the root app, before any route. */
export async function registerOpenApi(
  _app: FastifyInstance,
  _opts: { serverUrl: string },
): Promise<void> {}
