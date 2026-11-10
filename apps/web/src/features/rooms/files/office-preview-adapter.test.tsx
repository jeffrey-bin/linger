import type { ArtifactReadingPosition } from "./artifact-preview-cache";
import { officePreviewProtocol } from "./office-preview-protocol";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfficePreviewAdapter } from "./office-preview-adapter";
import * as frameSource from "./office-preview-frame-source";
import { takeOfficePreviewPreflightWorker } from "./office-preview-preflight-cache";

let workers: FakeWorker[];
class FakeWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    super();
    workers.push(this);
  }
}

function completePreflight(
  worker: FakeWorker,
  kind: "passed" | "failed" = "passed",
) {
  const request = worker.postMessage.mock.calls.at(-1)![0];
  act(() => {
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind,
          requestId: request.requestId,
          buffer: request.buffer,
          code: "invalid-file",
        },
      }),
    );
  });
}

function openPreview(filename = "report.xlsx", onError = vi.fn()) {
  return render(
    <OfficePreviewAdapter
      blob={new Blob(["office"])}
      filename={filename}
      mediaType="application/octet-stream"
      onError={onError}
    />,
  );
}

vi.mock("./office-preview-frame-docx.ts?worker&url", () => ({
  default: "/assets/office-preview-frame.js",
}));
vi.mock("./office-preview-preflight-worker.ts?worker&url", () => ({
  default: "/assets/office-preview-preflight-worker.js",
}));

