// Slicer links (build plan Task 17; AC-041, AC-040 link half, AC-091). A
// slicer opens a file from a URL and sends no cookie, so the link carries
// its own short-lived capability:
//
//   GET /s/<token>/<linkSegment(file)>
//   token = base64url( fileId(16 bytes) || exp(uint32 BE, unix s)
//                      || HMAC-SHA256(key, "ph-link-v1"||fileId||exp)[0..16] )
//
// - The key is derived from LINK_SECRET with HKDF-SHA256 under its own label
//   (linkKey). The login cookie's key (auth/routes.ts loginCookieKey) is
//   derived from the same secret under another label, so a value one of them
//   signs never passes the other's check, and LINK_SECRET itself signs
//   nothing.
// - A link works for LINK_LIFETIME_SECONDS (10 minutes, Q14) and opens only
//   the file whose id it carries. Expired, altered, malformed or naming a
//   file that is gone or in the trash: 403 with an empty body and no bytes.
//   The token's MAC and expiry are checked before anything is looked up, so
//   a forged link never reaches the database or the store.
// - The token is read from the path as sent (linkPath), not from the
//   router's decoded parameter, so only the literal 48-character token
//   matches: a percent-escaped form of it is refused, and so is a path with
//   an empty name segment or a further raw "/" after it.
// - The URL is absoluteUrl(...) on PUBLIC_ORIGIN, never built from the
//   request's Host (AC-091), and has no query string. Its last segment is
//   linkSegment: the file's name with its real extension (linkFileName),
//   with / \ % ? # ; NUL and control characters replaced by _, then
//   percent-encoded (Jon, 2026-11-12, PR #156), so it is always one segment
//   and holds nothing a proxy might decode, refuse or split on. OrcaSlicer
//   names its download after it. That segment is never used for lookup;
//   the answer's Content-Disposition carries the real stored name with its
//   extension (download.ts), so a slicer that prefers it gets that.
// - The route is registered as /s/:token/* rather than /s/:token/:name:
//   the router refuses a :param over its maxParamLength (100 characters)
//   with 414, which would break the link of any file whose name is longer.
//   The URLs it answers are the same. A path under /s/ that matches no
//   route (no name segment, another method) is answered by app.ts's
//   not-found handler as a refused link: 403, empty, no-store.
// - POST /app/api/files/:id/slicer-link mints one. It is a session route
//   that changes state, so the gate (auth/gate.ts) has already checked the
//   session and that Origin is PUBLIC_ORIGIN before it runs.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { FileContent, FileHead } from "../api/v1.js";
import {
  checkObjectSize,
  type DeliveryDeps,
  fileRouteErrors,
  type LinkFile,
  linkFileName,
  sendContent,
  unavailable,
} from "./download.js";

// linkFileName lives in download.ts, which this module imports, so the
// download route can use it without an import cycle; links still export it.
export { linkFileName };

/** How long a slicer link works (Q14). */
export const LINK_LIFETIME_SECONDS = 600;

/** A link token's length: 36 bytes in base64url. */
export const LINK_TOKEN_LENGTH = 48;

/** The link route's pattern: the token, then the file name as the rest. */
export const LINK_ROUTE = "/s/:token/*";

/** What a link's name segment never carries: each is replaced by "_" before encoding. */
const UNSAFE_IN_SEGMENT = /[/\\%?#;\p{Cc}]/gu;

/** The HKDF label of the link key; the login cookie's is "platehouse login cookie v1". */
const LINK_KEY_LABEL = "platehouse slicer link v1";

/** What the MAC covers before the file id and expiry (the Slicer link contract). */
const MAC_PREFIX = Buffer.from("ph-link-v1", "ascii");

const ID_BYTES = 16;
const EXP_BYTES = 4;
const MAC_BYTES = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{48}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SlicerLink {
  /** The link, on PUBLIC_ORIGIN. */
  url: string;
  /** When it stops working, ISO 8601. */
  expiresAt: string;
  /** The protocol URLs that open the link in each slicer. */
  open: { orca: string; bambuMac: string; bambuOther: string };
}

/** The key slicer links are MAC'd with, derived from LINK_SECRET. */
export function linkKey(linkSecret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(linkSecret, "utf8"), Buffer.alloc(0), LINK_KEY_LABEL, 32),
  );
}

function mac(key: Buffer, id: Buffer, exp: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(Buffer.concat([MAC_PREFIX, id, exp]))
    .digest()
    .subarray(0, MAC_BYTES);
}

/** A token for the file, good until expiresAt (unix seconds). */
export function mintLinkToken(key: Buffer, fileId: string, expiresAt: number): string {
  if (!UUID_PATTERN.test(fileId)) throw new RangeError("a link names a file by its UUID");
  const id = Buffer.from(fileId.replaceAll("-", ""), "hex");
  const exp = Buffer.alloc(EXP_BYTES);
  exp.writeUInt32BE(expiresAt);
  return Buffer.concat([id, exp, mac(key, id, exp)]).toString("base64url");
}

