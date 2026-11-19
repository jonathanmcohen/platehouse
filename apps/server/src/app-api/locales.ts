// The languages the web app can show (Jon, 2026-11-19), session-class like
// every /app/api route:
//
//   GET /app/api/locales        {locales: ListedLocale[]}: every language,
//                               English first (locales/locales.ts)
//   GET /app/api/locales/:code  {code, messages}: a language's checked
//                               messages, or 404 for a language there is none
//
// The web app bundles the built-in catalogs itself and asks here for a
// language a self-hoster dropped into LOCALES_DIR, and for the list the
// Settings language menu shows.
import { canonicalLocale } from "@platehouse/i18n";
import type { FastifyInstance } from "fastify";
import type { Locales } from "../locales/locales.js";
import { appApiScope, refuse } from "./settings.js";

const CODE_PARAMS = {
  type: "object",
  properties: { code: { type: "string", maxLength: 20 } },
  required: ["code"],
} as const;

export async function registerLocalesApi(app: FastifyInstance, locales: Locales): Promise<void> {
  await appApiScope(app, (scope) => {
    scope.get("/locales", async () => ({ locales: await locales.list() }));

    scope.get<{ Params: { code: string } }>(
      "/locales/:code",
      { schema: { params: CODE_PARAMS } },
      async (request, reply) => {
        const code = canonicalLocale(request.params.code);
        const messages = code === undefined ? undefined : await locales.messages(code);
        if (code === undefined || messages === undefined) return refuse(reply, 404, "not_found");
        return { code, messages };
      },
    );
  });
}
