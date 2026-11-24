// The server listens on "::" so an IPv6-only Docker network reaches it, and
// the dual-stack socket still answers IPv4 (issue #473). Where the host has
// no IPv6, it falls back to 0.0.0.0 and says so.
import { describe, expect, test, vi } from "vitest";
import { listenOnAllInterfaces } from "../src/main.js";

function target(failFirstWith?: string) {
  const hosts: string[] = [];
  const warn = vi.fn();
  return {
    hosts,
    warn,
    app: {
      listen: async ({ host }: { port: number; host: string }) => {
        hosts.push(host);
        if (hosts.length === 1 && failFirstWith !== undefined) {
          throw Object.assign(new Error("listen failed"), { code: failFirstWith });
        }
        return "";
      },
      log: { warn },
    },
  };
}

describe("listenOnAllInterfaces", () => {
  test("listens on :: and does not fall back when it works", async () => {
    const t = target();
    await listenOnAllInterfaces(t.app, 3000);
    expect(t.hosts).toEqual(["::"]);
    expect(t.warn).not.toHaveBeenCalled();
  });

  test("falls back to 0.0.0.0 and logs it when IPv6 is not available", async () => {
    const t = target("EAFNOSUPPORT");
    await listenOnAllInterfaces(t.app, 3000);
    expect(t.hosts).toEqual(["::", "0.0.0.0"]);
    expect(t.warn).toHaveBeenCalledTimes(1);
  });

  test("any other listen failure is not retried", async () => {
    const t = target("EADDRINUSE");
    await expect(listenOnAllInterfaces(t.app, 3000)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(t.hosts).toEqual(["::"]);
  });
});
