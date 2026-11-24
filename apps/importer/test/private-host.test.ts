import { describe, expect, it } from "vitest";
import { isPrivateHost } from "../src/private-host.js";

describe("isPrivateHost", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "[::1]",
    "::",
    "[fe80::1]",
    "[fd00::1]",
    "[::ffff:10.0.0.1]",
    "[::ffff:a00:1]",
    "intranet",
    "localhost",
    "a.localhost",
  ])("refuses %s", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "172.32.0.1",
    "objects.example.test",
    "[2001:db8::1]",
    "s3.amazonaws.com",
    "[::ffff:8.8.8.8]",
  ])("allows %s", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it("sees a private address through the URL parser's normal forms", () => {
    for (const url of ["https://0x7f.1/", "https://2130706433/", "https://[::ffff:10.0.0.1]/"]) {
      expect(isPrivateHost(new URL(url).hostname)).toBe(true);
    }
  });
});
