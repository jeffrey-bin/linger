import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { serviceCredential } from "./node.js";

// Shared with TeamHub's service_credentials_test.go, so the TypeScript and Go
// derivations agree.
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/fixtures/service-credentials/vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { vectors: { seed: string; label: string; credential: string }[] };

describe("serviceCredential", () => {
  it("derives every shared vector exactly as TeamHub does", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
    for (const vector of fixture.vectors) {
      expect(
        serviceCredential(vector.label, {
          LINGER_SECRET_SEED: vector.seed,
        }),
      ).toBe(vector.credential);
    }
  });

  it("needs a long enough seed", () => {
    expect(serviceCredential("teamhub-internal", {})).toBeUndefined();
    expect(() =>
      serviceCredential("teamhub-internal", { LINGER_SECRET_SEED: "short" }),
    ).toThrow("at least 32 characters");
  });
});
