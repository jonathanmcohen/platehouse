// A local OpenID Connect issuer for the login tests (build plan Task 15),
// built on jose: discovery, an authorize endpoint the test drives like a
// browser that is already signed in to Pocket ID, a token endpoint that
// checks the client, the redirect_uri and the PKCE verifier, the JWKS and
// userinfo. It listens on 127.0.0.1 over plain HTTP, so the app's OIDC client
// is created with openid-client's allowInsecureRequests for these tests only
// (production config refuses an http issuer).
//
// Also here: the app's auth dependencies for buildApp with sessions kept in
// memory and a clock the test moves, so the login tests need no container.
//
// Every key, client id, secret and claim is made per run; nothing here reads
// a real secret or reaches a real issuer.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { allowInsecureRequests } from "openid-client";
import { type AppAuth, buildApp } from "../../../src/app.js";
import { createOidc, type OidcClient } from "../../../src/auth/oidc.js";
import { LOGIN_COOKIE_PREFIX, loginCookieKey } from "../../../src/auth/routes.js";
import {
  createSessions,
  SESSION_COOKIE,
  type SessionStore,
  type Sessions,
} from "../../../src/auth/sessions.js";
import type { Session } from "../../../src/db/types.js";
import { createUploads } from "../../../src/uploads/tus.js";

/** The public origin the auth tests use. */
export const TEST_ORIGIN = "https://platehouse.test";

/** The Pocket ID group a test user must be in. */
export const TEST_GROUP = "platehouse";

/** Who the issuer says is signing in. Leave a claim undefined to leave it out. */
export interface TestUser {
  sub: string;
  email?: string;
  email_verified?: unknown;
  groups?: unknown;
  /** false: groups and email_verified go only to userinfo, not into the ID token. */
  claimsInIdToken?: boolean;
  /** What the issuer gets wrong on purpose, to test that the app refuses it. */
  forge?: Forgery;
}

/**
 * A bad answer the issuer sends on purpose: an ID token with another nonce,
 * audience or issuer, one that has already expired, or a userinfo answer
 * about another subject than the ID token names. The token is still signed
 * with the issuer's own key, so only the claim is wrong.
 */
export interface Forgery {
  nonce?: string;
  aud?: string;
  iss?: string;
  /** The ID token expired this many seconds ago. */
  expiredSecondsAgo?: number;
  /** The sub userinfo answers with. */
  userinfoSub?: string;
}

export interface TokenRequest {
  /** The form the app posted. */
  form: URLSearchParams;
  /** How the client authenticated: client_secret_basic or client_secret_post. */
  auth: "basic" | "post";
}

export interface MockIssuer {
  /** http://127.0.0.1:<port>, the issuer identifier. */
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The user the next authorize call signs in. */
  user: TestUser;
  /** The query of every authorize request, in order. */
  readonly authorizeRequests: URLSearchParams[];
  /** Every token request that passed the client check, in order. */
  readonly tokenRequests: TokenRequest[];
  /** How many discovery documents were served. */
  discoveries: number;
  /**
   * Follows the app's redirect to the authorize endpoint as a signed-in
   * browser would, and returns where the issuer sends the browser back: the
   * redirect_uri with code and state. Throws if the request is not a
   * well-formed code flow request with PKCE S256.
   */
  authorize(authorizeUrl: string): Promise<URL>;
  stop(): Promise<void>;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function s256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  user: TestUser;
}

export interface MockIssuerOptions {
  user?: Partial<TestUser>;
  /** A fixed port, to bring an issuer back where a stopped one was. */
  port?: number;
  clientId?: string;
  clientSecret?: string;
}

