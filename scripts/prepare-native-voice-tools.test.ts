import { describe, expect, it } from "vitest";
import {
  DARWIN_CPU_STUB,
  FFMPEG,
  FFMPEG_CONFIGURE,
  LIVEKIT,
  assertTarget,
  listedComponents,
  machoSigned,
  missingComponents,
  peImports,
  verifySource,
} from "./prepare-native-voice-tools.mjs";

describe("native voice tools publisher", () => {
  it("pins every download and builds ffmpeg without GPL or nonfree parts", () => {
    for (const source of [
      ...Object.values(LIVEKIT.releases),
      LIVEKIT.source,
      FFMPEG.source,
      FFMPEG.darwin,
    ]) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(FFMPEG_CONFIGURE).toEqual(
      expect.arrayContaining(["--disable-gpl", "--disable-nonfree"]),
    );
    expect(FFMPEG.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  });
  it("gives macOS LiveKit a cgo-free CPU reading for go-osstat", () => {
    expect(DARWIN_CPU_STUB).toMatch(
      /^\/\/go:build darwin && !cgo\n\npackage cpu\n/,
    );
    expect(DARWIN_CPU_STUB).toContain("func Get() (*Stats, error)");
    expect(DARWIN_CPU_STUB).not.toContain('import "C"');
  });
  it("rejects unknown targets and corrupt sources", () => {
    expect(assertTarget("win32-x64")).toBe("win32-x64");
    expect(() => assertTarget("linux-arm64")).toThrow("Unsupported");
    expect(() => verifySource(Buffer.from("x"), "0".repeat(64))).toThrow(
      "checksum mismatch",
    );
  });
  it("reads ffmpeg's component lists and names what the voice workers miss", () => {
    const encoders = [
      "Encoders:",
      " A..... = Audio",
      " ------",
      " A....D aac                  AAC (Advanced Audio Coding)",
      " A....D pcm_s16le            PCM signed 16-bit little-endian",
    ].join("\n");
    expect(listedComponents(encoders)).toEqual(new Set(["aac", "pcm_s16le"]));
    expect(listedComponents(" D  matroska,webm  Matroska").size).toBe(0);
    expect(
      listedComponents(
        "File formats:\n D. = Demuxing\n --\n D  matroska,webm  Matroska",
      ),
    ).toEqual(new Set(["matroska", "webm"]));
    expect(listedComponents("Bitstream filters:\nnoise\nsetts\n")).toEqual(
      new Set(["noise", "setts"]),
    );
    expect(missingComponents({ encoders })).toContain("decoders:opus");
    expect(missingComponents({ encoders })).not.toContain("encoders:aac");
  });
  it("tells a signed Mach-O from an unsigned one", () => {
    const macho = (command: number) => {
      const file = Buffer.alloc(48);
      file.writeUInt32LE(0xfeedfacf, 0);
      file.writeUInt32LE(1, 16);
      file.writeUInt32LE(command, 32);
      file.writeUInt32LE(16, 36);
      return file;
    };
    expect(machoSigned(macho(0x1d))).toBe(true);
    expect(machoSigned(macho(0x19))).toBe(false);
    expect(machoSigned(Buffer.from("MZ" + "\0".repeat(30)))).toBe(false);
  });
  it("lists the DLLs a Windows program imports", () => {
    // DOS header, PE header, PE32+ optional header with one section that
    // holds the import directory and its DLL name.
    const file = Buffer.alloc(0x400);
    file.write("MZ", 0);
    file.writeUInt32LE(0x40, 0x3c);
    file.writeUInt32LE(0x4550, 0x40);
    file.writeUInt16LE(1, 0x46);
    file.writeUInt16LE(240, 0x54);
    const optional = 0x58;
    file.writeUInt16LE(0x20b, optional);
    file.writeUInt32LE(0x1000, optional + 120);
    const section = optional + 240;
    file.writeUInt32LE(0x1000, section + 12);
    file.writeUInt32LE(0x200, section + 16);
    file.writeUInt32LE(0x200, section + 20);
    file.writeUInt32LE(0x1100, 0x200 + 12);
    file.write("libwinpthread-1.dll\0", 0x300, "latin1");
    expect(peImports(file)).toEqual(["libwinpthread-1.dll"]);
    expect(() => peImports(Buffer.alloc(0x100))).toThrow("Not a PE");
  });
});
