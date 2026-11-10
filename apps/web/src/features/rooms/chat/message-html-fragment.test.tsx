import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { writeClipboardText } from "@/lib/clipboard";

import {
  fragmentDownloadFileName,
  htmlFragmentSizeMessageType,
} from "./html-fragment-host";
import { MessageHtmlFragment } from "./message-html-fragment";

vi.mock("@/lib/clipboard", () => ({
  writeClipboardText: vi.fn(async () => undefined),
}));

describe("MessageHtmlFragment", () => {
  it("inlines hosted HTML in a script-only sandbox iframe", () => {
    render(
      <MessageHtmlFragment
        html={"<div class='option'>Pine Green Strategy</div>"}
        title="Visual fragment"
      />,
    );

    const frame = screen.getByTitle("Visual fragment");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).not.toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin",
    );
    expect(frame).toHaveAttribute(
      "srcdoc",
      expect.stringContaining("Pine Green Strategy"),
    );
    expect(frame.getAttribute("srcdoc")).toContain('id="vis-container"');
    expect(frame.getAttribute("srcdoc")).toContain("#vis-container > svg");
    expect(frame.getAttribute("srcdoc")).toContain(htmlFragmentSizeMessageType);
  });

  it("wraps a fixed-size SVG fragment so it can scale inside vis-container", () => {
    render(
      <MessageHtmlFragment
        html={
          '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"></svg>'
        }
        title="Architecture diagram"
      />,
    );

    const srcdoc =
      screen.getByTitle("Architecture diagram").getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('id="vis-container"');
    expect(srcdoc).toContain('width="1200" height="760"');
    expect(srcdoc).toContain("max-width: 100%");
    expect(srcdoc).toContain("height: auto");
  });

  it("exposes copy and download actions without save-as-artifact", async () => {
    const html = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    render(<MessageHtmlFragment html={html} title="Architecture diagram" />);

    fireEvent.click(screen.getByRole("button", { name: "Widget actions" }));
    const copyItem = screen.getByRole("menuitem", {
      name: "Copy to clipboard",
    });
    expect(copyItem).toBeVisible();
    expect(copyItem).toHaveClass("whitespace-nowrap");
    expect(screen.getByRole("menuitem", { name: "Download file" })).toHaveClass(
      "whitespace-nowrap",
    );
    expect(screen.queryByText("Save as artifact")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy to clipboard" }),
    );
    await vi.waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(html);
    });
  });

  it("names downloaded SVG fragments from the message title", () => {
    expect(
      fragmentDownloadFileName(
        "Architecture diagram",
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      ),
    ).toBe("Architecture-diagram.svg");
  });
});
