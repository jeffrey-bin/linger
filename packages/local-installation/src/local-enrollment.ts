import { windowsPrivatePath } from "./windows-private.js";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  atomicPrivate,
  validSourceDescriptor,
  type Instance,
} from "./instance.js";
import { readLocalLogin } from "./account.js";

const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
async function privateText(file: string): Promise<string> {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) ||
    info.size > 16_384
  )
    throw new Error(
      "Local connection credentials must be saved in a private file owned by the current user.",
    );
  if (process.platform === "win32") await windowsPrivatePath(file, "file");
  return readFile(file, "utf8");
}
function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Never expose parser errors containing passwords or tokens. */
  }
  throw new Error("Invalid local connection credential format.");
}

// Only the locally provisioned owner may authorize this release's isolated
// Computer. The existing Computer executable performs exchange and setup.
export async function prepareLocalEnrollment(
  instance: Instance,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const origin = new URL(instance.origin);
  if (
    !validSourceDescriptor(instance) ||
    origin.protocol !== "http:" ||
    origin.hostname !== "localhost" ||
    origin.origin !== instance.origin
  )
    throw new Error(
      "Automatic connection only applies to a verified local instance.",
    );
  const file = path.join(instance.root, "computer-enrollment.token");
  let previousComputer: string | undefined;
  let previousTenant: string | undefined;
  try {
    const text = (await privateText(file)).trim();
    if (!/^linger-connect-v1\.[A-Za-z0-9_-]+$/.test(text))
      throw new Error("Invalid local connection credential format.");
    const previous = parseJson(
      Buffer.from(
        text.slice("linger-connect-v1.".length),
        "base64url",
      ).toString("utf8"),
    );
    if (
      previous.origin !== instance.origin ||
      !id(previous.computer_id) ||
      !id(previous.tenant_id) ||
      !id(previous.enrollment_id) ||
      typeof previous.expires_at !== "string" ||
      !Number.isFinite(Date.parse(previous.expires_at))
    )
      throw new Error(
        "Local connection credentials do not belong to this instance.",
      );
    if (Date.parse(previous.expires_at) > Date.now() + 5000) return file;
    // Preserve exact identity until owner inventory confirms whether exchange created it.
    previousComputer = previous.computer_id;
    previousTenant = previous.tenant_id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const account = await readLocalLogin(instance);
  let cookie: string | undefined;
  async function request(route: string, body?: unknown) {
    let response: Response;
    try {
      response = await fetch(`${instance.origin}/v0/${route}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new Error(
        "The local Computer authorization service is unavailable. Reopen Linger to retry.",
      );
    }
    return response;
  }
  try {
    const login = await request("auth/login", {
      identifier: account.email,
      password: account.password,
    });
    await login.body?.cancel();
    if (!login.ok)
      throw new Error(`Local Computer sign-in failed (HTTP ${login.status})`);
    cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Local Computer sign-in returned no session.");
    let tenant = previousTenant;
    if (!tenant) {
      const tenants = await request("tenants");
      if (!tenants.ok) {
        await tenants.body?.cancel();
        throw new Error(
          `Local workspace query failed (HTTP ${tenants.status})`,
        );
      }
      const list = (await tenants.json()) as { items?: { id?: unknown }[] };
      if (!id(list.items?.[0]?.id))
        throw new Error("The local account has no workspace yet.");
      tenant = list.items[0].id;
    }
    if (previousComputer) {
      const inventory = await request(
        `tenants/${encodeURIComponent(tenant)}/local-computers`,
      );
      if (!inventory.ok) {
        await inventory.body?.cancel();
        throw new Error(
          `Could not determine the existing Computer status (HTTP ${inventory.status}). Connection credentials are preserved.`,
        );
      }
      let list: unknown;
      try {
        list = await inventory.json();
      } catch {
        throw new Error(
          "Could not determine the existing Computer status. Connection credentials are preserved.",
        );
      }
      const items =
        list && typeof list === "object"
          ? (list as { items?: unknown }).items
          : undefined;
      if (
        !Array.isArray(items) ||
        !items.every(
          (item) => item && typeof item === "object" && id(item.computer_id),
        )
      )
        throw new Error(
          "Could not determine the existing Computer status. Connection credentials are preserved.",
        );
      // An expired authorization may never have been exchanged. Only an
      // authoritative owner inventory can distinguish it from an existing device.
      if (!items.some((item) => item.computer_id === previousComputer))
        previousComputer = undefined;
    }
    const verifier = randomBytes(32).toString("base64url");
    const displayName =
      instance.computerName ?? `${hostname()} · ${instance.name}`.slice(0, 120);
    const authorized = await request(
      `tenants/${encodeURIComponent(tenant)}/local-computer-enrollments`,
      {
        display_name: displayName,
        redirect_uri: "http://127.0.0.1:9/callback",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        ...(previousComputer ? { computer_id: previousComputer } : {}),
      },
    );
    if (authorized.status !== 201) {
      await authorized.body?.cancel();
      throw new Error(
        `Local Computer authorization failed (HTTP ${authorized.status})`,
      );
    }
    const value = (await authorized.json()) as Record<string, unknown>;
    if (
      !id(value.enrollment_id) ||
      !id(value.computer_id) ||
      typeof value.authorization_code !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.authorization_code) ||
      typeof value.expires_at !== "string" ||
      !(Date.parse(value.expires_at) > Date.now()) ||
      (previousComputer && value.computer_id !== previousComputer)
    )
      throw new Error("Invalid local Computer authorization result.");
    const token = {
      origin: instance.origin,
      display_name: displayName,
      enrollment_id: value.enrollment_id,
      computer_id: value.computer_id,
      tenant_id: tenant,
      authorization_code: value.authorization_code,
      code_verifier: verifier,
      expires_at: value.expires_at,
    };
    await atomicPrivate(
      file,
      `linger-connect-v1.${Buffer.from(JSON.stringify(token)).toString("base64url")}\n`,
    );
    return file;
  } finally {
    if (cookie && !signal.aborted) {
      await request("auth/logout", {})
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
  }
}
