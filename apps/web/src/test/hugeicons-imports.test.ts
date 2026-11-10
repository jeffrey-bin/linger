import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readHugeiconsFiles,
  rewriteHugeiconsImports,
} from "../../vitest.hugeicons-imports";

const files = new Map([
  ["Braces", "/icons/FirstBracketIcon.js"],
  ["Brackets", "/icons/FirstBracketIcon.js"],
  ["FirstBracketIcon", "/icons/FirstBracketIcon.js"],
  ["Cancel01Icon", "/icons/Cancel01Icon.js"],
]);

const PACKAGE = "@hugeicons/core-free-icons";

describe("rewriteHugeiconsImports", () => {
  it("rewrites each name in a single-line import to its own default import", () => {
    expect(
      rewriteHugeiconsImports(
        `import { Braces, Cancel01Icon } from "${PACKAGE}";`,
        files,
      ),
    ).toBe(
      `import Braces from "/icons/FirstBracketIcon.js";import Cancel01Icon from "/icons/Cancel01Icon.js";`,
    );
  });

  it("uses the local name for aliased specifiers", () => {
    expect(
      rewriteHugeiconsImports(
        `import { Braces as B } from "${PACKAGE}";`,
        files,
      ),
    ).toBe(`import B from "/icons/FirstBracketIcon.js";`);
  });

  it("keeps the newline count of multi-line imports so later lines stay put", () => {
    const code = [
      "import {",
      "  Braces,",
      "  Cancel01Icon,",
      `} from "${PACKAGE}";`,
      "const line5 = 5;",
      "",
    ].join("\n");
    const result = rewriteHugeiconsImports(code, files)!;

    expect(result.split("\n").length).toBe(code.split("\n").length);
    expect(result.split("\n")[4]).toBe("const line5 = 5;");
    expect(result).toContain(
      `import Braces from "/icons/FirstBracketIcon.js";`,
    );
    expect(result).toContain(
      `import Cancel01Icon from "/icons/Cancel01Icon.js";`,
    );
  });

  it("handles single quotes and a missing semicolon", () => {
    expect(
      rewriteHugeiconsImports(`import { Braces } from '${PACKAGE}'`, files),
    ).toBe(`import Braces from "/icons/FirstBracketIcon.js";`);
  });

  it("throws a named error for an unknown icon", () => {
    expect(() =>
      rewriteHugeiconsImports(
        `import { NoSuchIcon } from "${PACKAGE}";`,
        files,
      ),
    ).toThrow(/NoSuchIcon/);
  });

  it("returns undefined when the code does not import the package", () => {
    expect(rewriteHugeiconsImports(`const x = 1;`, files)).toBeUndefined();
    expect(
      rewriteHugeiconsImports(
        `import { Braces } from "@hugeicons/react";`,
        files,
      ),
    ).toBeUndefined();
  });

  it("leaves imports from other packages untouched alongside a rewritten one", () => {
    const code = [
      `import { HugeiconsIcon } from "@hugeicons/react";`,
      `import { useState } from "react";`,
      `import { Braces } from "${PACKAGE}";`,
    ].join("\n");
    expect(rewriteHugeiconsImports(code, files)).toBe(
      [
        `import { HugeiconsIcon } from "@hugeicons/react";`,
        `import { useState } from "react";`,
        `import Braces from "/icons/FirstBracketIcon.js";`,
      ].join("\n"),
    );
  });

  it("leaves namespace imports of the package unchanged", () => {
    const code = `import * as icons from "${PACKAGE}";`;
    expect(rewriteHugeiconsImports(code, files)).toBeUndefined();
  });
});

describe("readHugeiconsFiles", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("throws when the index has no icon export lines", async () => {
    dir = await mkdtemp(join(tmpdir(), "hugeicons-index-"));
    const index = join(dir, "index.js");
    await writeFile(index, "export const nothing = 1;\n");

    expect(() => readHugeiconsFiles(index)).toThrow(/format changed/);
  });
});

describe("real @hugeicons/core-free-icons", () => {
  it("maps icons to files whose default export is the barrel's named export", async () => {
    const barrel = await import(PACKAGE);
    const realFiles = readHugeiconsFiles();

    for (const name of ["Braces", "FirstBracketIcon", "Cancel01Icon"]) {
      const file = realFiles.get(name);
      expect(file, name).toBeDefined();
      const perIcon = (await import(/* @vite-ignore */ file!)).default;
      expect(perIcon, name).toBe(barrel[name]);
    }
  });
});
