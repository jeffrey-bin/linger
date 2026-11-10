import {
  checkNativeSourceEnvironment,
  installNativeSource,
  probeNativeSourceServices,
  stopNativeSource,
} from "@linger/local-installation/native-source";
import {
  saveRuntimeApiKey,
  type ApiKeyProvider,
} from "@linger/local-installation/runtime-credentials";
import { RuntimeLoginManager } from "./runtime-login.js";
import { inspectSetup } from "@linger/local-installation/setup-plan";
import {
  readSetupChoice,
  DEFAULT_GPU_SHARING,
  readGpuSharing,
} from "@linger/local-installation/setup-selection";
import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  loadInstance,
  withInstanceLock,
} from "@linger/local-installation/instance";
import { readLocalLogin } from "@linger/local-installation/account";
import { inspectComputer } from "@linger/local-installation/computer";
import type { components } from "@linger/wire-contracts/linger-installer/types";
import { publicComputer } from "./public.js";
import { prepareDependencies } from "@linger/local-installation/dependencies";
import {
  managedRuntimeEnvironment,
  readManagedModel,
} from "@linger/local-installation/managed-codex";
import { localModelsEnvironment } from "@linger/local-installation/local-models";
import type { RunInstallation } from "./jobs.js";
const RUNTIME_ENVIRONMENT = [
  "LINGER_CODEX_PATH",
  "LINGER_CLAUDE_PATH",
  "LINGER_PI_PATH",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
] as const;
export function coreAdapter(
  home: string,
  sourceRepo: string,
  externalComputer = false,
) {
  const instance = (name: string) => loadInstance({ name, home });
  const nativeLogin = new RuntimeLoginManager();
  return {
    closeRuntimeLogins: () => nativeLogin.close(),
    cancelRuntimeLogin: async (name: string) => nativeLogin.cancel(name),
    async runtimeLogin(
      name: string,
      start = false,
      code?: string,
      credential?: {
        apiKey: string;
        provider: ApiKeyProvider;
        baseUrl?: string;
        model?: string;
      },
    ) {
      const value = await instance(name);
      const runtime = await readSetupChoice({ name, home });
      if (!value || !runtime || runtime === "local-models")
        return { state: "idle" as const };
      if (credential)
        await withInstanceLock(value, () =>
          saveRuntimeApiKey(
            value.root,
            runtime,
            credential.provider,
            credential.apiKey,
            credential.provider === "openai-compatible" &&
              credential.baseUrl &&
              credential.model
              ? { baseUrl: credential.baseUrl, model: credential.model }
              : undefined,
          ),
        );
      const input = { instance: name, home, root: value.root, runtime };
      return start && !credential
        ? nativeLogin.start(input, code)
        : nativeLogin.status(input);
    },
    setup: () =>
      inspectSetup({ home, signal: AbortSignal.timeout(10 * 60_000) }),
    run: ((input, signal, onEvent) =>
      input.preparation
        ? prepareDependencies({
            home,
            dependency: input.preparation,
            signal,
            onEvent,
          })
        : installNativeSource({
            ...input,
            name: input.instance,
            home,
            repo: sourceRepo,
            externalComputer,
            signal,
            onEvent,
          })) as RunInstallation,
    environment: () =>
      checkNativeSourceEnvironment({
        repo: sourceRepo,
        home,
        signal: AbortSignal.timeout(45000),
      }),
    async config(
      name: string,
    ): Promise<components["schemas"]["InstallerConfig"]> {
      const value = await instance(name);
      let accountExists = false,
        email = "owner@linger.local";
      if (value)
        try {
          const login = await readLocalLogin(value);
          if (login) {
            email = login.email;
            accountExists = true;
          }
        } catch {
          // Configuration remains readable before the private account is provisioned.
        }
      return {
        setupChoice: await readSetupChoice({ name, home }),
        shareGpu: (await readGpuSharing({ name, home })) ?? DEFAULT_GPU_SHARING,
        instance: name,
        dataDir: value?.root ?? path.join(home, "instances", name),
        email,
        computerName: value?.computerName ?? hostname(),
        releaseAvailable: true,
        accountExists,
        ...(value ? { port: value.port } : {}),
        ...(value?.model
          ? {
              model: {
                baseUrl: value.model.baseUrl,
                model: value.model.model,
                keySaved: true,
              },
            }
          : {}),
        ...(value ? { runtimeModel: await readManagedModel(value.root) } : {}),
      };
    },
    async instances(): Promise<components["schemas"]["InstanceSummary"][]> {
      let names: string[];
      try {
        names = await readdir(path.join(home, "instances"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const result: components["schemas"]["InstanceSummary"][] = [];
      for (const name of names) {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) continue;
        const item = await instance(name);
        if (item)
          result.push({
            name: item.name,
            origin: item.origin,
            mode: item.mode,
          });
      }
      return result;
    },
    async status(name: string) {
      const value = await instance(name);
      if (!value) return undefined;
      const signal = AbortSignal.timeout(20000);
      const [services, computer] = await Promise.all([
        probeNativeSourceServices(value, signal),
        inspectComputer(value, { signal }),
      ]);
      return {
        origin: value.origin,
        services,
        computer: publicComputer(computer),
        knowledge: value.model
          ? "configured_not_live_verified"
          : "action_required",
        businessVerification: "not_run",
      };
    },
    // What an external Computer (the desktop's) needs to find the runtime
    // this installer manages: the paths the CLI's Computer gets in its
    // environment, without the rest of that environment.
    async runtime(
      name: string,
    ): Promise<components["schemas"]["InstanceRuntime"] | undefined> {
      const value = await instance(name);
      if (!value) return undefined;
      const setupChoice = await readSetupChoice({ name, home });
      const found = {
        ...(await managedRuntimeEnvironment(home, value.root)),
        ...(await localModelsEnvironment(value)),
      };
      const environment: Record<string, string> = {};
      for (const key of RUNTIME_ENVIRONMENT) {
        const entry = found[key];
        if (entry && path.isAbsolute(entry)) environment[key] = entry;
      }
      return { ...(setupChoice ? { setupChoice } : {}), environment };
    },
    async login(name: string) {
      const value = await instance(name);
      if (!value) return undefined;
      const login = await readLocalLogin(value);
      return login
        ? { email: login.email, password: login.password, origin: value.origin }
        : undefined;
    },
    async target(name: string, kind: "data" | "product") {
      const value = await instance(name);
      return value ? (kind === "data" ? value.root : value.origin) : undefined;
    },
    async stop(name: string) {
      const value = await instance(name);
      if (!value) return false;
      await stopNativeSource(value, AbortSignal.timeout(120000));
      return true;
    },
  };
}
