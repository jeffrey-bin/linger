import { createHash, generateKeyPairSync, sign } from "node:crypto";

import type { RunnerHello } from "@linger/wire-contracts/runner-gateway/types";
import { describe, expect, it } from "vitest";

import {
  computerDaemonIdentityProofPayload,
  createComputerDaemonIdentityVerifier,
} from "../../../src/agent/runner-gateway/daemon-identity-verifier.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import { CURRENT_RUNNER_CAPABILITIES } from "../test-support/runner-capabilities.js";

describe("Computer Daemon Identity verifier", () => {
  it("accepts one fresh Ed25519 proof once", () => {
    const hello = signedHello();
    const verifier = createComputerDaemonIdentityVerifier({
      now: () => Date.parse(hello.sent_at),
    });
    expect(() =>
      verifier.verify({ computerId: hello.runner_id, hello }),
    ).not.toThrow();
    expect(() =>
      verifier.verify({ computerId: hello.runner_id, hello }),
    ).toThrow("replayed");
  });

  it("rejects a forged identity and a stale proof", () => {
    const hello = signedHello();
    const now = Date.parse(hello.sent_at);
    const forged = structuredClone(hello);
    forged.daemon_identity.daemon_id =
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    expect(() =>
      createComputerDaemonIdentityVerifier({ now: () => now }).verify({
        computerId: forged.runner_id,
        hello: forged,
      }),
    ).toThrow("does not match");
    expect(() =>
      createComputerDaemonIdentityVerifier({
        now: () => now + 10 * 60 * 1_000,
      }).verify({ computerId: hello.runner_id, hello }),
    ).toThrow("stale");
  });

  it.each([
    { offset: -300_001, reason: "future" },
    { offset: 300_001, reason: "past" },
    { offset: 0, reason: "unparseable" },
  ] as const)(
    "reports safe typed stale diagnostics: $reason",
    ({ offset, reason }) => {
      const hello = signedHello(
        reason === "unparseable" ? "invalid-time" : undefined,
      );
      const serverTimeMs = Date.parse("2026-09-02T12:00:00Z") + offset;
      const verifier = createComputerDaemonIdentityVerifier({
        now: () => serverTimeMs,
      });
      let error: unknown;
      try {
        verifier.verify({ computerId: hello.runner_id, hello });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: "ComputerDaemonIdentityStaleError",
        reason,
        sentAt: hello.sent_at,
        serverTimeMs,
        differenceMs: reason === "unparseable" ? null : offset,
        proofMaxAgeMs: 300_000,
      });
      expect(JSON.stringify(error)).not.toContain(hello.daemon_identity.proof);
      expect(JSON.stringify(error)).not.toContain(
        hello.daemon_identity.public_key,
      );
    },
  );

  it.each([-300_000, 300_000])(
    "accepts the exact freshness boundary %i",
    (offset) => {
      const hello = signedHello();
      expect(() =>
        createComputerDaemonIdentityVerifier({
          now: () => Date.parse(hello.sent_at) + offset,
        }).verify({ computerId: hello.runner_id, hello }),
      ).not.toThrow();
    },
  );

  it("rejects a damaged signature", () => {
    const hello = signedHello();
    hello.daemon_identity.proof = Buffer.alloc(64).toString("base64");
    expect(() =>
      createComputerDaemonIdentityVerifier({
        now: () => Date.parse(hello.sent_at),
      }).verify({ computerId: hello.runner_id, hello }),
    ).toThrow("invalid");
  });
});

const signedHello = (sentAt = "2026-09-02T12:00:00Z"): RunnerHello => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = publicDer.subarray(publicDer.byteLength - 32);
  const hello: RunnerHello = {
    type: "runner.hello",
    platform: "darwin",
    daemon_version: "dev",
    protocol_version: "2",
    runner_id: "computer-local",
    connection_nonce: "nonce-daemon-identity-test",
    sent_at: sentAt,
    runtimes: ["codex"],
    runtime_diagnostics: runtimeDiagnostics({ ready: ["codex"] }),
    capabilities: [...CURRENT_RUNNER_CAPABILITIES],
    workspace_grants: [],
    agent_runners: [],
    active_operations: [],
    runtime_registrations: [],
    daemon_identity: {
      daemon_id: createHash("sha256").update(rawPublicKey).digest("base64url"),
      public_key: rawPublicKey.toString("base64"),
      identity_version: 1,
      proof: "",
    },
  };
  hello.daemon_identity.proof = sign(
    null,
    computerDaemonIdentityProofPayload(hello),
    privateKey,
  ).toString("base64");
  return hello;
};
