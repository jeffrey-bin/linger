import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComputerSetupInstructions,
  CopyValueButton,
} from "./computer-setup-instructions";
import { ConnectComputerDialog } from "./computer-empty-states";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const originalSecureContextDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext",
);
const originalExecCommand = document.execCommand;

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }

  if (originalSecureContextDescriptor) {
    Object.defineProperty(
      window,
      "isSecureContext",
      originalSecureContextDescriptor,
    );
  } else {
    Reflect.deleteProperty(window, "isSecureContext");
  }

  document.execCommand = originalExecCommand;
  vi.restoreAllMocks();
});

describe("CopyValueButton", () => {
  it("lets a browser on macOS copy the command for a Windows computer", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<ComputerSetupInstructions />);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Computer operating system" }),
      { target: { value: "win32" } },
    );
    expect(screen.getByText(/Run these commands in PowerShell/)).toBeVisible();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Copy command" })[0]!,
    );
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "irm 'http://localhost:3000/install/linger-computer.ps1' | iex",
      ),
    );
    expect(screen.queryByText(/curl -fsSL/)).not.toBeInTheDocument();
  });

  it("initially selects Windows for a Windows browser", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    render(<ComputerSetupInstructions />);
    expect(
      screen.getByRole("combobox", { name: "Computer operating system" }),
    ).toHaveValue("win32");
    expect(screen.getByText(/linger-computer.ps1/)).toBeVisible();
  });

  it("copies both commands from the setup instructions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<ComputerSetupInstructions />);
    const buttons = screen.getAllByRole("button", { name: "Copy command" });

    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);

    await vi.waitFor(() =>
      expect(writeText).toHaveBeenNthCalledWith(
        1,
        'curl -fsSL "http://localhost:3000/install/linger-computer.sh" | bash',
      ),
    );
    expect(writeText).toHaveBeenNthCalledWith(
      2,
      "linger-computer-local-3000 login",
    );
  });

  it("copies both setup commands through the fallback inside the connection dialog", async () => {
    setSecureContext(false);
    setClipboard(undefined);
    const copiedValues: string[] = [];
    document.execCommand = vi.fn(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        "dialog[open] textarea",
      );
      if (!textarea) {
        return false;
      }
      copiedValues.push(textarea.value);
      return true;
    });
    render(
      <ConnectComputerDialog
        connected={false}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", {
      name: "Connect Local Computer",
    });
    const buttons = within(dialog).getAllByRole("button", {
      name: "Copy command",
    });

    buttons[0]!.focus();
    fireEvent.click(buttons[0]!);
    buttons[1]!.focus();
    fireEvent.click(buttons[1]!);

    await vi.waitFor(() =>
      expect(
        within(dialog).getAllByRole("button", { name: "Command copied" }),
      ).toHaveLength(2),
    );
    expect(copiedValues).toEqual([
      'curl -fsSL "http://localhost:3000/install/linger-computer.sh" | bash',
      "linger-computer-local-3000 login",
    ]);
  });

  it("uses the Clipboard API when the page has access to it", async () => {
    setSecureContext(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    renderCopyButton();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));

    expect(writeText).toHaveBeenCalledWith("linger-computer login");
    expect(
      await screen.findByRole("button", { name: "Command copied" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
  });

  it("copies through the browser fallback outside secure contexts", async () => {
    setSecureContext(false);
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true);
    renderCopyButton();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));

    expect(
      await screen.findByRole("button", { name: "Command copied" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("uses the browser fallback when Clipboard API access is rejected", async () => {
    setSecureContext(true);
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("Permission denied")),
    });
    document.execCommand = vi.fn(() => true);
    renderCopyButton();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));

    expect(
      await screen.findByRole("button", { name: "Command copied" }),
    ).toBeVisible();
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("selects the command only when every browser copy mechanism fails", async () => {
    setSecureContext(true);
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("Permission denied")),
    });
    document.execCommand = vi.fn(() => false);
    renderCopyButton();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));

    expect(
      await screen.findByRole("button", { name: "Command selected" }),
    ).toBeVisible();
    expect(window.getSelection()?.toString()).toBe("linger-computer login");
  });

  it("does not report success when every copy mechanism fails", async () => {
    setSecureContext(false);
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    render(
      <CopyValueButton
        selectionTargetRef={{ current: null }}
        value="linger-computer login"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Copy is unavailable on this connection.",
    );
    expect(
      screen.queryByRole("button", { name: "Command copied" }),
    ).not.toBeInTheDocument();
  });
});

function setSecureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value,
  });
}

function setClipboard(clipboard: Pick<Clipboard, "writeText"> | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
}

function renderCopyButton() {
  render(<CopyButtonHarness value="linger-computer login" />);
}

function CopyButtonHarness({ value }: { value: string }) {
  const commandRef = useRef<HTMLElement>(null);

  return (
    <>
      <code ref={commandRef}>{value}</code>
      <CopyValueButton selectionTargetRef={commandRef} value={value} />
    </>
  );
}
