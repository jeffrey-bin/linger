import type {
  RunnerCapability,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";

// A current Computer declares only host features; these fixtures have none.
export const CURRENT_RUNNER_CAPABILITIES: readonly RunnerCapability[] = [];

// Every hello carries a Daemon Identity proof and Runtime Registration
// observations. Test authorities accept the proof without verifying it.
export const currentRunnerIdentity = (): Pick<
  RunnerHello,
  "daemon_identity" | "runtime_registrations"
> => ({
  daemon_identity: {
    daemon_id: "A".repeat(43),
    public_key: Buffer.alloc(32).toString("base64"),
    identity_version: 1,
    proof: Buffer.alloc(64).toString("base64"),
  },
  runtime_registrations: [],
});
