// @vitest-environment node

import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

import { afterEach, describe, expect, it, vi } from "vitest";

import viteConfig from "../../vite.config";

vi.mock("vite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vite")>()),
  loadEnv: vi.fn(() => ({})),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Vite build configuration", () => {
  it.each([
    ["office-preview-frame-doc", false],
    ["office-preview-frame-docx", false],
    ["office-preview-frame-ppt", false],
    ["office-preview-frame-pptx", false],
    ["office-preview-frame-xls", false],
    ["office-preview-frame-xlsx", false],

    ["office-preview-preflight-worker", true],
  ])(
    "builds %s with the intended renderer download boundary",
    async (entry, hasLazyChunks) => {
      const config = viteConfig({ command: "build", mode: "production" });
      const result = await build({
        configFile: false,
        root: fileURLToPath(new URL("../..", import.meta.url)),
        logLevel: "silent",
        worker: {
          ...config.worker,
          plugins: () => [
            ...(config.worker!.plugins!() as Plugin[]),
            {
              name: "assert-office-dependency-boundary",
              generateBundle() {
                const ids = [...this.getModuleIds()];
                if (entry === "office-preview-frame-pptx") {
                  expect(ids.some((id) => id.includes("/pptx-renderer/"))).toBe(
                    true,
                  );
                  for (const dependency of [
                    "docx-preview",
                    "mammoth",
                    "xlsx",
                    "@e965/xlsx",
                    "emf-converter",
                    "pdfjs-dist",
                  ])
                    expect(
                      ids.some((id) =>
                        id.includes(`/node_modules/${dependency}/`),
                      ),
                    ).toBe(false);
                }
                if (
                  entry === "office-preview-frame-docx" ||
                  entry === "office-preview-frame-xlsx"
                )
                  expect(ids.some((id) => id.includes("/pptx-renderer/"))).toBe(
                    false,
                  );
              },
            },
          ],
        },
        plugins: [
          {
            name: "worker-cache-test-entry",
            resolveId(id) {
              if (id === "worker-cache-test-entry") return `\0${id}`;
            },
            load(id) {
              if (id !== "\0worker-cache-test-entry") return;
              const entryPath = fileURLToPath(
                new URL(`../features/rooms/files/${entry}.ts`, import.meta.url),
              );
              return `import url from ${JSON.stringify(`${entryPath}?worker&url`)}; console.log(url);`;
            },
          },
        ],
        build: {
          write: false,
          minify: false,
          rolldownOptions: {
            input: "worker-cache-test-entry",
          },
        },
      });
      if (!("output" in result))
        throw new Error("Expected a single build output");
      // Worker chunks are emitted as assets by Vite. The frame must be executable
      // from srcdoc without fetching dependencies from its opaque origin.
      const scripts = result.output.filter(
        (output) => output.type === "asset" && output.fileName.endsWith(".js"),
      );
      expect(scripts.length > 1).toBe(hasLazyChunks);
      expect(scripts.some((script) => script.fileName.includes(entry))).toBe(
        true,
      );
    },
  );
});
