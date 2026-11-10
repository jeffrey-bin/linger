import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareProductionAssets } from "../../build-assets.mjs";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Web production build assets", () => {
  it("measures the static initial JavaScript graph and emits compressed assets", async () => {
    const fixture = await createBuildFixture();

    const result = await prepareProductionAssets({
      budget: {
        brotliBytes: 10_000,
        gzipBytes: 10_000,
        minifiedBytes: 10_000,
      },
      root: fixture.root,
    });

    expect(result.initialJavaScript.files).toEqual([
      "assets/entry.js",
      "assets/runtime.js",
    ]);
    expect(result.initialJavaScript.minifiedBytes).toBe(
      fixture.entry.length + fixture.runtime.length,
    );
    expect(result.initialJavaScript.gzipBytes).toBeLessThan(
      result.initialJavaScript.minifiedBytes,
    );
    expect(result.initialJavaScript.brotliBytes).toBeLessThan(
      result.initialJavaScript.minifiedBytes,
    );

    await expectCompressedVariant(
      fixture.root,
      "assets/entry.js",
      fixture.entry,
    );
    await expectCompressedVariant(fixture.root, "assets/app.css", fixture.css);
    await expect(
      readFile(join(fixture.root, "brand", "logo.png.gz")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails when the production initial JavaScript graph exceeds its budget", async () => {
    const fixture = await createBuildFixture();

    await expect(
      prepareProductionAssets({
        budget: {
          brotliBytes: 10_000,
          gzipBytes: 10_000,
          minifiedBytes: fixture.entry.length + fixture.runtime.length - 1,
        },
        root: fixture.root,
      }),
    ).rejects.toThrow(/minified.*budget/i);
  });

  it("rejects a React development bundle in the production graph", async () => {
    const fixture = await createBuildFixture({
      entry:
        'console.warn("Each child in a list should have a unique key prop.");',
    });

    await expect(
      prepareProductionAssets({
        budget: {
          brotliBytes: 10_000,
          gzipBytes: 10_000,
          minifiedBytes: 10_000,
        },
        root: fixture.root,
      }),
    ).rejects.toThrow(/React development bundle/i);
  });

  it("rejects React development code in a lazy production chunk", async () => {
    const fixture = await createBuildFixture({
      dynamic:
        'console.warn("A React Element from an older version of React was rendered");',
    });

    await expect(
      prepareProductionAssets({
        budget: {
          brotliBytes: 10_000,
          gzipBytes: 10_000,
          minifiedBytes: 10_000,
        },
        root: fixture.root,
      }),
    ).rejects.toThrow(/React development bundle/i);
  });
});

async function createBuildFixture({
  dynamic,
  entry,
}: { dynamic?: string; entry?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "linger-web-build-"));
  fixtureRoots.push(root);
  await mkdir(join(root, ".vite"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "brand"), { recursive: true });

  const entryBytes = Buffer.from(entry ?? "const room = 'Linger';".repeat(80));
  const runtimeBytes = Buffer.from("const runtime = true;".repeat(40));
  const dynamicBytes = Buffer.from(
    dynamic ?? "const preview = 'lazy';".repeat(40),
  );
  const cssBytes = Buffer.from(".room{display:flex}".repeat(80));
  await Promise.all([
    writeFile(join(root, "index.html"), "<main>Linger</main>".repeat(40)),
    writeFile(join(root, "assets", "entry.js"), entryBytes),
    writeFile(join(root, "assets", "runtime.js"), runtimeBytes),
    writeFile(join(root, "assets", "dynamic.js"), dynamicBytes),
    writeFile(join(root, "assets", "app.css"), cssBytes),
    writeFile(join(root, "brand", "logo.png"), "not-compressible"),
    writeFile(
      join(root, ".vite", "manifest.json"),
      JSON.stringify({
        "_runtime.js": {
          file: "assets/runtime.js",
        },
        "index.html": {
          css: ["assets/app.css"],
          dynamicImports: ["src/lazy.tsx"],
          file: "assets/entry.js",
          imports: ["_runtime.js"],
          isEntry: true,
        },
        "src/lazy.tsx": {
          file: "assets/dynamic.js",
          isDynamicEntry: true,
        },
      }),
    ),
  ]);

  return {
    css: cssBytes,
    entry: entryBytes,
    root,
    runtime: runtimeBytes,
  };
}

async function expectCompressedVariant(
  root: string,
  relativePath: string,
  original: Buffer,
) {
  const [brotli, gzip] = await Promise.all([
    readFile(join(root, `${relativePath}.br`)),
    readFile(join(root, `${relativePath}.gz`)),
  ]);

  expect(brotliDecompressSync(brotli)).toEqual(original);
  expect(gunzipSync(gzip)).toEqual(original);
}
