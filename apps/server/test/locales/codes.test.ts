// The codes the server sends beside its English sentences, so the web app
// can say them in its language (the maintainer, 2026-11-19): render messages split into
// Platehouse's own sentences and the program's words, inbox reason files
// with a stable code first, printer names in the shared English form, the
// login pages in the request's language, and the shell page's lang.
import fastifyCookie from "@fastify/cookie";
import { englishPrinterName, parsePrinterName } from "@platehouse/i18n";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerAuthRoutes } from "../../src/auth/routes.js";
import { loadConfig } from "../../src/config.js";
import {
  DERIVED_MESSAGES,
  DERIVED_SENTENCES,
  PREVIOUS_RENDERS_SENTENCE,
  splitDerivedMessage,
} from "../../src/derived/client.js";
import { OTHER_PRINTER_LABEL, printerName } from "../../src/estimates/display.js";
import {
  CHANGED_REASON,
  HELD_REASON,
  NON_UTF8_REASON,
  parseReasonFile,
  reasonCode,
  reasonFileText,
  repeatedErrorReason,
  STILL_WRITING_REASON,
  TOO_LARGE_REASON,
  tooLargeReason,
} from "../../src/inbox/watch.js";
import { UNSUPPORTED_MESSAGE } from "../../src/ingest/ingest.js";
import { createLocales } from "../../src/locales/locales.js";
import { parseShellTemplate } from "../../src/web/shell.js";

describe("splitDerivedMessage", () => {
  test.each(Object.entries(DERIVED_SENTENCES))(
    "gives back %s's sentence as its code",
    (code, text) => {
      expect(splitDerivedMessage(text)).toEqual({ codes: [code], detail: null });
    },
  );

  test("peels Platehouse's sentences off the front and keeps the program's words", () => {
    const openscad = 'ERROR: Parser error in file "[path]", line 3';
    expect(splitDerivedMessage(`${DERIVED_MESSAGES.previousRendersScad} ${openscad}`)).toEqual({
      codes: ["previousRendersScad"],
      detail: openscad,
    });
    expect(
      splitDerivedMessage(`${PREVIOUS_RENDERS_SENTENCE.scad} ${DERIVED_MESSAGES.slicerError}`),
    ).toEqual({ codes: ["previousScad", "slicerError"], detail: null });
  });

  test("gives no codes for a message that does not start with one of them", () => {
    expect(splitDerivedMessage("ERROR: something")).toEqual({
      codes: [],
      detail: "ERROR: something",
    });
    expect(splitDerivedMessage(`x${DERIVED_MESSAGES.slicerError}`).codes).toEqual([]);
  });
});

describe("inbox reason files", () => {
  test.each([
    [CHANGED_REASON, "changed"],
    [STILL_WRITING_REASON, "still_writing"],
    [HELD_REASON, "held"],
    [NON_UTF8_REASON, "non_utf8"],
    [TOO_LARGE_REASON, "too_large"],
    [tooLargeReason(1024), "too_large"],
    [repeatedErrorReason(new Error("boom")), "retries_exhausted"],
    [`${UNSUPPORTED_MESSAGE}.`, "unsupported_type"],
    ["Something else entirely.", "failed"],
  ])("%s is written with the code %s first", (reason, code) => {
    expect(reasonCode(reason)).toBe(code);
    expect(reasonFileText(reason)).toBe(`${code}: ${reason}\n`);
    expect(parseReasonFile(reasonFileText(reason))).toEqual({ code, reason: `${reason}\n` });
  });

  test("an older reason file with no code reads as its sentence", () => {
    expect(parseReasonFile("This file is not a supported file.\n")).toEqual({
      code: null,
      reason: "This file is not a supported file.\n",
    });
  });

  test("an explicit code wins over the words", () => {
    expect(reasonFileText("Refused 3.", "unsupported_type")).toBe("unsupported_type: Refused 3.\n");
  });
});

