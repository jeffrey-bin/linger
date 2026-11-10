import { describe, expect, it } from "vitest";

import {
  asError,
  displayText,
  isNodeError,
  isRecord,
  requestBodyText,
  requestUrlText,
  sleep,
} from "./index.js";

describe("isRecord", () => {
  it("accepts objects and rejects arrays, null, and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("isNodeError", () => {
  it("requires an Error with a string code and optionally matches it", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(isNodeError(error)).toBe(true);
    expect(isNodeError(error, "ENOENT")).toBe(true);
    expect(isNodeError(error, "EACCES")).toBe(false);
    expect(isNodeError(new Error("plain"))).toBe(false);
    expect(isNodeError({ code: "ENOENT" })).toBe(false);
    expect(isNodeError(Object.assign(new Error("x"), { code: 1 }))).toBe(false);
  });
});

describe("asError", () => {
  it("returns Errors as is and wraps everything else with a cause", () => {
    const error = new Error("boom");
    expect(asError(error)).toBe(error);
    expect(asError("text").message).toBe("text");
    const wrapped = asError({ reason: 1 });
    expect(wrapped.message).toBe("Unknown error");
    expect(wrapped.cause).toEqual({ reason: 1 });
  });
});

describe("displayText", () => {
  it("renders strings, URLs, structures, and primitives", () => {
    expect(displayText("a")).toBe("a");
    expect(displayText(new URL("https://example.com/x"))).toBe(
      "https://example.com/x",
    );
    expect(displayText({ a: 1 })).toBe('{"a":1}');
    expect(displayText([1, 2])).toBe("[1,2]");
    expect(displayText(null)).toBe("null");
    expect(displayText(7)).toBe("7");
    expect(displayText(undefined)).toBe("undefined");
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });

  it("rejects with the abort reason, before or during the wait", async () => {
    const reason = new Error("stop");
    const aborted = AbortSignal.abort(reason);
    await expect(sleep(10_000, aborted)).rejects.toBe(reason);

    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("request text helpers", () => {
  it("extracts URL text from fetch inputs", () => {
    expect(requestUrlText("https://a.test/")).toBe("https://a.test/");
    expect(requestUrlText(new URL("https://a.test/b"))).toBe(
      "https://a.test/b",
    );
    expect(requestUrlText(new Request("https://a.test/c"))).toBe(
      "https://a.test/c",
    );
    expect(requestUrlText(undefined)).toBeUndefined();
  });

  it("requires string request bodies", () => {
    expect(requestBodyText("{}")).toBe("{}");
    expect(() => requestBodyText(null)).toThrow(TypeError);
  });
});
