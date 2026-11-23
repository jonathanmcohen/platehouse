// The auth pages (routes.ts: login unavailable, a login that did not finish,
// a login refused) show the Platehouse logo above their heading (the maintainer's
// decision A-1, 2026-11-19). The app has no sign-in page of its own
// (/auth/login sends the browser to the OIDC provider), so these plain pages are
// where a signed-out person sees Platehouse. The logo is /favicon.svg, which
// is public-class, so it loads without a session; nothing else about the
// pages changes.
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { patternClass } from "../../src/auth/gate.js";
import { LoginError } from "../../src/auth/oidc.js";
import { LOGIN_UNAVAILABLE, registerAuthRoutes } from "../../src/auth/routes.js";

const LOGO = '<img src="/favicon.svg" alt="Platehouse" width="48" height="48">';

const UNREACHABLE_OIDC = {
  begin: async (): Promise<never> => {
    throw new Error("the issuer cannot be reached");
  },
  finish: async (): Promise<never> => {
    throw new Error("not used");
  },
};

async function withAuthApp(
  run: (app: ReturnType<typeof Fastify>) => Promise<void>,
  oidc: Parameters<typeof registerAuthRoutes>[1]["oidc"] = UNREACHABLE_OIDC,
) {
  const app = Fastify();
  try {
    await app.register(fastifyCookie, { secret: "synthetic-cookie-secret" });
    await registerAuthRoutes(app, {
      oidc,
      sessions: {
        start: async () => {
          throw new Error("not used");
        },
        find: async () => undefined,
        end: async () => {},
        signOutEverywhere: async () => ({ sessionsEnded: 0, tokensRevoked: 0 }),
      },
      publicOrigin: "https://platehouse.test",
      absoluteUrl: (path) => `https://platehouse.test${path}`,
      group: "platehouse",
    });
    await run(app);
  } finally {
    await app.close();
  }
}

describe("the auth pages show the logo", () => {
  test("login unavailable (503): the logo, then the heading", async () => {
    await withAuthApp(async (app) => {
      const res = await app.inject({ method: "GET", url: "/auth/login" });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain(`<main>${LOGO}<h1>${LOGIN_UNAVAILABLE}</h1>`);
    });
  });

  test("a login that did not finish (400): the logo, then the heading", async () => {
    await withAuthApp(async (app) => {
      const res = await app.inject({ method: "GET", url: "/auth/callback?state=x" });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(`<main>${LOGO}<h1>Login did not finish</h1>`);
    });
  });

  test("the logo once per page, and it is a file a signed-out browser may load", async () => {
    await withAuthApp(async (app) => {
      const res = await app.inject({ method: "GET", url: "/auth/login" });
      expect(res.body.split("<img").length - 1).toBe(1);
      expect(patternClass("/favicon.svg")).toBe("public");
    });
  });
});

describe("the page for a user not in the group", () => {
  test("403 and does not name the configured group", async () => {
    const oidc = {
      begin: async () => ({
        url: new URL("https://issuer.test/authorize"),
        checks: {
          codeVerifier: "synthetic-verifier",
          state: "synthetic-state-0123456789",
          nonce: "synthetic-nonce",
        },
      }),
      finish: async () => {
        throw new LoginError("not_in_group", "not in the group");
      },
    };
    await withAuthApp(async (app) => {
      const login = await app.inject({ method: "GET", url: "/auth/login" });
      const cookies = login.cookies
        .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
        .join("; ");
      const res = await app.inject({
        method: "GET",
        url: "/auth/callback?state=synthetic-state-0123456789&code=c",
        headers: { cookie: cookies },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("Your account is not allowed to use this Platehouse.");
      expect(res.body).not.toContain("platehouse</");
      expect(res.body.toLowerCase()).not.toContain(" platehouse group");
      expect(res.body).not.toMatch(/\bgroup\b/);
    }, oidc);
  });
});
