import path from "node:path";
import { startInstallerServer, type ServerOptions } from "./server.js";
import { openLocalTarget } from "./platform.js";
import { writeLauncher } from "./launcher.js";
import { privateRead } from "./storage.js";
type LaunchOptions = ServerOptions & {
  noOpen?: boolean;
  open?: (file: string) => Promise<void>;
};
const busy = (message: string, cause?: unknown) =>
  Object.assign(new Error(message, { cause }), { code: "INSTALLER_BUSY" });
async function reopenInstaller(options: LaunchOptions) {
  const stateDir = path.join(options.home, "installer");
  let metadata: {
    origin?: unknown;
    controlToken?: unknown;
    sourceRepo?: unknown;
    externalComputer?: unknown;
    instanceName?: unknown;
  };
  try {
    metadata = (await privateRead(
      path.join(stateDir, "session.json"),
    )) as typeof metadata;
  } catch (error) {
    throw busy(
      "Another installer holds this home but its session is unreadable. Try again in a moment.",
      error,
    );
  }
  if (
    typeof metadata.origin !== "string" ||
    !/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(metadata.origin) ||
    new URL(metadata.origin).port === "" ||
    Number(new URL(metadata.origin).port) > 65535 ||
    typeof metadata.controlToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(metadata.controlToken)
  )
    throw busy(
      "Another installer holds this home but its session is invalid. Try again in a moment.",
    );
  const control = async (action: string) => {
    try {
      const response = await fetch(`${metadata.origin}/api/${action}`, {
        method: "POST",
        headers: {
          Origin: metadata.origin as string,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: metadata.controlToken }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        message?: unknown;
      };
      return { ok: response.ok, code: body.code, message: body.message };
    } catch (error) {
      throw busy(
        "The running installer did not answer. Try again in a moment.",
        error,
      );
    }
  };
  if (
    metadata.sourceRepo !== options.sourceRepo ||
    (metadata.externalComputer ?? false) !==
      (options.externalComputer ?? false) ||
    (metadata.instanceName ?? "default") !== (options.instanceName ?? "default")
  ) {
    // An idle desktop-owned manager for the same instance steps aside for the
    // desktop's next launch with a newer bundled checkout. A running job is
    // never interrupted.
    if (
      !options.externalComputer ||
      metadata.externalComputer !== true ||
      (metadata.instanceName ?? "default") !==
        (options.instanceName ?? "default")
    )
      throw busy(
        "The installer is already running for another installation. Finish or close it, then try again.",
      );
    const retired = await control("retire");
    if (!retired.ok)
      throw busy(
        retired.code === "JOB_RUNNING"
          ? "An earlier installation is still running. Wait for it to finish or cancel it, then try again."
          : "The running installer could not step aside. Try again in a moment.",
      );
    return undefined;
  }
  const reopened = await control("reopen");
  if (!reopened.ok)
    throw busy("Could not reopen the installer page. Try again later.");
  const launcher = path.join(stateDir, "launch.html");
  if (!options.noOpen)
    await (options.open ?? openLocalTarget)(launcher).catch(() => {});
  return {
    origin: metadata.origin,
    bootstrapToken: "",
    reused: true as const,
    closed: Promise.resolve(),
    close: async () => {},
  };
}
export async function launchInstaller(options: LaunchOptions) {
  let server: Awaited<ReturnType<typeof startInstallerServer>>;
  for (let attempt = 0; ; attempt++) {
    try {
      server = await startInstallerServer(options);
      break;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "INSTALLER_BUSY") throw error;
      if (attempt === 0) {
        const reopened = await reopenInstaller(options);
        if (reopened) return reopened;
      } else if (attempt >= 50)
        throw busy(
          "The earlier installer is still closing. Try again in a moment.",
          error,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    const launcher = await writeLauncher(
      path.join(options.home, "installer"),
      server.origin,
      server.bootstrapToken,
    );
    if (!options.noOpen)
      await (options.open ?? openLocalTarget)(launcher).catch(() => {});
  } catch {
    await server.close();
    throw new Error(
      "Could not open the installer page. Open the installer again.",
    );
  }
  return { ...server, reused: false as const };
}
