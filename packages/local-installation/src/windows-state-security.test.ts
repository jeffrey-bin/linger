import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("./windows-private.js", () => ({
  windowsPrivatePath: vi.fn().mockResolvedValue(undefined),
}));
import { windowsPrivatePath } from "./windows-private.js";
import { readLocalLogin, ensureLocalAccount } from "./account.js";
import { prepareLocalEnrollment } from "./local-enrollment.js";
import { readPrivate, type Instance } from "./instance.js";
let root: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.mocked(windowsPrivatePath).mockReset().mockResolvedValue(undefined);
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), "linger-windows-security-"));
  vi.stubGlobal(
    "process",
    Object.create(process, { platform: { value: "win32" } }),
  );
  return {
    root,
    mode: "source-native",
    origin: "http://localhost:3000",
    port: 3000,
    releaseDir: "/source",
    source: {
      repo: "/source",
      ports: {
        web: 3000,
        teamhub: 3001,
        nodeServices: 3002,
        document: 3003,
        postgres: 3004,
      },
    },
  } as Instance;
}
it("uses Windows SID/DACL validation for existing local account reads and reuse", async () => {
  const instance = await fixture();
  const file = path.join(root, "local-account.json");
  await writeFile(
    file,
    JSON.stringify({
      email: "owner@linger.local",
      password: "existing-private-password",
      provisioned: true,
    }),
    { mode: 0o644 },
  );
  expect((await readLocalLogin(instance)).email).toBe("owner@linger.local");
  expect(
    (
      await ensureLocalAccount(instance, new AbortController().signal, {
        provisionOwner: async () => {},
      })
    ).email,
  ).toBe("owner@linger.local");
  expect(windowsPrivatePath).toHaveBeenCalledWith(file, "file");
});
it("checks the ACL before reusing a saved enrollment token", async () => {
  const instance = await fixture();
  const file = path.join(root, "computer-enrollment.token");
  const token = {
    origin: instance.origin,
    computer_id: "computer",
    tenant_id: "tenant",
    enrollment_id: "enrollment",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  await writeFile(
    file,
    "linger-connect-v1." +
      Buffer.from(JSON.stringify(token)).toString("base64url"),
    { mode: 0o644 },
  );
  expect(
    await prepareLocalEnrollment(instance, new AbortController().signal),
  ).toBe(file);
  expect(windowsPrivatePath).toHaveBeenCalledWith(file, "file");
});
it("fails closed on Windows ACL rejection across private state/config readers", async () => {
  const instance = await fixture();
  const file = path.join(root, "local-account.json");
  await writeFile(file, "{}", { mode: 0o600 });
  vi.mocked(windowsPrivatePath).mockRejectedValue(new Error("Unsafe ACL"));
  await expect(readPrivate(file)).rejects.toThrow("Unsafe ACL");
  await expect(readLocalLogin(instance)).rejects.toThrow("Unsafe ACL");
  await expect(
    ensureLocalAccount(instance, new AbortController().signal, {
      provisionOwner: async () => {},
    }),
  ).rejects.toThrow("Unsafe ACL");
});
