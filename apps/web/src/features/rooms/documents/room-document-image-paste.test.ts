// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { afterEach, describe, expect, it, vi } from "vitest";

let host: HTMLDivElement | undefined;

afterEach(() => {
  host?.remove();
  host = undefined;
});

describe("Room Document image paste", () => {
  it("uploads a pasted image through uploadFile and inserts an image block", async () => {
    const uploadFile = vi.fn(
      async () => "https://assets.example.test/screenshot.png",
    );
    const editor = BlockNoteEditor.create({
      initialContent: [{ type: "paragraph", content: "hello" }],
      uploadFile,
    });
    editor.headless = false;
    host = document.createElement("div");
    document.body.appendChild(host);
    editor.mount(host);
    const dom = editor.domElement;
    expect(dom).toBeInstanceOf(HTMLElement);

    const file = new File(["image-bytes"], "screenshot.png", {
      type: "image/png",
    });
    const clipboardData = {
      clearData: () => undefined,
      getData: () => "",
      items: [{ getAsFile: () => file, type: file.type }],
      setData: () => undefined,
      types: ["Files"],
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });

    dom?.dispatchEvent(event);

    await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledOnce());
    expect(uploadFile).toHaveBeenCalledWith(file, expect.any(String));

    await vi.waitFor(() =>
      expect(
        editor.document.some(
          (block) =>
            block.type === "image" &&
            block.props.url === "https://assets.example.test/screenshot.png" &&
            block.props.name === "screenshot.png",
        ),
      ).toBe(true),
    );
  });
});
