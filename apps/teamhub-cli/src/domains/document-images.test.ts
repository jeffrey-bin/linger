import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  prepareDocumentSource,
  bundleDocumentImages,
} from "@linger/document-files";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
const uri = `data:image/png;base64,${png}`;
function file(filePath: string, text: string | Uint8Array) {
  const content = typeof text === "string" ? Buffer.from(text) : text;
  return {
    filePath,
    content,
    sizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    mediaType: "text/markdown",
  };
}
describe("Document image preparation and publication", () => {
  it("keeps one compact document and restores exact image bytes without model copying Base64", async () => {
    const original = file(
      "./playground/source.md",
      `# Report\n\n![one](${uri})\n\n![two][same]\n\n[same]: ${uri}\n`,
    );
    const prepared = prepareDocumentSource(original);
    expect(prepared.image_count).toBe(2);
    expect(prepared.markdown).not.toContain(png);
    expect(prepared.markdown).toContain("document-image:");
    const reader = vi.fn(async () => original);
    const bundled = await bundleDocumentImages(
      file("./playground/result.md", prepared.markdown),
      reader,
      new AbortController().signal,
    );
    expect(Buffer.from(bundled.content).toString().split(uri)).toHaveLength(3);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(bundled.sha256).toBe(
      createHash("sha256").update(bundled.content).digest("hex"),
    );
  });
  it("bundles newly generated local image references but never fetches external URLs", async () => {
    const reader = vi.fn(async (filePath: string) =>
      file(filePath, Buffer.from(png, "base64")),
    );
    const result = await bundleDocumentImages(
      file(
        "./playground/report.md",
        "![a](images/a.png)\n\n![b](https://example.com/a.png)",
      ),
      reader,
      new AbortController().signal,
    );
    expect(Buffer.from(result.content).toString()).toContain(uri);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0]?.[0]).toBe("./playground/images/a.png");
  });
  it("bounds repeated image expansion before serialization", async () => {
    const bytes = Buffer.concat([
      Buffer.from(png, "base64"),
      Buffer.alloc(1024 * 1024),
    ]);
    const markdown = Array.from({ length: 40 }, () => "![a](large.png)").join(
      "\n\n",
    );
    await expect(
      bundleDocumentImages(
        file("./playground/a.md", markdown),
        async () => file("./playground/large.png", bytes),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it("preserves code examples and rejects bad encodings", () => {
    expect(
      prepareDocumentSource(file("./playground/a.md", `\`![example](${uri})\``))
        .image_count,
    ).toBe(0);
    expect(() =>
      prepareDocumentSource(
        file("./playground/a.md", "![a](data:image/png;base64,broken!)"),
      ),
    ).toThrow();
  });
  it("rejects changed sources, escaping paths and non-image bytes", async () => {
    const original = file("./playground/source.md", `![one](${uri})`);
    const prepared = prepareDocumentSource(original);
    await expect(
      bundleDocumentImages(
        file("./playground/a.md", prepared.markdown),
        async () => file(original.filePath, "changed"),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const reader = vi.fn(async () =>
      file("./playground/x.png", "not an image"),
    );
    await expect(
      bundleDocumentImages(
        file("./playground/a.md", "![a](../../secret.png)"),
        reader,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
    await expect(
      bundleDocumentImages(
        file("./playground/a.md", "![a](x.png)"),
        reader,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});
