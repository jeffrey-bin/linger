import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UrlPreviewPanel } from "./url-preview-panel";

afterEach(() => vi.unstubAllEnvs());

describe("URL preview fallback", () => {
  it("does not embed the application origin with script and storage privileges", () => {
    vi.stubEnv("DEV", false);
    render(<UrlPreviewPanel url={window.location.origin + "/settings"} />);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("does not let an iframe message open unsolicited external tabs", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<UrlPreviewPanel url="https://example.com/" />);
    const frame = screen.getByTitle<HTMLIFrameElement>(
      "Preview https://example.com/",
    );
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "linger-preview-navigate", url: "http://10.0.0.1/" },
      }),
    );
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
    open.mockRestore();
  });
  it("opens a submitted local URL once and keeps a retry link", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<UrlPreviewPanel url="https://example.com/" />);
    const address = screen.getByRole("textbox", { name: "URL address" });
    fireEvent.change(address, {
      target: { value: "http://10.0.0.5:6001/" },
    });
    fireEvent.submit(address.closest("form")!);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "http://10.0.0.5:6001/",
      "_blank",
      "noopener,noreferrer",
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open in new tab" }),
    ).toHaveAttribute("href", "http://10.0.0.5:6001/");
    open.mockRestore();
  });

  it("never embeds a restored local URL and offers a real new-tab link", () => {
    render(<UrlPreviewPanel url="http://10.0.0.5:6001/" />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Open in new tab" })[0],
    ).toHaveAttribute("href", "http://10.0.0.5:6001/");
  });

  it("provides a manual escape for sites that reject embedding", () => {
    render(<UrlPreviewPanel url="https://example.com/" />);
    expect(
      screen.getByRole("link", { name: "Open in new tab" }),
    ).toHaveAttribute("target", "_blank");
  });

  it("allows site storage only for a direct cross-origin frame", () => {
    vi.stubEnv("DEV", false);
    render(<UrlPreviewPanel url="https://example.com/" />);
    expect(
      screen.getByTitle<HTMLIFrameElement>("Preview https://example.com/"),
    ).toHaveAttribute("sandbox", "allow-forms allow-scripts allow-same-origin");
  });

  it("keeps development proxy frames isolated from application storage", () => {
    vi.stubEnv("DEV", true);
    render(<UrlPreviewPanel url="https://example.com/" />);
    expect(
      screen
        .getByTitle<HTMLIFrameElement>("Preview https://example.com/")
        .getAttribute("sandbox"),
    ).not.toContain("allow-same-origin");
  });

  it("frames sites directly in the desktop app, even on a development server", () => {
    vi.stubEnv("DEV", true);
    vi.stubGlobal("lingerDesktop", {});
    try {
      render(<UrlPreviewPanel url="https://example.com/" />);
      const frame = screen.getByTitle<HTMLIFrameElement>(
        "Preview https://example.com/",
      );
      expect(frame).toHaveAttribute("src", "https://example.com/");
      expect(frame).toHaveAttribute(
        "sandbox",
        "allow-forms allow-scripts allow-same-origin",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