/** The file id a live, untampered token names; undefined for anything else. */
export function readLinkToken(key: Buffer, token: string, now: Date): string | undefined {
  if (!TOKEN_PATTERN.test(token)) return undefined;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== ID_BYTES + EXP_BYTES + MAC_BYTES) return undefined;
  const id = bytes.subarray(0, ID_BYTES);
  const exp = bytes.subarray(ID_BYTES, ID_BYTES + EXP_BYTES);
  if (!timingSafeEqual(bytes.subarray(ID_BYTES + EXP_BYTES), mac(key, id, exp))) {
    return undefined;
  }
  if (now.getTime() >= exp.readUInt32BE(0) * 1000) return undefined;
  const hex = id.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A link's last segment: linkFileName with / \ % ? # ; NUL and control
 * characters replaced by "_", then encodeURIComponent. It ends in the file's
 * real extension, which none of those characters is part of.
 */
export function linkSegment(file: Pick<LinkFile, "name" | "originalName" | "kind">): string {
  return encodeURIComponent(linkFileName(file).replace(UNSAFE_IN_SEGMENT, "_"));
}

/** A link to the file, minted now, with the protocol URLs for each slicer. */
export function slicerLink(opts: {
  key: Buffer;
  file: LinkFile;
  now: Date;
  absoluteUrl(path: string): string;
}): SlicerLink {
  const exp = Math.ceil(opts.now.getTime() / 1000) + LINK_LIFETIME_SECONDS;
  const token = mintLinkToken(opts.key, opts.file.id, exp);
  const url = opts.absoluteUrl(`/s/${token}/${linkSegment(opts.file)}`);
  const enc = encodeURIComponent(url);
  return {
    url,
    expiresAt: new Date(exp * 1000).toISOString(),
    open: {
      orca: `orcaslicer://open?file=${enc}`,
      bambuMac: `bambustudioopen://${enc}`,
      bambuOther: `bambustudio://open?file=${enc}`,
    },
  };
}

/**
 * The token of a raw request path of the form /<s>/<token>/<name>: exactly
 * one name segment, not empty, and nothing after it but the query. It reads
 * the path as sent, before the router decodes it, so the token is the
 * literal text of its segment and a "/" sent as %2F stays inside one
 * segment. Undefined for any other path.
 */
function linkPath(url: string): string | undefined {
  const at = url.search(/[?#]/);
  const path = at === -1 ? url : url.slice(0, at);
  const segments = path.split("/");
  if (segments.length !== 4 || segments[3] === "") return undefined;
  return segments[2];
}

/** A link refused: 403, nothing in the body. */
function refuseLink(reply: FastifyReply) {
  return reply.code(403).header("cache-control", "no-store").send();
}

/** Registers the mint route and the link route. */
export async function registerLinks(
  app: FastifyInstance,
  deps: DeliveryDeps & { absoluteUrl(path: string): string },
): Promise<void> {
  const key = linkKey(deps.linkSecret);
  const now = deps.now ?? (() => new Date());

  await app.register(async (scope) => {
    scope.setErrorHandler(fileRouteErrors("delivery: a slicer link request failed"));

    scope.post<{ Params: { id: string } }>(
      "/app/api/files/:id/slicer-link",
      async (request, reply) => {
        const file = await deps.library.linkFile(request.params.id);
        reply.header("cache-control", "no-store");
        if (file === undefined) return reply.code(404).send({ error: "not_found" });
        return slicerLink({ key, file, now: now(), absoluteUrl: deps.absoluteUrl });
      },
    );

    scope.get(LINK_ROUTE, async (request, reply) => {
      const token = linkPath(request.url);
      if (token === undefined) return refuseLink(reply);
      const fileId = readLinkToken(key, token, now());
      if (fileId === undefined) return refuseLink(reply);
      // The file's kind and original name give the Content-Disposition name
      // its extension (linkFileName); the database only, the store not yet.
      const file = await deps.library.linkFile(fileId);
      if (file === undefined) return refuseLink(reply);
      const head = request.method === "HEAD";
      let content: FileHead | FileContent | undefined;
      try {
        content = head ? await deps.files.fileHead(fileId) : await deps.files.openFile(fileId);
        if (content !== undefined) checkObjectSize(content);
      } catch (error) {
        const answered = unavailable(error, request, reply);
        if (answered !== undefined) return answered;
        throw error;
      }
      if (content === undefined) return refuseLink(reply);
      return sendContent(reply, content, { attachment: true, fileName: linkFileName(file) });
    });
  });
}
