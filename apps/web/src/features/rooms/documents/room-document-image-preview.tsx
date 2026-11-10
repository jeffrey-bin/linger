import {
  createBlockSpec,
  createImageBlockConfig,
  createImageBlockSpec,
  imageParse,
} from "@blocknote/core";

import type {
  RoomDocumentEditor,
  RoomDocumentPartialBlock,
} from "./room-document-comment-schema";

interface Preview {
  filename: string;
  objectUrl: string;
}

export type RoomDocumentImagePreviewStore = ReturnType<
  typeof createRoomDocumentImagePreviewStore
>;

const storesByEditor = new WeakMap<object, RoomDocumentImagePreviewStore>();

export function createRoomDocumentImagePreviewStore() {
  const previews = new Map<string, Preview>();
  const staged = new Map<File, Preview>();
  const stagedByFilename = new Map<string, Preview[]>();
  const listeners = new Set<() => void>();
  let activeRetainers = 0;
  let disposalGeneration = 0;
  let disposed = false;

  function emit() {
    listeners.forEach((listener) => listener());
  }

  function finish(blockId: string) {
    const preview = previews.get(blockId);
    if (!preview) return;
    previews.delete(blockId);
    URL.revokeObjectURL(preview.objectUrl);
    emit();
  }

  function removeStaged(file: File, preview: Preview, revoke: boolean) {
    staged.delete(file);
    const queued = stagedByFilename.get(preview.filename) ?? [];
    const remaining = queued.filter((candidate) => candidate !== preview);
    if (remaining.length) {
      stagedByFilename.set(preview.filename, remaining);
    } else {
      stagedByFilename.delete(preview.filename);
    }
    if (revoke) URL.revokeObjectURL(preview.objectUrl);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const blockId of [...previews.keys()]) finish(blockId);
    for (const [file, preview] of staged) {
      removeStaged(file, preview, true);
    }
    listeners.clear();
  }

  return {
    begin(blockId: string, file: File) {
      if (disposed) {
        throw new Error("Document image preview store is disposed.");
      }
      finish(blockId);
      const stagedPreview = staged.get(file);
      const preview = stagedPreview ?? {
        filename: file.name,
        objectUrl: URL.createObjectURL(file),
      };
      if (stagedPreview) removeStaged(file, stagedPreview, false);
      previews.set(blockId, preview);
      emit();
      return preview.objectUrl;
    },
    dispose,
    finish,
    get(blockId: string) {
      return previews.get(blockId);
    },
    peekStaged(filename: string) {
      return stagedByFilename.get(filename)?.[0];
    },
    reconcile(editor: RoomDocumentEditor) {
      for (const blockId of [...previews.keys()]) {
        const block = editor.getBlock(blockId);
        if (!block || block.type !== "image" || block.props.url !== "") {
          finish(blockId);
        }
      }
    },
    retain() {
      if (disposed) {
        throw new Error("Document image preview store is disposed.");
      }
      activeRetainers += 1;
      disposalGeneration += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeRetainers -= 1;
        if (activeRetainers !== 0) return;
        const scheduledGeneration = ++disposalGeneration;
        queueMicrotask(() => {
          if (
            activeRetainers === 0 &&
            disposalGeneration === scheduledGeneration
          ) {
            dispose();
          }
        });
      };
    },
    size() {
      return previews.size + staged.size;
    },
    stage(file: File) {
      if (disposed || !file.type.startsWith("image/") || staged.has(file)) {
        return;
      }
      const preview = {
        filename: file.name,
        objectUrl: URL.createObjectURL(file),
      };
      staged.set(file, preview);
      stagedByFilename.set(file.name, [
        ...(stagedByFilename.get(file.name) ?? []),
        preview,
      ]);
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function bindRoomDocumentImagePreviewStore(
  editor: RoomDocumentEditor,
  store: RoomDocumentImagePreviewStore,
) {
  storesByEditor.set(editor, store);
  storesByEditor.set(editor._tiptapEditor, store);
  return () => {
    if (storesByEditor.get(editor) === store) storesByEditor.delete(editor);
    if (storesByEditor.get(editor._tiptapEditor) === store) {
      storesByEditor.delete(editor._tiptapEditor);
    }
  };
}

export function createRoomDocumentOptimisticUpload({
  getEditor,
  previewStore,
  prime,
  upload,
}: {
  getEditor: () => RoomDocumentEditor;
  previewStore: RoomDocumentImagePreviewStore;
  prime: (reference: string, file: File) => boolean;
  upload: (file: File, blockId?: string) => Promise<string>;
}) {
  return async (file: File, blockId?: string) => {
    if (!blockId || !file.type.startsWith("image/")) {
      return upload(file, blockId);
    }
    const initialBlock = getEditor().getBlock(blockId);
    const implicitPastePlaceholder =
      initialBlock?.type === "image" &&
      initialBlock.props.url === "" &&
      initialBlock.props.name === file.name;
    previewStore.begin(blockId, file);
    try {
      const reference = await upload(file, blockId);
      const block = getEditor().getBlock(blockId);
      if (!block || block.type !== "image" || block.props.url !== "") {
        previewStore.finish(blockId);
        return {};
      }
      prime(reference, file);
      return reference;
    } catch (error) {
      const editor = getEditor();
      const block = editor.getBlock(blockId);
      if (block?.type === "image" && block.props.url === "") {
        editor.removeBlocks([blockId]);
      }
      previewStore.finish(blockId);
      if (implicitPastePlaceholder) return {};
      throw error;
    }
  };
}

export function insertRoomDocumentOptimisticImages(
  editor: RoomDocumentEditor,
  files: File[],
  previewStore: RoomDocumentImagePreviewStore,
) {
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (!images.length || !editor.uploadFile) return false;
  let anchor = editor.getTextCursorPosition().block;
  for (const file of images) {
    const blockId =
      globalThis.crypto?.randomUUID?.() ??
      `image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    previewStore.stage(file);
    const inserted = editor.insertBlocks(
      [
        {
          id: blockId,
          props: {
            name: file.name,
            url: "",
          },
          type: "image",
        },
      ],
      anchor,
      "after",
    )[0]!;
    anchor = inserted;
    void editor
      .uploadFile(file, blockId)
      .then((result) => {
        const current = editor.getBlock(blockId);
        if (!current || current.type !== "image" || current.props.url !== "") {
          return;
        }
        editor.updateBlock(
          blockId,
          typeof result === "string"
            ? { props: { url: result } }
            : (result as RoomDocumentPartialBlock),
        );
      })
      .catch(() => undefined);
  }
  return true;
}

const defaultImageBlockSpec = createImageBlockSpec();
const defaultImageRender = defaultImageBlockSpec.implementation.render;
const roomDocumentImageRender: typeof defaultImageRender = function (
  block,
  editor,
) {
  const store = storesByEditor.get(editor);
  const preview = store?.get(block.id) ?? store?.peekStaged(block.props.name);
  if (!block.props.url && !preview) {
    return defaultImageRender.call(this, block, editor);
  }

  const wrapper = document.createElement("div");
  wrapper.className = "bn-visual-media-wrapper relative";
  const filename = block.props.name || preview?.filename || "image";
  const status = document.createElement("span");
  status.className =
    "inline-flex min-h-24 w-full items-center justify-center text-sm text-app-muted";
  status.setAttribute("role", "status");
  status.textContent = preview
    ? `Uploading ${filename}`
    : `Loading ${filename}`;

  const image = document.createElement("img");
  image.alt = filename;
  image.className = "bn-visual-media";
  image.contentEditable = "false";
  image.draggable = false;
  if (block.props.previewWidth) image.width = block.props.previewWidth;

  if (preview) {
    image.src = preview.objectUrl;
    wrapper.append(image, status);
  } else {
    wrapper.append(status);
    void editor
      .resolveFileUrl?.(block.props.url)
      .then((url) => {
        if (!url) return;
        image.src = url;
        status.replaceWith(image);
      })
      .catch(() => {
        status.setAttribute("role", "alert");
        status.textContent = `${filename} is unavailable`;
      });
  }
  return { dom: wrapper };
};

export const roomDocumentImageBlockSpec = createBlockSpec(
  createImageBlockConfig,
  (config) => ({
    ...defaultImageBlockSpec.implementation,
    meta: { fileBlockAccept: ["image/*"] },
    parse: imageParse(config),
    render: roomDocumentImageRender,
    runsBefore: ["file"],
  }),
);
