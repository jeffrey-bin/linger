import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { decodePng, renderTrayIcon, type TrayArtwork } from "./tray-icon.js";

const pixels = (png: Buffer): Buffer => {
  // Single IDAT written by encodePng: length at 33, data at 41.
  const length = png.readUInt32BE(33);
  return inflateSync(png.subarray(41, 41 + length));
};

const resource = (name: string): Buffer =>
  readFileSync(new URL(`../../resources/tray/${name}`, import.meta.url));
const artwork = (size: number): TrayArtwork => ({
  mark: resource(`mark-${size}.png`),
  tile: resource(`tile-${size}.png`),
});

describe("renderTrayIcon", () => {
  it("encodes a PNG at the requested size", () => {
    const png = renderTrayIcon({
      tone: "online",
      size: 32,
      template: true,
      artwork: artwork(32),
    });
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(32);
    expect(pixels(png)).toHaveLength(32 * (32 * 4 + 1));
  });

  it("draws a different image for every state and busy frame", () => {
    for (const template of [true, false]) {
      const images = new Set(
        [
          { tone: "online" as const },
          { tone: "offline" as const },
          { tone: "error" as const },
          { tone: "busy" as const, frame: 0 },
          { tone: "busy" as const, frame: 1 },
        ].map((spec) =>
          renderTrayIcon({
            ...spec,
            size: 16,
            template,
            artwork: artwork(16),
          }).toString("hex"),
        ),
      );
      expect(images.size).toBe(5);
    }
  });

  it("keeps template images monochrome and draws the L and dot", () => {
    const rows = pixels(
      renderTrayIcon({
        tone: "online",
        size: 16,
        template: true,
        artwork: artwork(16),
      }),
    );
    let opaque = 0;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const i = y * 65 + 1 + x * 4;
        expect(rows[i]! + rows[i + 1]! + rows[i + 2]!).toBe(0);
        if (rows[i + 3]! > 128) opaque += 1;
      }
    expect(opaque).toBeGreaterThan(40);
    // The app tile must not become a solid square in the macOS menu bar.
    expect(rows[2 * 65 + 1 + 7 * 4 + 3]).toBe(0);
    expect(rows[8 * 65 + 1 + 5 * 4 + 3]).toBeGreaterThan(128);
    expect(rows[7 * 65 + 1 + 9 * 4 + 3]).toBeGreaterThan(128);
  });

  it("shows the dark logo tile on other platforms", () => {
    const tile = decodePng(resource("tile-32.png"), 32);
    const rows = pixels(
      renderTrayIcon({
        tone: "online",
        size: 32,
        template: false,
        artwork: artwork(32),
      }),
    );
    // Top left is outside the rounded corner; the middle is the logo.
    expect(rows[1 + 3]).toBe(0);
    const i = 16 * 32 * 4 + 8 * 4;
    expect([
      ...rows.subarray(16 * 129 + 1 + 8 * 4, 16 * 129 + 1 + 8 * 4 + 4),
    ]).toEqual([...tile.subarray(i, i + 4)]);
  });
});

describe("decodePng", () => {
  it("reads the logo artwork and rejects another size", () => {
    expect(decodePng(resource("mark-16.png"), 16)).toHaveLength(16 * 16 * 4);
    expect(() => decodePng(resource("mark-16.png"), 32)).toThrow("32 px");
  });
});
