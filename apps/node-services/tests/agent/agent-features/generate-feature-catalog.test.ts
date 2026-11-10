import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkFeatureCatalog,
  discoverFeatureNames,
  generateFeatureCatalog,
  renderFeatureCatalog,
  type FeatureCatalogLayout,
} from "../../../scripts/generate-feature-catalog.js";

const temporaryRoots: string[] = [];

const makeFixture = async (
  featureNames: readonly string[],
): Promise<FeatureCatalogLayout> => {
  const root = await mkdtemp(path.join(tmpdir(), "feature-catalog-"));
  temporaryRoots.push(root);
  const featuresRoot = path.join(root, "agent-features");
  await mkdir(featuresRoot, { recursive: true });
  for (const name of featureNames) {
    await mkdir(path.join(featuresRoot, name), { recursive: true });
    await writeFile(
      path.join(featuresRoot, name, "feature.ts"),
      `// fixture feature ${name}\n`,
    );
  }
  return {
    featuresRoot,
    target: path.join(featuresRoot, "catalog.generated.ts"),
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("discoverFeatureNames", () => {
  it("lists direct-child directories with feature.ts in deterministic order", async () => {
    const layout = await makeFixture(["timer-source", "agent-memory"]);
    await mkdir(path.join(layout.featuresRoot, "not-a-feature"));
    await mkdir(path.join(layout.featuresRoot, "nested/inner"), {
      recursive: true,
    });
    await writeFile(
      path.join(layout.featuresRoot, "nested/inner/feature.ts"),
      "// nested fixture\n",
    );
    await writeFile(
      path.join(layout.featuresRoot, "catalog.generated.ts"),
      "// existing catalog\n",
    );

    await expect(discoverFeatureNames(layout.featuresRoot)).resolves.toEqual([
      "agent-memory",
      "timer-source",
    ]);
  });
});

describe("renderFeatureCatalog", () => {
  it("emits namespace imports and a directory-name keyed const map", () => {
    const output = renderFeatureCatalog(["agent-memory", "flashback"]);

    expect(output).toContain(
      'import * as agentMemory from "./agent-memory/feature.js";',
    );
    expect(output).toContain(
      'import * as flashback from "./flashback/feature.js";',
    );
    expect(output).toContain("AGENT_FEATURE_MODULES");
    expect(output).toContain('"agent-memory": agentMemory,');
    expect(output).toContain("flashback: flashback,");
    expect(output).toContain(
      "export type AgentFeatureModuleName = keyof typeof AGENT_FEATURE_MODULES;",
    );
    expect(output.indexOf("agent-memory")).toBeLessThan(
      output.indexOf("flashback"),
    );
  });

  it("rejects directory names that cannot form a module identifier", () => {
    expect(() => renderFeatureCatalog(["9lives"])).toThrow(/module identifier/);
    expect(() => renderFeatureCatalog(["a-b", "aB"])).toThrow(
      /same module identifier/,
    );
  });
});

describe("generateFeatureCatalog", () => {
  it("writes the manifest, reports additions and removals, and skips rewrites when unchanged", async () => {
    const layout = await makeFixture(["alpha-feature", "beta-feature"]);

    const first = await generateFeatureCatalog(layout);
    expect(first).toMatchObject({
      changed: true,
      featureNames: ["alpha-feature", "beta-feature"],
    });
    const written = await readFile(layout.target, "utf8");
    expect(written).toBe(renderFeatureCatalog(first.featureNames));
    const mtime = (await stat(layout.target)).mtimeMs;

    const second = await generateFeatureCatalog(layout);
    expect(second.changed).toBe(false);
    expect((await stat(layout.target)).mtimeMs).toBe(mtime);

    await rm(path.join(layout.featuresRoot, "beta-feature"), {
      recursive: true,
    });
    const removed = await generateFeatureCatalog(layout);
    expect(removed.featureNames).toEqual(["alpha-feature"]);
    expect(removed.changed).toBe(true);
    await expect(
      stat(path.join(layout.featuresRoot, "beta-feature")),
    ).rejects.toThrow();
    const afterRemoval = await readFile(layout.target, "utf8");
    expect(afterRemoval).not.toContain("beta-feature");
    expect(afterRemoval).toContain("alpha-feature");

    await mkdir(path.join(layout.featuresRoot, "gamma"));
    await writeFile(
      path.join(layout.featuresRoot, "gamma/feature.ts"),
      "// new feature\n",
    );
    const added = await generateFeatureCatalog(layout);
    expect(added.featureNames).toEqual(["alpha-feature", "gamma"]);
    expect(added.changed).toBe(true);
  });
});

describe("checkFeatureCatalog", () => {
  it("detects stale and missing manifests without writing", async () => {
    const layout = await makeFixture(["alpha-feature"]);

    const missing = await checkFeatureCatalog(layout);
    expect(missing.upToDate).toBe(false);
    await expect(stat(layout.target)).rejects.toThrow();

    await generateFeatureCatalog(layout);
    const fresh = await checkFeatureCatalog(layout);
    expect(fresh.upToDate).toBe(true);
    expect(fresh.featureNames).toEqual(["alpha-feature"]);

    await mkdir(path.join(layout.featuresRoot, "beta-feature"));
    await writeFile(
      path.join(layout.featuresRoot, "beta-feature/feature.ts"),
      "// unlisted feature\n",
    );
    const stale = await checkFeatureCatalog(layout);
    expect(stale.upToDate).toBe(false);
    expect(stale.featureNames).toEqual(["alpha-feature", "beta-feature"]);
    // Check mode must not heal the file.
    await expect(readFile(layout.target, "utf8")).resolves.toBe(
      renderFeatureCatalog(["alpha-feature"]),
    );
  });
});
