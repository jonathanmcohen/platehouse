// Reads one pixel from a PNG screenshot (build plan Task 22, the first-paint
// spec). Playwright's screenshots are 8-bit RGB or RGBA, non-interlaced; this
// decodes exactly that with node:zlib and refuses anything else, so a format
// it cannot read fails the spec instead of returning a wrong colour.
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** The pixel at (x, y) as "#rrggbb", lowercase. */
export function pixelAt(png: Buffer, x: number, y: number): string {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (x < 0 || y < 0 || x >= width || y >= height) throw new Error("pixel outside the image");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  for (let r = 0; r <= y; r += 1) {
    const start = r * (stride + 1);
    const filter = raw[start];
    row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? (row[i - channels] as number) : 0;
      const up = previous[i] as number;
      const upLeft = i >= channels ? (previous[i - channels] as number) : 0;
      const value = row[i] as number;
      if (filter === 1) row[i] = (value + left) & 0xff;
      else if (filter === 2) row[i] = (value + up) & 0xff;
      else if (filter === 3) row[i] = (value + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) row[i] = (value + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
    }
    previous = row;
  }
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const i = x * channels;
  return `#${hex(row[i] as number)}${hex(row[i + 1] as number)}${hex(row[i + 2] as number)}`;
}
