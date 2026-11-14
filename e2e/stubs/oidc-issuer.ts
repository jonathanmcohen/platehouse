// A mock OpenID Connect issuer for the end-to-end stack (build plan Task 22),
// standing in for Pocket ID. It answers discovery, an authorize endpoint
// that signs in one fixed test user at once (as Pocket ID does for a browser
// already signed in to it), a token endpoint that checks the client, the
// redirect_uri and the PKCE verifier, the JWKS and userinfo. ID tokens are
// RS256, signed with a key made at start. Plain node:crypto and node:http, so
// it needs no package.
//
// It listens over plain HTTP on 8080 inside the compose network; Traefik
// serves it as https://id.e2e.test, the issuer identifier, so the app talks
// to it over TLS like it talks to Pocket ID. The client secret comes from
// the run's env file; the user and the key are made here and are throwaway.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const ISSUER = need("ISSUER");
const CLIENT_ID = need("CLIENT_ID");
const CLIENT_SECRET = need("CLIENT_SECRET");
const REDIRECT_URI = need("REDIRECT_URI");
const PORT = 8080;

/** The one user this issuer signs in: in the platehouse group, email verified. */
const USER = {
  sub: "e2e-user",
  email: "e2e@example.test",
  email_verified: true,
  groups: ["platehouse"],
};

const { privateKey: pem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const privateKey = createPrivateKey(pem);
const kid = randomBytes(8).toString("hex");
const jwk = {
  ...createPublicKey(privateKey).export({ format: "jwk" }),
  kid,
  alg: "RS256",
  use: "sig",
};

interface Code {
  redirectUri: string;
  challenge: string;
  nonce: string;
  expires: number;
}

const codes = new Map<string, Code>();
const accessTokens = new Map<string, number>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function idToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const claims = b64url(
    JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, nonce, ...USER }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The client from Basic auth or the form, as client_secret_basic or _post sends it. */
function clientOf(req: IncomingMessage, form: URLSearchParams): { id: string; secret: string } {
  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  }
  return { id: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" };
}

function authorize(url: URL, res: ServerResponse): void {
  const q = url.searchParams;
  const redirectUri = q.get("redirect_uri") ?? "";
  const ok =
    q.get("response_type") === "code" &&
    q.get("client_id") === CLIENT_ID &&
    redirectUri === REDIRECT_URI &&
    q.get("code_challenge_method") === "S256" &&
    (q.get("code_challenge") ?? "") !== "" &&
    (q.get("state") ?? "") !== "" &&
    (q.get("nonce") ?? "") !== "" &&
    (q.get("scope") ?? "").split(" ").includes("openid");
  if (!ok) {
    // A malformed request is shown as an error page, never redirected.
    json(res, 400, { error: "invalid_request" });
    return;
  }
  const code = randomBytes(16).toString("base64url");
  codes.set(code, {
    redirectUri,
    challenge: q.get("code_challenge") ?? "",
    nonce: q.get("nonce") ?? "",
    expires: Date.now() + 60_000,
  });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", q.get("state") ?? "");
  res.writeHead(302, { location: back.href, "cache-control": "no-store" });
  res.end();
}

async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = new URLSearchParams(await readBody(req));
  const client = clientOf(req, form);
  if (!same(client.id, CLIENT_ID) || !same(client.secret, CLIENT_SECRET)) {
    return json(res, 401, { error: "invalid_client" });
  }
  const key = form.get("code") ?? "";
  const code = codes.get(key);
  codes.delete(key);
  const verifier = form.get("code_verifier") ?? "";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  if (
    form.get("grant_type") !== "authorization_code" ||
    code === undefined ||
    code.expires < Date.now() ||
    code.redirectUri !== form.get("redirect_uri") ||
    challenge !== code.challenge
  ) {
    return json(res, 400, { error: "invalid_grant" });
  }
  const accessToken = randomBytes(24).toString("base64url");
  accessTokens.set(accessToken, Date.now() + 300_000);
  return json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 300,
    scope: "openid email profile groups",
    id_token: idToken(code.nonce),
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  void (async () => {
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        scopes_supported: ["openid", "email", "profile", "groups"],
      });
    }
    if (req.method === "GET" && url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (req.method === "GET" && url.pathname === "/authorize") return authorize(url, res);
    if (req.method === "POST" && url.pathname === "/token") return token(req, res);
    if (req.method === "GET" && url.pathname === "/userinfo") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const expires = accessTokens.get(bearer);
      if (expires === undefined || expires < Date.now()) {
        return json(res, 401, { error: "invalid_token" });
      }
      return json(res, 200, USER);
    }
    return json(res, 404, { error: "not_found" });
  })().catch(() => {
    if (!res.headersSent) json(res, 500, { error: "server_error" });
    else res.destroy();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.info(`mock issuer: ${ISSUER} on ${PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
