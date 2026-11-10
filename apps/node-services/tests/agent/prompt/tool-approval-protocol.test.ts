import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TOOL_APPROVAL_PROTOCOL } from "../../../src/agent/prompt/tool-approval-protocol.js";
import { PERMISSION_REVIEW_UNAVAILABLE } from "../../../src/agent/runner-gateway/remote-codex-provider.js";

const repoRoot = new URL("../../../../../", import.meta.url);

function readGoString(relativePath: string, pattern: RegExp): string {
  const source = readFileSync(new URL(relativePath, repoRoot), "utf8");
  const match = pattern.exec(source);
  if (!match) throw new Error(`no match for ${pattern} in ${relativePath}`);
  return match[1]!;
}

describe("tool-approval protocol", () => {
  const teamhubUnavailable = readGoString(
    "apps/teamhub/internal/permissionreview/service.go",
    /unavailableMessage\s*=\s*"([^"]*)"/u,
  );
  const daemonUnavailable = readGoString(
    "apps/computer/local-daemon/internal/permission/action.go",
    /const UnavailableMessage = "([^"]*)"/u,
  );

  it("keeps the unavailable notice byte-identical across TeamHub, the daemon, and node-services", () => {
    expect(PERMISSION_REVIEW_UNAVAILABLE).toBe(teamhubUnavailable);
    expect(daemonUnavailable).toBe(teamhubUnavailable);
  });

  it("quotes the exact prefixes of the TeamHub and TS notices", () => {
    const unavailablePrefix = PERMISSION_REVIEW_UNAVAILABLE.split(", so")[0]!;
    expect(TOOL_APPROVAL_PROTOCOL).toContain(`"${unavailablePrefix}`);

    const approvalMessage = readGoString(
      "apps/teamhub/internal/permissionreview/service.go",
      /approvalMessage\s*=\s*"([^"]*)"/u,
    );
    const approvalPrefix = approvalMessage.split(" %s")[0]!;
    expect(TOOL_APPROVAL_PROTOCOL).toContain(
      `"${approvalPrefix} <id> has been sent`,
    );

    const denyMessage = readGoString(
      "apps/teamhub/internal/permissionreview/service.go",
      /denyMessage\s*=\s*"([^"]*)"/u,
    );
    const denyPrefix = denyMessage.split(": %s")[0]!;
    expect(TOOL_APPROVAL_PROTOCOL).toContain(`"${denyPrefix}`);

    const granted = readGoString(
      "apps/teamhub/internal/typedcard/decision_runtime_permission.go",
      /"(Approval %s was granted:)/u,
    );
    expect(TOOL_APPROVAL_PROTOCOL).toContain(
      `"${granted.replace("%s", "<id>")}"`,
    );
  });
});