describe("OfficePreviewAdapter", () => {
  beforeEach(() => {
    workers = [];
    vi.spyOn(Blob.prototype, "arrayBuffer").mockResolvedValue(
      new ArrayBuffer(8),
    );
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => {
    cleanup();
    // Drain the page-scoped idle slot between tests, including tests that
    // replace Worker with a constructor-only spy.
    takeOfficePreviewPreflightWorker().terminate?.();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["frame", "preflight"])(
    "prepares in parallel and renders once after %s finishes last",
    async (last) => {
      const buffer = new ArrayBuffer(8);
      let release!: (buffer: ArrayBuffer) => void;
      const blob = new Blob(["office"]);
      vi.spyOn(blob, "arrayBuffer").mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const view = render(
        <OfficePreviewAdapter
          blob={blob}
          filename="parallel.docx"
          mediaType="application/octet-stream"
        />,
      );
      const frame = screen.getByTitle<HTMLIFrameElement>(
        "Basic preview parallel.docx",
      );
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      const ready = () => {
        act(() => {
          window.dispatchEvent(
            new MessageEvent("message", {
              source: frame.contentWindow,
              data: { protocol: officePreviewProtocol, kind: "ready" },
            }),
          );
        });
      };
      // Byte preparation must start without a ready message from the iframe.
      expect(blob.arrayBuffer).toHaveBeenCalledOnce();
      await act(async () => release(buffer));
      expect(workers).toHaveLength(1);
      const requestId = workers[0]!.postMessage.mock.calls[0]![0].requestId;
      // Stale worker replies cannot consume the current reply listener.
      act(() => {
        workers[0]!.dispatchEvent(
          new MessageEvent("message", {
            data: { kind: "passed", requestId: "stale", buffer },
          }),
        );
      });
      const complete = () => {
        act(() => {
          workers[0]!.dispatchEvent(
            new MessageEvent("message", {
              data: { kind: "passed", requestId, buffer },
            }),
          );
        });
      };
      if (last === "frame") complete();
      else ready();
      expect(
        post.mock.calls.filter(([message]) => message.kind === "render"),
      ).toHaveLength(0);
      if (last === "frame") ready();
      else complete();
      ready();
      expect(
        post.mock.calls.filter(([message]) => message.kind === "render"),
      ).toHaveLength(1);
      complete();
      expect(workers[0]!.terminate).not.toHaveBeenCalled();
      const loaded = {
        protocol: officePreviewProtocol,
        kind: "loaded",
        requestId,
      };
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { source: window, data: loaded }),
        );
      });
      expect(screen.getByText("Preparing basic preview")).toBeVisible();
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: frame.contentWindow,
            data: loaded,
          }),
        );
      });
      expect(screen.queryByText("Preparing basic preview")).toBeNull();
      view.unmount();
    },
  );

  it("reuses preflight code across sequential previews", async () => {
    for (const filename of ["first.xlsx", "second.xlsx", "third.docx"]) {
      const view = openPreview(filename);
      await act(async () => {});
      completePreflight(workers.at(-1)!);
      view.unmount();
    }
    expect(workers).toHaveLength(1);
    expect(workers[0]!.postMessage).toHaveBeenCalledTimes(3);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
  });

  it.each(["cancel", "timeout", "crash"])(
    "discards a busy worker on %s and allows retry",
    async (reason) => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const first = openPreview("first.xlsx", onError);
      await act(async () => {});
      const worker = workers[0]!;
      if (reason === "cancel") first.unmount();
      if (reason === "timeout")
        act(() => {
          vi.advanceTimersByTime(10_001);
        });
      if (reason === "crash")
        act(() => {
          worker.dispatchEvent(new Event("error"));
        });
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledTimes(reason === "cancel" ? 0 : 1);
      first.unmount();
      openPreview("retry.xlsx");
      await act(async () => {});
      expect(workers).toHaveLength(2);
      completePreflight(workers[1]!);
      expect(workers[1]!.terminate).not.toHaveBeenCalled();
    },
  );

  it("does not let a previous owner stop a reused worker or receive its errors", async () => {
    const previousError = vi.fn();
    const first = openPreview("first.xlsx", previousError);
    await act(async () => {});
    completePreflight(workers[0]!);
    const currentError = vi.fn();
    openPreview("second.xlsx", currentError);
    await act(async () => {});
    expect(workers).toHaveLength(1);
    first.unmount();
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    act(() => {
      workers[0]!.dispatchEvent(new Event("error"));
    });
    expect(previousError).not.toHaveBeenCalled();
    expect(currentError).toHaveBeenCalledOnce();
  });

  it("isolates concurrent cancellation and retains at most one completed worker", async () => {
    const first = openPreview("first.xlsx");
    const second = openPreview("second.xlsx");
    await act(async () => {});
    expect(workers).toHaveLength(2);
    first.unmount();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers[1]!.terminate).not.toHaveBeenCalled();
    const third = openPreview("third.xlsx");
    await act(async () => {});
    completePreflight(workers[1]!);
    completePreflight(workers[2]!);
    expect(workers[2]!.terminate).toHaveBeenCalledOnce();
    second.unmount();
    third.unmount();
    openPreview("fourth.xlsx");
    await act(async () => {});
    expect(workers).toHaveLength(3);
    expect(workers[1]!.postMessage).toHaveBeenCalledTimes(2);
  });

  it("reuses code after a file rejection without caching the rejected result", async () => {
    const first = openPreview("damaged.xlsx");
    await act(async () => {});
    completePreflight(workers[0]!, "failed");
    expect(screen.getByRole("alert")).toHaveTextContent("could not be read");
    first.unmount();
    openPreview("valid.xlsx");
    await act(async () => {});
    expect(workers).toHaveLength(1);
    expect(workers[0]!.postMessage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    completePreflight(workers[0]!);
  });

  it("ignores pending byte preparation after the preview closes", async () => {
    const Worker = vi.fn();
    vi.stubGlobal("Worker", Worker);
    let release!: (buffer: ArrayBuffer) => void;
    const blob = new Blob(["office"]);
    vi.spyOn(blob, "arrayBuffer").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const view = render(
      <OfficePreviewAdapter
        blob={blob}
        filename="cancel.docx"
        mediaType="application/octet-stream"
      />,
    );
    expect(blob.arrayBuffer).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => release(new ArrayBuffer(8)));
    expect(Worker).not.toHaveBeenCalled();
  });

  it("reinitializes the sandbox after Strict Mode cleanup", async () => {
    render(
      <StrictMode>
        <OfficePreviewAdapter
          blob={new Blob(["office"])}
          filename="strict.docx"
          mediaType="application/octet-stream"
        />
      </StrictMode>,
    );
    await act(async () => {});
    expect(
      screen.getByTitle<HTMLIFrameElement>("Basic preview strict.docx"),
    ).toHaveAttribute(
      "srcdoc",
      expect.stringContaining('<script type="module"'),
    );
  });

  it("lets only the effect navigate the sandbox so ready matches the live document", async () => {
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
    render(
      <OfficePreviewAdapter
        blob={new Blob(["office"])}
        filename="deck.pptx"
        mediaType="application/octet-stream"
      />,
    );

    await act(async () => {});
    // Only the effect may write srcdoc. A JSX srcDoc prop wrote it a second
    // time per mount, and assigning srcdoc queues a navigation.
    expect(
      setAttribute.mock.calls.filter(
        ([name]) => name.toLowerCase() === "srcdoc",
      ),
    ).toHaveLength(0);
    expect(
      screen.getByTitle<HTMLIFrameElement>("Basic preview deck.pptx"),
    ).toHaveAttribute(
      "srcdoc",
      expect.stringContaining('<script type="module"'),
    );
  });

  it("runs the third-party renderer in a script-only opaque sandbox", async () => {
    // HTTP Owner development origins have getRandomValues, but no randomUUID.
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    vi.spyOn(frameSource, "loadOfficePreviewFrameSource").mockResolvedValue(
      'const markup = "</script><script>untrusted()</script>";',
    );
    render(
      <OfficePreviewAdapter
        blob={new Blob(["office"])}
        filename="report.docx"
        mediaType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onError={() => undefined}
      />,
    );

    await act(async () => {});
    const frame = screen.getByTitle<HTMLIFrameElement>(
      "Basic preview report.docx",
    );
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("connect-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain('<script type="module"');
    const document = new DOMParser().parseFromString(
      frame.getAttribute("srcdoc")!,
      "text/html",
    );
    expect(document.scripts).toHaveLength(1);
    const nonce = document.scripts[0]!.getAttribute("nonce");
    expect(nonce).toBeTruthy();
    expect(
      document.querySelector("meta[http-equiv]")!.getAttribute("content"),
    ).toContain(`script-src 'nonce-${nonce}'`);
    expect(document.scripts[0]!.hasAttribute("src")).toBe(false);
  });

  it("does not navigate a closed preview when shared code arrives late", async () => {
    let resolve!: (source: string) => void;
    vi.spyOn(frameSource, "loadOfficePreviewFrameSource").mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(
      <OfficePreviewAdapter
        blob={new Blob(["office"])}
        filename="late.pptx"
        mediaType="application/octet-stream"
      />,
    );
    const frame = screen.getByTitle<HTMLIFrameElement>(
      "Basic preview late.pptx",
    );
    view.unmount();
    await act(async () => resolve("renderer"));
    expect(frame).not.toHaveAttribute("srcdoc");
    expect(frame).toHaveAttribute("src", "about:blank");
  });

  it("keeps the iframe alive across callback changes and accepts only its current reading position", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-0000-0000-000000000123",
    );
    const blob = new Blob(["office"]);
    const readingPosition: ArtifactReadingPosition = {};
    const view = render(
      <OfficePreviewAdapter
        blob={blob}
        filename="report.docx"
        mediaType="application/octet-stream"
        readingPosition={readingPosition}
        onError={() => undefined}
      />,
    );
    const frame = screen.getByTitle<HTMLIFrameElement>(
      "Basic preview report.docx",
    );
    const remove = vi.spyOn(frame, "removeAttribute");
    view.rerender(
      <OfficePreviewAdapter
        blob={blob}
        filename="report.docx"
        mediaType="application/octet-stream"
        readingPosition={readingPosition}
        onError={() => undefined}
      />,
    );
    expect(remove).not.toHaveBeenCalled();
    const message = {
      kind: "scroll",
      protocol: officePreviewProtocol,
      requestId: "00000000-0000-0000-0000-000000000123",
      position: { top: 720, left: 10 },
    };
    const send = (data: unknown, source: Window | null) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, source }));
      });
    send(message, window);
    send({ ...message, requestId: "stale" }, frame.contentWindow);
    expect(readingPosition.officeScroll).toBeUndefined();
    send(message, frame.contentWindow);
    expect(readingPosition.officeScroll).toEqual({ top: 720, left: 10 });
    view.unmount();
    expect(remove).toHaveBeenCalledWith("srcdoc");
  });

  it("shows a terminal error and download fallback without an onError consumer", () => {
    vi.useFakeTimers();
    const blob = new Blob(["office"]);
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:office-download");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(
      <OfficePreviewAdapter
        blob={blob}
        filename="report.docx"
        mediaType="application/octet-stream"
      />,
    );

    const frame = screen.getByTitle<HTMLIFrameElement>(
      "Basic preview report.docx",
    );
    act(() => {
      vi.advanceTimersByTime(20_001);
    });

    // No frame ever answered "ready", so this is the boot timeout, which
    // reports separately from a renderer that stalled on the bytes.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The basic Office preview sandbox did not start",
    );
    expect(frame).not.toBeInTheDocument();
    expect(frame).toHaveAttribute("src", "about:blank");
    expect(frame).not.toHaveAttribute("srcdoc");
    expect(
      screen.getByRole("button", { name: "Download original" }),
    ).toBeVisible();
    expect(screen.queryByText("Preparing basic preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download original" }));
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:office-download");
  });
});
