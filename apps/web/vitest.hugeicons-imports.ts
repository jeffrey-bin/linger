import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

// @hugeicons/core-free-icons exposes ~6000 icons through one ESM barrel. Every
// Vitest file runs in a fresh worker, so loading the barrel costs ~1.6 s per file.
// Production builds tree-shake the barrel, so this rewrite is test-only: named
// imports become default imports of the single icon file that defines them.

const PACKAGE = "@hugeicons/core-free-icons";
const IMPORT_PATTERN =
  /import\s*\{([^}]*)\}\s*from\s*["']@hugeicons\/core-free-icons["'];?/g;
const EXPORT_PATTERN = /export \{([^}]*)\} from '\.\/([^']+)';/g;

function defaultIndexPath(): string {
  const packageJson = createRequire(import.meta.url).resolve(
    `${PACKAGE}/package.json`,
  );
  return join(dirname(packageJson), "dist/esm/index.js");
}

export function readHugeiconsFiles(
  indexPath: string = defaultIndexPath(),
): Map<string, string> {
  const files = new Map<string, string>();
  for (const [, names, file] of readFileSync(indexPath, "utf8").matchAll(
    EXPORT_PATTERN,
  )) {
    for (const [, name] of names!.matchAll(/default as (\w+)/g)) {
      files.set(name!, join(dirname(indexPath), file!));
    }
  }
  if (files.size === 0) {
    throw new Error(
      `No icon exports found in ${indexPath}; ${PACKAGE} format changed`,
    );
  }
  return files;
}

export function rewriteHugeiconsImports(
  code: string,
  files: Map<string, string>,
): string | undefined {
  if (!code.includes(PACKAGE)) return undefined;
  let matched = false;
  const rewritten = code.replace(
    IMPORT_PATTERN,
    (whole, specifiers: string) => {
      matched = true;
      const imports = specifiers
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean)
        .map((specifier) => {
          const [name, local = name] = specifier.split(/\s+as\s+/);
          const file = files.get(name!);
          if (!file) throw new Error(`Unknown ${PACKAGE} export ${name}`);
          return `import ${local} from ${JSON.stringify(file)};`;
        })
        .join("");
      // Keep the newlines of the original statement so later line numbers stay put.
      const newlines = "\n".repeat(whole.split("\n").length - 1);
      return imports + newlines;
    },
  );
  return matched ? rewritten : undefined;
}

export function hugeiconsPerIconImports(): Plugin {
  let files: Map<string, string> | undefined;
  return {
    name: "hugeicons-per-icon-imports",
    // Runs after TypeScript is stripped, so type-only specifiers are already gone.
    enforce: "post",
    transform(code, id) {
      if (id.includes("/node_modules/")) return undefined;
      files ??= readHugeiconsFiles();
      const result = rewriteHugeiconsImports(code, files);
      return result === undefined ? undefined : { code: result, map: null };
    },
  };
}
