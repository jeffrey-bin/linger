import { crc32, deflateSync, inflateSync } from "node:zlib";

import type { StatusTone } from "./status.js";

// Draws the tray icon for a status from the Linger logo at 16 and 32 px,
// so there are no binary assets per state. macOS gets a monochrome template
// image of the L and dot with a status badge cut into the corner. Other
// platforms get the logo on its dark tile, which reads on both light and dark
// panels, with a coloured status dot.

export interface TrayArtwork {
  // The black L and dot on transparency, exported for template rendering.
  readonly mark: Buffer;
  // The logo on its dark tile (apps/assets/logo/web favicon), as a PNG.
  readonly tile: Buffer;
}

export interface TrayIconSpec {
  readonly tone: StatusTone;
  readonly size: number;
  readonly template: boolean;
  readonly artwork: TrayArtwork;
  // Animation frame for the busy state.
  readonly frame?: number;
}

type Rgb = readonly [number, number, number];
type Shape = (x: number, y: number) => number; // signed distance, 16-unit grid

const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [0, 0, 0];
const DOT: Record<StatusTone, Rgb> = {
  online: [47, 158, 68],
  busy: [238, 110, 40],
  offline: [140, 140, 140],
  error: [217, 45, 32],
  setup: [140, 140, 140],
};

const roundedRect =
  (x0: number, y0: number, x1: number, y1: number, r: number): Shape =>
  (x, y) => {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const qx = Math.abs(x - cx) - (x1 - x0) / 2 + r;
    const qy = Math.abs(y - cy) - (y1 - y0) / 2 + r;
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0) -
      r
    );
  };
const circle =
  (cx: number, cy: number, r: number): Shape =>
  (x, y) =>
    Math.hypot(x - cx, y - cy) - r;
const union =
  (...shapes: Shape[]): Shape =>
  (x, y) =>
    Math.min(...shapes.map((s) => s(x, y)));

// The badge sits bottom right; the mark is cut away around it.
const BADGE_X = 12.6;
const BADGE_Y = 12.6;
const badgeClearance = circle(BADGE_X, BADGE_Y, 3.6);
const badge = (tone: StatusTone, frame: number): Shape | undefined => {
  if (tone === "busy")
    return circle(BADGE_X, BADGE_Y, [1.6, 2.1, 2.6][frame % 3]!);
  if (tone === "error") {
    const disc = circle(BADGE_X, BADGE_Y, 2.8);
    const mark = union(
      roundedRect(BADGE_X - 0.55, 10.7, BADGE_X + 0.55, 13.2, 0.4),
      circle(BADGE_X, 14.2, 0.6),
    );
    return (x, y) => Math.max(disc(x, y), -mark(x, y));
  }
  return undefined;
};

const coverage = (shape: Shape, px: number, py: number, k: number): number => {
  let inside = 0;
  for (let sy = 0; sy < 4; sy++)
    for (let sx = 0; sx < 4; sx++)
      if (shape((px + (sx + 0.5) / 4) * k, (py + (sy + 0.5) / 4) * k) <= 0)
        inside += 1;
  return inside / 16;
};

export const renderTrayIcon = (spec: TrayIconSpec): Buffer => {
  const { size, tone, template, artwork } = spec;
  const k = 16 / size;
  const rgba = Buffer.alloc(size * size * 4);
  const paint = (i: number, color: Rgb, alpha: number): void => {
    if (alpha <= 0) return;
    const under = rgba[i + 3]! / 255;
    const out = alpha + under * (1 - alpha);
    for (let c = 0; c < 3; c++)
      rgba[i + c] = Math.round(
        (color[c]! * alpha + rgba[i + c]! * under * (1 - alpha)) / out,
      );
    rgba[i + 3] = Math.round(out * 255);
  };

  if (template) {
    // Template images carry state in shape and alpha only.
    const mark = decodePng(artwork.mark, size);
    const status = badge(tone, spec.frame ?? 0);
    const alpha = tone === "offline" || tone === "setup" ? 0.45 : 1;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const cut = status ? 1 - coverage(badgeClearance, x, y, k) : 1;
        paint(i, INK, (mark[i + 3]! / 255) * cut * alpha);
        if (status) paint(i, INK, coverage(status, x, y, k));
      }
    return encodePng(size, rgba);
  }

  // The logo tile with rounded corners; the dot colour carries the state.
  const tile = decodePng(artwork.tile, size);
  const corners = roundedRect(0, 0, 16, 16, 3);
  const dotRing = circle(12.8, 12.8, 3.5);
  const dotRadius =
    tone === "busy" ? [1.9, 2.3, 2.7][(spec.frame ?? 0) % 3]! : 2.6;
  const dot = circle(12.8, 12.8, dotRadius);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const color: Rgb = [tile[i]!, tile[i + 1]!, tile[i + 2]!];
      paint(i, color, (tile[i + 3]! / 255) * coverage(corners, x, y, k));
      paint(i, WHITE, coverage(dotRing, x, y, k));
      paint(i, DOT[tone], coverage(dot, x, y, k));
    }
  return encodePng(size, rgba);
};

// Reads the 8-bit RGBA, non-interlaced PNGs the logo export writes.
export const decodePng = (png: Buffer, size: number): Buffer => {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== size || height !== size || png[24] !== 8 || png[25] !== 6)
    throw new Error(`Tray artwork must be a ${size} px 8-bit RGBA PNG.`);
  if (png[28] !== 0) throw new Error("Tray artwork must not be interlaced.");
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT")
      data.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const rows = inflateSync(Buffer.concat(data));
  const stride = size * 4;
  const out = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const filter = rows[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const raw = rows[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predicted = [
        0,
        a,
        b,
        (a + b) >> 1,
        pa <= pb && pa <= pc ? a : pb <= pc ? b : c,
      ][filter];
      if (predicted === undefined)
        throw new Error(`Unknown PNG filter ${filter}.`);
      out[y * stride + x] = (raw + predicted) & 0xff;
    }
  }
  return out;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

export const encodePng = (size: number, rgba: Buffer): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
