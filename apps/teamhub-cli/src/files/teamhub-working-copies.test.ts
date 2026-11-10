import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TeamHubFileError,
  TeamHubWorkingCopies,
  type TeamHubFileBackend,
  type TeamHubWorkspaceFiles,
} from "./teamhub-working-copies.js";
import { createHostTeamHubWorkingCopyStateFiles } from "./teamhub-workspace-files.js";

const sha = (content: Uint8Array) =>
  createHash("sha256").update(content).digest("hex");
const bytes = (text: string) => Buffer.from(text);
const recordName = `${sha(bytes("report.md"))}.json`;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "teamhub-copies-"));
  temporaryDirectories.push(root);
  const stateDirectory = path.join(root, ".teamhub", "files");
  const disk = new Map<string, Uint8Array>();
  const files: TeamHubWorkspaceFiles = {
    normalize: (value) => {
      if (value !== "/workspace/report.md")
        throw new TeamHubFileError("invalid_path", "outside workspace");
      return "report.md";
    },
    inspect: async (filePath) => {
      const content = disk.get(filePath);
      return content ? { sha256: sha(content) } : null;
    },
    read: async (filePath) => {
      const content = disk.get(filePath);
      return content ? { content, sha256: sha(content) } : null;
    },
    install: vi.fn(async (filePath, content, expectedSHA256) => {
      const current = disk.get(filePath);
      if ((current ? sha(current) : null) !== expectedSHA256) {
        throw new TeamHubFileError(
          "file_changed",
          "file changed during download",
        );
      }
      disk.set(filePath, Uint8Array.from(content));
    }),
  };
  let downloaded = {
    documentId: "doc-1",
    versionId: "version-1",
    name: "report.md",
    readOnly: false,
    content: bytes("first"),
    sha256: sha(bytes("first")),
  };
  const replace = vi.fn<TeamHubFileBackend["replace"]>(async (input) => ({
    documentId: input.documentId,
    versionId: "replaced-version",
    name: input.name,
    sha256: input.sha256,
    readOnly: true,
    format: input.format,
    unchanged: false,
  }));
  const backend: TeamHubFileBackend = {
    download: vi.fn(async () => downloaded),
    replace,
  };
  const create = () =>
    new TeamHubWorkingCopies({
      stateFiles: createHostTeamHubWorkingCopyStateFiles({
        workspacePath: root,
        signal: new AbortController().signal,
      }),
      stateBinding: "test-context",
      integrityKey: "test-integrity-key-0000000000000000",
      files,
      backend,
    });
  return {
    stateDirectory,
    disk,
    files,
    backend,
    replace,
    create,
    download: (value: Partial<typeof downloaded>) => {
      downloaded = { ...downloaded, ...value };
    },
    /** Download the native Document body as HTML, the base docs replace needs. */
    getNative: async (targetPath = "/workspace/report.md") => {
      downloaded = { ...downloaded, readOnly: true };
      return create().get("doc-1", targetPath, "html");
    },
  };
}

