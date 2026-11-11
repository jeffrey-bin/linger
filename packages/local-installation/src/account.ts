import { windowsPrivatePath } from "./windows-private.js";
import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Instance } from "./instance.js";
import { atomicPrivate } from "./private-files.js";

export function validateLocalCredentials(options: {
  email?: string;
  password?: string;
}): void {
  if (
    options.email !== undefined &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email)
  )
    throw new Error("Enter a valid login email.");
  if (
    options.password !== undefined &&
    (options.password.length < 8 ||
      options.password.length > 256 ||
      /\p{Cc}/u.test(options.password))
  )
    throw new Error(
      "Login passwords must contain 8–256 characters without control characters.",
    );
}
export async function readLocalLogin(
  instance: Pick<Instance, "root">,
): Promise<{ email: string; password: string; file: string }> {
  const file = path.join(instance.root, "local-account.json");
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) ||
    info.size > 16384
  )
    throw new Error(
      "The local account file must be private and owned by the current user (chmod 600).",
    );
  if (process.platform === "win32") await windowsPrivatePath(file, "file");
  try {
    const account = JSON.parse(await readFile(file, "utf8")) as LocalAccount;
    validateLocalCredentials(account);
    if (
      account.provisioned !== true ||
      typeof account.email !== "string" ||
      typeof account.password !== "string"
    )
      throw new Error();
    return { email: account.email, password: account.password, file };
  } catch {
    throw new Error(
      "The local account file is invalid or the account has not been created.",
    );
  }
}
interface LocalAccount {
  email: string;
  password: string;
  provisioned: boolean;
}

// Called under the instance lock. TeamHub owns deployment-owner creation;
// its idempotent command never resets an existing account password.
export async function ensureLocalAccount(
  instance: Instance,
  signal: AbortSignal,
  options: {
    email?: string;
    password?: string;
    provisionOwner: (email: string, password: string) => Promise<void>;
  },
): Promise<{ email: string; file: string; password: string }> {
  const file = path.join(instance.root, "local-account.json");
  let account: LocalAccount;
  try {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      throw new Error(
        "The local account file must be private and owned by the current user (chmod 600).",
      );
    if (process.platform === "win32") await windowsPrivatePath(file, "file");
    account = JSON.parse(await readFile(file, "utf8")) as LocalAccount;
    if (
      typeof account.email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) ||
      typeof account.password !== "string" ||
      account.password.length < 8 ||
      account.password.length > 256 ||
      /\p{Cc}/u.test(account.password) ||
      typeof account.provisioned !== "boolean"
    )
      throw new Error(
        "The local account file is invalid; existing credentials will not be overwritten.",
      );
  } catch (error) {
    if (error instanceof SyntaxError)
      // eslint-disable-next-line preserve-caught-error -- JSON parser errors may contain the private password.
      throw new Error(
        "The local account file is invalid; existing credentials will not be overwritten.",
      );
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    validateLocalCredentials(options);
    account = {
      email: options.email ?? "owner@linger.local",
      password: options.password ?? randomBytes(24).toString("base64url"),
      provisioned: false,
    };
    // Persist before creation, allowing a retry after a committed owner transaction.
    await atomicPrivate(file, JSON.stringify(account, null, 2) + "\n");
  }
  const email = account.email;
  signal.throwIfAborted();
  if (account.provisioned) return { email, file, password: account.password };
  async function post(route: string, body: unknown, cookie?: string) {
    let response: Response;
    try {
      response = await fetch(`${instance.origin}/v0/auth/${route}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new Error(
        "The local account service is unavailable. Reopen Linger to retry; account credentials are preserved.",
      );
    }
    await response.body?.cancel();
    return response;
  }
  async function complete(response: Response) {
    account.provisioned = true;
    await atomicPrivate(file, JSON.stringify(account, null, 2) + "\n");
    // This CLI session is not the browser session; discard it after provisioning.
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (cookie) await post("logout", {}, cookie).catch(() => {});
    signal.throwIfAborted();
    return { email, file, password: account.password };
  }
  const login = await post("login", {
    identifier: email,
    password: account.password,
  });
  if (login.ok) return complete(login);
  if (login.status !== 401)
    throw new Error(`Local account login check failed (HTTP ${login.status})`);
  try {
    await options.provisionOwner(email, account.password);
  } catch {
    // The command can fail after commit. Never expose diagnostics containing
    // private input; confirm ownership using the persisted password instead.
    signal.throwIfAborted();
  }
  const confirmed = await post("login", {
    identifier: email,
    password: account.password,
  });
  if (confirmed.ok) return complete(confirmed);
  throw new Error(
    `Local account sign-in failed after creation (HTTP ${confirmed.status}). Credentials are preserved; existing accounts will not be reset.`,
  );
}
