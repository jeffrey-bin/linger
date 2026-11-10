const pdfHeader = "%PDF-";
const escapedNewline = "\\n";

export function repairEscapedNewlinePdf(data: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(data);
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    return data;
  }
  if (!hasPrefix(bytes, pdfHeader) || bytes.includes(0x0a)) {
    return data;
  }

  const source = new TextDecoder("latin1").decode(bytes);
  if (!source.includes(escapedNewline)) {
    return data;
  }

  const repaired = new TextEncoder().encode(
    source.replaceAll(escapedNewline, "\n"),
  );
  return repaired.buffer.slice(
    repaired.byteOffset,
    repaired.byteOffset + repaired.byteLength,
  );
}

function hasPrefix(bytes: Uint8Array, prefix: string) {
  if (bytes.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}
