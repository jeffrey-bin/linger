import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DataPreviewAdapter } from "./data-preview-adapter";

afterEach(() => vi.unstubAllGlobals());

it("keeps one parser across callback changes and reports errors to the current callback", () => {
  const workers: EventTarget[] = [];
  const terminate = vi.fn();
  vi.stubGlobal(
    "Worker",
    class extends EventTarget {
      constructor() {
        super();
        workers.push(this);
      }
      postMessage() {}
      terminate = terminate;
    },
  );
  const blob = new Blob(["a,b\n1,2"]);
  const oldError = vi.fn();
  const newError = vi.fn();
  const view = render(
    <DataPreviewAdapter
      blob={blob}
      filename="data.csv"
      mediaType="text/csv"
      onError={oldError}
    />,
  );
  view.rerender(
    <DataPreviewAdapter
      blob={blob}
      filename="data.csv"
      mediaType="text/csv"
      onError={newError}
    />,
  );
  expect(workers).toHaveLength(1);
  expect(terminate).not.toHaveBeenCalled();
  view.rerender(
    <DataPreviewAdapter
      blob={new Blob(["new,data"])}
      filename="data.csv"
      mediaType="text/csv"
      onError={newError}
    />,
  );
  expect(workers).toHaveLength(2);
  expect(terminate).toHaveBeenCalledOnce();
  act(() => {
    workers[1]!.dispatchEvent(new Event("error"));
  });
  expect(newError).toHaveBeenCalledOnce();
  expect(oldError).not.toHaveBeenCalled();
  view.unmount();
  expect(terminate).toHaveBeenCalledTimes(2);
});
