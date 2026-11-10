import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createRunnerCredentialTestFixture,
  signTestRunnerCredential,
  TEST_RUNNER_SIGNING_KEY,
} from "../test-support/runner-credential-authority.js";

// TeamHub's enrollment exchange signs this exact token in
// apps/teamhub/internal/app/local_computer_credential_test.go.
const TEAMHUB_SIGNED_VECTOR =
  "sr1.eyJjcmVkZW50aWFsX2dlbmVyYXRpb24iOjIsImV4cCI6MjAwMDAwMDAwMCwiaWF0IjoxNzAwMDAwMDAwLCJydW5uZXJfaWQiOiJjb21wdXRlcl8xIiwidGVuYW50X293bmVycyI6W3sib3duZXJfYWN0b3JfaWQiOiJhY3Rvcl9vd25lciIsInRlbmFudF9pZCI6InRlbmFudF8xIn1dLCJ2IjoxfQ.gm_cetXEmBKmoORdn9iy3oBzzcr6zuj70O8Beyw5qMQ";

describe("TeamHubRunnerCredentialAuthority", () => {
  it("verifies the credential TeamHub signs", async () => {
    const fixture = createRunnerCredentialTestFixture({
      now: () => 1_700_000_000_000,
    });
    fixture.credentialGeneration.mockImplementation(
      async (computerId, owner) =>
        computerId === "computer_1" &&
        owner.tenantId === "tenant_1" &&
        owner.ownerActorId === "actor_owner"
          ? 2
          : null,
    );
    await expect(
      fixture.authority.authenticate(`Bearer ${TEAMHUB_SIGNED_VECTOR}`),
    ).resolves.toEqual({
      runnerId: "computer_1",
      tenantOwners: [{ ownerActorId: "actor_owner", tenantId: "tenant_1" }],
      credentialGeneration: 2,
      expiresAtMs: 2_000_000_000_000,
      token: TEAMHUB_SIGNED_VECTOR,
    });
    await expect(
      fixture.authority.authenticate(`Bearer ${TEAMHUB_SIGNED_VECTOR}x`),
    ).resolves.toBeNull();
  });

  it("accepts only the Computer's current credential generation", async () => {
    const fixture = createRunnerCredentialTestFixture();
    const first = fixture.enroll("computer_mac");
    await expect(
      fixture.authority.authenticate(`Bearer ${first.gatewayToken}`),
    ).resolves.toMatchObject({
      runnerId: "computer_mac",
      credentialGeneration: 0,
    });

    const renewed = fixture.enroll("computer_mac");
    await expect(
      fixture.authority.authenticate(`Bearer ${renewed.gatewayToken}`),
    ).resolves.toMatchObject({
      runnerId: "computer_mac",
      credentialGeneration: 1,
    });
    await expect(
      fixture.authority.authenticate(`Bearer ${first.gatewayToken}`),
    ).resolves.toBeNull();
  });

  it("rejects a credential TeamHub did not commit", async () => {
    const fixture = createRunnerCredentialTestFixture();
    const forged = signTestRunnerCredential({ computerId: "computer_unknown" });

    await expect(
      fixture.authority.authenticate(`Bearer ${forged.gatewayToken}`),
    ).resolves.toBeNull();
    expect(fixture.credentialGeneration).toHaveBeenCalledOnce();
  });

  it("rejects a token signed with another key without asking TeamHub", async () => {
    const fixture = createRunnerCredentialTestFixture();
    fixture.enroll("computer_1");
    const foreign = signTestRunnerCredential({
      computerId: "computer_1",
      signingKey: `${TEST_RUNNER_SIGNING_KEY}-other`,
    });

    await expect(
      fixture.authority.authenticate(`Bearer ${foreign.gatewayToken}`),
    ).resolves.toBeNull();
    expect(fixture.credentialGeneration).not.toHaveBeenCalled();
  });

  it("rejects a signed credential without a credential generation", async () => {
    const fixture = createRunnerCredentialTestFixture();
    const credential = fixture.enroll("computer_1");
    const [prefix, payload] = credential.gatewayToken.split(".") as [
      string,
      string,
    ];
    const { credential_generation: _generation, ...claims } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const unsigned = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const signature = createHmac("sha256", TEST_RUNNER_SIGNING_KEY)
      .update(unsigned)
      .digest("base64url");

    await expect(
      fixture.authority.authenticate(`Bearer ${unsigned}.${signature}`),
    ).resolves.toBeNull();
  });
});
