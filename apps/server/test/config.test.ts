import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const ORIGIN = "https://platehouse.local.jonco.dev";

// Synthetic values only. Each private value is joined from parts so that no
// single source line looks like a credential.
const fakeS3 = ["synthetic", "s3", "value", "never", "printed"].join("-");
const fakeOidc = ["synthetic", "oidc", "client", "value"].join("-");
const fakeLink = ["synthetic", "link", "value", "longer", "than", "32", "bytes"].join("-");
const fakeDb = ["synthetic", "db", "pass"].join("-");
const DATABASE_URL = ["postgres://platehouse:", fakeDb, "@db:5432/platehouse"].join("");
const PRIVATE_VALUES = [fakeS3, fakeOidc, fakeLink, fakeDb];

const REQUIRED_KEYS = [
  "PUBLIC_ORIGIN",
  "DATABASE_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "LINK_SECRET",
] as const;

function validEnv(): NodeJS.ProcessEnv {
  const pairs: Array<[string, string]> = [
    ["PUBLIC_ORIGIN", ORIGIN],
    ["DATABASE_URL", DATABASE_URL],
    ["S3_ENDPOINT", "http://minio-synthetic:9000"],
    ["S3_REGION", "eu-synthetic-1"],
    ["S3_BUCKET", "platehouse-synthetic-bucket"],
    ["S3_ACCESS_KEY_ID", ["SYNTHETIC", "ACCESS", "ID"].join("")],
    ["S3_SECRET_ACCESS_KEY", fakeS3],
    ["S3_FORCE_PATH_STYLE", "true"],
    ["OIDC_CLIENT_ID", "platehouse-synthetic-client"],
    ["OIDC_CLIENT_SECRET", fakeOidc],
    ["LINK_SECRET", fakeLink],
  ];
  return Object.fromEntries(pairs);
}

function withValue(env: NodeJS.ProcessEnv, key: string, value: string): NodeJS.ProcessEnv {
  return { ...env, [key]: value };
}

function without(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[key];
  return copy;
}

function configErrorOf(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("loadConfig did not throw");
}

// Every way the error can reach a log: its message, its stack, util.inspect
// (what console.log and pino's err serializer walk) and JSON.
function everyRendering(err: ConfigError): string {
  return [err.message, String(err.stack), inspect(err, { depth: 10 }), JSON.stringify(err)].join(
    "\n",
  );
}

// Values short enough to occur in ordinary words ("true", "1") are not
// distinctive, so the never-echoed checks use values of 5 characters or more.
function distinctiveValues(env: NodeJS.ProcessEnv): string[] {
  return Object.values(env).filter((v): v is string => typeof v === "string" && v.length >= 5);
}

