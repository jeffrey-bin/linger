import { expect, it } from "vitest";
import { extractDocumentImages, bundleDocumentImages } from "./index.js";

it("extracts duplicate reference-style images once, preserves code, and restores image bytes", async () => {
  const encoded = "R0lGODlh";
  const snapshot = {
    filePath: "report.md",
    content: Buffer.from(
      `![a][image]\n\n![b][image]\n\n[image]: data:image/gif;base64,${encoded}\n\n\`data:image/gif;base64,${encoded}\`\n`,
    ),
    sizeBytes: 0,
    sha256: "",
  };
  const result = extractDocumentImages(snapshot);
  expect(result.files.size).toBe(1);
  const markdown = Buffer.from(result.content).toString();
  expect(markdown).toContain("`data:image/gif;base64,R0lGODlh`");
  expect(markdown.match(/report.md.image-/gu)).toHaveLength(2);
  const bundled = await bundleDocumentImages(
    { ...snapshot, content: result.content },
    async (filePath) => {
      const content = result.files.get(filePath.slice(13))!;
      return { filePath, content, sizeBytes: content.length, sha256: "" };
    },
    new AbortController().signal,
  );
  expect(
    Buffer.from(bundled.content)
      .toString()
      .match(/data:image\/gif;base64,R0lGODlh/gu),
  ).toHaveLength(3);
});

it("bounds parallel image reads, deduplicates sources, and waits for in-flight reads on failure", async () => {
  const content = Buffer.from(
    Array.from({ length: 12 }, (_, i) => `![${i}](image-${i % 6}.gif)`).join(
      "\n",
    ),
  );
  let active = 0,
    maximum = 0,
    calls = 0;
  const snapshot = {
    filePath: "report.md",
    content,
    sizeBytes: content.length,
    sha256: "",
  };
  const read = async (filePath: string) => {
    active++;
    calls++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return {
      filePath,
      content: Buffer.from("GIF89a"),
      sizeBytes: 6,
      sha256: "",
    };
  };
  const result = await bundleDocumentImages(
    snapshot,
    read,
    new AbortController().signal,
  );
  expect(calls).toBe(6);
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(
    Buffer.from(result.content)
      .toString()
      .match(/data:image/g),
  ).toHaveLength(12);
  let started = 0;
  await expect(
    bundleDocumentImages(
      snapshot,
      async (p) => {
        if (++started === 2) throw new Error("read failed");
        return read(p);
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("read failed");
  expect(active).toBe(0);
});
