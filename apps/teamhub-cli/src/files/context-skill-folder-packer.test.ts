import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { fromBufferPromise } from "yauzl";
import { afterEach, describe, expect, it } from "vitest";

import { packContextSkillFolder } from "./context-skill-folder-packer.js";
import { computeSkillPackageSha256 } from "./skill-package.js";

const temporaryDirectories: string[] = [];
const execFilePromise = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Context Skill folder packer", () => {
  it("produces a canonical metadata-free ZIP and canonical package digest", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "review-agent",
        description: "  Reviews proposed changes  ",
        extra: [
          "license: MIT",
          "compatibility: Node.js",
          "metadata:",
          "  owner: platform",
          "allowed-tools: Bash",
        ],
      }),
      "references/checklist.md": "Check the diff.\n",
      "scripts/review.sh": "#!/bin/sh\necho review\n",
    });

    const packed = await packFixture(fixture);

    expect(packed).toMatchObject({
      packageName: "review-agent",
      description: "Reviews proposed changes",
      fileCount: 3,
    });
    expect(packed.totalBytes).toBe(
      Buffer.byteLength(fixture.files["SKILL.md"]!) +
        Buffer.byteLength(fixture.files["references/checklist.md"]!) +
        Buffer.byteLength(fixture.files["scripts/review.sh"]!),
    );
    expect(packed.archiveSha256).toBe(
      createHash("sha256").update(packed.archive).digest("hex"),
    );
    expect(packed.packageSha256).toBe(
      computeSkillPackageSha256(
        Object.entries(fixture.files).map(([filePath, content]) => ({
          path: filePath,
          content: Buffer.from(content),
        })),
      ),
    );

    const entries = await inspectArchive(packed.archive);
    expect(entries.map(({ path: entryPath }) => entryPath)).toEqual([
      "SKILL.md",
      "references/checklist.md",
      "scripts/review.sh",
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        mode: 0o100644,
        modified: [1980, 1, 1, 0, 0, 0],
        extraFieldCount: 0,
      });
      expect([0, 8]).toContain(entry.compressionMethod);
      expect(entry.uncompressedSize).toBeLessThanOrEqual(
        entry.compressedSize * 200,
      );
    }

    await expect(archiveText(packed.archive, "SKILL.md")).resolves.toBe(
      fixture.files["SKILL.md"],
    );
  });

  it("excludes private .simplexai metadata from the Skill package", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "sourced-skill",
        description: "Carries private source metadata",
      }),
      ".simplexai/meta-info.json": `${JSON.stringify({
        schema_version: 1,
        source: {
          kind: "skill_search",
          source_ref: "build_skill_source_1",
          result: { id: "github.com/acme/sourced-skill" },
        },
      })}\n`,
      "references/checklist.md": "# Checklist\n",
    });

    const packed = await packFixture(fixture);
    const packagedFiles = [
      { path: "SKILL.md", content: Buffer.from(fixture.files["SKILL.md"]!) },
      {
        path: "references/checklist.md",
        content: Buffer.from(fixture.files["references/checklist.md"]!),
      },
    ];

    expect(packed.fileCount).toBe(2);
    expect(packed.totalBytes).toBe(
      packagedFiles.reduce((total, file) => total + file.content.byteLength, 0),
    );
    expect(packed.packageSha256).toBe(computeSkillPackageSha256(packagedFiles));
    expect(
      (await inspectArchive(packed.archive)).map(
        ({ path: entryPath }) => entryPath,
      ),
    ).toEqual(["SKILL.md", "references/checklist.md"]);
  });

  it("is byte-identical across repeated runs and ignores host metadata", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "stable-skill",
        description: "Stable package",
      }),
      "z-last.txt": "last\n",
      "a-first.txt": "first\n",
    });
    const first = await packFixture(fixture);

    const firstPath = path.join(fixture.folderPath, "a-first.txt");
    await chmod(firstPath, 0o755);
    await utimes(firstPath, new Date(2035, 1, 2), new Date(2035, 1, 2));
    const second = await packFixture(fixture);

    expect(Buffer.from(second.archive).equals(Buffer.from(first.archive))).toBe(
      true,
    );
    expect(second.archiveSha256).toBe(first.archiveSha256);
    expect(second.packageSha256).toBe(first.packageSha256);
  });

  it("is byte-identical across process timezones", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "timezone-stable",
        description: "Stable in every timezone",
      }),
      "references/data.txt": "timezone-independent\n".repeat(20),
    });

    const utc = await packFixtureInTimezone(fixture, "UTC");
    const shanghai = await packFixtureInTimezone(fixture, "Asia/Shanghai");

    expect(shanghai).toEqual(utc);
  });

  it("stores highly compressible files to stay below the package ratio limit", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "ratio-safe",
        description: "Avoids suspicious compression ratios",
      }),
      "references/repeated.txt": "A".repeat(512 * 1024),
    });

    const packed = await packFixture(fixture);
    const repeated = (await inspectArchive(packed.archive)).find(
      ({ path: entryPath }) => entryPath === "references/repeated.txt",
    );
    expect(repeated).toMatchObject({
      compressionMethod: 0,
      compressedSize: 512 * 1024,
      uncompressedSize: 512 * 1024,
    });
  });

  it("keeps the 32 MiB expanded budget distinct from the 16 MiB archive budget", async () => {
    const payload = moderatelyCompressibleBytes(6 * 1024 * 1024);
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "compressed-assets",
        description: "Carries compressed assets",
      }),
      "assets/first.bin": payload,
      "assets/second.bin": payload,
      "assets/third.bin": payload,
    });

    const packed = await packFixture(fixture);

    expect(packed.totalBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(packed.archive.byteLength).toBeLessThan(16 * 1024 * 1024);
    const assets = (await inspectArchive(packed.archive)).filter(({ path }) =>
      path.startsWith("assets/"),
    );
    expect(assets).toHaveLength(3);
    for (const asset of assets) {
      expect(asset.compressionMethod).toBe(8);
      expect(asset.uncompressedSize).toBeLessThanOrEqual(
        asset.compressedSize * 200,
      );
    }
  }, 15_000);

  it("rejects unsafe folder paths before touching the filesystem", async () => {
    const rootPath = await makeTemporaryDirectory();
    const signal = new AbortController().signal;
    for (const folderPath of [
      "/skills/example",
      "../skills/example",
      "skills//example",
      "skills\\example",
      "skills/Cafe\u0301",
    ]) {
      await expect(
        packContextSkillFolder({
          playgroundRootPath: rootPath,
          folderPath,
          signal,
        }),
      ).rejects.toMatchObject({ code: "invalid_folder_path" });
    }
  });

  it("rejects root, intermediate, and nested symbolic links", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "no-links",
        description: "Rejects links",
      }),
    });
    const external = path.join(fixture.rootPath, "outside.txt");
    await writeFile(external, "outside");
    if (process.platform === "win32") {
      const fixtureRoot = process.env.LINGER_TEST_WINDOWS_FILE_LINKS;
      if (!fixtureRoot)
        throw new Error("LINGER_TEST_WINDOWS_FILE_LINKS is required");
      await rename(
        path.join(fixtureRoot, "standalone", "skill"),
        path.join(fixture.folderPath, "linked.txt"),
      );
    } else await symlink(external, path.join(fixture.folderPath, "linked.txt"));
    await expect(packFixture(fixture)).rejects.toMatchObject({
      code: "unsupported_entry_type",
    });

    await rm(path.join(fixture.folderPath, "linked.txt"));
    const realFolder = path.join(fixture.rootPath, "real-skill");
    await mkdir(realFolder);
    await writeFile(
      path.join(realFolder, "SKILL.md"),
      skillManifest({ name: "real-skill", description: "Real" }),
    );
    await symlink(
      realFolder,
      path.join(fixture.rootPath, "skill-link"),
      "junction",
    );
    await expect(
      packContextSkillFolder({
        playgroundRootPath: fixture.rootPath,
        folderPath: "skill-link",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "unsupported_entry_type" });

    const linkedRoot = path.join(fixture.parentPath, "playground-link");
    await symlink(fixture.rootPath, linkedRoot, "junction");
    await expect(
      packContextSkillFolder({
        playgroundRootPath: linkedRoot,
        folderPath: fixture.relativeFolderPath,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects hard links to files outside the selected folder", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "no-hard-links",
        description: "Rejects hard links",
      }),
    });
    const external = path.join(fixture.parentPath, "outside.txt");
    await writeFile(external, "outside");
    await link(external, path.join(fixture.folderPath, "linked.txt"));

    await expect(packFixture(fixture)).rejects.toMatchObject({
      code: "unsupported_entry_type",
    });
  });

  it.skipIf(process.platform === "win32")("rejects special files", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "regular-files",
        description: "Only regular files",
      }),
    });
    await execFilePromise("mkfifo", [
      path.join(fixture.folderPath, "runtime.pipe"),
    ]);

    await expect(packFixture(fixture)).rejects.toMatchObject({
      code: "unsupported_entry_type",
    });
  });

  it("rejects non-NFC and case-fold-colliding package paths", async () => {
    const nfdFixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "canonical-paths",
        description: "Canonical paths",
      }),
      "Cafe\u0301.txt": "nfd",
    });
    await expect(packFixture(nfdFixture)).rejects.toMatchObject({
      code: "invalid_entry_path",
    });

    const collisionFixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "no-collisions",
        description: "No collisions",
      }),
      "README.md": "upper",
    });
    try {
      await writeFile(
        path.join(collisionFixture.folderPath, "readme.md"),
        "lower",
        {
          flag: "wx",
        },
      );
    } catch (error) {
      if (fileSystemCode(error) === "EEXIST") {
        // The host filesystem already enforces this invariant.
        return;
      }
      throw error;
    }
    await expect(packFixture(collisionFixture)).rejects.toMatchObject({
      code: "duplicate_entry_path",
    });
  });

  it("requires valid UTF-8 strict frontmatter in root SKILL.md", async () => {
    const missing = await createFixture({
      "nested/SKILL.md": skillManifest({
        name: "nested-only",
        description: "Nested",
      }),
    });
    await expect(packFixture(missing)).rejects.toMatchObject({
      code: "missing_skill_manifest",
    });

    for (const manifest of [
      "# no frontmatter\n",
      skillManifest({
        name: "invalid-known-field",
        description: "Invalid known field",
        extra: ["license: [MIT]"],
      }),
      skillManifest({
        name: "навык",
        description: "No canonical package name",
      }),
    ]) {
      const fixture = await createFixture({ "SKILL.md": manifest });
      await expect(packFixture(fixture)).rejects.toMatchObject({
        code: "invalid_skill_manifest",
      });
    }

    const invalidUtf8 = await createFixture({
      "SKILL.md": Uint8Array.from([0xff, 0xfe, 0xfd]),
    });
    await expect(packFixture(invalidUtf8)).rejects.toMatchObject({
      code: "invalid_skill_manifest",
    });
  });

  it("preserves extension frontmatter and normalizes an upstream display name", async () => {
    const fixture = await createFixture({
      "SKILL.md": skillManifest({
        name: "BytesAgain Ecommerce SEO Optimizer",
        description: "Optimizes ecommerce SEO.",
        extra: [
          'version: "1.0.0"',
          'author: "BytesAgain"',
          'homepage: "https://bytesagain.com"',
          'source: "https://github.com/bytesagain/ai-skills"',
          'tags: ["ecommerce", "seo"]',
          'category: "ecommerce"',
          "metadata:",
          '  author: "BytesAgain"',
          "  hermes:",
          '    tags: ["marketing", "seo"]',
          '    category: "seo-geo"',
        ],
      }),
    });

    const packed = await packFixture(fixture);
    expect(packed).toMatchObject({
      packageName: "bytesagain-ecommerce-seo-optimizer",
      description: "Optimizes ecommerce SEO.",
    });

    const manifest = await archiveText(packed.archive, "SKILL.md");
    expect(manifest).toContain("name: bytesagain-ecommerce-seo-optimizer");
    expect(manifest).toContain('version: "1.0.0"');
    expect(manifest).toContain('author: "BytesAgain"');
    expect(manifest).toContain('tags: [ "ecommerce", "seo" ]');
    expect(manifest).toContain("hermes:");
    expect(manifest).toContain('category: "seo-geo"');
  });

  it("enforces entry, file, total, and archive limits", async () => {
    const manifest = skillManifest({
      name: "limited-skill",
      description: "Limited",
    });
    const fixture = await createFixture({
      "SKILL.md": manifest,
      "nested/data.txt": "12345",
    });
    const signal = new AbortController().signal;
    const base = {
      playgroundRootPath: fixture.rootPath,
      folderPath: fixture.relativeFolderPath,
      signal,
    };

    await expect(
      packContextSkillFolder({ ...base, limits: { maxEntries: 1 } }),
    ).rejects.toMatchObject({ code: "entry_count_exceeded" });
    await expect(
      packContextSkillFolder({ ...base, limits: { maxFiles: 1 } }),
    ).rejects.toMatchObject({ code: "entry_count_exceeded" });
    await expect(
      packContextSkillFolder({
        ...base,
        limits: { maxFileBytes: Buffer.byteLength(manifest) },
      }),
    ).resolves.toBeDefined();

    await writeFile(
      path.join(fixture.folderPath, "nested/data.txt"),
      "x".repeat(Buffer.byteLength(manifest) + 1),
    );
    await expect(
      packContextSkillFolder({
        ...base,
        limits: { maxFileBytes: Buffer.byteLength(manifest) },
      }),
    ).rejects.toMatchObject({ code: "entry_size_exceeded" });

    await writeFile(path.join(fixture.folderPath, "nested/data.txt"), "12345");
    await expect(
      packContextSkillFolder({
        ...base,
        limits: { maxTotalBytes: Buffer.byteLength(manifest) + 4 },
      }),
    ).rejects.toMatchObject({ code: "expanded_size_exceeded" });
    await expect(
      packContextSkillFolder({ ...base, limits: { maxArchiveBytes: 64 } }),
    ).rejects.toMatchObject({ code: "archive_size_exceeded" });
  });

  it("honors cancellation before filesystem work", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      packContextSkillFolder({
        playgroundRootPath: "/not/used",
        folderPath: "skills/example",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

type FixtureContent = string | Uint8Array;

interface SkillFixture {
  readonly parentPath: string;
  readonly rootPath: string;
  readonly relativeFolderPath: string;
  readonly folderPath: string;
  readonly files: Readonly<Record<string, string>>;
}

const createFixture = async (
  files: Readonly<Record<string, FixtureContent>>,
  relativeFolderPath = "skills/example",
): Promise<SkillFixture> => {
  const parentPath = await makeTemporaryDirectory();
  const rootPath = path.join(parentPath, "playground");
  const folderPath = path.join(rootPath, ...relativeFolderPath.split("/"));
  await mkdir(folderPath, { recursive: true });
  const textFiles: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(folderPath, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    if (typeof content === "string") textFiles[relativePath] = content;
  }
  return {
    parentPath,
    rootPath,
    relativeFolderPath,
    folderPath,
    files: textFiles,
  };
};

const packFixture = (fixture: SkillFixture) =>
  packContextSkillFolder({
    playgroundRootPath: fixture.rootPath,
    folderPath: fixture.relativeFolderPath,
    signal: new AbortController().signal,
  });

const skillManifest = (input: {
  readonly name: string;
  readonly description: string;
  readonly extra?: readonly string[];
}): string =>
  [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    ...(input.extra ?? []),
    "---",
    "",
    "# Instructions",
    "",
  ].join("\n");

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mirror-skill-pack-"));
  temporaryDirectories.push(directory);
  return directory;
};

const inspectArchive = async (
  archive: Uint8Array,
): Promise<
  Array<{
    path: string;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    mode: number;
    modified: number[];
    extraFieldCount: number;
  }>
> => {
  const zip = await fromBufferPromise(Buffer.from(archive), {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
  });
  const entries = [];
  try {
    for await (const entry of zip.eachEntry()) {
      const modified = entry.getLastModDate();
      entries.push({
        path: entry.fileName,
        compressionMethod: entry.compressionMethod,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        mode: (entry.externalFileAttributes >>> 16) & 0xffff,
        modified: [
          modified.getFullYear(),
          modified.getMonth() + 1,
          modified.getDate(),
          modified.getHours(),
          modified.getMinutes(),
          modified.getSeconds(),
        ],
        extraFieldCount: entry.extraFields.length,
      });
    }
  } finally {
    zip.close();
  }
  return entries;
};

const packFixtureInTimezone = async (
  fixture: SkillFixture,
  timezone: string,
): Promise<{
  readonly archive: string;
  readonly archiveSha256: string;
  readonly packageSha256: string;
}> => {
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dirname, "context-skill-folder-packer.ts"),
  ).href;
  const program = [
    `import { packContextSkillFolder } from ${JSON.stringify(moduleUrl)};`,
    `const packed = await packContextSkillFolder({ playgroundRootPath: ${JSON.stringify(fixture.rootPath)}, folderPath: ${JSON.stringify(fixture.relativeFolderPath)}, signal: new AbortController().signal });`,
    'process.stdout.write(JSON.stringify({ archive: Buffer.from(packed.archive).toString("base64"), archiveSha256: packed.archiveSha256, packageSha256: packed.packageSha256 }));',
  ].join("\n");
  const { stdout } = await execFilePromise(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program],
    {
      cwd: process.cwd(),
      env: { ...process.env, TZ: timezone },
    },
  );
  return JSON.parse(String(stdout)) as {
    readonly archive: string;
    readonly archiveSha256: string;
    readonly packageSha256: string;
  };
};

const moderatelyCompressibleBytes = (size: number): Uint8Array => {
  const output = Buffer.allocUnsafe(size);
  let state = 0x13579bdf;
  for (let offset = 0; offset < size; offset += 2) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = state & 0xff;
    output[offset] = value;
    if (offset + 1 < size) output[offset + 1] = value;
  }
  return output;
};

const fileSystemCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const archiveText = async (
  archive: Uint8Array,
  name: string,
): Promise<string> => {
  const zip = await fromBufferPromise(Buffer.from(archive), {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
  });
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== name) continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    }
  } finally {
    zip.close();
  }
  throw new Error(`The archive has no ${name}`);
};
