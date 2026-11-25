// The security headers the app sends on every answer (issue #449), so a
// reverse proxy does not have to add them (the proxy pages in docs/ say so):
//
// - Content-Security-Policy: everything from the app's own origin only.
//   The web build has one module script and one stylesheet, both files
//   under /assets/, and nothing inline (no inline script, no style
//   attribute in the HTML; test/web/shell.test.ts checks the real build),
//   so script-src and style-src are 'self'. Images may also be data: and
//   blob: URLs. frame-ancestors 'none' keeps any other site from framing
//   the app.
// - Referrer-Policy: no-referrer, so no app URL (a model id, a search, the
//   OAuth callback's query) leaves in a Referer header.
// - X-Content-Type-Options: nosniff, so a browser keeps to the content type
//   the app names.
//
// HSTS is not here: only the TLS-terminating proxy knows the site is
// HTTPS-only, so it stays the proxy's job.
//
// addSecurityHeaders adds a root onSend hook, so every answer gets them:
// every route and scope, the not-found handler, error answers and the
// gate's refusals. A header a route set itself, to a non-empty value, is
// left as it is. Fastify's own 400 and 414 for a bad path come before any
// hook, so app.ts frameworkError calls setSecurityHeaders itself.
import type { FastifyInstance, FastifyReply } from "fastify";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

/** Sets each of SECURITY_HEADERS on reply unless it already has a non-empty value. */
export function setSecurityHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    const current = reply.getHeader(name);
    const empty =
      current === undefined || current === "" || (Array.isArray(current) && current.length === 0);
    if (empty) reply.header(name, value);
  }
}

/** Sends SECURITY_HEADERS on every answer of app; call it before any route is registered. */
export function addSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    setSecurityHeaders(reply);
    return payload;
  });
}
