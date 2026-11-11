import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInstance, withInstanceLock, type Instance } from "./instance.js";
import { migrateLegacyInstallation } from "./legacy-migration.js";
import { legacyMigrationPending } from "./home.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "linger-legacy-"));
  roots.push(root);
  return root;
}

async function put(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
}

// An instance as an install from before the rename left it.
async function legacyInstance(
  home: string,
  name: string,
  mode: Instance["mode"] = "source-native",
): Promise<Instance> {
  const root = path.join(home, "instances", name);
  const instance: Instance = {
    schemaVersion: 1,
    name,
    mode,
    root,
    project: `simplex-${name}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
    origin: "http://localhost:3999",
    port: 3999,
    releaseDir: path.join(home, "releases", "1"),
    computerConfig: path.join(root, "computer", "config.json"),
    computerExecutable: "linger-computer",
    ...(mode === "source-native"
      ? {
          releaseDir: "/checkout",
          source: {
            repo: "/checkout",
            ports: {
              web: 3999,
              teamhub: 4001,
              nodeServices: 4002,
              document: 4003,
              postgres: 4004,
            },
          },
        }
      : {}),
  };
  await put(path.join(root, "instance.json"), JSON.stringify(instance));
  await put(
    path.join(root, "services.env"),
    "SIMPLEX_POSTGRES_PASSWORD=pw\nSIMPLEX_SECRET_SEED=seed\nTEAMHUB_SECRET_ENCRYPTION_KEY=key\n",
  );
  await put(
    path.join(root, "computer", "config.json"),
    JSON.stringify({ state: path.join(root, "computer", "state") }),
  );
  return instance;
}

describe("migrateLegacyInstallation", () => {
  it("gives each instance its Linger names once", async () => {
    const home = await temporary();
    await legacyInstance(home, "desktop");
    const stopped: string[] = [];
    const options = {
      home,
      stopInstance: vi.fn(async (instance: Instance) => {
        stopped.push(instance.name);
      }),
    };
    expect(await legacyMigrationPending(home)).toBe(true);

    await migrateLegacyInstallation(options);

    const instance = (await loadInstance({ name: "desktop", home }))!;
    expect(instance.project).toMatch(/^linger-desktop-[a-f0-9]{12}$/);
    expect(
      await readFile(path.join(instance.root, "services.env"), "utf8"),
    ).toBe(
      "LINGER_POSTGRES_PASSWORD=pw\nLINGER_SECRET_SEED=seed\nTEAMHUB_SECRET_ENCRYPTION_KEY=key\n",
    );
    expect(stopped).toEqual(["desktop"]);
    expect(await legacyMigrationPending(home)).toBe(false);

    await migrateLegacyInstallation(options);
    expect(stopped).toEqual(["desktop"]);
  });

  it("skips a damaged record and converts the other instances", async () => {
    const home = await temporary();
    await put(path.join(home, "instances", "broken", "instance.json"), "{");
    await legacyInstance(home, "desktop");
    const stopInstance = vi.fn(async () => {});

    await migrateLegacyInstallation({ home, stopInstance });

    expect(stopInstance).toHaveBeenCalledTimes(1);
    expect((await loadInstance({ name: "desktop", home }))!.project).toMatch(
      /^linger-desktop-/,
    );
  });

  it("converts the other instances when one fails, then names it", async () => {
    const home = await temporary();
    await legacyInstance(home, "alpha");
    await legacyInstance(home, "beta");
    const stopInstance = vi.fn(async (instance: Instance) => {
      if (instance.name === "alpha")
        throw new Error("Instance busy: active operations are running");
    });

    await expect(
      migrateLegacyInstallation({ home, stopInstance }),
    ).rejects.toThrow(/alpha: Instance busy: active operations are running/);

    expect(stopInstance).toHaveBeenCalledTimes(2);
    expect((await loadInstance({ name: "beta", home }))!.project).toMatch(
      /^linger-beta-/,
    );
    expect(await legacyMigrationPending(home)).toBe(true);

    stopInstance.mockImplementation(async () => {});
    await migrateLegacyInstallation({ home, stopInstance });
    expect((await loadInstance({ name: "alpha", home }))!.project).toMatch(
      /^linger-alpha-/,
    );
    expect(await legacyMigrationPending(home)).toBe(false);
  });

  it("reports an instance whose lock another installer holds", async () => {
    const home = await temporary();
    const instance = await legacyInstance(home, "desktop");
    const stopInstance = vi.fn(async () => {});

    await withInstanceLock(instance, () =>
      expect(migrateLegacyInstallation({ home, stopInstance })).rejects.toThrow(
        /desktop: Instance busy/,
      ),
    );

    expect(stopInstance).not.toHaveBeenCalled();
    expect(await legacyMigrationPending(home)).toBe(true);
  });

  it("converges after a crash that renamed only some keys", async () => {
    const home = await temporary();
    const instance = await legacyInstance(home, "desktop");
    // The state a crash leaves between the env rewrite and instance.json.
    await put(
      path.join(instance.root, "services.env"),
      "LINGER_POSTGRES_PASSWORD=pw\nSIMPLEX_SECRET_SEED=seed\n",
    );
    const stopInstance = vi.fn(async () => {});

    await migrateLegacyInstallation({ home, stopInstance });

    expect(stopInstance).toHaveBeenCalledTimes(1);
    expect(
      await readFile(path.join(instance.root, "services.env"), "utf8"),
    ).toBe("LINGER_POSTGRES_PASSWORD=pw\nLINGER_SECRET_SEED=seed\n");
    expect(await legacyMigrationPending(home)).toBe(false);
  });

  it("leaves a home without legacy instances untouched", async () => {
    const home = await temporary();
    const stopInstance = vi.fn(async () => {});
    await migrateLegacyInstallation({ home, stopInstance });
    expect(stopInstance).not.toHaveBeenCalled();
    expect(await legacyMigrationPending(home)).toBe(false);
  });

  it("does not count a damaged instance record as pending", async () => {
    const home = await temporary();
    await put(path.join(home, "instances", "broken", "instance.json"), "{");
    expect(await legacyMigrationPending(home)).toBe(false);
  });
});
