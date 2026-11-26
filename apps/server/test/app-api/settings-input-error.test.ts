// The app API's error answer for RangeError (issue #473): only a named user
// mistake (SettingsInputError) answers 400 with its message; any other
// RangeError (an int overflow, "Invalid time value") is a logged 500 that
// does not echo the message.
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerOrganiseApi } from "../../src/app-api/organise.js";
import { SettingsInputError } from "../../src/app-api/settings.js";

const ID = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";

async function appThrowing(error: Error) {
  const server = Fastify({ logger: false });
  await registerOrganiseApi(server, {
    db: {} as never,
    trash: {
      restoreModel: async () => {
        throw error;
      },
      trashModel: async () => false,
      requestPurge: async () => 0,
    } as never,
    boss: {} as never,
  });
  await server.ready();
  return server;
}

describe("the app API error handler", () => {
  test("answers a SettingsInputError with 400 and its message", async () => {
    const server = await appThrowing(new SettingsInputError("A tag name must not be empty"));
    const res = await server.inject({ method: "POST", url: `/app/api/trash/${ID}/restore` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request", message: "A tag name must not be empty" });
  });

  test("answers any other RangeError with 500 and no message", async () => {
    const server = await appThrowing(new RangeError("Invalid time value"));
    const res = await server.inject({ method: "POST", url: `/app/api/trash/${ID}/restore` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(res.body).not.toContain("Invalid time value");
  });

  test("a SettingsInputError is still a RangeError, for callers that catch that", () => {
    expect(new SettingsInputError("x")).toBeInstanceOf(RangeError);
    expect(new SettingsInputError("x").name).toBe("SettingsInputError");
  });
});
