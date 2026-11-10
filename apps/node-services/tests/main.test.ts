import { describe, expect, it } from "vitest";

import { readHttpAddress, selectRoles } from "../src/main.js";

describe("selectRoles", () => {
  it("starts every role when NODE_SERVICES_ROLES is unset or empty", () => {
    const all = ["memory", "llm-wiki", "agent", "voice", "document"];
    expect(selectRoles(undefined)).toEqual(all);
    expect(selectRoles(" , ")).toEqual(all);
  });

  it("keeps the host's start order without duplicates", () => {
    expect(selectRoles("agent, llm-wiki, memory,llm-wiki")).toEqual([
      "memory",
      "llm-wiki",
      "agent",
    ]);
  });

  it("rejects unknown roles", () => {
    expect(() => selectRoles("memory,skill-indexer")).toThrow(
      "NODE_SERVICES_ROLES contains unknown roles: skill-indexer",
    );
  });
});

describe("readHttpAddress", () => {
  it("defaults to the loopback listener on 4319", () => {
    expect(readHttpAddress({})).toEqual({ host: "127.0.0.1", port: 4319 });
  });

  it("reads host:port, [ipv6]:port and :port for every interface", () => {
    expect(
      readHttpAddress({ NODE_SERVICES_HTTP_ADDRESS: "10.0.0.5:5000" }),
    ).toEqual({ host: "10.0.0.5", port: 5000 });
    expect(
      readHttpAddress({ NODE_SERVICES_HTTP_ADDRESS: "[::1]:5000" }),
    ).toEqual({ host: "::1", port: 5000 });
    expect(readHttpAddress({ NODE_SERVICES_HTTP_ADDRESS: ":5000" })).toEqual({
      host: "0.0.0.0",
      port: 5000,
    });
  });

  it("allows an ephemeral port only in tests", () => {
    expect(
      readHttpAddress({
        NODE_ENV: "test",
        NODE_SERVICES_HTTP_ADDRESS: "127.0.0.1:0",
      }),
    ).toEqual({ host: "127.0.0.1", port: 0 });
    for (const value of ["127.0.0.1:0", "127.0.0.1:4.5", "4319"])
      expect(() =>
        readHttpAddress({ NODE_SERVICES_HTTP_ADDRESS: value }),
      ).toThrow(
        "NODE_SERVICES_HTTP_ADDRESS must be host:port with a port between 1 and 65535",
      );
  });
});
