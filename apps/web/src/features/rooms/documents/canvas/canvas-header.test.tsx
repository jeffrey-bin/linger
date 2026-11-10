import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomDocumentEditor } from "../room-document-comment-schema";
import { CanvasHeader, useCanvas } from "./canvas-header";

type Listener = (
  editor: RoomDocumentEditor,
  context: { getChanges: () => { source: { type: string } }[] },
) => void;

function fakeEditor(text: string) {
  const listeners = new Set<Listener>();
  const editor = {
    document: [
      {
        id: "block_canvas",
        type: "codeBlock",
        content: [{ type: "text", text, styles: {} }],
        children: [],
        props: {},
      },
    ],
    onChange: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateBlock: vi.fn((_id: string, update: { content: string }) => {
      editor.document[0]!.content = [
        { type: "text", text: update.content, styles: {} },
      ];
    }),
  };
  /** Notifies a change; with text, the header block first gets that text. */
  const change = (source: string, nextText?: string) =>
    act(() => {
      if (nextText !== undefined)
        editor.document[0]!.content = [
          { type: "text", text: nextText, styles: {} },
        ];
      for (const listener of listeners)
        listener(editor as unknown as RoomDocumentEditor, {
          getChanges: () => [{ source: { type: source } }],
        });
    });
  return {
    change,
    editor: editor as unknown as RoomDocumentEditor & typeof editor,
  };
}

function awarenessOf(size: number) {
  return {
    getStates: () => new Map(Array.from({ length: size }, (_, i) => [i, {}])),
  };
}

function Harness({
  awareness,
  editable = true,
  editor,
}: {
  awareness?: ReturnType<typeof awarenessOf>;
  editable?: boolean;
  editor: RoomDocumentEditor;
}) {
  const { agentEditing, canvas } = useCanvas(editor, awareness as never);
  return canvas ? (
    <CanvasHeader
      agentEditing={agentEditing}
      canvas={canvas}
      editable={editable}
      editor={editor}
    />
  ) : (
    <p>Not a canvas</p>
  );
}

afterEach(() => vi.useRealTimers());

describe("CanvasHeader", () => {
  it("shows the target's fields and writes an edit back into the header block", () => {
    const { editor } = fakeEditor(
      "canvas: gmail\nto: lisa@acme.com\nsubject: Pricing\nstatus: editing",
    );
    render(<Harness editor={editor} />);

    expect(screen.getByRole("region", { name: "Gmail canvas" })).toBeVisible();
    expect(screen.getByLabelText("To")).toHaveValue("lisa@acme.com");
    expect(screen.getByLabelText("Cc")).toHaveValue("");
    const subject = screen.getByLabelText("Subject");
    fireEvent.focus(subject);
    fireEvent.change(subject, { target: { value: "Pricing follow-up" } });
    fireEvent.keyDown(subject, { key: "Enter" });
    fireEvent.blur(subject);

    expect(editor.updateBlock).toHaveBeenCalledWith("block_canvas", {
      content:
        "canvas: gmail\nto: lisa@acme.com\ncc: \nsubject: Pricing follow-up\nstatus: editing",
    });
  });

  it("does not write a field the user left unchanged", () => {
    const { editor } = fakeEditor("canvas: gmail\nsubject: Pricing");
    render(<Harness editor={editor} />);
    const subject = screen.getByLabelText("Subject");
    fireEvent.focus(subject);
    fireEvent.blur(subject);
    expect(editor.updateBlock).not.toHaveBeenCalled();
  });

  it("links the delivered draft and is read-only without edit access", () => {
    const { editor } = fakeEditor(
      "canvas: gmail\nsubject: Pricing\nstatus: draft\nlink: https://mail.google.com/mail/#drafts",
    );
    render(<Harness editable={false} editor={editor} />);
    expect(screen.getByRole("link", { name: "Draft saved" })).toHaveAttribute(
      "href",
      "https://mail.google.com/mail/#drafts",
    );
    expect(screen.getByLabelText("Subject")).toHaveAttribute("readonly");
  });

  it("shows the Agent editing while remote changes arrive and nobody else is here", () => {
    vi.useFakeTimers();
    const { change, editor } = fakeEditor("canvas: gmail\nsubject: Pricing");
    render(<Harness awareness={awarenessOf(1)} editor={editor} />);

    change("local", "canvas: gmail\nsubject: Pricing!");
    expect(screen.queryByText("Agent is editing…")).not.toBeInTheDocument();
    change("yjs-remote", "canvas: gmail\nsubject: Pricing update");
    expect(screen.getByRole("status")).toHaveTextContent("Agent is editing…");
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.queryByText("Agent is editing…")).not.toBeInTheDocument();
  });

  it("does not credit the Agent with another person's edits", () => {
    const { change, editor } = fakeEditor("canvas: gmail\nsubject: Pricing");
    render(<Harness awareness={awarenessOf(2)} editor={editor} />);
    change("yjs-remote", "canvas: gmail\nsubject: Pricing update");
    expect(screen.queryByText("Agent is editing…")).not.toBeInTheDocument();
  });

  it("does not count the initial load or an unchanged sync as the Agent writing", () => {
    const { change, editor } = fakeEditor("");
    render(<Harness awareness={awarenessOf(1)} editor={editor} />);
    // The canvas content arrives from the server after the editor mounts.
    change("yjs-remote", "canvas: gmail\nsubject: Pricing");
    expect(screen.getByLabelText("Subject")).toHaveValue("Pricing");
    expect(screen.queryByText("Agent is editing…")).not.toBeInTheDocument();
    change("yjs-remote");
    expect(screen.queryByText("Agent is editing…")).not.toBeInTheDocument();
  });

  it("renders nothing special for an ordinary Document", () => {
    const { editor } = fakeEditor("const answer = 42;");
    render(<Harness editor={editor} />);
    expect(screen.getByText("Not a canvas")).toBeVisible();
  });
});
