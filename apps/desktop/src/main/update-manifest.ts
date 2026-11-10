import { createPublicKey, verify } from "node:crypto";

import { z } from "zod";

// The update feed lives on the deployment's own server:
// <server>/install/desktop/<channel>/manifest.json plus manifest.json.sig,
// an Ed25519 signature over the exact manifest bytes. Package files sit next
// to the manifest.
export const FEED_PATH = "install/desktop/stable/";
export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.json.sig";

// Preview release key. The private half never leaves the release machine.
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA985QJ8UAvzK0ZLPW6YPaIkiCS2A+qPbEaZvi0aAccR4=
-----END PUBLIC KEY-----`;

const VERSION = /^\d+\.\d+\.\d+$/;

const updatePackage = z.object({
  // A bare file name: the package always comes from the feed directory.
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
});
export type UpdatePackage = z.infer<typeof updatePackage>;

const updateManifest = z.object({
  schema: z.literal(1),
  version: z.string().regex(VERSION),
  // Keyed by `${platform}-${arch}`, e.g. darwin-arm64.
  packages: z.record(z.string(), updatePackage),
});
export type UpdateManifest = z.infer<typeof updateManifest>;

export class ManifestError extends Error {}

// Returns the manifest only when the signature matches the built-in key.
export const verifyManifest = (
  bytes: Buffer,
  signature: string,
  publicKey: string = UPDATE_PUBLIC_KEY,
): UpdateManifest => {
  const valid = verify(
    null,
    bytes,
    createPublicKey(publicKey),
    Buffer.from(signature.trim(), "base64"),
  );
  if (!valid) throw new ManifestError("Update signature does not match");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ManifestError("Update manifest is not JSON");
  }
  const parsed = updateManifest.safeParse(json);
  if (!parsed.success) throw new ManifestError("Update manifest is invalid");
  return parsed.data;
};

// Positive when a is newer than b. Both are plain x.y.z versions.
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const packageFor = (
  manifest: UpdateManifest,
  platform: string,
  arch: string,
): UpdatePackage | undefined => manifest.packages[`${platform}-${arch}`];
