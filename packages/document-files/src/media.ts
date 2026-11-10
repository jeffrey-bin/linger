/** A bounded signature check prevents renamed PDFs and declared MIME spoofing. */
export function matchesMediaContent(
  bytes: Uint8Array,
  mediaType: string,
): boolean {
  const buffer = Buffer.from(bytes);
  const ascii = (start: number, end: number) =>
    buffer.subarray(start, end).toString("ascii");
  switch (mediaType) {
    case "image/jpeg":
      return (
        buffer.length >= 3 &&
        buffer[0] === 255 &&
        buffer[1] === 216 &&
        buffer[2] === 255
      );
    case "image/png":
      return (
        buffer.length >= 8 &&
        buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/bmp":
      return ascii(0, 2) === "BM";
    case "image/avif":
      return (
        ascii(4, 8) === "ftyp" &&
        ["avif", "avis"].some((brand) =>
          ascii(8, Math.min(buffer.length, 64)).includes(brand),
        )
      );
    case "video/mp4":
      return (
        ascii(4, 8) === "ftyp" &&
        /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |M4VH|M4VP|dash|MSNV|3gp[4-9])$/u.test(
          ascii(8, 12),
        )
      );
    case "video/quicktime":
      return (
        (ascii(4, 8) === "ftyp" && ascii(8, 12) === "qt  ") ||
        ["moov", "mdat", "wide", "free"].includes(ascii(4, 8))
      );
    case "video/webm":
      return (
        buffer.length >= 4 &&
        buffer[0] === 26 &&
        buffer[1] === 69 &&
        buffer[2] === 223 &&
        buffer[3] === 163 &&
        buffer.subarray(4, 4096).includes(Buffer.from("webm"))
      );
    case "video/ogg":
      return (
        ascii(0, 4) === "OggS" &&
        buffer.subarray(4, 4096).includes(Buffer.from("theora"))
      );
    default:
      return false;
  }
}
