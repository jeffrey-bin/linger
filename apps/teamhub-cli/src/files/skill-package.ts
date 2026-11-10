import { createHash } from "node:crypto";

export interface CanonicalSkillPackageFile {
  readonly path: string;
  readonly content: Uint8Array;
}

const PACKAGE_DIGEST_VERSION = "teamhub.skill-package.v1\0";

/** Computes the content identity persisted by TeamHub, independent of ZIP bytes. */
export const computeSkillPackageSha256 = (
  source: readonly CanonicalSkillPackageFile[],
): string => {
  const paths = new Set<string>();
  const files = source.map((file) => {
    if (
      !isSafeRelativePath(file.path, 1_024) ||
      file.path.endsWith("/") ||
      file.path !== file.path.normalize("NFC")
    ) {
      throw new TypeError(`Skill Package file path "${file.path}" is invalid`);
    }
    if (paths.has(file.path)) {
      throw new TypeError(`Duplicate Skill Package file path "${file.path}"`);
    }
    if (!(file.content instanceof Uint8Array)) {
      throw new TypeError(
        `Skill Package file "${file.path}" has invalid content`,
      );
    }
    paths.add(file.path);
    return { path: file.path, content: Uint8Array.from(file.content) };
  });
  files.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    ),
  );

  const digest = createHash("sha256");
  digest.update(PACKAGE_DIGEST_VERSION, "utf8");
  for (const file of files) {
    const encodedPath = Buffer.from(file.path, "utf8");
    digest.update(encodeUint64(encodedPath.byteLength));
    digest.update(encodedPath);
    digest.update(encodeUint64(file.content.byteLength));
    digest.update(createHash("sha256").update(file.content).digest());
  }
  return digest.digest("hex");
};

const encodeUint64 = (value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Skill Package length is outside the supported range");
  }
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
};

const isSafeRelativePath = (
  entryPath: string,
  maxPathBytes = Number.POSITIVE_INFINITY,
): boolean => {
  if (
    entryPath.length === 0 ||
    Buffer.byteLength(entryPath) > maxPathBytes ||
    entryPath.includes("\0") ||
    entryPath.includes("\\") ||
    entryPath.startsWith("/") ||
    /^[A-Za-z]:/.test(entryPath)
  ) {
    return false;
  }
  const normalized = entryPath.replace(/\/$/, "");
  return (
    normalized.length > 0 &&
    normalized
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
};
