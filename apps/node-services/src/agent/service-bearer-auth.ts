import { createHash, timingSafeEqual } from "node:crypto";

export const hasBearerToken = (
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean => {
  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader ?? "");
  if (!match?.[1] || expectedToken.length === 0) {
    return false;
  }
  return timingSafeEqual(digest(match[1]), digest(expectedToken));
};

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();