describe("Host-owned TeamHub working copies", () => {
  it("requires the downloaded identity before replacing a body", async () => {
    const f = await fixture();
    await f.getNative();
    f.disk.set("report.md", bytes("<p>changed</p>"));
    await expect(
      f.create().replace("wrong-doc", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await f.create().replace("doc-1", "/workspace/report.md");
    expect(f.replace.mock.calls[0]![0]).toMatchObject({
      documentId: "doc-1",
      baseVersionId: "version-1",
      format: "html",
    });
  });
  it.each(["blocks", "html"] as const)(
    "leaves an unedited downloaded %s copy at its original revision without writing",
    async (format) => {
      const f = await fixture();
      const content = bytes(
        format === "html"
          ? "<p>Unchanged Café déjà vu ✅</p>"
          : JSON.stringify({
              schema_version: 1,
              blocks: [
                {
                  id: "existing",
                  type: "paragraph",
                  content: "Unchanged Café déjà vu ✅",
                },
              ],
            }),
      );
      f.download({ readOnly: true, content, sha256: sha(content) });
      const replacement = vi.fn<TeamHubFileBackend["replace"]>(
        async (input) => ({
          documentId: input.documentId,
          versionId: "unexpected-new-revision",
          historyEntryId: "unexpected-new-history",
          name: input.name,
          readOnly: true,
          sha256: input.sha256,
          unchanged: false,
        }),
      );
      f.backend.replace = replacement;
      const downloaded = await f
        .create()
        .get("doc-1", "/workspace/report.md", format);

      const result = await f.create().replace("doc-1", "/workspace/report.md");
      expect(result).toEqual({ ...downloaded, unchanged: true });
      expect(result).not.toHaveProperty("historyEntryId");
      expect(replacement).not.toHaveBeenCalled();
      expect(Buffer.from(f.disk.get("report.md")!)).toEqual(content);
    },
  );

  it("fills new block IDs into the working copy and keeps its base after a lost response", async () => {
    const f = await fixture();
    const read = f.files.read;
    f.files.read = async (p) => {
      const result = await read(p);
      return result && Object.freeze(result);
    };
    f.download({ readOnly: true });
    const replacement = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockImplementation(async (input) => ({
        documentId: input.documentId,
        versionId: "revision-2",
        name: "body.json",
        readOnly: true,
        sha256: input.sha256,
        unchanged: false,
        historyEntryId: "history-2",
      }));
    f.backend.replace = replacement;
    await f.create().get("doc-1", "/workspace/report.md", "blocks");
    f.disk.set(
      "report.md",
      bytes(
        JSON.stringify({
          schema_version: 1,
          blocks: [
            { id: "existing", type: "paragraph", content: "Edited" },
            { type: "paragraph", content: "New" },
          ],
        }),
      ),
    );
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toThrow("timeout");
    const filled = JSON.parse(Buffer.from(f.disk.get("report.md")!).toString());
    expect(filled.blocks[1].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(filled.blocks[0].id).toBe("existing");
    filled.blocks[1].content = "Later local edit";
    f.disk.set("report.md", bytes(JSON.stringify(filled)));
    // Nothing local replays the lost write: the retry is a new operation on
    // the same base, so TeamHub's CAS rejects it if the first one committed.
    await f.create().replace("doc-1", "/workspace/report.md");
    const [first, second] = replacement.mock.calls.map(([input]) => input);
    expect(second).toMatchObject({
      baseVersionId: "version-1",
      format: "blocks",
    });
    expect(second.operationId).not.toBe(first.operationId);
    expect(Buffer.from(second.content).toString()).toContain(
      "Later local edit",
    );
    expect(Buffer.from(f.disk.get("report.md")!).toString()).toContain(
      "Later local edit",
    );
  });

  it("uses digests instead of uploading body bytes for download checks", async () => {
    const f = await fixture();
    const read = vi.spyOn(f.files, "read");
    Object.assign(f.files, {
      inspect: async (p: string) => {
        const content = f.disk.get(p);
        return content ? { sha256: sha(content) } : null;
      },
    });
    await f.create().get("doc-1", "/workspace/report.md");
    await f.create().get("doc-1", "/workspace/report.md");
    expect(read).not.toHaveBeenCalled();
  });

  it("does not read extracted image bytes back from the Runner", async () => {
    const f = await fixture();
    const image = bytes("GIF89a-image");
    const content = bytes(
      `![image](data:image/gif;base64,${image.toString("base64")})`,
    );
    f.download({ content, sha256: sha(content) });
    const read = vi.spyOn(f.files, "read");
    Object.assign(f.files, {
      inspect: async (p: string) => {
        const value = f.disk.get(p);
        return value ? { sha256: sha(value) } : null;
      },
    });
    await f.create().get("doc-1", "/workspace/report.md");
    expect(read).not.toHaveBeenCalled();
  });

  it("allows another file to finish while a download is blocked", async () => {
    const f = await fixture();
    f.files.normalize = (p) => p.slice("/workspace/".length);
    f.download({ readOnly: true });
    let releaseSlow!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let enteredSlow!: () => void;
    const slowDownloadStarted = new Promise<void>((resolve) => {
      enteredSlow = resolve;
    });
    const original = f.backend.download;
    f.backend.download = async (name, format) => {
      if (name === "slow") {
        enteredSlow();
        await blocked;
      }
      return original(name, format);
    };
    const slow = f.create().get("slow", "/workspace/slow.html", "html");
    await slowDownloadStarted;
    try {
      await f.create().get("fast", "/workspace/fast.html", "html");
      expect(f.disk.has("fast.html")).toBe(true);
    } finally {
      releaseSlow();
      await slow;
    }
    // Both identities survive concurrent writes and a new Host instance.
    f.disk.set("slow.html", bytes("<p>slow edit</p>"));
    f.disk.set("fast.html", bytes("<p>fast edit</p>"));
    await f.create().replace("doc-1", "/workspace/slow.html");
    await f.create().replace("doc-1", "/workspace/fast.html");
    expect(f.replace).toHaveBeenCalledTimes(2);
    expect(f.replace.mock.calls.map(([input]) => input.documentId)).toEqual([
      "doc-1",
      "doc-1",
    ]);
  });

  it("keeps raw download bytes and leaves existing sidecar edits untouched", async () => {
    const f = await fixture();
    const image = bytes("GIF89a-original");
    const content = bytes(
      `![image](data:image/gif;base64,${image.toString("base64")})`,
    );
    f.download({ content, sha256: sha(content) });
    await f.create().get("doc-1", "/workspace/report.md", undefined, true);
    expect(Buffer.from(f.disk.get("report.md")!)).toEqual(content);
    expect(f.disk.size).toBe(1);
    const sidecar = `report.md.image-${sha(image)}.gif`;
    f.disk.set(sidecar, bytes("local image edit"));
    await expect(
      f.create().get("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "file_exists" });
    expect(f.disk.get(sidecar)).toEqual(bytes("local image edit"));
    expect(Buffer.from(f.disk.get("report.md")!)).toEqual(content);
  });
  it("downloads image-rich Markdown as compact text with image sidecars", async () => {
    const f = await fixture();
    const image = Buffer.from("89504e470d0a1a0a", "hex");
    const source = bytes(
      `# Report\n\n![chart](data:image/png;base64,${image.toString("base64")})\n`,
    );
    f.download({ content: source, sha256: sha(source) });
    await f.create().get("doc-1", "/workspace/report.md");
    const compact = Buffer.from(f.disk.get("report.md")!).toString();
    expect(compact).not.toContain("base64");
    expect(compact).toContain(".png");
    expect([...f.disk.values()].some((v) => Buffer.from(v).equals(image))).toBe(
      true,
    );
  });
  it("retains the server filename when a body is downloaded under another local name", async () => {
    const f = await fixture();
    f.download({ name: "original.txt" });
    await f.getNative();
    f.disk.set("report.md", bytes("<p>edited</p>"));
    await f.create().replace("doc-1", "/workspace/report.md");
    expect(f.replace.mock.calls[0]![0].name).toBe("original.txt");
  });
  it("keeps a downloaded base across Host restart and replaces with that exact base", async () => {
    const f = await fixture();
    await f.getNative();
    f.disk.set("report.md", bytes("<p>edited</p>"));
    await f.create().replace("doc-1", "/workspace/report.md");
    expect(f.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "doc-1",
        baseVersionId: "version-1",
        sha256: sha(bytes("<p>edited</p>")),
      }),
    );
    expect(
      await f.create().replace("doc-1", "/workspace/report.md"),
    ).toMatchObject({ versionId: "replaced-version", unchanged: true });
    expect(f.replace).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite dirty or untracked content", async () => {
    const f = await fixture();
    f.disk.set("report.md", bytes("local"));
    await expect(
      f.create().get("report.md", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "file_exists" });
    expect(f.disk.get("report.md")).toEqual(bytes("local"));
    f.disk.delete("report.md");
    await f.create().get("report.md", "/workspace/report.md");
    f.disk.set("report.md", bytes("dirty"));
    await expect(
      f.create().get("report.md", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "file_exists" });
    expect(f.disk.get("report.md")).toEqual(bytes("dirty"));
  });

  it("refreshes a clean working copy", async () => {
    const f = await fixture();
    await f.getNative();
    f.download({
      versionId: "version-2",
      content: bytes("second"),
      sha256: sha(bytes("second")),
    });
    await f.getNative();
    f.disk.set("report.md", bytes("<p>edit second</p>"));
    await f.create().replace("doc-1", "/workspace/report.md");
    expect(f.replace.mock.calls[0]![0].baseVersionId).toBe("version-2");
  });

  it("keeps the old base after an explicit server conflict", async () => {
    const f = await fixture();
    await f.getNative();
    f.disk.set("report.md", bytes("<p>edited</p>"));
    f.replace.mockRejectedValueOnce(
      new TeamHubFileError("version_conflict", "newer version", {
        currentVersionId: "version-2",
      }),
    );
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await f.create().replace("doc-1", "/workspace/report.md");
    expect(f.replace.mock.calls[1]![0].baseVersionId).toBe("version-1");
  });

  it("replays the same operation when an unchanged file is replaced again after a lost response", async () => {
    const f = await fixture();
    await f.getNative();
    f.disk.set("report.md", bytes("<p>edited</p>"));
    f.replace.mockRejectedValueOnce(
      new Error("connection reset after server commit"),
    );
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toThrow("connection reset");
    await f.create().replace("doc-1", "/workspace/report.md");
    // The ID comes from the Document, base, format and bytes, so TeamHub
    // returns the first commit instead of a version conflict.
    const [first, second] = f.replace.mock.calls.map(([input]) => input);
    expect(second!.operationId).toBe(first!.operationId);
    expect(first!.operationId).toMatch(/^docs-replace:[0-9a-f]{64}$/u);
  });

  it("starts a fresh operation after the backend rejected one with an HTTP 4xx", async () => {
    const f = await fixture();
    await f.getNative();
    f.disk.set("report.md", bytes("<p>original</p>"));
    f.replace.mockRejectedValueOnce(
      Object.assign(new Error("rejected"), {
        code: "invalid_input",
        details: { http_status: 400 },
      }),
    );
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toThrow("rejected");
    f.disk.set("report.md", bytes("<p>fixed</p>"));
    await f.create().replace("doc-1", "/workspace/report.md");
    expect(f.replace.mock.calls[1]![0].operationId).not.toBe(
      f.replace.mock.calls[0]![0].operationId,
    );
    expect(f.replace.mock.calls[1]![0].sha256).toBe(sha(bytes("<p>fixed</p>")));
  });

  it("keeps no local copy of a write whose response was lost", async () => {
    const f = await fixture();
    await f.getNative();
    f.disk.set("report.md", bytes("<p>original</p>"));
    f.replace.mockRejectedValueOnce(
      new Error("connection reset after server commit"),
    );
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toThrow("connection reset");
    expect(await readdir(path.join(f.stateDirectory))).toEqual([
      `${sha(bytes("report.md"))}.json`,
    ]);
    f.disk.set("report.md", bytes("<p>changed while offline</p>"));
    await f.create().replace("doc-1", "/workspace/report.md");
    expect(f.replace.mock.calls[1]![0]).toMatchObject({
      documentId: "doc-1",
      baseVersionId: "version-1",
      sha256: sha(bytes("<p>changed while offline</p>")),
    });
  });

  it("replaces only a native body downloaded as HTML or blocks", async () => {
    const f = await fixture();
    await f.create().get("report.md", "/workspace/report.md");
    f.disk.set("report.md", bytes("edited file"));
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    f.disk.delete("report.md");
    f.download({ readOnly: true });
    await f.create().get("report.md", "/workspace/report.md");
    f.disk.set("report.md", bytes("edited native Markdown"));
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.replace).not.toHaveBeenCalled();
  });

  it("fails closed when a working-copy record is corrupt and asks for a download when it is missing", async () => {
    const f = await fixture();
    await f.getNative();
    await writeFile(path.join(f.stateDirectory, recordName), "{broken");
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "state_unavailable" });
    await rm(path.join(f.stateDirectory, recordName));
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.replace).not.toHaveBeenCalled();
  });

  it("rejects metadata copied from another Context or modified without a new signature", async () => {
    const f = await fixture();
    await f.getNative();
    f.disk.set("report.md", bytes("<p>edited</p>"));
    const statePath = path.join(f.stateDirectory, recordName);
    const original = JSON.parse(await readFile(statePath, "utf8"));
    const stateFiles = createHostTeamHubWorkingCopyStateFiles({
      workspacePath: path.dirname(path.dirname(f.stateDirectory)),
      signal: new AbortController().signal,
    });
    const otherContext = new TeamHubWorkingCopies({
      stateFiles,
      stateBinding: "another-context",
      integrityKey: "test-integrity-key-0000000000000000",
      files: f.files,
      backend: f.backend,
    });
    await expect(
      otherContext.replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "state_unavailable" });

    original.base.versionId = "forged-version";
    await writeFile(statePath, JSON.stringify(original));
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "state_unavailable" });
    expect(f.replace).not.toHaveBeenCalled();
  });

  it("never installs a download whose content does not match its server digest", async () => {
    const f = await fixture();
    f.download({ sha256: "0".repeat(64) });
    await expect(
      f.create().get("report.md", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "content_mismatch" });
    expect(f.disk.size).toBe(0);
  });

  it("does not record a successful download when the installed file has different bytes", async () => {
    const f = await fixture();
    f.files.install = async (filePath) => {
      f.disk.set(filePath, bytes("concurrent edit"));
    };
    await expect(
      f.create().get("report.md", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "file_changed" });
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.replace).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a file whose download was interrupted before its base was recorded", async () => {
    const f = await fixture();
    f.download({ readOnly: true });
    const install = f.files.install;
    f.files.install = async (...args) => {
      await install(...args);
      throw new Error("interrupted after file install");
    };
    await expect(
      f.create().get("report.md", "/workspace/report.md", "html"),
    ).rejects.toThrow("interrupted");
    f.files.install = install;
    await expect(
      f.create().get("report.md", "/workspace/report.md", "html"),
    ).rejects.toMatchObject({ code: "file_exists" });
    await expect(
      f.create().replace("doc-1", "/workspace/report.md"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.replace).not.toHaveBeenCalled();
  });
});
