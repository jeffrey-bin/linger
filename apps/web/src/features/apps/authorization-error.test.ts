import { describe, expect, it } from "vitest";

import {
  INSUFFICIENT_PERMISSION_MESSAGE,
  connectionAuthorizationError,
  connectionStatusErrorMessage,
} from "./authorization-error";

describe("authorization error copy", () => {
  it("explains insufficient provider permission", () => {
    expect(connectionStatusErrorMessage("provider_auth_failed")).toBe(
      INSUFFICIENT_PERMISSION_MESSAGE,
    );
    expect(
      connectionAuthorizationError({
        status: "failed",
        status_error_code: "provider_auth_failed",
      }),
    ).toBe(INSUFFICIENT_PERMISSION_MESSAGE);
  });

  it("falls back for a failed authorization without a specific code", () => {
    expect(connectionAuthorizationError({ status: "failed" })).toBe(
      "Authorization failed. Reconnect this app and approve the requested access.",
    );
    expect(connectionAuthorizationError({ status: "pending" })).toBeUndefined();
  });
});
