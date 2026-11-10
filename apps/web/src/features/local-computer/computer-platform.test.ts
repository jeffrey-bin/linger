import { expect, it } from "vitest";

import { computerEnvironmentName } from "./computer-platform";

// scripts/local-computer-installer.test.ts holds the installer's side of these.
it.each([
  ["https://ci-linger.example.org", "ci"],
  ["https://staging-linger.example.net", "staging"],
  ["https://dev-local.example.net", "dev-local"],
  ["https://linger.example.com", "linger"],
  ["http://localhost:3000", "local-3000"],
  ["http://127.0.0.1:23300", "local-23300"],
  ["http://[::1]:8080", "local-8080"],
  ["https://preview.localhost", "local"],
  ["http://10.0.0.5:31037", "ip-10-0-0-5-31037"],
  ["https://[fe80::1]", "ip-fe80--1"],
  ["http://app.example.com:8443", "app-8443"],
])("names the Computer environment of %s %s", (origin, name) => {
  expect(computerEnvironmentName(origin)).toBe(name);
});
