// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeClipboardText } from "./clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "clipboard",
);
const originalExecCommand = document.execCommand;

describe("clipboard fallback", () => {
  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(
        Navigator.prototype,
        "clipboard",
        originalClipboard,
      );
    } else {
      Reflect.deleteProperty(Navigator.prototype, "clipboard");
    }
    document.execCommand = originalExecCommand;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("uses the browser copy command when Clipboard API access is rejected", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    document.execCommand = vi.fn(() => true);

    await expect(writeClipboardText("copy me")).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("keeps the fallback control inside the active modal dialog", async () => {
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const copyButton = document.createElement("button");
    dialog.append(copyButton);
    document.body.append(dialog);
    copyButton.focus();
    document.execCommand = vi.fn(() =>
      Boolean(document.querySelector("textarea")?.closest("dialog[open]")),
    );

    await expect(writeClipboardText("copy me")).resolves.toBeUndefined();

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.activeElement).toBe(copyButton);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it.each([
    ["returns false", vi.fn(() => false)],
    [
      "throws",
      vi.fn(() => {
        throw new Error("copy failed");
      }),
    ],
  ])(
    "restores focus and selection when execCommand %s",
    async (_label, execCommand) => {
      Object.defineProperty(Navigator.prototype, "clipboard", {
        configurable: true,
        value: undefined,
      });
      document.execCommand = execCommand;
      const input = document.createElement("input");
      input.value = "before and after";
      document.body.append(input);
      input.focus();
      input.setSelectionRange(3, 9, "forward");

      await expect(writeClipboardText("copy me")).rejects.toThrow();

      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(3);
      expect(input.selectionEnd).toBe(9);
      expect(document.querySelector("textarea")).toBeNull();
    },
  );
});
