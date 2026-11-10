import { JSDOM } from "jsdom";

let runtimeDOM: JSDOM | undefined;

export function installDocumentRuntimeDOM(): void {
  if (typeof globalThis.document !== "undefined") {
    return;
  }
  runtimeDOM = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://document-runtime.internal",
  });
  const window = runtimeDOM.window;
  const globals: Record<string, unknown> = {
    DOMParser: window.DOMParser,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    localStorage: window.localStorage,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    document: window.document,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    window,
  };
  if (typeof globalThis.File === "undefined") {
    globals.File = window.File;
  }
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  }
}
