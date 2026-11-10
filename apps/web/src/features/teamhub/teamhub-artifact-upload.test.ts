import { expect, it, vi } from "vitest";
import { uploadTeamHubFile } from "./teamhub-artifact-upload";

it.each([
  [
    "report.docx",
    "",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "report.XLSX",
    "application/octet-stream",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    "report.PpTx",
    "APPLICATION/OCTET-STREAM",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["report.docx", "application/pdf", "application/pdf"],
  ["report.docx", "application/zip", "application/zip"],
  ["report.unknown", "", "application/octet-stream"],
])("uploads %s with MIME %s as %s", async (name, type, expected) => {
  const onAuthenticationRequired = vi.fn();
  let submitted: FormData | undefined;
  const request = {
    upload: {},
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    status: 201,
    responseText: JSON.stringify({ id: "document_one" }),
    onload: () => {},
    send(body: FormData) {
      submitted = body;
      this.onload();
    },
  };
  await expect(
    uploadTeamHubFile({
      file: new File(["Office bytes"], name, { type }),
      idempotencyKey: "office-upload-operation",
      url: "/v0/tenants/tenant-northstar/documents/uploads",
      onAuthenticationRequired,
      xhrFactory: () => request as unknown as XMLHttpRequest,
    }),
  ).resolves.toEqual({ id: "document_one" });
  expect(submitted!.get("media_type")).toBe(expected);
  expect(submitted!.get("filename")).toBe(name);
  expect(submitted!.get("content")).toBeInstanceOf(File);
  expect(onAuthenticationRequired).not.toHaveBeenCalled();
});

it("names a proxy timeout instead of reporting the proxy body", async () => {
  const request = {
    upload: {},
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    status: 524,
    responseText: "error code: 524",
    onload: () => {},
    send() {
      this.onload();
    },
  };
  await expect(
    uploadTeamHubFile({
      file: new File(["large"], "large.zip"),
      idempotencyKey: "slow-upload-operation",
      url: "/v0/rooms/room-one/message-attachment-uploads",
      onAuthenticationRequired: vi.fn(),
      xhrFactory: () => request as unknown as XMLHttpRequest,
    }),
  ).rejects.toThrow(/timed out before it reached TeamHub \(HTTP 524\)/);
});
