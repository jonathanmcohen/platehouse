// The route-class gate (build plan Task 15; the Route classes contract).
// Not implemented yet: the failing tests come first.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Session } from "../db/types.js";
import type { AuthHook } from "../uploads/tus.js";
import type { Sessions } from "./sessions.js";

export type RouteClass = "bearer" | "link" | "public" | "session";

/** The class of a route path (the Route classes table); anything unlisted is session. */
export function routeClass(_path: string): RouteClass {
  throw new Error("routeClass is not implemented yet");
}

/** The session requireSession found for this request, if any. */
export function sessionOf(_request: FastifyRequest): Session | undefined {
  return undefined;
}

export interface GateDeps {
  sessions: Sessions;
  publicOrigin: string;
  absoluteUrl(path: string): string;
}

/** Installs the gate on the root app and returns requireSession. */
export function installGate(_app: FastifyInstance, _deps: GateDeps): { requireSession: AuthHook } {
  return {
    requireSession: async () => {
      throw new Error("requireSession is not implemented yet");
    },
  };
}
