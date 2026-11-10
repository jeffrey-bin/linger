// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMermaidSandboxDocument,
  renderMermaidSvg,
  sanitizeMermaidSvg,
} from "./mermaid-preview-adapter";
import { mermaidPreviewRenderId } from "./mermaid-preview-protocol";

describe("Mermaid preview adapter", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("keeps labels and theme CSS while removing executable markup", () => {
    const sanitized = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <style>.node rect { fill: #eee; }</style>
        <g class="label"><foreignObject x="0" y="0" width="100" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><p>Human</p></div></foreignObject></g>
        <script>alert(1)</script>
        <rect onload="alert(1)" />
      </svg>
    `);

    expect(sanitized).toContain("<style>");
    expect(sanitized).toContain("Human");
    expect(sanitized).toContain("<text");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("onload");
  });

  it("wraps the SVG in a scriptless sandbox document", () => {
    const document = createMermaidSandboxDocument("<svg></svg>");

    expect(document).toContain("default-src 'none'");
    expect(document).not.toContain("<script");
    expect(document).toContain("<svg></svg>");
  });

  it("preserves every label when Mermaid emits HTML line breaks and entities", () => {
    const sanitized =
      sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg">
      <g class="label"><foreignObject width="120" height="48"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Task<br>One-off goal&nbsp;&amp;collaboration</p></span></div></foreignObject></g>
      <g class="label"><foreignObject width="80" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><p>Profile</p></div></foreignObject></g>
      <script>alert(1)</script></svg>`);
    const parsed = new DOMParser().parseFromString(sanitized, "text/html");

    expect(
      Array.from(parsed.querySelectorAll("tspan"), (line) => line.textContent),
    ).toEqual(["Task", "One-off goal\u00a0&collaboration", "Profile"]);
    expect(
      parsed.querySelector("parsererror, foreignObject, script"),
    ).toBeNull();
  });

  it("creates a selector-safe render id when randomUUID is unavailable", () => {
    const id = mermaidPreviewRenderId("1787820276275-0.2717110857836649");

    expect(id).toBe("mermaid-1787820276275-0-2717110857836649");
    const host = document.createElement("div");
    host.id = id;
    document.body.append(host);
    expect(() => document.querySelector(`#${id}`)).not.toThrow();
    expect(document.querySelector(`#${id}`)).toBe(host);
  });

  it("renders in a disposable sandbox runtime and sanitizes its response", async () => {
    const rendered = renderMermaidSvg("graph TD\n  A[Human] --> B[Agent]");
    const frame = requireRuntimeFrame();

    dispatchRuntimeMessage(frame, { kind: "linger.mermaid.ready" });
    expect(frame.contentWindow?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "linger.mermaid.render",
        source: "graph TD\n  A[Human] --> B[Agent]",
      }),
      "*",
    );
    const request = vi.mocked(frame.contentWindow!.postMessage).mock
      .calls[0]?.[0] as {
      requestId: string;
    };
    dispatchRuntimeMessage(frame, {
      kind: "linger.mermaid.result",
      requestId: request.requestId,
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject x="0" y="0" width="100" height="20"><p>Human</p></foreignObject><script>alert(1)</script></svg>`,
    });

    const result = await rendered;
    expect(result).toContain("Human");
    expect(result).not.toContain("foreignObject");
    expect(document.body).not.toContainElement(frame);
  });

  it("destroys the runtime when rendering exceeds its deadline", async () => {
    vi.useFakeTimers();
    const rendered = renderMermaidSvg("graph TD\n  A --> B", {
      renderTimeoutMs: 25,
    });
    const rejection = expect(rendered).rejects.toThrow(
      "Mermaid preview exceeded the execution time limit.",
    );
    const frame = requireRuntimeFrame();
    dispatchRuntimeMessage(frame, { kind: "linger.mermaid.ready" });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(document.body).not.toContainElement(frame);
  });

  it("destroys the runtime when the caller cancels rendering", async () => {
    const controller = new AbortController();
    const rendered = renderMermaidSvg("graph TD\n  A --> B", {
      signal: controller.signal,
    });
    const frame = requireRuntimeFrame();

    controller.abort();

    await expect(rendered).rejects.toMatchObject({ name: "AbortError" });
    expect(document.body).not.toContainElement(frame);
  });
});

function requireRuntimeFrame() {
  const frame = document.querySelector<HTMLIFrameElement>(
    'iframe[title="Mermaid rendering runtime"]',
  );
  expect(frame).not.toBeNull();
  if (!frame) throw new Error("Expected Mermaid runtime iframe.");
  vi.spyOn(frame.contentWindow!, "postMessage");
  return frame;
}

function dispatchRuntimeMessage(
  frame: HTMLIFrameElement,
  data: Record<string, unknown>,
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      source: frame.contentWindow,
    }),
  );
}
