import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CredentialStore } from "./computer-credential.js";

const credential = {
  computerId: "computer-1",
  gatewayUrl: "wss://linger.example/v1/runner-gateway",
  token: "sr1.test-credential-0123456789abcdefghij",
};

const store = () => {
  const file = path.join(
    mkdtempSync(path.join(os.tmpdir(), "credential-")),
    "computer/credential.json",
  );
  return { file, credentials: new CredentialStore(file) };
};

describe("CredentialStore", () => {
  it("keeps the credential in an owner-only file", () => {
    const { file, credentials } = store();
    expect(credentials.read()).toBeUndefined();
    credentials.write(credential);
    expect(credentials.read()).toEqual(credential);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    credentials.clear();
    expect(credentials.read()).toBeUndefined();
  });

  it("treats a damaged file as missing", () => {
    const { file, credentials } = store();
    credentials.write(credential);
    writeFileSync(file, "{");
    expect(credentials.read()).toBeUndefined();
  });

  it("only accepts a WebSocket Gateway", () => {
    const { credentials } = store();
    expect(() =>
      credentials.write({
        ...credential,
        gatewayUrl: "https://linger.example",
      }),
    ).toThrow();
  });
});
