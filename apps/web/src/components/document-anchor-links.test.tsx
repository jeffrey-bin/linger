import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scrollToDocumentAnchor,
  useDocumentAnchorLinks,
} from "./document-anchor-links";

afterEach(() => vi.restoreAllMocks());

describe("document section navigation", () => {
  it("resolves visible headings, non-ASCII text and duplicate slugs within its own document", () => {
    const view = render(
      <div>
        <div data-id="hidden" style={{ display: "none" }}>
          <h2>Sources</h2>
        </div>
        <div data-id="one">
          <h4>Direction: Test</h4>
        </div>
        <div data-id="two">
          <h4>Direction: Test</h4>
        </div>
        <div data-id="three">
          <h4>Café progress</h4>
        </div>
      </div>,
    );
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    expect(scrollToDocumentAnchor(view.container, "#direction-test-1")).toBe(
      true,
    );
    expect(scroll.mock.instances.at(-1)).toBe(
      view.container.querySelector('[data-id="two"]'),
    );
    expect(scrollToDocumentAnchor(view.container, "#caf%C3%A9-progress")).toBe(
      true,
    );
    expect(scroll.mock.instances.at(-1)).toBe(
      view.container.querySelector('[data-id="three"]'),
    );
    expect(scrollToDocumentAnchor(view.container, "#sources")).toBe(false);
    expect(scrollToDocumentAnchor(view.container, "#bad%ZZ")).toBe(false);
    expect(scrollToDocumentAnchor(view.container, "#missing")).toBe(false);
  });

  it.each(["click", "keyboard"])(
    "handles %s without leaving the document and reports missing sections",
    (action) => {
      render(
        <MemoryRouter>
          <Reader identity="document-one" />
        </MemoryRouter>,
      );
      const link = screen.getByRole("link", { name: "Go to section" });
      const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
      if (action === "click") expect(fireEvent.click(link)).toBe(false);
      else expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(false);
      expect(scroll).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "start",
      });
      fireEvent.click(screen.getByRole("link", { name: "Missing section" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This section is unavailable",
      );
      fireEvent.click(link);
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("lets a valid in-page click recover from a missing fragment in the URL", async () => {
    render(
      <MemoryRouter initialEntries={["/reader#missing"]}>
        <Reader identity="document-one" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This section is unavailable",
    );
    fireEvent.click(screen.getByRole("link", { name: "Go to section" }));
    await act(() => Promise.resolve());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("waits for cross-page content and disconnects observers without resubscribing on presentation rerenders", async () => {
    const OriginalObserver = window.MutationObserver;
    const disconnect = vi.fn();
    const observe = vi
      .spyOn(window, "MutationObserver")
      .mockImplementation(function (callback) {
        const observer = new OriginalObserver(callback);
        const stop = observer.disconnect.bind(observer);
        observer.disconnect = () => {
          disconnect();
          stop();
        };
        return observer;
      });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const view = render(
      <MemoryRouter initialEntries={["/reader#direction-test"]}>
        <Reader identity="document-one" pending />
      </MemoryRouter>,
    );
    expect(scroll).not.toHaveBeenCalled();
    const subscriptions = observe.mock.calls.length;
    view.rerender(
      <MemoryRouter initialEntries={["/reader#direction-test"]}>
        <Reader identity="document-one" />
      </MemoryRouter>,
    );
    await act(() => Promise.resolve());
    expect(scroll).toHaveBeenCalled();
    expect(observe.mock.calls.length).toBe(subscriptions);
    expect(disconnect).toHaveBeenCalled();
    view.rerender(
      <MemoryRouter>
        <Reader identity="document-two" />
      </MemoryRouter>,
    );
    expect(observe.mock.calls.length).toBe(subscriptions + 1);
    view.unmount();
    expect(disconnect.mock.calls.length).toBeGreaterThan(1);
  });
});

function Reader({
  identity,
  pending = false,
}: {
  identity: string;
  pending?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const links = useDocumentAnchorLinks(root, identity);
  return (
    <div
      ref={root}
      onClickCapture={links.openAnchor}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter") links.openAnchor(event);
      }}
    >
      {links.error ? <p role="alert">{links.error}</p> : null}
      {pending ? (
        <p>Loading...</p>
      ) : (
        <div className="bn-editor">
          <a href="#direction-test" target="_blank">
            Go to section
          </a>
          <a href="#missing">Missing section</a>
          <div data-id="section">
            <h4>Direction: Test</h4>
          </div>
        </div>
      )}
    </div>
  );
}
