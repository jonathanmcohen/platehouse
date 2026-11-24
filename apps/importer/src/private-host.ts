// Whether a URL hostname names a machine on a private, loopback or link-local
// network, or a name that only resolves inside one. Used on the hostname the
// URL parser produced, so decimal, hex and octal IPv4 forms are already
// dotted quads and an IPv6 literal still has its brackets. Names are never
// looked up: a public-looking name that resolves to a private address is not
// caught here.
import { isIPv4, isIPv6 } from "node:net";

function privateV4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
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

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIPv4(bare)) {
    const [a = 0, b = 0] = bare.split(".").map(Number);
    return privateV4(a, b);
  }
  if (isIPv6(bare)) {
    const g = groupsOf(bare);
    if (g === null) return true; // cannot read it, so do not follow it
    const [g0 = 0] = g;
    if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;
    if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xfe00) === 0xfc00) return true;
    // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form.
    const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
    if (mapped) return privateV4((g[6] ?? 0) >> 8, (g[6] ?? 0) & 0xff);
    return false;
  }
  return !host.includes(".") || host === "localhost" || host.endsWith(".localhost");
}
