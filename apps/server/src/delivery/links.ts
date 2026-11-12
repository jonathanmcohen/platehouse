// Slicer links (build plan Task 17; AC-041, AC-040 link half). Interface
// only: the implementation lands in the next commit, after the failing tests.
import type { FastifyInstance } from "fastify";
import type { DeliveryDeps, LinkFile } from "./download.js";

/** How long a slicer link works (Q14). */
export const LINK_LIFETIME_SECONDS = 600;

/** A link token's length: 36 bytes in base64url. */
export const LINK_TOKEN_LENGTH = 48;

export interface SlicerLink {
  url: string;
  expiresAt: string;
  open: { orca: string; bambuMac: string; bambuOther: string };
}

export function linkKey(_linkSecret: string): Buffer {
  throw new Error("not implemented");
}

export function mintLinkToken(_key: Buffer, _fileId: string, _expiresAt: number): string {
  throw new Error("not implemented");
}

export function readLinkToken(_key: Buffer, _token: string, _now: Date): string | undefined {
  throw new Error("not implemented");
}

export function linkFileName(_file: Pick<LinkFile, "name" | "originalName" | "kind">): string {
  throw new Error("not implemented");
}

export function slicerLink(_opts: {
  key: Buffer;
  file: LinkFile;
  now: Date;
  absoluteUrl(path: string): string;
}): SlicerLink {
  throw new Error("not implemented");
}

export async function registerLinks(
  _app: FastifyInstance,
  _deps: DeliveryDeps & { absoluteUrl(path: string): string },
): Promise<void> {}
