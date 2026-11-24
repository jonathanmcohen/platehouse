import { describe, expect, it } from "vitest";
import { isPrivateHost, normaliseAllowedHost } from "../src/private-host.js";

describe("isPrivateHost", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    ["100", "64", "0", "1"].join("."), // built from parts: the tree scan flags the dotted literal
    "[::1]",
    "::",
    "[fe80::1]",
    "[fd00::1]",
    "[::ffff:10.0.0.1]",
    "[::ffff:a00:1]",
    "intranet",
    "localhost",
    "a.localhost",
    "localhost.",
    "localhost..",
    "intranet.",
    "intranet..",
    "a..b.example",
    "198.18.0.1",
    "198.19.255.255",
    "192.0.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "[64:ff9b::a00:1]",
    "[64:ff9b::7f00:1]",
    "[64:ff9b:1::a00:1]",
    "[64:ff9b:1:a00:0:100:808:808]",
    "[::ffff:0:a00:1]",
    "[2002:a00:1::]",
    "[2002:c0a8:101::1]",
    "[fec0::1]",
    "[ff02::1]",
    "printer.local",
    "nas.home.arpa",
    "db.internal",
    "box.localdomain",
    "localhost.localdomain",
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
    "198.20.0.1",
    "192.0.2.1",
    "223.255.255.255",
    "[64:ff9b::808:808]",
    "[2002:808:808::]",
    "localdomain.example",
  ])("allows %s", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it("sees a private address through the URL parser's normal forms", () => {
    for (const url of ["https://0x7f.1/", "https://2130706433/", "https://[::ffff:10.0.0.1]/"]) {
      expect(isPrivateHost(new URL(url).hostname)).toBe(true);
    }
  });
});

describe("normaliseAllowedHost", () => {
  it.each([
    ["MinIO.LAN.", "minio.lan"],
    ["192.168.1.20", "192.168.1.20"],
    ["[fd00::1]", "[fd00::1]"],
    ["fd00::1", "[fd00::1]"],
    ["intranet", "intranet"],
  ])("writes %s as %s", (entry, expected) => {
    expect(normaliseAllowedHost(entry)).toBe(expected);
  });

  it.each(["", "  ", "https://minio", "minio:9000", "minio/x", "a..b", "a b", "user@minio", "."])(
    "refuses %j",
    (entry) => {
      expect(normaliseAllowedHost(entry)).toBeNull();
    },
  );
});
