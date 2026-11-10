import type { ComputerRelease } from "../../../src/agent/runner-gateway/computer-release.js";
import {
  RunnerGateway,
  type RunnerGatewayOptions,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import {
  createTestLocalComputerRegistry,
  type TestLocalComputerRegistry,
} from "./local-computer-registry.js";

export { testRegistrationId } from "./local-computer-registry.js";

const testReleaseTargets = {
  "linux-x64": {
    app: {
      file: `app-linux-x64-${"a".repeat(64)}.tar.gz`,
      sha256: "a".repeat(64),
      size: 10,
    },
    deps: {
      file: `deps-linux-x64-${"d".repeat(64)}.tar.gz`,
      sha256: "d".repeat(64),
      size: 20,
    },
  },
};
/** The Computer release test gateways ship unless a test passes `computerRelease: undefined`. */
export const testComputerRelease: ComputerRelease = {
  root: "/nonexistent/computer-release",
  version: "0.40.0",
  targets: testReleaseTargets,
  installerTemplate: "",
  uninstallerTemplate: "",
  windowsInstallerTemplate: "",
  windowsUninstallerTemplate: "",
};

const testRegistries = new WeakMap<RunnerGateway, TestLocalComputerRegistry>();

/**
 * Production reads Computers and placements from TeamHub. Test gateways read
 * them from a test registry and accept every Daemon Identity proof.
 */
export const createTestRunnerGateway = (
  options: Partial<RunnerGatewayOptions> & {
    readonly computerRegistry?: TestLocalComputerRegistry;
  } = {},
): RunnerGateway => {
  const computerRegistry =
    options.computerRegistry ?? createTestLocalComputerRegistry();
  const gateway = new RunnerGateway({
    ...options,
    computerRegistry,
    computerRelease:
      "computerRelease" in options
        ? options.computerRelease
        : testComputerRelease,
    computerDaemonIdentityVerifier: options.computerDaemonIdentityVerifier ?? {
      verify: () => {},
    },
  });
  testRegistries.set(gateway, computerRegistry);
  return gateway;
};

/** The registry a test gateway reads Computers and placements from. */
export const testRegistryOf = (
  gateway: RunnerGateway,
): TestLocalComputerRegistry => {
  const registry = testRegistries.get(gateway);
  if (!registry) throw new Error("Not a test Runner Gateway");
  return registry;
};
