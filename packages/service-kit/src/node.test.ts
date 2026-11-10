import { describe, expect, it } from "vitest";

import { createJsonLogger, sha256Hex } from "./node.js";

describe("sha256Hex", () => {
  it("hashes strings as UTF-8 and bytes identically", () => {
    const expected =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256Hex("abc")).toBe(expected);
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(expected);
    expect(sha256Hex("é")).toBe(sha256Hex(new TextEncoder().encode("é")));
  });
});

const capture = (
  options: Partial<Parameters<typeof createJsonLogger>[0]> = {},
) => {
  const lines: string[] = [];
  const logger = createJsonLogger({
    service: "svc",
    write: (line) => lines.push(line),
    ...options,
  });
  const entries = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, entries };
};

describe("createJsonLogger", () => {
  it("writes one JSON line with time, level, service, event, and fields", () => {
    const { logger, entries } = capture();
    logger.log("info", "area.thing_happened", { count: 2 });
    const [entry] = entries();
    expect(Object.keys(entry ?? {}).slice(0, 4)).toEqual([
      "time",
      "level",
      "service",
      "event",
    ]);
    expect(entry).toMatchObject({
      level: "info",
      service: "svc",
      event: "area.thing_happened",
      count: 2,
    });
    expect(Number.isNaN(Date.parse(String(entry?.time)))).toBe(false);
  });

  it("merges child fields, with call fields taking precedence", () => {
    const { logger, entries } = capture();
    const child = logger.child({ role: "memory", n: 1 }).child({ n: 2 });
    child.log("warn", "a.b", { extra: true });
    child.log("warn", "a.c", { n: 3 });
    expect(entries()[0]).toMatchObject({ role: "memory", n: 2, extra: true });
    expect(entries()[1]).toMatchObject({ n: 3 });
  });

  it("keeps reserved keys when fields reuse their names", () => {
    const { logger, entries } = capture();
    logger.child({ service: "other" }).log("info", "a.b", {
      level: "debug",
      event: "x",
      time: "never",
    });
    const [entry] = entries();
    expect(entry).toMatchObject({
      level: "info",
      service: "svc",
      event: "a.b",
    });
    expect(entry?.time).not.toBe("never");
  });

  it("filters by level and supports off", () => {
    const warn = capture({ level: "warn" });
    warn.logger.log("info", "a.b");
    warn.logger.log("error", "a.c");
    expect(warn.entries().map((entry) => entry.event)).toEqual(["a.c"]);

    const off = capture({ level: "off" });
    off.logger.log("error", "a.b");
    expect(off.lines).toEqual([]);

    const dflt = capture();
    dflt.logger.log("debug", "a.b");
    expect(dflt.lines).toEqual([]);
  });

  it("redacts sensitive keys at any depth but not change tokens", () => {
    const { logger, entries } = capture();
    logger.log("info", "a.b", {
      authorization: "Bearer x",
      apiKey: "k",
      service_token: "t",
      headers: { cookie: "c", accept: "json" },
      list: [{ password: "p" }],
      changeToken: "visible",
    });
    expect(entries()[0]).toMatchObject({
      authorization: "[Redacted]",
      apiKey: "[Redacted]",
      service_token: "[Redacted]",
      headers: { cookie: "[Redacted]", accept: "json" },
      list: [{ password: "[Redacted]" }],
      changeToken: "visible",
    });
  });

  it("serializes errors with bounded causes and no stack below debug", () => {
    const { logger, entries } = capture();
    const root = new Error("root");
    const error = new Error("top", {
      cause: new Error("l1", {
        cause: new Error("l2", { cause: new Error("l3", { cause: root }) }),
      }),
    });
    Object.assign(error, { code: "E_TOP" });
    logger.log("error", "a.b", { error });
    const serialized = entries()[0]?.error as Record<string, unknown>;
    expect(serialized).toMatchObject({
      name: "Error",
      message: "top",
      code: "E_TOP",
    });
    expect(serialized).not.toHaveProperty("stack");
    const l1 = serialized.cause as Record<string, unknown>;
    const l2 = l1.cause as Record<string, unknown>;
    const l3 = l2.cause as Record<string, unknown>;
    expect(l3.message).toBe("l3");
    expect(l3).not.toHaveProperty("cause");
  });

  it("includes the stack only at debug level", () => {
    const { logger, entries } = capture({ level: "debug" });
    logger.log("debug", "a.b", { error: new Error("x") });
    expect(entries()[0]?.error).toHaveProperty("stack");
  });

  it("does not throw on bigint, circular, or throwing values", () => {
    const { logger, entries, lines } = capture();
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const cyclicError = new Error("e");
    cyclicError.cause = cyclicError;
    expect(() =>
      logger.log("info", "a.b", {
        big: 10n,
        circular,
        cyclicError,
      }),
    ).not.toThrow();
    expect(entries()[0]).toMatchObject({
      big: "10",
      circular: { name: "loop", self: "[Circular]" },
      cyclicError: { name: "Error", message: "e", cause: "[Circular]" },
    });

    const hostile = {
      get boom(): never {
        throw new Error("getter");
      },
    };
    expect(() => logger.log("info", "a.c", { hostile })).not.toThrow();
    expect(lines).toHaveLength(2);
    expect(entries()[1]).toMatchObject({ event: "a.c" });
  });

  it("does not report a repeated shared object as circular", () => {
    const { logger, entries } = capture();
    const shared = { a: 1 };
    logger.log("info", "a.b", { x: shared, y: shared });
    expect(entries()[0]).toMatchObject({ x: { a: 1 }, y: { a: 1 } });
  });

  it("swallows write failures", () => {
    const logger = createJsonLogger({
      service: "svc",
      write: () => {
        throw new Error("sink");
      },
    });
    expect(() => logger.log("error", "a.b")).not.toThrow();
  });
});
