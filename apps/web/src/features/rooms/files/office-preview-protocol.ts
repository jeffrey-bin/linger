import { isRecord } from "@linger/service-kit";
export const officePreviewProtocol = "linger-office-preview-v1";

export type OfficePreviewErrorCode =
  | "encrypted-file"
  | "invalid-container"
  | "invalid-file"
  | "limit-exceeded"
  | "render-failed"
  | "timeout"
  | "unsupported-file";

export interface OfficePreviewRenderMessage {
  buffer: ArrayBuffer;
  filename: string;
  kind: "render";
  scrollPosition?: OfficeScrollPosition;
  mediaType: string;
  protocol: typeof officePreviewProtocol;
  requestId: string;
}

export interface OfficePreviewProbeMessage {
  kind: "probe";
  protocol: typeof officePreviewProtocol;
}

export interface OfficeScrollPosition {
  top: number;
  left: number;
}

export type OfficePreviewFrameMessage =
  | {
      kind: "scroll";
      position: OfficeScrollPosition;
      protocol: typeof officePreviewProtocol;
      requestId: string;
    }
  | {
      kind: "ready";
      protocol: typeof officePreviewProtocol;
    }
  | {
      kind: "loaded";
      protocol: typeof officePreviewProtocol;
      requestId: string;
    }
  | {
      code: OfficePreviewErrorCode;
      detail?: string;
      kind: "error";
      protocol: typeof officePreviewProtocol;
      requestId: string;
    };

export interface OfficePreviewPreflightRequest {
  buffer: ArrayBuffer;
  filename: string;
  mediaType: string;
  requestId: string;
}

export type OfficePreviewPreflightResponse =
  | {
      buffer: ArrayBuffer;
      kind: "passed";
      requestId: string;
    }
  | {
      code: OfficePreviewErrorCode;
      detail?: string;
      kind: "failed";
      requestId: string;
    };

const officePreviewErrorCodes = new Set<OfficePreviewErrorCode>([
  "encrypted-file",
  "invalid-container",
  "invalid-file",
  "limit-exceeded",
  "render-failed",
  "timeout",
  "unsupported-file",
]);

export function isOfficePreviewFrameMessage(
  value: unknown,
): value is OfficePreviewFrameMessage {
  if (!isRecord(value) || value.protocol !== officePreviewProtocol) {
    return false;
  }

  if (value.kind === "ready") {
    return true;
  }

  if (value.kind === "scroll") {
    return (
      typeof value.requestId === "string" &&
      isOfficeScrollPosition(value.position)
    );
  }
  if (value.kind === "loaded") {
    return typeof value.requestId === "string";
  }

  return (
    value.kind === "error" &&
    typeof value.requestId === "string" &&
    typeof value.code === "string" &&
    officePreviewErrorCodes.has(value.code as OfficePreviewErrorCode)
  );
}

export function isOfficeScrollPosition(
  value: unknown,
): value is OfficeScrollPosition {
  return (
    isRecord(value) &&
    typeof value.top === "number" &&
    Number.isFinite(value.top) &&
    value.top >= 0 &&
    typeof value.left === "number" &&
    Number.isFinite(value.left) &&
    value.left >= 0
  );
}
