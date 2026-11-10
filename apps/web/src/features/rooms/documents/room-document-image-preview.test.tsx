import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindRoomDocumentImagePreviewStore,
  createRoomDocumentImagePreviewStore,
  createRoomDocumentOptimisticUpload,
  insertRoomDocumentOptimisticImages,
} from "./room-document-image-preview";
import { roomDocumentCommentSchema } from "./room-document-comment-schema";

type TestEditor = BlockNoteEditor<
  typeof roomDocumentCommentSchema.blockSchema,
  typeof roomDocumentCommentSchema.inlineContentSchema,
  typeof roomDocumentCommentSchema.styleSchema
>;

let editor: TestEditor | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  editor?.unmount();
  host?.remove();
  editor = undefined;
  host = undefined;
  vi.restoreAllMocks();
});

describe("Room Document optimistic image preview", () => {
  it("shows pasted bytes immediately without persisting a blob URL", async () => {
    const upload = deferred<string>();
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:preview")
      .mockReturnValueOnce("blob:stable");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const store = createRoomDocumentImagePreviewStore();
    const resolver = {
      prime: vi.fn(() => true),
      resolve: vi.fn(async () => "blob:stable"),
    };
    editor = createEditor(store, resolver, () => upload.promise);
    mountEditor(editor);

    const file = new File([new Uint8Array(8 << 20)], "image.png", {
      type: "image/png",
    });
    expect(insertRoomDocumentOptimisticImages(editor, [file], store)).toBe(
      true,
    );

    await waitFor(() => expect(store.size()).toBe(1));
    await waitFor(() => {
      const image = editor!.document.find((block) => block.type === "image");
      expect(image?.props.url).toBe("");
      expect(store.get(image!.id)).toBeDefined();
      expect(store.get(image!.id)?.objectUrl).toBe("blob:preview");
      expect(screen.getByRole("img", { name: "image.png" })).toHaveAttribute(
        "src",
        "blob:preview",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("Uploading image.png");
    expect(screen.queryByText("Add image")).toBeNull();
    expect(screen.queryByRole("button", { name: "image.png" })).toBeNull();

    upload.resolve("document-asset:asset_1");
    await waitFor(() =>
      expect(
        editor!.document.find((block) => block.type === "image")?.props.url,
      ).toBe("document-asset:asset_1"),
    );
    expect(resolver.prime).toHaveBeenCalled();
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:preview"));
  });

  it("shows only loading while a durable internal reference resolves", async () => {
    const resolution = deferred<string>();
    editor = BlockNoteEditor.create({
      initialContent: [
        {
          props: { name: "remote.png", url: "document-asset:asset_remote" },
          type: "image",
        },
      ],
      resolveFileUrl: () => resolution.promise,
      schema: roomDocumentCommentSchema,
    });
    mountEditor(editor);

    expect(screen.getByRole("status")).toHaveTextContent("Loading remote.png");
    expect(screen.queryByRole("img", { name: "remote.png" })).toBeNull();
    expect(host?.querySelector('img[src^="document-asset:"]')).toBeNull();

    resolution.resolve("blob:remote");
    expect(
      await screen.findByRole("img", { name: "remote.png" }),
    ).toHaveAttribute("src", "blob:remote");
  });

  it("preserves a replacement and revokes previews on unmount", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const store = createRoomDocumentImagePreviewStore();
    const release = store.retain();
    const upload = deferred<string>();
    editor = createEditor(
      store,
      { prime: () => true, resolve: async () => "blob:stable" },
      () => upload.promise,
    );
    mountEditor(editor);
    expect(
      insertRoomDocumentOptimisticImages(
        editor,
        [new File(["image"], "failure.png", { type: "image/png" })],
        store,
      ),
    ).toBe(true);
    await waitFor(() => expect(store.size()).toBe(1));
    const block = editor.document.find((item) => item.type === "image")!;
    editor.updateBlock(block.id, {
      props: { url: "document-asset:replacement" },
    });
    store.reconcile(editor);
    expect(revoke).toHaveBeenCalledWith("blob:preview");

    upload.resolve("document-asset:late");
    await waitFor(() =>
      expect(imageUrl(editor!, block.id)).toBe("document-asset:replacement"),
    );

    store.begin("temporary", new File(["x"], "temporary.png"));
    release();
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("removes only its unchanged placeholder when upload fails", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:failed");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const upload = deferred<string>();
    const store = createRoomDocumentImagePreviewStore();
    editor = createEditor(
      store,
      { prime: () => true, resolve: async () => "blob:stable" },
      () => upload.promise,
    );
    mountEditor(editor);
    insertRoomDocumentOptimisticImages(
      editor,
      [new File(["bad"], "failed.png", { type: "image/png" })],
      store,
    );
    await waitFor(() =>
      expect(editor!.document.some((block) => block.type === "image")).toBe(
        true,
      ),
    );

    upload.reject(new Error("upload failed"));

    await waitFor(() =>
      expect(editor!.document.some((block) => block.type === "image")).toBe(
        false,
      ),
    );
    expect(revoke).toHaveBeenCalledWith("blob:failed");
  });

  it("does not restore a placeholder deleted while its upload is pending", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:deleted");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const upload = deferred<string>();
    const store = createRoomDocumentImagePreviewStore();
    const prime = vi.fn(() => true);
    editor = createEditor(
      store,
      { prime, resolve: async () => "blob:stable" },
      () => upload.promise,
    );
    mountEditor(editor);
    insertRoomDocumentOptimisticImages(
      editor,
      [new File(["delete"], "deleted.png", { type: "image/png" })],
      store,
    );
    await waitFor(() => expect(store.size()).toBe(1));
    const block = editor.document.find((item) => item.type === "image")!;
    editor.removeBlocks([block.id]);
    store.reconcile(editor);
    expect(revoke).toHaveBeenCalledWith("blob:deleted");

    upload.resolve("document-asset:late");
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.getBlock(block.id)).toBeUndefined();
    expect(prime).not.toHaveBeenCalled();
  });
});

function createEditor(
  store: ReturnType<typeof createRoomDocumentImagePreviewStore>,
  resolver: {
    prime(reference: string, file: File): boolean;
    resolve(reference: string): Promise<string>;
  },
  upload: (file: File, blockId?: string) => Promise<string>,
) {
  const holder: { current?: TestEditor } = {};
  const value = BlockNoteEditor.create({
    initialContent: [{ content: "hello", type: "paragraph" }],
    resolveFileUrl: resolver.resolve,
    schema: roomDocumentCommentSchema,
    uploadFile: createRoomDocumentOptimisticUpload({
      getEditor: () => holder.current!,
      previewStore: store,
      prime: resolver.prime,
      upload,
    }),
  });
  holder.current = value;
  value.onChange(() => store.reconcile(value));
  bindRoomDocumentImagePreviewStore(value, store);
  return value;
}

function imageUrl(value: TestEditor, blockId: string) {
  const block = value.getBlock(blockId);
  return block?.type === "image" ? block.props.url : undefined;
}

function mountEditor(value: TestEditor) {
  const rendered = render(<BlockNoteView editor={value} />);
  host = rendered.container as HTMLDivElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
