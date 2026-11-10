import { describe, expect, it } from "vitest";
import { runtimeFailureMessage } from "./runtime-failure-message";

describe("Runtime failure messages", () => {
  it.each(["claude", "codex"] as const)(
    "describes the classified outcome for %s without infrastructure details",
    (runtime_type) => {
      const message = runtimeFailureMessage({
        code: "execution_outcome_unknown",
        runtime_type,
      });
      expect(message).toContain("A command was dispatched");
      expect(message).toContain("not automatically replayed");
      expect(message).toContain("Check its effects before retrying");
      expect(message).not.toMatch(
        /Pod|container|Kubernetes|token|network error/i,
      );
    },
  );

  it("tells people to choose another model when the account cannot use it", () => {
    const message = runtimeFailureMessage({
      code: "model_unavailable",
      runtime_type: "codex",
      runtime_version: "0.153.4",
    });
    expect(message).toContain("Codex 0.153.4");
    expect(message).toContain("Choose another model");
    expect(message).not.toMatch(/Check the Agent's computer/);
  });

  it("points to the Agent's settings when its Computer does not offer the model", () => {
    const message = runtimeFailureMessage({
      code: "model_not_offered",
      runtime_type: "codex",
    });
    expect(message).toContain("Codex:");
    expect(message).toContain("does not offer its selected model");
    expect(message).toContain("Open the Agent's settings");
  });

  it("says the Agent finished but its reply did not reach the Room", () => {
    const message = runtimeFailureMessage({
      code: "reply_undelivered",
      runtime_type: "pi",
    });
    expect(message).toContain("Pi:");
    expect(message).toContain("reply did not reach the Room");
    expect(message).toContain("TeamHub");
  });

  it("names a failure the Agent Service observed without a Runtime prefix", () => {
    expect(runtimeFailureMessage({ code: "interrupted" })).toMatch(
      /^The Run was interrupted before it finished/,
    );
    expect(runtimeFailureMessage({ code: "computer_unavailable" })).toContain(
      "Make sure the Computer is online",
    );
  });

  it.each([
    ["context_too_long", "context window"],
    ["model_service_error", "model service reported an internal error"],
    ["timeout", "time limit"],
    ["response_too_large", "larger than a Room message"],
    ["cleanup_unconfirmed", "could not be confirmed stopped"],
    ["unclassified", "could not identify"],
  ] as const)("gives %s its own cause", (code, cause) => {
    const message = runtimeFailureMessage({ code, runtime_type: "claude" });
    expect(message).toMatch(/^Claude: /);
    expect(message).toContain(cause);
  });

  it("only describes protocol errors as incompatible", () => {
    expect(
      runtimeFailureMessage({
        code: "protocol_incompatible",
        runtime_type: "codex",
        runtime_version: "0.153.4",
      }),
    ).toContain("protocol is incompatible");
    for (const code of [
      "authentication_required",
      "network_error",
      "rate_limited",
      "execution_failed",
    ] as const) {
      expect(
        runtimeFailureMessage({ code, runtime_type: "codex" }),
      ).not.toContain("incompatible");
    }
  });
  it("does not render raw version data or invent a version for legacy failures", () => {
    expect(
      runtimeFailureMessage({
        code: "execution_failed",
        runtime_type: "codex",
        runtime_version: "/private/token",
      }),
    ).not.toContain("private");
    expect(runtimeFailureMessage()).toBe("Run failed");
  });
});
