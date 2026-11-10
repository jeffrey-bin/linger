import { expect, it } from "vitest";
import {
  localmodelsFailure,
  redactLocalmodelsOutput,
} from "./localmodels-failure.js";

const args = ["gateway", "ensure", "--root", "/private/root", "--jsonl"];

it("reads the cause from the JSONL error line after progress events", () => {
  const progress = JSON.stringify({
    kind: "progress",
    stage: "download",
    completed: 10,
    total: 100,
    unit: "bytes",
  });
  const failure = localmodelsFailure(args, {
    code: 1,
    stdout: [
      progress,
      progress,
      JSON.stringify({
        schema: "localmodels.gateway-error/v1",
        code: "GATEWAY_DOWNLOAD_FAILED",
        message:
          "Download of magpie-cli-darwin-arm64 from github.com failed: host name lookup failed.",
        host: "github.com",
        reason: "host name lookup failed",
      }),
    ].join("\n"),
    stderr: "",
  });
  expect(failure).toMatchObject({
    code: "GATEWAY_DOWNLOAD_FAILED",
    cause:
      "Download of magpie-cli-darwin-arm64 from github.com failed: host name lookup failed.",
  });
  const log = failure.log.join("");
  expect(log).toContain("localmodels gateway ensure exited with code 1");
  expect(log).toContain("GATEWAY_DOWNLOAD_FAILED");
  expect(log).not.toContain('"progress"');
});

it("accepts a kind error event and falls back to its reason", () => {
  expect(
    localmodelsFailure(args, {
      code: 1,
      stdout: JSON.stringify({ kind: "error", reason: "disk full" }),
      stderr: "",
    }).cause,
  ).toBe("disk full");
});

it("uses a short tail of stderr when no error line was printed", () => {
  const failure = localmodelsFailure(args, {
    code: 1,
    stdout: "",
    stderr: [
      "Traceback (most recent call last):",
      '  File "gateway_cli.py", line 279, in ensure',
      "    raise RuntimeError(...)",
      "RuntimeError: Selected runtime must be prepared before gateway ensure",
      "",
    ].join("\n"),
  });
  expect(failure.code).toBeUndefined();
  expect(failure.cause).toMatch(
    /RuntimeError: Selected runtime must be prepared before gateway ensure$/,
  );
  expect(failure.cause).not.toContain("Traceback");
  expect(failure.log.join("")).toContain("Traceback (most recent call last)");
});

it("has no cause when the process printed nothing", () => {
  expect(
    localmodelsFailure(args, { code: 143, stdout: "", stderr: "" }),
  ).toMatchObject({
    cause: undefined,
    log: ["localmodels gateway ensure exited with code 143."],
  });
});

it("redacts credentials from the cause and the log", () => {
  const secrets = [
    "Authorization: Bearer abc.def.ghi",
    "api_key=sk-ant-0123456789abcdefghij",
    "https://user:pa55word@proxy.example/x",
    "https://objects.githubusercontent.com/a/b?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA",
    "token: ghp_0123456789abcdefghijklmn",
    "plain sk-proj-0123456789abcdefghij",
  ];
  const failure = localmodelsFailure(args, {
    code: 1,
    stdout: JSON.stringify({
      schema: "localmodels.gateway-error/v1",
      code: "GATEWAY_DOWNLOAD_FAILED",
      message: `failed via ${secrets[3]} with ${secrets[0]}`,
    }),
    stderr: secrets.join("\n"),
  });
  const text = `${failure.cause}\n${failure.log.join("")}`;
  for (const value of [
    "abc.def.ghi",
    "sk-ant-0123456789abcdefghij",
    "pa55word",
    "deadbeef",
    "AKIA",
    "ghp_0123456789abcdefghijklmn",
    "sk-proj-0123456789abcdefghij",
  ])
    expect(text).not.toContain(value);
  expect(failure.cause).toContain(
    "https://objects.githubusercontent.com/a/b?[REDACTED]",
  );
  expect(redactLocalmodelsOutput("a\u0007b\u001b[31mc")).toBe("abc");
});

it("keeps the end of long output within bounded log events", () => {
  const failure = localmodelsFailure(args, {
    code: 1,
    stdout: "",
    stderr: `${"x".repeat(40_000)}\nfinal cause`,
  });
  expect(failure.log.length).toBeLessThanOrEqual(9);
  expect(failure.log.every((part) => part.length <= 1800)).toBe(true);
  expect(failure.log[1]).toBe("[earlier output omitted]");
  expect(failure.log.at(-1)).toMatch(/final cause$/);
  expect(failure.cause).toMatch(/final cause$/);
});
