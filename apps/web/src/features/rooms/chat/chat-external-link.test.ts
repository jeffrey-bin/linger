// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { followChatExternalLink } from "./chat-external-link";

describe("external link routing", () => {
  it.each([
    "http://10.0.0.5:6001/project",
    "https://10.0.0.5/project",
    "http://10.0.0.1/",
    "https://172.16.0.1/",
    "http://127.0.0.1:3000/",
    "http://localhost:3000/",
    "https://printer.local/",
    "https://intranet/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:10.0.0.1]/",
    "http://0xc0a80a75/",
    "https://169.254.1.1/",
  ])("keeps native new-tab navigation for %s", (href) => {
    const event = {
      altKey: false,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
    };
    const preview = vi.fn();
    followChatExternalLink(event, href, preview);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("still previews public HTTPS links", () => {
    const event = {
      altKey: false,
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
    };
    const preview = vi.fn();
    followChatExternalLink(event, "https://192.0.2.1/docs", preview);
    expect(preview).toHaveBeenCalledWith("https://192.0.2.1/docs");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