export async function startMockIssuer(opts: MockIssuerOptions = {}): Promise<MockIssuer> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const clientId = opts.clientId ?? `platehouse-test-${randomBytes(4).toString("hex")}`;
  const clientSecret = opts.clientSecret ?? randomBytes(24).toString("base64url");
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, TestUser>();
  const sockets = new Set<Socket>();

  const server = http.createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(opts.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const issuer: MockIssuer = {
    url,
    clientId,
    clientSecret,
    user: {
      sub: `user-${randomBytes(4).toString("hex")}`,
      email: "jon@example.test",
      email_verified: true,
      groups: [TEST_GROUP, "other"],
      ...opts.user,
    },
    authorizeRequests: [],
    tokenRequests: [],
    discoveries: 0,
    async authorize(authorizeUrl) {
      const target = new URL(authorizeUrl);
      if (`${target.origin}` !== url || target.pathname !== "/authorize") {
        throw new Error(`not this issuer's authorize endpoint: ${target.origin}${target.pathname}`);
      }
      const q = target.searchParams;
      issuer.authorizeRequests.push(new URLSearchParams(q));
      const need = (name: string) => {
        const value = q.get(name);
        if (value === null || value === "") throw new Error(`authorize request has no ${name}`);
        return value;
      };
      if (need("response_type") !== "code") throw new Error("response_type is not code");
      if (need("client_id") !== clientId) throw new Error("unknown client_id");
      if (need("code_challenge_method") !== "S256") throw new Error("PKCE is not S256");
      const redirectUri = need("redirect_uri");
      const code = randomBytes(16).toString("base64url");
      codes.set(code, {
        clientId,
        redirectUri,
        challenge: need("code_challenge"),
        nonce: need("nonce"),
        user: { ...issuer.user },
      });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", need("state"));
      return back;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  async function idToken(code: IssuedCode): Promise<string> {
    const { user } = code;
    const forge = user.forge ?? {};
    const claims: Record<string, unknown> = { nonce: forge.nonce ?? code.nonce };
    if (user.email !== undefined) claims.email = user.email;
    if (user.claimsInIdToken !== false) {
      if (user.email_verified !== undefined) claims.email_verified = user.email_verified;
      if (user.groups !== undefined) claims.groups = user.groups;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = forge.expiredSecondsAgo;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(forge.iss ?? url)
      .setSubject(user.sub)
      .setAudience(forge.aud ?? clientId)
      .setIssuedAt(expired === undefined ? nowSeconds : nowSeconds - expired - 300)
      .setExpirationTime(expired === undefined ? nowSeconds + 300 : nowSeconds - expired)
      .sign(privateKey);
  }

  server.on("request", (req, res) => {
    const path = new URL(req.url ?? "/", url).pathname;
    void (async () => {
      if (req.method === "GET" && path === "/.well-known/openid-configuration") {
        issuer.discoveries += 1;
        return json(res, 200, {
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          userinfo_endpoint: `${url}/userinfo`,
          jwks_uri: `${url}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          scopes_supported: ["openid", "email", "profile", "groups"],
        });
      }
      if (req.method === "GET" && path === "/jwks") return json(res, 200, { keys: [jwk] });
      if (req.method === "POST" && path === "/token") {
        const form = new URLSearchParams(await readBody(req));
        let auth: TokenRequest["auth"];
        let id: string | null;
        let secret: string | null;
        const header = req.headers.authorization;
        if (header?.startsWith("Basic ")) {
          auth = "basic";
          const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
          const colon = decoded.indexOf(":");
          id = decodeURIComponent(decoded.slice(0, colon));
          secret = decodeURIComponent(decoded.slice(colon + 1));
        } else {
          auth = "post";
          id = form.get("client_id");
          secret = form.get("client_secret");
        }
        if (id !== clientId || secret !== clientSecret) {
          return json(res, 401, { error: "invalid_client" });
        }
        issuer.tokenRequests.push({ form, auth });
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (
          form.get("grant_type") !== "authorization_code" ||
          code === undefined ||
          code.redirectUri !== form.get("redirect_uri") ||
          s256(form.get("code_verifier") ?? "") !== code.challenge
        ) {
          return json(res, 400, { error: "invalid_grant" });
        }
        const accessToken = randomBytes(24).toString("base64url");
        accessTokens.set(accessToken, code.user);
        return json(res, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid email profile groups",
          id_token: await idToken(code),
        });
      }
      if (req.method === "GET" && path === "/userinfo") {
        const header = req.headers.authorization ?? "";
        const u = accessTokens.get(header.replace(/^Bearer /, ""));
        if (u === undefined) return json(res, 401, { error: "invalid_token" });
        const body: Record<string, unknown> = { sub: u.forge?.userinfoSub ?? u.sub };
        if (u.email !== undefined) body.email = u.email;
        if (u.email_verified !== undefined) body.email_verified = u.email_verified;
        if (u.groups !== undefined) body.groups = u.groups;
        return json(res, 200, body);
      }
      return json(res, 404, { error: "not_found" });
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: "server_error" });
      else res.destroy();
    });
  });

  return issuer;
}

/** A clock the test moves by hand. */
export interface TestClock {
  now: Date;
  advance(ms: number): void;
}

export function testClock(start = new Date()): TestClock {
  const clock: TestClock = {
    now: start,
    advance(ms) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  return clock;
}

/** Sessions kept in a Map, with the same expiry rules as the sessions table query. */
export interface MemoryStore extends SessionStore {
  readonly rows: Map<string, Session>;
  /** How many times get() was called. */
  gets: number;
  /** When set, every call fails with this error, as a database that is down would. */
  failWith?: Error;
}

export function memorySessionStore(): MemoryStore {
  const rows = new Map<string, Session>();
  const store: MemoryStore = {
    rows,
    gets: 0,
    async create(input) {
      if (store.failWith) throw store.failWith;
      const row: Session = { ...input, createdAt: new Date() };
      rows.set(input.id, row);
      return row;
    },
    async get(id, now) {
      store.gets += 1;
      if (store.failWith) throw store.failWith;
      const row = rows.get(id);
      if (row === undefined || row.expiresAt <= now || row.idleExpiresAt <= now) return undefined;
      return { ...row };
    },
    async delete(id) {
      if (store.failWith) throw store.failWith;
      return rows.delete(id);
    },
    async touch(id, idleExpiresAt) {
      if (store.failWith) throw store.failWith;
      const row = rows.get(id);
      if (row !== undefined) rows.set(id, { ...row, idleExpiresAt });
    },
  };
  return store;
}

export interface TestAuth {
  auth: AppAuth;
  issuer: MockIssuer;
  oidc: OidcClient;
  sessions: Sessions;
  store: MemoryStore;
  clock: TestClock;
}

/**
 * The auth dependencies buildApp takes, against a mock issuer (or, with
 * issuerUrl, any issuer URL, such as one nothing listens on), with sessions
 * in memory and a test clock.
 */
export async function testAuth(
  opts: {
    issuer?: MockIssuer;
    issuerUrl?: string;
    store?: SessionStore & Partial<MemoryStore>;
  } = {},
): Promise<TestAuth> {
  const issuer = opts.issuer ?? (await startMockIssuer());
  const clock = testClock();
  const store = (opts.store ?? memorySessionStore()) as MemoryStore;
  const oidc = createOidc({
    issuer: opts.issuerUrl ?? issuer.url,
    clientId: issuer.clientId,
    clientSecret: issuer.clientSecret,
    redirectUri: `${TEST_ORIGIN}/auth/callback`,
    group: TEST_GROUP,
    discovery: { execute: [allowInsecureRequests] },
  });
  const sessions = createSessions({ store, now: () => clock.now });
  const auth: AppAuth = {
    oidc,
    sessions,
    publicOrigin: TEST_ORIGIN,
    absoluteUrl: (path) => `${TEST_ORIGIN}${path}`,
    group: TEST_GROUP,
    cookieSecret: loginCookieKey(randomBytes(32).toString("hex")),
    now: () => clock.now,
  };
  return { auth, issuer, oidc, sessions, store, clock };
}

export interface AuthTestApp extends TestAuth {
  app: FastifyInstance;
  /** The upload store's temp folder. */
  dir: string;
  /** Closes the app and the issuer, and deletes the temp folder. */
  close(): Promise<void>;
}

/**
 * buildApp with these auth dependencies, a healthy database and queues, and
 * a real upload store in a temp folder whose queue records nothing. Ready,
 * not listening. beforeReady runs on the app before it is made ready, so a
 * test can register a route of its own (never shipped code).
 */
export async function authTestApp(
  opts: Parameters<typeof testAuth>[0] & {
    beforeReady?: (app: FastifyInstance) => void | Promise<void>;
  } = {},
): Promise<AuthTestApp> {
  const t = await testAuth(opts);
  const dir = await mkdtemp(join(tmpdir(), "platehouse-auth-"));
  const app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: dir,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: t.auth,
  });
  await opts.beforeReady?.(app);
  await app.ready();
  return {
    ...t,
    app,
    dir,
    async close() {
      await app.close();
      await t.issuer.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A response from app.inject. */
type Injected = LightMyRequestResponse;

export interface LoginRun {
  /** GET /auth/login's answer. */
  start: Injected;
  /** The login cookie it set (signed value), if any. */
  loginCookie: string | undefined;
  /** That cookie's name, which carries the login's state. */
  loginCookieName: string | undefined;
  /** Where the issuer sent the browser back. */
  callbackUrl: URL;
  /** GET /auth/callback's answer. */
  callback: Injected;
  /** The session cookie the callback set, if any. */
  sessionCookie: string | undefined;
}

/**
 * A whole login through the app and the mock issuer, as a browser makes it:
 * GET /auth/login, the issuer's authorize endpoint, GET /auth/callback with
 * the login cookie. headers go on both app requests; beforeCallback runs
 * between the issuer and the callback (to move the clock or stop the issuer).
 */
export async function runLogin(
  t: Pick<AuthTestApp, "app" | "issuer">,
  opts: {
    headers?: Record<string, string>;
    beforeCallback?: (callbackUrl: URL) => Promise<void> | void;
  } = {},
): Promise<LoginRun> {
  const headers = opts.headers ?? {};
  const start = await t.app.inject({ method: "GET", url: "/auth/login", headers });
  const location = start.headers.location;
  if (start.statusCode !== 302 || typeof location !== "string") {
    throw new Error(`GET /auth/login answered ${start.statusCode}, not a redirect`);
  }
  const login = loginCookieOf(start);
  const loginCookie = login?.value;
  const loginCookieName = login?.name;
  const callbackUrl = await t.issuer.authorize(location);
  await opts.beforeCallback?.(callbackUrl);
  const callback = await t.app.inject({
    method: "GET",
    url: `${callbackUrl.pathname}${callbackUrl.search}`,
    headers,
    cookies:
      loginCookie === undefined || loginCookieName === undefined
        ? {}
        : { [loginCookieName]: loginCookie },
  });
  return {
    start,
    loginCookie,
    loginCookieName,
    callbackUrl,
    callback,
    sessionCookie: setCookie(callback, SESSION_COOKIE)?.value,
  };
}

/** One Set-Cookie header, parsed. Attribute names are lowercase. */
export interface SetCookie {
  raw: string;
  name: string;
  value: string;
  attributes: Map<string, string | true>;
}

/** Every Set-Cookie header of a response (inject or node:http). */
export function setCookies(res: { headers: Record<string, unknown> }): SetCookie[] {
  const header = res.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
  return lines.map((raw: string) => {
    const [pair = "", ...rest] = raw.split(";");
    const eq = pair.indexOf("=");
    const attributes = new Map<string, string | true>();
    for (const part of rest) {
      const at = part.indexOf("=");
      const key = (at === -1 ? part : part.slice(0, at)).trim().toLowerCase();
      if (key !== "") attributes.set(key, at === -1 ? true : part.slice(at + 1).trim());
    }
    return { raw, name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes };
  });
}

/** The Set-Cookie header for one cookie name, if the response set it. */
export function setCookie(
  res: { headers: Record<string, unknown> },
  name: string,
): SetCookie | undefined {
  return setCookies(res).find((c) => c.name === name);
}

/** The login cookie a response set or cleared (its name carries the state), if any. */
export function loginCookieOf(res: { headers: Record<string, unknown> }): SetCookie | undefined {
  return setCookies(res).find((c) => c.name.startsWith(LOGIN_COOKIE_PREFIX));
}

/** A route of the app as app.printRoutes() lists it: its full path and its methods. */
export interface RouteEntry {
  path: string;
  methods: string[];
}

/**
 * Every route the app has, read from app.printRoutes(): the tree's segments
 * are joined back into full paths, and each node that lists methods is a
 * route. The app must be ready.
 */
export function registeredRoutes(app: FastifyInstance): RouteEntry[] {
  // The tree's connectors, spelled by code point to keep this file ASCII:
  // U+251C or U+2514, then two U+2500 and a space.
  const dashes = `${String.fromCharCode(0x2500, 0x2500)} `;
  const connectors = [String.fromCharCode(0x251c), String.fromCharCode(0x2514)].map(
    (corner) => `${corner}${dashes}`,
  );
  const routes: RouteEntry[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes().split("\n")) {
    const at = Math.max(...connectors.map((c) => line.indexOf(c)));
    if (at === -1) continue;
    const depth = at / 4;
    const node = line.slice(at + 4);
    const methods = /^(.*) \(([A-Z, ]+)\)$/.exec(node);
    stack.length = depth;
    stack.push(methods?.[1] ?? node);
    if (methods?.[2] !== undefined) {
      routes.push({ path: stack.join(""), methods: methods[2].split(", ") });
    }
  }
  return routes;
}

/** A request path for a route path: every :param becomes a UUID, * becomes x. */
export function concretePath(path: string): string {
  return path
    .replace(/:[A-Za-z0-9_]+/g, "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f")
    .replace(/\*/g, "x");
}
