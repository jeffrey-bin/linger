import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  MessageComposer,
  type MessageComposerHandle,
} from "./message-composer";
import {
  formatDocumentToken,
  formatSkillToken,
} from "./message-composer-references";
import { TEAMHUB_MESSAGE_MAX_LENGTH } from "./use-composer-draft";

describe("MessageComposer", () => {
  it("remeasures wrapping after a width change without resubscribing on rerenders", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const callbacks: ResizeObserverCallback[] = [];
    const observers: ResizeObserver[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class implements ResizeObserver {
        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
          observers.push(this);
        }
      },
    );
    try {
      const { rerender, unmount } = render(
        <MessageComposer
          initialValue="A draft that wraps at a narrow width"
          onSend={vi.fn()}
        />,
      );
      const input = screen.getByRole("textbox", { name: "Message Room" });
      Object.defineProperty(input, "scrollHeight", {
        configurable: true,
        value: 108,
      });
      act(() =>
        callbacks[0]!(
          [
            {
              target: input,
              contentRect: new DOMRect(0, 0, 500, 108),
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          observers[0]!,
        ),
      );
      expect(input).toHaveStyle({ height: "108px" });
      rerender(
        <MessageComposer
          disabled
          initialValue="A draft that wraps at a narrow width"
          onSend={vi.fn()}
        />,
      );
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledWith(input);
      unmount();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("puts the toolbar under the editor with tools left and Send right", () => {
    render(
      <MessageComposer
        attachmentEnabled
        modelSwitch={<button type="button">Model</button>}
        onSend={vi.fn()}
      />,
    );

    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    const rightCommands = screen
      .getByRole("button", { name: "Send message" })
      .closest(".message-composer-toolbar-right");
    const leftTools = screen
      .getByRole("button", { name: "Attach file" })
      .closest(".message-composer-toolbar-left");

    expect(rightCommands).not.toBeNull();
    expect(leftTools).not.toBeNull();
    expect(leftTools).toContainElement(
      screen.getByRole("button", { name: "Model" }),
    );
    expect(editor.closest(".message-composer-editor")?.nextElementSibling).toBe(
      leftTools?.parentElement,
    );
  });

  it("keeps overflowing mention results inside a shrinkable scroll region", () => {
    const mentionOptions = Array.from({ length: 20 }, (_, index) => ({
      display_name: `Person ${index + 1}`,
      id: `actor-${index + 1}`,
      kind: "human" as const,
      tenant_id: "tenant-1",
    }));
    render(
      <MessageComposer mentionOptions={mentionOptions} onSend={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("Message Room"), {
      target: { selectionStart: 1, value: "@" },
    });

    const listbox = screen.getByRole("listbox", {
      name: "Mention people or documents",
    });
    expect(listbox.parentElement).toHaveClass("flex", "min-h-0", "flex-1");
    expect(listbox).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  });

  it("keeps a one-line draft with a mention on the compact row", () => {
    render(
      <MessageComposer
        mentionOptions={[
          {
            display_name: "Codex",
            id: "agent-codex",
            kind: "agent",
            tenant_id: "tenant-1",
          },
        ]}
        onSend={vi.fn()}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(editor).toHaveValue("@Codex ");
    // The mention lives inside the text, so it must not stack the toolbar
    // below the editor the way a staged attachment row does.
    expect(editor.closest(".message-composer-box")).toHaveAttribute(
      "data-compact",
      "true",
    );
  });

  it("sends with Enter and keeps Shift+Enter as a newline", () => {
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { value: "First line" } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "Ship V0" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith({
      body: "Ship V0",
      files: [],
      mentions: [],
    });
  });

  it("never sends while an IME composition owns Enter", () => {
    const onSend = vi.fn();
    const alice = {
      display_name: "Alice",
      id: "actor-alice",
      kind: "human" as const,
      tenant_id: "tenant-1",
    };
    render(<MessageComposer mentionOptions={[alice]} onSend={onSend} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });
    expect(screen.getByRole("option", { name: /Alice/ })).toBeVisible();
    fireEvent.compositionStart(editor);
    expect(editor).toHaveAttribute("data-composing", "true");
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(editor);

    expect(editor).not.toHaveAttribute("data-composing");
    expect(editor).toHaveValue("@");
    expect(screen.getByRole("option", { name: /Alice/ })).toBeVisible();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps local input but blocks send and attachment commands while disconnected", () => {
    const onSend = vi.fn();
    render(<MessageComposer disabled onSend={onSend} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { value: "Keep this draft" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(editor).toHaveValue("Keep this draft");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("retains the draft until accepted and releases the composer for the next message", async () => {
    let accept!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    render(<MessageComposer onSend={onSend} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    fireEvent.change(editor, { target: { value: "Durable first" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor).toHaveValue("Durable first");
    expect(editor).toHaveAttribute("readonly");
    await act(async () => accept());
    expect(editor).toHaveValue("");
    expect(editor).not.toHaveAttribute("readonly");
    fireEvent.change(editor, { target: { value: "New draft" } });
    expect(editor).toHaveValue("New draft");
  });

  it("keeps the draft and reports the error when message delivery fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("Agent is deleted"));
    render(<MessageComposer onSend={onSend} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { value: "Keep this after failure" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent is deleted",
    );
    expect(editor).toHaveValue("Keep this after failure");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
  });

  it("shows and sends an immutable Document context without message text", () => {
    const documentContext = {
      documentId: "document-report",
      documentVersionId: "version-report-v1",
      filename: "report.md",
      sourceRoomId: "room-source",
      sourceRoomName: "Source Room",
      versionNumber: 1,
    };
    const onOpenDocumentContext = vi.fn();
    const onSend = vi.fn();
    render(
      <MessageComposer
        initialDocumentContexts={[documentContext]}
        onOpenDocumentContext={onOpenDocumentContext}
        onSend={onSend}
      />,
    );

    expect(screen.getByText("report.md")).toBeVisible();
    expect(screen.getByText("Version 1 · Source Room")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Open report.md Version 1" }),
    );
    expect(onOpenDocumentContext).toHaveBeenCalledWith(documentContext);

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({
      documentContexts: [documentContext],
      body: "",
      files: [],
      mentions: [],
    });
  });

  it("clears a committed retry body without overwriting a newer draft", () => {
    const onDraftStateChange = vi.fn();
    const ref = createRef<MessageComposerHandle>();
    render(
      <MessageComposer
        onDraftStateChange={onDraftStateChange}
        onSend={vi.fn()}
        ref={ref}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { value: "Draft for the next Message" },
    });
    onDraftStateChange.mockClear();
    act(() => ref.current?.clearCommittedBody("Earlier failed Message"));
    expect(editor).toHaveValue("Draft for the next Message");
    expect(onDraftStateChange).not.toHaveBeenCalled();

    act(() => ref.current?.clearCommittedBody("Draft for the next Message"));
    expect(editor).toHaveValue("");
    expect(onDraftStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ body: "" }),
    );
  });

  it("keeps an empty editor compact without measuring the new Room layout", () => {
    const measure = vi.spyOn(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
      "get",
    );
    try {
      render(<MessageComposer onSend={vi.fn()} />);
      const editor = screen.getByLabelText("Message Room");
      // The CSS min-height owns the empty editor's one-line height.
      expect(editor.style.height).toBe("");
      expect(editor).toHaveStyle({ overflowY: "hidden" });
      expect(measure).not.toHaveBeenCalled();
    } finally {
      measure.mockRestore();
    }
  });

  it("grows with its content, caps at 400px, and collapses after send", () => {
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    let scrollHeight = 20;
    Object.defineProperty(editor, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    fireEvent.change(editor, { target: { value: "A" } });
    expect(editor).toHaveStyle({ height: "20px" });
    expect(editor.closest(".message-composer-box")).toHaveAttribute(
      "data-compact",
      "true",
    );

    scrollHeight = 36;
    fireEvent.change(editor, { target: { value: "A\nB" } });
    expect(editor).toHaveStyle({ height: "36px" });
    expect(editor.closest(".message-composer-box")).toHaveAttribute(
      "data-multiline",
      "true",
    );

    scrollHeight = 84;
    fireEvent.change(editor, { target: { value: "A\nB\nC" } });
    expect(editor).toHaveStyle({ height: "84px", overflowY: "hidden" });

    scrollHeight = 520;
    fireEvent.change(editor, { target: { value: "A\nB\nC\nD" } });
    expect(editor).toHaveStyle({ height: "400px", overflowY: "auto" });

    scrollHeight = 20;
    fireEvent.change(editor, { target: { value: "A" } });
    expect(editor.closest(".message-composer-box")).not.toHaveAttribute(
      "data-multiline",
    );
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.style.height).toBe("");
    expect(editor).toHaveStyle({ overflowY: "hidden" });
  });

  it("submits selected Actor identities and Files as one composition", () => {
    const onSend = vi.fn();
    const codex = {
      display_name: "Codex",
      id: "actor-codex",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer
        attachmentEnabled
        mentionOptions={[codex]}
        onSend={onSend}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    const file = new File(["fixture"], "launch-plan.zip", {
      type: "application/zip",
    });

    fireEvent.change(editor, { target: { value: "@Cod" } });
    fireEvent.click(screen.getByRole("option", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith({
      body: "@Codex",
      files: [file],
      mentions: [codex],
    });
    expect(
      screen.queryByRole("button", { name: "Attach image" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeVisible();
  });

  it("finishes attachment staging in the Composer before enabling send", async () => {
    let finishUpload!: () => void;
    const onSend = vi.fn();
    const onStageAttachment = vi.fn(
      ({ onProgress }: { onProgress?: (progress: number) => void }) =>
        new Promise<void>((resolve) => {
          onProgress?.(0.35);
          finishUpload = resolve;
        }),
    );
    const file = new File(["video"], "sample.mp4", { type: "video/mp4" });
    render(
      <MessageComposer
        attachmentEnabled
        onSend={onSend}
        onStageAttachment={onStageAttachment}
      />,
    );

    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files: [file] },
    });

    expect(screen.getByText("Uploading 35%")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => finishUpload());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith({
      attachmentIdempotencyKey: expect.any(String),
      attachmentInputs: [{ clientId: expect.any(String), file }],
      body: "",
      files: [file],
      mentions: [],
    });
  });

  it("keeps the compact attachment remove control visible and cancels its staged upload", async () => {
    const onCancelAttachment = vi.fn().mockResolvedValue(undefined);
    const onStageAttachment = vi.fn().mockResolvedValue(undefined);
    const file = new File(["plan"], "plan.md", { type: "text/markdown" });
    render(
      <MessageComposer
        attachmentEnabled
        onCancelAttachment={onCancelAttachment}
        onSend={vi.fn()}
        onStageAttachment={onStageAttachment}
      />,
    );
    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files: [file] },
    });

    const remove = await screen.findByRole("button", {
      name: "Remove plan.md",
    });
    expect(remove).toHaveClass("size-3");
    expect(remove).not.toHaveClass("opacity-0");
    fireEvent.click(remove);

    await waitFor(() => expect(onCancelAttachment).toHaveBeenCalledOnce());
    expect(onCancelAttachment).toHaveBeenCalledWith({
      attachmentClientId: expect.any(String),
      idempotencyKey: expect.any(String),
    });
    expect(screen.queryByText("plan.md")).toBeNull();
  });

  it("keeps a keyed draft's upload running and its chip across a remount", async () => {
    const onCancelAttachment = vi.fn().mockResolvedValue(undefined);
    let finishUpload: () => void = () => undefined;
    const onStageAttachment = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          finishUpload = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const file = new File(["plan"], "plan.md", { type: "text/markdown" });
    const composer = () => (
      <MessageComposer
        attachmentDraftKey="account:tenant:room-remount"
        attachmentEnabled
        onCancelAttachment={onCancelAttachment}
        onSend={vi.fn()}
        onStageAttachment={onStageAttachment}
      />
    );
    const first = render(composer());
    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files: [file] },
    });
    expect(await screen.findByText("plan.md")).toBeVisible();
    first.unmount();

    expect(onCancelAttachment).not.toHaveBeenCalled();
    await act(async () => finishUpload());
    render(composer());

    expect(screen.getByText("plan.md")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    expect(onStageAttachment).toHaveBeenCalledOnce();
  });

  it("uses the authored PDF, code, and presentation attachment tokens", () => {
    const files = [
      new File(["pdf"], "brief.pdf", { type: "application/pdf" }),
      new File(["code"], "readme.md", { type: "text/markdown" }),
      new File(["slides"], "deck.pptx", {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ];
    render(<MessageComposer attachmentEnabled onSend={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files },
    });

    const pendingAttachments = screen.getByRole("region", {
      name: "Pending attachments",
    });
    // Staged files sit on their own row above the editor, inside the box.
    expect(pendingAttachments.parentElement).toHaveClass(
      "message-composer-box",
    );
    expect(pendingAttachments.nextElementSibling).toHaveClass(
      "message-composer-editor",
    );
    expect(
      screen.getByRole("button", { name: "Download brief.pdf" }).parentElement,
    ).toHaveClass("h-5", "bg-[var(--composer-attachment-pdf-surface)]");
    expect(
      screen.getByRole("button", { name: "Download readme.md" }).parentElement,
    ).toHaveClass("bg-[var(--composer-attachment-code-surface)]");
    expect(
      screen.getByRole("button", { name: "Download deck.pptx" }).parentElement,
    ).toHaveClass("bg-[var(--composer-attachment-presentation-surface)]");
    expect(pendingAttachments.querySelectorAll("img")).toHaveLength(0);
    expect(pendingAttachments.querySelectorAll("svg.size-4")).toHaveLength(3);
  });

  it("uses colored document, sheet, and compressed attachment tokens", () => {
    const files = [
      new File(["doc"], "brief.docx"),
      new File(["sheet"], "budget.xlsx"),
      new File(["archive"], "sources.zip"),
    ];
    render(<MessageComposer attachmentEnabled onSend={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files },
    });

    expect(
      screen.getByRole("button", { name: "Download brief.docx" }).parentElement,
    ).toHaveClass("bg-[var(--composer-attachment-document-surface)]");
    expect(
      screen.getByRole("button", { name: "Download budget.xlsx" })
        .parentElement,
    ).toHaveClass("bg-[var(--composer-attachment-sheet-surface)]");
    expect(
      screen.getByRole("button", { name: "Download sources.zip" })
        .parentElement,
    ).toHaveClass("bg-[var(--composer-attachment-compressed-surface)]");
  });

  it("appends dropped files to files already selected with the picker", () => {
    const ref = createRef<MessageComposerHandle>();
    const onSend = vi.fn();
    const picked = new File(["picked"], "picked.txt", { type: "text/plain" });
    const dropped = new File(["dropped"], "dropped.txt", {
      type: "text/plain",
    });
    render(<MessageComposer attachmentEnabled onSend={onSend} ref={ref} />);

    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files: [picked] },
    });
    act(() => {
      expect(ref.current?.addFiles([dropped])).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith({
      body: "",
      files: [picked, dropped],
      mentions: [],
    });
  });

  it("adds pasted image, audio, and video files with preview and download actions", async () => {
    const onSend = vi.fn();
    const image = new File(["image"], "screenshot.png", {
      type: "image/png",
    });
    const audio = new File(["audio"], "sample.mp3", {
      type: "audio/mpeg",
    });
    const video = new File(["video"], "sample.mp4", {
      type: "video/mp4",
    });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:image")
      .mockReturnValueOnce("blob:audio")
      .mockReturnValueOnce("blob:video");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(<MessageComposer attachmentEnabled onSend={onSend} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    const accepted = fireEvent.paste(editor, {
      clipboardData: {
        files: [image, audio, video],
        getData: () => "",
        items: [],
      },
    });

    expect(accepted).toBe(false);
    const pendingAttachments = screen.getByRole("region", {
      name: "Pending attachments",
    });
    // Staged files sit on their own row above the editor, inside the box.
    expect(pendingAttachments.parentElement).toHaveClass(
      "message-composer-box",
    );
    expect(pendingAttachments.nextElementSibling).toHaveClass(
      "message-composer-editor",
    );
    expect(screen.queryByText("screenshot.png")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Preview screenshot.png" })
        .querySelector("img"),
    ).toHaveClass("h-full", "w-auto");
    expect(
      screen.getByRole("button", { name: "Download sample.mp3" }).parentElement,
    ).toHaveClass("bg-[var(--composer-attachment-universal-surface)]");
    expect(
      screen.getByRole("button", { name: "Download sample.mp4" }).parentElement,
    ).toHaveClass("bg-[var(--composer-attachment-universal-surface)]");
    fireEvent.click(
      screen.getByRole("button", { name: "Preview screenshot.png" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Preview screenshot.png" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Close image preview" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Download sample.mp3" }),
    );
    expect(anchorClick).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith({
      body: "",
      files: [image, audio, video],
      mentions: [],
    });

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    anchorClick.mockRestore();
  });

  it("offers Human and Agent members with keyboard mention selection", () => {
    const onSend = vi.fn();
    const official = {
      display_name: "@official",
      id: "actor-official",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    const alice = {
      display_name: "Alice",
      id: "actor-alice",
      kind: "human" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer mentionOptions={[official, alice]} onSend={onSend} />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(editor, { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    fireEvent.mouseEnter(options[1]!);
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(editor).toHaveValue("@Alice ");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({
      body: "@Alice",
      files: [],
      mentions: [alice],
    });
  });

  it("keeps every Room member reachable when the list exceeds eight", () => {
    const mentionOptions = Array.from({ length: 9 }, (_, index) => ({
      display_name: index === 8 ? "newmember" : `member${index + 1}`,
      id: `actor-${index + 1}`,
      kind: "human" as const,
      tenant_id: "tenant-1",
    }));
    render(
      <MessageComposer mentionOptions={mentionOptions} onSend={vi.fn()} />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 1, value: "@" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(9);
    fireEvent.click(screen.getByRole("option", { name: /newmember/ }));

    expect(editor).toHaveValue("@newmember ");
  });

  it("cycles All, People, and Docs from the editor with Left and Right", () => {
    const alice = {
      display_name: "Alice",
      id: "actor-alice",
      kind: "human" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer
        documentOptions={[
          {
            documentId: "document-plan",
            name: "Launch plan",
            updatedAt: new Date(2026, 8, 9, 14, 5, 6).toISOString(),
          },
        ]}
        mentionOptions={[alice]}
        onSend={vi.fn()}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });
    expect(screen.getByRole("tab", { name: "all" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "people" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Alice/ })).toBeVisible();

    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "docs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Launch plan/ })).toBeVisible();
    expect(screen.getByText(/Updated .*14:05:06/)).toBeVisible();

    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "all" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "docs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.change(editor, {
      target: { selectionStart: 3, value: "@La" },
    });
    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "all" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(editor).toHaveValue("@La");
    expect(screen.getByRole("option", { name: /Launch plan/ })).toBeVisible();
  });

  it("uses roving tab focus with Left, Right, Home, and End", () => {
    render(<MessageComposer onSend={vi.fn()} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });

    expect(fireEvent.keyDown(editor, { key: "Tab", shiftKey: true })).toBe(
      true,
    );
    expect(editor).toHaveValue("@");

    const allTab = screen.getByRole("tab", { name: "all" });
    allTab.focus();
    fireEvent.keyDown(allTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "people" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "all" })).toHaveAttribute(
      "tabindex",
      "-1",
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "people" }), {
      key: "End",
    });
    expect(screen.getByRole("tab", { name: "docs" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "docs" }), {
      key: "Home",
    });
    expect(screen.getByRole("tab", { name: "all" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "all" }), {
      key: "ArrowLeft",
    });
    expect(screen.getByRole("tab", { name: "docs" })).toHaveFocus();
  });

  it("confirms the default mention with Tab without duplicating its @ prefix", () => {
    const official = {
      display_name: "@official",
      id: "actor-official",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    render(<MessageComposer mentionOptions={[official]} onSend={vi.fn()} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 8, value: "Ask @off later" },
    });
    fireEvent.keyDown(editor, { key: "Tab" });

    expect(editor).toHaveValue("Ask @official later");

    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });
    expect(screen.getByRole("option", { name: /official/ })).toBeVisible();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(editor).toHaveValue("@");
  });

  it("filters and inserts Unicode member names", () => {
    const zhangWei = {
      display_name: "Zoë Ågren",
      id: "actor-zhang-wei",
      kind: "human" as const,
      tenant_id: "tenant-1",
    };
    render(<MessageComposer mentionOptions={[zhangWei]} onSend={vi.fn()} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 2, value: "@Z" },
    });
    expect(screen.getByRole("option", { name: /Zoë Ågren/ })).toBeVisible();
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(editor).toHaveValue("@Zoë Ågren ");
  });

  it("switches the @ picker to Docs and sends a native Draft by Document identity", () => {
    const onSend = vi.fn();
    render(
      <MessageComposer
        documentOptions={[
          {
            documentId: "document-draft",
            name: "Draft notes",
            updatedAt: "2026-08-07T10:00:00Z",
          },
          {
            documentId: "document-plan",
            name: "Launch plan",
            updatedAt: "2026-08-08T10:00:00Z",
          },
        ]}
        onSend={onSend}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });
    fireEvent.click(screen.getByRole("tab", { name: "docs" }));
    expect(
      screen.getByRole("option", { name: /Draft notes/ }),
    ).not.toHaveAttribute("aria-disabled");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor).toHaveValue("@Draft_notes ");
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith({
      body: "@Draft_notes",
      documentReferences: [
        { documentId: "document-draft", token: "@Draft_notes" },
      ],
      files: [],
      mentions: [],
    });
  });

  it("turns a pasted internal Document link into a structured token at the selection", () => {
    const onSend = vi.fn();
    render(
      <MessageComposer
        documentOptions={[
          {
            documentId: "document-plan",
            name: "Launch plan",
            tenantId: "tenant-1",
            updatedAt: "2026-08-08T10:00:00Z",
          },
        ]}
        documentOptionsReady
        initialValue="Review old text today"
        onSend={onSend}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    editor.setSelectionRange(7, 15);
    fireEvent.paste(editor, {
      clipboardData: {
        getData: () =>
          `${window.location.origin}/t/tenant-1/documents/document-plan`,
      },
    });

    expect(editor).toHaveValue("Review @Launch_plan today");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({
      body: "Review @Launch_plan today",
      documentReferences: [
        { documentId: "document-plan", token: "@Launch_plan" },
      ],
      files: [],
      mentions: [],
    });
  });

  it.each([false, true])(
    "resolves a pasted Document without renumbering it when cached=%s",
    async (cached) => {
      const onSend = vi.fn();
      let finishResolution:
        | ((value: {
            documentId: string;
            name: string;
            tenantId: string;
            updatedAt: string;
          }) => void)
        | undefined;
      const resolution = new Promise<{
        documentId: string;
        name: string;
        tenantId: string;
        updatedAt: string;
      }>((resolve) => {
        finishResolution = resolve;
      });
      const resolved = {
        documentId: "document-personal",
        name: "Personal brief.md",
        tenantId: "tenant-1",
        updatedAt: "2026-08-08T10:00:00Z",
      };
      const resolveDocumentLink = vi.fn(() => resolution);
      render(
        <MessageComposer
          documentOptions={
            cached ? [{ ...resolved, requiresRoomBinding: true }] : []
          }
          documentOptionsReady
          onOpenDocument={vi.fn()}
          onSend={onSend}
          resolveDocumentLink={resolveDocumentLink}
        />,
      );
      const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
      const value = `${window.location.origin}/t/tenant-1/documents/document-personal`;
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: {
          getData: (type: string) =>
            type === "text/html"
              ? `<a href="${value}" data-linger-document-id="document-personal" data-linger-tenant-id="tenant-1">Personal brief.md</a>`
              : value,
        },
      });
      act(() => {
        editor.dispatchEvent(paste);
      });

      expect(paste.defaultPrevented).toBe(true);
      expect(editor).toHaveValue("@Personal_brief_md ");
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      expect(resolveDocumentLink).toHaveBeenCalledWith({
        documentId: "document-personal",
        tenantId: "tenant-1",
      });
      finishResolution?.(resolved);
      expect(
        await screen.findByRole("button", { name: "Open Personal brief.md" }),
      ).toBeVisible();
      expect(editor).toHaveValue("@Personal_brief_md ");
      fireEvent.change(editor, { target: { value: "" } });
      fireEvent.paste(editor, {
        clipboardData: {
          getData: (type: string) => (type === "text/plain" ? value : ""),
        },
      });
      await waitFor(() => expect(editor).toHaveValue("@Personal_brief_md "));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled(),
      );
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({
          documentReferences: [
            {
              documentId: "document-personal",
              token: "@Personal_brief_md",
            },
          ],
        }),
      );
    },
  );

  it("keeps a denied Document URL as text without constructing a segment", async () => {
    const onSend = vi.fn();
    const resolveDocumentLink = vi
      .fn()
      .mockRejectedValue(new Error("Document cannot be shared in this Room."));
    render(
      <MessageComposer
        documentOptions={[]}
        documentOptionsReady
        onSend={onSend}
        resolveDocumentLink={resolveDocumentLink}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    const value = `${window.location.origin}/t/tenant-1/documents/document-denied`;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === "text/html"
            ? `<a href="${value}" data-linger-document-id="document-denied" data-linger-tenant-id="tenant-1">Denied document</a>`
            : value,
      },
    });
    act(() => {
      editor.dispatchEvent(paste);
    });

    expect(paste.defaultPrevented).toBe(true);
    expect(editor).toHaveValue("@Denied_document ");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document cannot be shared in this Room.",
    );
    expect(editor).toHaveValue(`${value} `);
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({
      body: value,
      files: [],
      mentions: [],
    });
  });

  it("keeps pasted links as text when the Document catalog cannot authorize them", () => {
    render(
      <MessageComposer
        documentOptions={[]}
        documentOptionsReady
        onSend={vi.fn()}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    const value = `${window.location.origin}/t/tenant-1/documents/deleted`;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => value },
    });
    editor.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(editor).toHaveValue("");
  });

  it("does not structure a non-canonical Document URL with route state", () => {
    render(
      <MessageComposer
        documentOptions={[
          {
            documentId: "document-plan",
            name: "Launch plan",
            tenantId: "tenant-1",
            updatedAt: "2026-08-08T10:00:00Z",
          },
        ]}
        documentOptionsReady
        onSend={vi.fn()}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: () =>
          `${window.location.origin}/t/tenant-1/documents/document-plan?download=1`,
      },
    });
    editor.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(editor).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: "Open Launch plan" }),
    ).toBeNull();
  });

  it.each([
    ["ordinary", "https://example.com/roadmap"],
    ["malformed", `${window.location.origin}/t/%E0%A4%A/documents/document-1`],
  ])("leaves an %s URL to native paste", (_kind, value) => {
    render(
      <MessageComposer
        documentOptions={[]}
        documentOptionsReady
        onSend={vi.fn()}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => value },
    });
    editor.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(
      screen.queryByRole("group", { name: "Composer references" }),
    ).not.toHaveTextContent(/@/);
  });

  it("renders only structured Person and Document tokens as distinct actions", () => {
    const onOpenDocument = vi.fn();
    const onOpenProfile = vi.fn();
    const codex = {
      display_name: "Codex",
      id: "actor-codex",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    const document = {
      documentId: "document-plan",
      name: "Launch plan",
      tenantId: "tenant-1",
      updatedAt: "2026-08-08T10:00:00Z",
    };
    render(
      <MessageComposer
        documentOptions={[document]}
        initialDocumentReferences={[
          {
            documentId: "document-plan",
            token: "@Launch_plan",
          },
        ]}
        initialMentions={[codex]}
        initialValue="Ask @Codex to inspect @Launch_plan, not @plain."
        onOpenDocument={onOpenDocument}
        onOpenProfile={onOpenProfile}
        onSend={vi.fn()}
      />,
    );

    const actorAction = screen.getByRole("button", {
      name: "Open Codex profile",
    });
    const documentAction = screen.getByRole("button", {
      name: "Open Launch plan",
    });
    expect(actorAction).toHaveAttribute("data-reference-kind", "actor");
    expect(documentAction).toHaveAttribute("data-reference-kind", "document");
    expect(
      screen.queryByRole("button", { name: /plain/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(actorAction);
    expect(onOpenProfile).toHaveBeenCalledWith("actor-codex");
    fireEvent.click(documentAction);
    expect(onOpenDocument).toHaveBeenCalledWith(document);
    fireEvent.keyDown(actorAction, { key: "Enter" });
    expect(onOpenProfile).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(documentAction, { key: " " });
    expect(onOpenDocument).toHaveBeenCalledTimes(2);
  });

  it("publishes a complete structured draft and restores its send semantics", () => {
    const onDraftStateChange = vi.fn();
    const onSend = vi.fn();
    const codex = {
      display_name: "Codex",
      id: "actor-codex",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    const documentReference = {
      documentId: "document-plan",
      token: "@Launch_plan",
    };
    const skillReference = {
      manifestVersion: "1.0.0",
      skillId: "skill-review",
      target: "actor-codex",
      token: "/review-changes",
    };
    render(
      <MessageComposer
        initialDocumentReferences={[documentReference]}
        initialMentions={[codex]}
        initialSkillReferences={[skillReference]}
        initialValue="@Codex /review-changes @Launch_plan"
        onDraftStateChange={onDraftStateChange}
        onSend={onSend}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { value: "@Codex /review-changes @Launch_plan now" },
    });
    expect(onDraftStateChange).toHaveBeenLastCalledWith({
      documentContexts: [],
      body: "@Codex /review-changes @Launch_plan now",
      documentReferences: [documentReference],
      mentions: [codex],
      skillReferences: [skillReference],
    });

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({
      body: "@Codex /review-changes @Launch_plan now",
      documentReferences: [documentReference],
      files: [],
      mentions: [codex],
      skillReferences: [skillReference],
    });
  });

  it("degrades unavailable restored references to plain text", () => {
    const onSend = vi.fn();
    const staleActor = {
      display_name: "Retired Agent",
      id: "actor-retired",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer
        agentOptionsReady
        documentOptionsReady
        initialDocumentReferences={[
          {
            documentId: "document-deleted",
            token: "@Deleted_plan",
          },
        ]}
        initialMentions={[staleActor]}
        initialSkillReferences={[
          {
            manifestVersion: "1.0.0",
            skillId: "skill-retired",
            target: staleActor.id,
            token: "/retired-skill",
          },
        ]}
        initialValue="@Retired_Agent /retired-skill inspect @Deleted_plan"
        onOpenDocument={vi.fn()}
        onOpenProfile={vi.fn()}
        onSend={onSend}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    expect(
      screen.queryByRole("button", { name: /Retired Agent profile/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Open Deleted plan/i }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith({
      body: "@Retired_Agent /retired-skill inspect @Deleted_plan",
      files: [],
      mentions: [],
    });
  });

  it("waits for reference catalogs before validating a restored draft", () => {
    const onSend = vi.fn();
    const codex = {
      display_name: "Codex",
      id: "actor-codex",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    const document = {
      documentId: "document-plan",
      name: "Launch plan",
      tenantId: "tenant-1",
      updatedAt: "2026-08-08T10:00:00Z",
    };
    const documentReference = {
      documentId: document.documentId,
      token: "@Launch_plan",
    };
    const skill = {
      agent: codex,
      manifestVersion: "1.0.0",
      name: "Review changes",
      skillId: "skill-review",
    };
    const skillReference = {
      manifestVersion: skill.manifestVersion,
      skillId: skill.skillId,
      target: codex.id,
      token: "/review-changes",
    };
    const { rerender } = render(
      <MessageComposer
        agentOptionsReady={false}
        documentOptionsReady={false}
        initialDocumentReferences={[documentReference]}
        initialMentions={[codex]}
        initialSkillReferences={[skillReference]}
        initialValue="@Codex /review-changes inspect @Launch_plan"
        onSend={onSend}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(
      screen.getByText("Message references are still loading. Try again."),
    ).toBeVisible();

    rerender(
      <MessageComposer
        agentOptionsReady
        documentOptions={[document]}
        documentOptionsReady
        initialDocumentReferences={[documentReference]}
        initialMentions={[codex]}
        initialSkillReferences={[skillReference]}
        initialValue="@Codex /review-changes inspect @Launch_plan"
        mentionOptions={[codex]}
        onSend={onSend}
        skillOptions={[skill]}
      />,
    );
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith({
      body: "@Codex /review-changes inspect @Launch_plan",
      documentReferences: [
        { documentId: "document-plan", token: "@Launch_plan" },
      ],
      files: [],
      mentions: [codex],
      skillReferences: [skillReference],
    });
  });

  it("opens an Agent-scoped Skill menu only once a slash query starts", () => {
    const onSend = vi.fn();
    const reviewer = {
      display_name: "Reviewer",
      id: "actor-reviewer",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    const researcher = {
      display_name: "Researcher",
      id: "actor-researcher",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer
        mentionOptions={[reviewer, researcher]}
        onSend={onSend}
        skillOptions={[
          {
            agent: reviewer,
            description:
              "Review the current working tree and report actionable findings.",
            manifestVersion: "1.0.0",
            name: "Review Changes",
            skillId: "skill-review",
          },
          {
            agent: reviewer,
            description:
              "Summarize the selected Room discussion into meeting notes.",
            manifestVersion: "1.0.0",
            name: "Create Meeting Minutes",
            skillId: "skill-meeting-minutes",
          },
          {
            agent: researcher,
            manifestVersion: "2.0.0",
            name: "Research Market",
            skillId: "skill-research",
          },
        ]}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 4, value: "@Rev" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Reviewer/ }));

    expect(editor).toHaveValue("@Reviewer ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.change(editor, {
      target: { selectionStart: 11, value: "@Reviewer /" },
    });
    expect(
      screen.getByRole("listbox", { name: "Skills for Reviewer" }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: /review-changes/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Selected Skill description" }),
    ).toHaveTextContent(
      "Review the current working tree and report actionable findings.",
    );
    expect(
      screen.queryByRole("option", { name: /research-market/i }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor).toHaveValue("@Reviewer /review-changes ");
    const skillReference = screen.getByLabelText("Skill /review-changes");
    expect(skillReference).toHaveAttribute("data-reference-kind", "skill");
    fireEvent.mouseEnter(skillReference);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Review the current working tree and report actionable findings.",
    );
    fireEvent.mouseLeave(skillReference);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith({
      body: "@Reviewer /review-changes",
      files: [],
      mentions: [reviewer],
      skillReferences: [
        {
          manifestVersion: "1.0.0",
          skillId: "skill-review",
          target: "actor-reviewer",
          token: "/review-changes",
        },
      ],
    });
  });

  it("keeps Shift+Enter for a newline and closes stale Skill queries after caret movement", () => {
    const onSend = vi.fn();
    const reviewer = {
      display_name: "Reviewer",
      id: "actor-reviewer",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer
        mentionOptions={[reviewer]}
        onSend={onSend}
        skillOptions={[
          {
            agent: reviewer,
            manifestVersion: "1.0.0",
            name: "Review Changes",
            skillId: "skill-review",
          },
        ]}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 4, value: "@Rev" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Reviewer/ }));
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(editor).toHaveValue("@Reviewer ");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({
      body: "@Reviewer",
      files: [],
      mentions: [reviewer],
    });
  });

  it("closes an Agent Skill menu when pointer selection moves the caret", () => {
    const reviewer = {
      display_name: "Reviewer",
      id: "actor-reviewer",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer
        mentionOptions={[reviewer]}
        onSend={vi.fn()}
        skillOptions={[
          {
            agent: reviewer,
            manifestVersion: "1.0.0",
            name: "Review Changes",
            skillId: "skill-review",
          },
        ]}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 4, value: "@Rev" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Reviewer/ }));
    editor.setSelectionRange(1, 1);
    fireEvent.click(editor);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps slash Skills closed without an Agent context", () => {
    const onSend = vi.fn();
    const reviewer = {
      display_name: "Reviewer",
      id: "actor-reviewer",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer
        mentionOptions={[reviewer]}
        onSend={onSend}
        skillOptions={[
          {
            agent: reviewer,
            manifestVersion: "1.0.0",
            name: "Review Changes",
            skillId: "skill-review",
          },
        ]}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 4, value: "/rev" },
    });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({
      body: "/rev",
      files: [],
      mentions: [],
    });
  });

  it("scopes later slash queries and removes a Skill when its Agent mention is deleted", () => {
    const onSend = vi.fn();
    const reviewer = {
      display_name: "Reviewer",
      id: "actor-reviewer",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    render(
      <MessageComposer
        mentionOptions={[reviewer]}
        onSend={onSend}
        skillOptions={[
          {
            agent: reviewer,
            manifestVersion: "1.0.0",
            name: "Review Changes",
            skillId: "skill-review",
          },
        ]}
      />,
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 4, value: "@Rev" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Reviewer/ }));
    fireEvent.keyDown(editor, { key: "Escape" });
    fireEvent.change(editor, {
      target: {
        selectionStart: 21,
        value: "@Reviewer please /rev",
      },
    });
    expect(
      screen.getByRole("listbox", { name: "Skills for Reviewer" }),
    ).toBeVisible();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor).toHaveValue("@Reviewer please /review-changes ");

    fireEvent.change(editor, {
      target: {
        selectionStart: 15,
        value: "/review-changes",
      },
    });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith({
      body: "/review-changes",
      files: [],
      mentions: [],
    });
  });

  it("reports and rejects selections above the five-file limit", () => {
    const onSend = vi.fn();
    render(<MessageComposer attachmentEnabled onSend={onSend} />);
    const files = Array.from(
      { length: 6 },
      (_, index) => new File(["fixture"], `file-${index}.txt`),
    );

    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Attach up to 5 files at a time.",
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("keeps existing files when the combined attachment count is invalid", () => {
    const ref = createRef<MessageComposerHandle>();
    const onSend = vi.fn();
    const existing = new File(["existing"], "existing.txt");
    render(<MessageComposer attachmentEnabled onSend={onSend} ref={ref} />);
    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: { files: [existing] },
    });

    const overflow = Array.from(
      { length: 5 },
      (_, index) => new File(["next"], `next-${index}.txt`),
    );
    act(() => {
      expect(ref.current?.addFiles(overflow)).toBe(false);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Attach up to 5 files at a time.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith({
      body: "",
      files: [existing],
      mentions: [],
    });
  });

  it("accepts up to five files when their combined size exceeds 100 MiB", () => {
    const ref = createRef<MessageComposerHandle>();
    const files = Array.from({ length: 5 }, (_, index) => {
      const file = new File([], `file-${index}.bin`);
      Object.defineProperty(file, "size", { value: 25 * 1024 * 1024 });
      return file;
    });
    render(<MessageComposer attachmentEnabled onSend={vi.fn()} ref={ref} />);

    act(() => {
      expect(ref.current?.addFiles(files.slice(0, 3))).toBe(true);
    });
    act(() => {
      expect(ref.current?.addFiles(files.slice(3))).toBe(true);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    for (const file of files) {
      expect(screen.getByText(file.name)).toBeVisible();
    }
  });

  it("does not accept imperative files while attachments are disabled", () => {
    const ref = createRef<MessageComposerHandle>();
    render(<MessageComposer onSend={vi.fn()} ref={ref} />);

    expect(ref.current?.canAcceptFiles()).toBe(false);
    expect(ref.current?.addFiles([new File(["x"], "x.txt")])).toBe(false);
  });

  it("does not accept more files while a message is submitting", async () => {
    const ref = createRef<MessageComposerHandle>();
    let resolveSend: (() => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    render(<MessageComposer attachmentEnabled onSend={onSend} ref={ref} />);
    fireEvent.change(screen.getByLabelText("Message Room"), {
      target: { value: "sending" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(ref.current?.canAcceptFiles()).toBe(false);
    expect(ref.current?.addFiles([new File(["x"], "x.txt")])).toBe(false);
    resolveSend?.();
    await waitFor(() => expect(ref.current?.canAcceptFiles()).toBe(true));
  });

  it("accepts a Message at the TeamHub 50,000-character boundary", () => {
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} />);
    const body = "a".repeat(TEAMHUB_MESSAGE_MAX_LENGTH);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    fireEvent.change(editor, { target: { value: body } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith({ body, files: [], mentions: [] });
  });

  it("rejects a Message above the TeamHub character boundary", () => {
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>("Message Room");

    expect(editor).toHaveAttribute(
      "maxlength",
      String(TEAMHUB_MESSAGE_MAX_LENGTH),
    );
    fireEvent.change(editor, {
      target: { value: "a".repeat(TEAMHUB_MESSAGE_MAX_LENGTH + 1) },
    });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Message must be 50,000 characters or fewer.",
    );
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("Message Composer reference tokens", () => {
  it("deterministically disambiguates colliding Document and Agent Skill labels", () => {
    const documents = [
      {
        documentId: "document-a",
        name: "Plan",
        tenantId: "tenant-1",
        updatedAt: "2026-08-09T00:00:00Z",
      },
      {
        documentId: "document-b",
        name: "Plan",
        tenantId: "tenant-1",
        updatedAt: "2026-08-09T00:00:00Z",
      },
    ];
    const agent = {
      display_name: "Reviewer",
      id: "actor-reviewer",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    const skills = [
      {
        agent,
        manifestVersion: "1.0.0",
        name: "Review",
        skillId: "skill-a",
      },
      {
        agent,
        manifestVersion: "1.0.0",
        name: "Review",
        skillId: "skill-b",
      },
    ];

    expect(
      documents.map((item) => formatDocumentToken(item, documents)),
    ).toEqual(["@Plan", "@Plan_2"]);
    expect(skills.map((item) => formatSkillToken(item, skills))).toEqual([
      "/review",
      "/review-2",
    ]);
  });
});
