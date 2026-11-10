import { describe, expect, it } from "vitest";

import {
  isOfficePreviewFrameMessage,
  officePreviewProtocol,
} from "./office-preview-protocol";

describe("Office preview protocol", () => {
  it.each([
    undefined,
    null,
    { top: -1, left: 0 },
    { top: Infinity, left: 0 },
    { top: 2, left: NaN },
    { top: "10", left: 0 },
  ])("rejects invalid scroll offsets %j", (position) => {
    expect(
      isOfficePreviewFrameMessage({
        kind: "scroll",
        protocol: officePreviewProtocol,
        requestId: "current",
        position,
      }),
    ).toBe(false);
  });

  it("accepts only versioned frame messages", () => {
    expect(
      isOfficePreviewFrameMessage({
        kind: "loaded",
        protocol: officePreviewProtocol,
        requestId: "request-1",
      }),
    ).toBe(true);
    expect(
      isOfficePreviewFrameMessage({
        kind: "loaded",
        protocol: "unknown-preview-protocol",
        requestId: "request-1",
      }),
    ).toBe(false);
    expect(
      isOfficePreviewFrameMessage({
        kind: "loaded",
        protocol: officePreviewProtocol,
      }),
    ).toBe(false);
    expect(
      isOfficePreviewFrameMessage({
        code: "invented-error",
        kind: "error",
        protocol: officePreviewProtocol,
        requestId: "request-1",
      }),
    ).toBe(false);
  });
});
