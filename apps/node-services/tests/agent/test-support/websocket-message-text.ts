import type { RawData } from "ws";

/** Decodes a received WebSocket message payload as UTF-8 text. */
export const webSocketMessageText = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
};
