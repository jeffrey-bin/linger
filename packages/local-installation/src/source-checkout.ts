import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  atomicPrivate,
  initializeInstance,
  loadInstance,
  readPrivate,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import {
  liveKitEnvironment,
  prepareLiveKitSettings,
  readLiveKitSettings,
} from "./native-livekit.js";
import { readUserEnvironment } from "./user-environment.js";
import type { SetupChoice } from "./setup-plan.js";
import type { InstallerEvent } from "./events.js";

// A Native installation of one Linger source checkout: the desktop client's
// unpacked source package, or a developer's clone.
export interface SourceInstallOptions {
  setupChoice?: SetupChoice;
  shareGpu?: boolean;
  localModelsApproval?: string;
  localModelsReplan?: boolean;
  name: string;
  home?: string;
  port?: number;
  email?: string;
  password?: string;
  computerName?: string;
  model?: { baseUrl: string; model: string; apiKey: string };
  runtimeModel?: { baseUrl: string; model: string; apiKey: string };
  signal: AbortSignal;
  onEvent: (event: InstallerEvent) => void;
  repo: string;
  // The desktop client is this machine's Computer: source installs skip the
  // Go Computer build and enrollment, and the client signs in itself.
  externalComputer?: boolean;
}
export interface EnvironmentReport {
  platform: string;
  arch: string;
  releaseAvailable: boolean;
  checks: {
    id: string;
    title: string;
    state: "ready" | "action_required" | "failed";
    detail: string;
  }[];
  availableBytes?: number;
  requiredBytes?: number;
}
export async function validateSourceRepository(
  repository: string,
): Promise<string> {
  const repo = await realpath(repository);
  try {
    const manifest = JSON.parse(
      await readFile(path.join(repo, "package.json"), "utf8"),
    ) as { name?: string };
    if (manifest.name !== "linger") throw new Error("Wrong repository");
    const info = await lstat(path.join(repo, "scripts/source-native.mjs"));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Invalid native source script");
  } catch (cause) {
    throw new Error(
      "Source checkout must be a Linger checkout with scripts/source-native.mjs.",
      { cause },
    );
  }
  return repo;
}
async function allocatePort(reserved: Set<number>): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close((error) => (error ? reject(error) : resolve(port)));
      });
    });
    if (!reserved.has(port)) {
      reserved.add(port);
      return port;
    }
  }
}
export async function prepareSourceConfiguration(
  repository: string,
  options: {
    name: string;
    home?: string;
    port?: number;
    computerName?: string;
    externalComputer?: boolean;
  },
): Promise<{
  instance: Instance;
  env: NodeJS.ProcessEnv;
  warnings: string[];
}> {
  const repo = await validateSourceRepository(repository);
  const instance = await initializeInstance({ ...options, releaseDir: repo });
  return withInstanceLock(instance, async () => {
    if (
      instance.releaseDir !== repo ||
      (!instance.source &&
        (await readPrivate(path.join(instance.root, "local-account.json"))) !==
          undefined)
    )
      throw new Error(
        "Instance is already bound to another release or checkout; select a new instance.",
      );
    // The ports every other instance of this home keeps, Native LiveKit's too.
    const reservedPorts = async () => {
      const reserved = new Set<number>([
        instance.port,
        ...Object.values(instance.source?.ports ?? {}),
      ]);
      for (const name of await readdir(path.dirname(instance.root))) {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || name === instance.name)
          continue;
        const other = await loadInstance({
          name,
          home: path.resolve(instance.root, "../.."),
        });
        if (other) {
          reserved.add(other.port);
          for (const port of Object.values(other.source?.ports ?? {}))
            reserved.add(port);
          const livekit = await readLiveKitSettings(other.root).catch(
            () => undefined,
          );
          if (livekit) reserved.add(livekit.httpPort).add(livekit.rtcPort);
        }
      }
      return reserved;
    };
    if (!instance.source) {
      const reserved = await reservedPorts();
      instance.source = {
        repo,
        ports: {
          web: instance.port,
          teamhub: await allocatePort(reserved),
          nodeServices: await allocatePort(reserved),
          document: await allocatePort(reserved),
          postgres: await allocatePort(reserved),
        },
      };
      await atomicPrivate(
        path.join(instance.root, "instance.json"),
        JSON.stringify(instance, null, 2) + "\n",
      );
    }
    const envFile = path.join(instance.root, "native.env");
    // The desktop installs from a source package that each update replaces,
    // so only the instance's user.env configures it; a developer's checkout
    // also supplies its own .env, under user.env.
    let supplied: Record<string, string> = {};
    if (!options.externalComputer) {
      const selected = process.env.LOCAL_ENV_FILE
        ? path.resolve(repo, process.env.LOCAL_ENV_FILE)
        : path.join(repo, ".env");
      try {
        supplied = parseEnv(await readFile(selected, "utf8")) as Record<
          string,
          string
        >;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          process.env.LOCAL_ENV_FILE
        )
          throw new Error("Cannot read source environment file.", {
            cause: error,
          });
      }
    }
    const warnings: string[] = [];
    const user = await readUserEnvironment(instance.root, (message) =>
      warnings.push(message),
    );
    const secrets = parseEnv(
      (await readPrivate(path.join(instance.root, "services.env")))!,
    );
    const ports = instance.source.ports;
    const generated = {
      ...supplied,
      // Native without its voice tools turns the voice keys off when it
      // starts the services (native-source.ts).
      ...user,
      LOCAL_ENV_FILE: envFile,
      COMPUTER_RELEASE_TARGETS: `${process.platform}-${process.arch}`,
      WEB_HTTP_PORT: String(ports.web),
      TEAMHUB_HTTP_PORT: String(ports.teamhub),
      NODE_SERVICES_HTTP_PORT: String(ports.nodeServices),
      DOCUMENT_RUNTIME_HTTP_PORT: String(ports.document),
      POSTGRES_PORT: String(ports.postgres),
      WEB_PUBLIC_ORIGIN: instance.origin,
      AGENT_RUNNER_PUBLIC_GATEWAY_URL: `ws://127.0.0.1:${ports.nodeServices}/v1/runner-gateway`,
      LINGER_SECRET_SEED: secrets.LINGER_SECRET_SEED!,
      TEAMHUB_SECRET_ENCRYPTION_KEY: secrets.TEAMHUB_SECRET_ENCRYPTION_KEY!,
      TEAMHUB_DATABASE_URL: `postgres://simplexai:${encodeURIComponent(secrets.LINGER_POSTGRES_PASSWORD!)}@127.0.0.1:${ports.postgres}/simplexai?sslmode=disable`,
      TEAMHUB_HTTP_ADDRESS: `127.0.0.1:${ports.teamhub}`,
      TEAMHUB_BASE_URL: `http://127.0.0.1:${ports.teamhub}`,
      TEAMHUB_CLI_BASE_URL: `http://127.0.0.1:${ports.teamhub}`,
      TEAMHUB_NODE_SERVICES_URL: `http://127.0.0.1:${ports.nodeServices}`,
      TEAMHUB_ARTIFACT_STORAGE_ROOT: path.join(instance.root, "data/artifacts"),
      TEAMHUB_DOCUMENT_RUNTIME_URL: `http://127.0.0.1:${ports.document}`,
      NODE_SERVICES_HTTP_ADDRESS: `127.0.0.1:${ports.nodeServices}`,
      DOCUMENT_RUNTIME_HTTP_ADDRESS: `127.0.0.1:${ports.document}`,
      AGENT_HOME: path.join(instance.root, "data/agent"),
      COMPUTER_RELEASE_DIR: path.join(instance.root, "native/computer-release"),
      PORT: String(ports.web),
      HOST: "127.0.0.1",
      // Native runs its own LiveKit on loopback with this instance's ports
      // and keys.
      ...liveKitEnvironment(
        await prepareLiveKitSettings(instance.root, await reservedPorts()),
      ),
    };
    const quote = (value: string) => {
      if (/[\r\n\0']/.test(value))
        throw new Error("Source environment contains unsupported characters.");
      return `'${value}'`;
    };
    const nativeFileOmissions = new Set([
      "WEB_HTTP_PORT",
      "TEAMHUB_HTTP_PORT",
      "DOCUMENT_RUNTIME_HTTP_PORT",
      "POSTGRES_PORT",
      "HOST",
      "LOCAL_ENV_FILE",
    ]);
    await atomicPrivate(
      envFile,
      Object.entries(generated)
        .filter(([key]) => !nativeFileOmissions.has(key))
        .map(([key, value]) => `${key}=${quote(value)}`)
        .join("\n") + "\n",
    );
    return { instance, env: generated, warnings };
  });
}