describe("loadConfig", () => {
  it("config rejects a missing PUBLIC_ORIGIN", () => {
    const env = without(validEnv(), "PUBLIC_ORIGIN");
    const err = configErrorOf(env);
    expect(err.message).toContain("PUBLIC_ORIGIN");
    const text = everyRendering(err);
    for (const value of distinctiveValues(env)) {
      expect(text).not.toContain(value);
    }
  });

  it("absoluteUrl ignores request host", () => {
    const config = loadConfig(validEnv());
    expect(config.absoluteUrl("/auth/callback")).toBe(
      "https://platehouse.local.jonco.dev/auth/callback",
    );
  });

  it("config error never prints a secret", () => {
    const env = without(validEnv(), "DATABASE_URL");
    expect(env.S3_SECRET_ACCESS_KEY).toBe(fakeS3);
    const err = configErrorOf(env);
    expect(err.message).toContain("DATABASE_URL");
    const text = everyRendering(err);
    for (const value of PRIVATE_VALUES) {
      expect(text).not.toContain(value);
    }
  });

  it.each(REQUIRED_KEYS)("a missing %s is named and no value is printed", (key) => {
    const env = without(validEnv(), key);
    const err = configErrorOf(env);
    expect(err.keys).toEqual([key]);
    expect(err.message).toContain(`${key} is missing`);
    const text = everyRendering(err);
    for (const value of distinctiveValues(env)) {
      expect(text).not.toContain(value);
    }
  });

  it.each(REQUIRED_KEYS)("an empty %s counts as missing", (key) => {
    const err = configErrorOf(withValue(validEnv(), key, ""));
    expect(err.keys).toEqual([key]);
    expect(err.message).toContain(`${key} is missing`);
  });

  const invalid: Array<[key: string, value: string]> = [
    ["PUBLIC_ORIGIN", "not-a-url-at-all"],
    ["PUBLIC_ORIGIN", "http://platehouse.local.jonco.dev"],
    ["PUBLIC_ORIGIN", "https://platehouse.local.jonco.dev/app"],
    ["PUBLIC_ORIGIN", "https://platehouse.local.jonco.dev/?from=query"],
    ["PUBLIC_ORIGIN", "https://platehouse.local.jonco.dev/#fragment"],
    ["PUBLIC_ORIGIN", ["https://user:", fakeDb, "@platehouse.local.jonco.dev"].join("")],
    ["DATABASE_URL", ["mysql://platehouse:", fakeDb, "@db/platehouse"].join("")],
    ["DATABASE_URL", "not-a-database-url"],
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "3000abc"],
    ["PORT", "30.5"],
    ["S3_ENDPOINT", "minio-without-scheme"],
    ["S3_ENDPOINT", "ftp://minio-synthetic:9000"],
    ["S3_FORCE_PATH_STYLE", "maybe-later"],
    ["S3_FORCE_PATH_STYLE", "1"],
    ["OIDC_ISSUER", "http://id.local.jonco.dev"],
    ["OIDC_ISSUER", "issuer-without-scheme"],
    ["LINK_SECRET", "a".repeat(31)],
    ["LINK_SECRET", `${"é".repeat(15)}a`],
    ["SLICER_URL", "slicer:8080"],
    ["SLICER_CONCURRENCY", "0"],
    ["SLICER_CONCURRENCY", "1.5"],
    ["SLICE_PLATE_SECONDS", "0"],
    ["SLICE_PLATE_SECONDS", "two-minutes"],
    ["INBOX_SETTLE_SECONDS", "-15"],
    ["INBOX_DIR", "relative/inbox"],
    ["TMP_DIR", "relative/tmp"],
  ];

  it.each(invalid)("an invalid %s (%s) is named and never echoed", (key, value) => {
    const env = withValue(validEnv(), key, value);
    const err = configErrorOf(env);
    expect(err.keys).toEqual([key]);
    expect(err.message).toContain(key);
    const text = everyRendering(err);
    for (const v of distinctiveValues(env)) {
      expect(text).not.toContain(v);
    }
  });

  it("reports every problem at once, in contract order", () => {
    const env = withValue(
      withValue(without(validEnv(), "DATABASE_URL"), "PORT", "70000"),
      "LINK_SECRET",
      "a".repeat(10),
    );
    const err = configErrorOf(env);
    expect(err.keys).toEqual(["DATABASE_URL", "PORT", "LINK_SECRET"]);
  });

  it("applies the contract defaults when optional keys are unset", () => {
    const config = loadConfig(validEnv());
    expect(config.port).toBe(3000);
    expect(config.oidc.issuer).toBe("https://id.local.jonco.dev");
    expect(config.oidc.group).toBe("platehouse");
    expect(config.slicer.url).toBe("http://slicer:8080");
    expect(config.slicer.concurrency).toBe(1);
    expect(config.slicer.plateSeconds).toBe(120);
    expect(config.inbox.dir).toBe("/data/inbox");
    expect(config.inbox.settleSeconds).toBe(15);
    expect(config.tmpDir).toBe("/data/tmp");
  });

  it("an empty optional value takes the default", () => {
    const config = loadConfig(
      withValue(withValue(validEnv(), "OIDC_GROUP", ""), "SLICER_CONCURRENCY", ""),
    );
    expect(config.oidc.group).toBe("platehouse");
    expect(config.slicer.concurrency).toBe(1);
  });

  it("parses every key in the contract", () => {
    const config = loadConfig({
      ...validEnv(),
      PORT: "8080",
      S3_FORCE_PATH_STYLE: "false",
      OIDC_ISSUER: "https://id.synthetic.example",
      OIDC_GROUP: "printers",
      SLICER_URL: "http://slicer-synthetic:9090",
      SLICER_CONCURRENCY: "2",
      SLICE_PLATE_SECONDS: "300",
      INBOX_DIR: "/srv/inbox",
      TMP_DIR: "/srv/tmp",
      INBOX_SETTLE_SECONDS: "30",
    });
    expect(config.publicOrigin).toBe(ORIGIN);
    expect(config.databaseUrl).toBe(DATABASE_URL);
    expect(config.port).toBe(8080);
    expect(config.s3.endpoint).toBe("http://minio-synthetic:9000");
    expect(config.s3.region).toBe("eu-synthetic-1");
    expect(config.s3.bucket).toBe("platehouse-synthetic-bucket");
    expect(config.s3.accessKeyId).toBe("SYNTHETICACCESSID");
    expect(config.s3.secretAccessKey).toBe(fakeS3);
    expect(config.s3.forcePathStyle).toBe(false);
    expect(config.oidc.issuer).toBe("https://id.synthetic.example");
    expect(config.oidc.clientId).toBe("platehouse-synthetic-client");
    expect(config.oidc.clientSecret).toBe(fakeOidc);
    expect(config.oidc.group).toBe("printers");
    expect(config.linkSecret).toBe(fakeLink);
    expect(config.slicer.url).toBe("http://slicer-synthetic:9090");
    expect(config.slicer.concurrency).toBe(2);
    expect(config.slicer.plateSeconds).toBe(300);
    expect(config.inbox.dir).toBe("/srv/inbox");
    expect(config.inbox.settleSeconds).toBe(30);
    expect(config.tmpDir).toBe("/srv/tmp");
  });

  it("S3_FORCE_PATH_STYLE true parses as true", () => {
    expect(loadConfig(validEnv()).s3.forcePathStyle).toBe(true);
  });

  it("measures LINK_SECRET in bytes, not characters", () => {
    const config = loadConfig(withValue(validEnv(), "LINK_SECRET", "é".repeat(16)));
    expect(Buffer.byteLength(config.linkSecret, "utf8")).toBe(32);
  });

  it("a trailing slash on PUBLIC_ORIGIN is dropped", () => {
    const config = loadConfig(withValue(validEnv(), "PUBLIC_ORIGIN", `${ORIGIN}/`));
    expect(config.publicOrigin).toBe(ORIGIN);
    expect(config.absoluteUrl("/s/token/name.3mf")).toBe(`${ORIGIN}/s/token/name.3mf`);
  });

  it.each([
    "auth/callback",
    "//evil.example/auth/callback",
    "https://evil.example/auth/callback",
    "",
  ])("absoluteUrl refuses %j, which is not a path on the origin", (path) => {
    const config = loadConfig(validEnv());
    expect(() => config.absoluteUrl(path)).toThrow(TypeError);
  });

  it("the config cannot be changed after loading", () => {
    const config = loadConfig(validEnv());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.s3)).toBe(true);
  });
});
