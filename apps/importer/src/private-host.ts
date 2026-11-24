// Whether a URL hostname names a machine on a private, loopback or link-local
// network, or a name that only resolves inside one. Used on the hostname the
// URL parser produced, so decimal, hex and octal IPv4 forms are already
// dotted quads and an IPv6 literal still has its brackets. Names are never
// looked up: a public-looking name that resolves to a private address is not
// caught here.
import { isIPv4, isIPv6 } from "node:net";

function privateV4(a: number, b: number, c = 1): boolean {
  return (
    (a === 192 && b === 0 && c === 0) ||
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast, reserved and broadcast
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** The eight 16-bit groups of an IPv6 literal, or null when it is not one. */
function groupsOf(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  // A trailing dotted quad stands for the last two groups.
  const tail = text.lastIndexOf(":");
  const quad = text.slice(tail + 1);
  if (quad.includes(".")) {
    if (!isIPv4(quad)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = quad.split(".").map(Number);
    text = `${text.slice(0, tail + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array<string>(fill).fill("0"), ...rest];
  const groups = parts.map((p) => Number.parseInt(p, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** A hostname as the URL parser writes it: lowercase, no trailing dots. */
function normalised(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/**
 * A host given to --allow-redirect-host, written as new URL would write a
 * hostname (lowercase, no trailing dots, IPv6 in brackets), or null when it
 * is not a bare host name or address.
 */
export function normaliseAllowedHost(entry: string): string | null {
  const text = entry.trim();
  if (text === "" || /[\s/?#@\\%]/.test(text)) return null;
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const literal = isIPv6(bare);
  if (!literal && /[:[\]]/.test(bare)) return null;
  try {
    const host = normalised(new URL(`https://${literal ? `[${bare}]` : bare}/`).hostname);
    return host === "" || host.split(".").some((label) => label === "") ? null : host;
  } catch {
    return null;
  }
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".home.arpa", ".internal", ".localdomain"];

export function isPrivateHost(hostname: string): boolean {
  const host = normalised(hostname);
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIPv4(bare)) {
    const [a = 0, b = 0, c = 0] = bare.split(".").map(Number);
    return privateV4(a, b, c);
  }
  if (isIPv6(bare)) {
    const g = groupsOf(bare);
    if (g === null) return true; // cannot read it, so do not follow it
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
    if (g.slice(0, 7).every((x) => x === 0) && (g7 === 0 || g7 === 1)) return true;
    if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
    if ((g0 & 0xfe00) === 0xfc00 || g0 >> 8 === 0xff) return true;
    const v4 = (hi: number, lo: number) => privateV4(hi >> 8, hi & 0xff, lo >> 8);
    const low = v4(g6, g7);
    // 2002::/16 (6to4) carries its IPv4 in the next 32 bits.
    if (g0 === 0x2002) return v4(g1, g2);
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible) and ::ffff:0:a.b.c.d.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
      if ((g4 === 0 && (g5 === 0xffff || g5 === 0)) || (g4 === 0xffff && g5 === 0)) return low;
    }
    // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64) carry it in the last 32 bits.
    if (
      g0 === 0x64 &&
      g1 === 0xff9b &&
      (g2 === 1 || (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0))
    )
      return low;
    return false;
  }
  if (host.split(".").some((label) => label === "")) return true;
  return (
    !host.includes(".") ||
    host === "localhost" ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}
