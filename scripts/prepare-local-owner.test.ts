import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Copies the script into an empty checkout whose PATH has a fake `go` that
// records each account command and exits with FAKE_GO_STATUS.
async function createCheckout() {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-owner-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "apps/teamhub"), { recursive: true });
  await copyFile(
    path.join(repositoryRoot, "scripts/prepare-local-owner.mjs"),
    path.join(root, "scripts/prepare-local-owner.mjs"),
  );
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "go"),
    '#!/bin/sh\nprintf \'%s %s %s\\n\' "$3" "$5" "$(cat)" >> "$FAKE_GO_LOG"\nexit "${FAKE_GO_STATUS:-0}"\n',
  );
  await chmod(path.join(bin, "go"), 0o755);
  return { root, bin, log: path.join(root, "go.log") };
}

async function prepare(
  checkout: Awaited<ReturnType<typeof createCheckout>>,
  environment: Record<string, string> = {},
) {
  return execFileAsync(
    process.execPath,
    [path.join(checkout.root, "scripts/prepare-local-owner.mjs")],
    {
      env: {
        ...process.env,
        FAKE_GO_LOG: checkout.log,
        OWNER_EMAIL: "",
        PATH: `${checkout.bin}${path.delimiter}${process.env.PATH}`,
        ...environment,
      },
    },
  );
}

const ownerFile = (root: string) =>
  path.join(root, ".linger-runtime/local-owner.json");

describe("local owner preparation", () => {
  it("writes the owner file only after the account commands succeed", async () => {
    const checkout = await createCheckout();
    await expect(
      prepare(checkout, { FAKE_GO_STATUS: "1", OWNER_EMAIL: "not-an-email" }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(stat(ownerFile(checkout.root))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const first = await prepare(checkout, { OWNER_EMAIL: "me@example.com" });
    const owner = JSON.parse(await readFile(ownerFile(checkout.root), "utf8"));
    expect(owner.owner_email).toBe("me@example.com");
    expect((await stat(ownerFile(checkout.root))).mode & 0o777).toBe(0o600);
    expect(first.stdout).toContain(owner.owner_password);
    expect(first.stdout).toContain(
      "Owner account: me@example.com (password saved in .linger-runtime/local-owner.json)",
    );
    const commands = (await readFile(checkout.log, "utf8")).trim().split("\n");
    expect(commands.slice(1)).toEqual([
      `create-owner me@example.com ${owner.owner_password}`,
      `set-password me@example.com ${owner.owner_password}`,
    ]);

    // Later runs keep the saved owner and never print its password again.
    const second = await prepare(checkout, {
      OWNER_EMAIL: "other@example.com",
    });
    expect(second.stdout).not.toContain(owner.owner_password);
    expect(second.stdout).toContain("Owner account: me@example.com");
    expect(
      (await readFile(checkout.log, "utf8")).trim().split("\n").at(-1),
    ).toBe(`create-owner me@example.com ${owner.owner_password}`);
  });
});