describe("printer names", () => {
  test("are written in the shared English form the web app reads back", () => {
    const name = printerName("Bambu Lab P1S 0.4 nozzle", []);
    expect(name).toBe(englishPrinterName("Bambu Lab P1S", 0.4));
    expect(parsePrinterName(name)).toEqual({ model: "Bambu Lab P1S", nozzle: 0.4 });
    expect(OTHER_PRINTER_LABEL).toBe("another printer");
  });
});

describe("LOCALES_DIR in the configuration", () => {
  const BASE = {
    PUBLIC_ORIGIN: "https://platehouse.test",
    DATABASE_URL: "postgres://db/x",
    S3_ENDPOINT: "http://s3",
    S3_REGION: "r",
    S3_BUCKET: "b",
    S3_ACCESS_KEY_ID: "k",
    S3_SECRET_ACCESS_KEY: "s",
    S3_FORCE_PATH_STYLE: "true",
    OIDC_ISSUER: "https://id.platehouse.test",
    OIDC_CLIENT_ID: "c",
    OIDC_CLIENT_SECRET: "s",
    LINK_SECRET: "x".repeat(32),
  };

  test("is optional: unset or empty means no folder", () => {
    expect(loadConfig(BASE).localesDir).toBeUndefined();
    expect(loadConfig({ ...BASE, LOCALES_DIR: "" }).localesDir).toBeUndefined();
    expect(loadConfig({ ...BASE, LOCALES_DIR: "/data/locales" }).localesDir).toBe("/data/locales");
  });

  test("refuses a relative path, naming the key and not the value", () => {
    expect(() => loadConfig({ ...BASE, LOCALES_DIR: "locales" })).toThrow(
      "LOCALES_DIR must be an absolute path",
    );
  });
});

describe("the shell page's lang", () => {
  const INDEX = '<html lang="en" data-theme="dark"><meta name="color-scheme" content="dark" />';

  test("is the resolved language, and English for anything that is not a locale code", () => {
    const template = parseShellTemplate(INDEX);
    expect(template.render(undefined, undefined, "fr")).toContain(
      '<html lang="fr" data-theme="dark"',
    );
    expect(template.render(undefined, undefined, "pt-br")).toContain('lang="pt-BR"');
    expect(template.render(undefined, undefined, '"><script>')).toContain('lang="en"');
    expect(template.render(undefined)).toContain('lang="en"');
  });

  test("is added when the template has none, and a second lang is refused", () => {
    expect(
      parseShellTemplate(
        '<html data-theme="dark"><meta name="color-scheme" content="dark">',
      ).render(undefined, undefined, "es"),
    ).toContain('<html lang="es" data-theme="dark"');
    expect(() =>
      parseShellTemplate(
        '<html lang="en" lang="fr" data-theme="dark"><meta name="color-scheme" content="dark">',
      ),
    ).toThrow();
  });
});

describe("the login pages", () => {
  async function page(headers: Record<string, string>): Promise<string> {
    const app = Fastify();
    try {
      await app.register(fastifyCookie);
      await registerAuthRoutes(app, {
        oidc: {
          begin: async () => {
            throw new Error("the issuer cannot be reached");
          },
          finish: async () => {
            throw new Error("not used");
          },
        },
        sessions: {
          start: async () => {
            throw new Error("not used");
          },
          find: async () => undefined,
          end: async () => {},
          endAllFor: async () => 0,
        },
        publicOrigin: "https://platehouse.test",
        absoluteUrl: (path) => `https://platehouse.test${path}`,
        group: "platehouse",
        locales: createLocales(),
      });
      return (await app.inject({ method: "GET", url: "/auth/login", headers })).body;
    } finally {
      await app.close();
    }
  }

  test("are English by default", async () => {
    const body = await page({});
    expect(body).toContain('<html lang="en">');
    expect(body).toContain("<h1>Login is unavailable right now</h1>");
  });

  test("follow the ph_lang cookie, then Accept-Language", async () => {
    expect(await page({ cookie: "ph_lang=fr" })).toContain('<html lang="fr">');
    const es = await page({ "accept-language": "es-ES,es;q=0.9" });
    expect(es).toContain('<html lang="es">');
    expect(es).toContain("Reintentar");
  });
});
