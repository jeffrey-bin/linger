import { baseKeymap } from "@tiptap/pm/commands";
import { history, redo, undo } from "@tiptap/pm/history";
import {
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
} from "@tiptap/pm/inputrules";
import { keymap } from "@tiptap/pm/keymap";
import {
  Schema,
  Slice,
  type Fragment,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { EditorState, Plugin, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import {
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";

import { cn } from "@/lib/cn";

// Each block remains one Markdown line, including empty lines and heading markers.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "text*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    heading: {
      group: "block",
      content: "text*",
      defining: true,
      attrs: { level: { default: 1 } },
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        attrs: { level },
      })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    text: { group: "inline" },
  },
});

function parseNote(text: string) {
  return schema.node(
    "doc",
    null,
    text.split("\n").map((line) => {
      const heading = /^(#{1,6}) (.*)$/u.exec(line);
      const body = heading ? heading[2] : line;
      return schema.node(
        heading ? "heading" : "paragraph",
        heading ? { level: heading[1]!.length } : null,
        body ? schema.text(body) : undefined,
      );
    }),
  );
}

function prefix(node: ProseMirrorNode) {
  return node.type.name === "heading" ? `${"#".repeat(node.attrs.level)} ` : "";
}

function noteText(doc: ProseMirrorNode | Fragment) {
  const lines: string[] = [];
  doc.forEach((node) => lines.push(prefix(node) + node.textContent));
  return lines.join("\n");
}

export interface PocketNoteEditorHandle {
  selectionStart: () => number;
  focusAt: (offset: number) => void;
}

export function PocketNoteEditor({
  maxLength,
  onChange,
  onFull,
  ref,
  value,
}: {
  maxLength: number;
  onChange: (value: string) => void;
  onFull: () => void;
  ref: Ref<PocketNoteEditorHandle>;
  value: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [initialDoc] = useState(() => parseNote(value));
  const changed = useEffectEvent(onChange);
  const full = useEffectEvent(onFull);

  useLayoutEffect(() => {
    const editor = new EditorView(host.current, {
      state: EditorState.create({
        doc: initialDoc,
        selection: TextSelection.atEnd(initialDoc),
        plugins: [
          inputRules({
            rules: [
              textblockTypeInputRule(
                /^(#{1,6}) $/u,
                schema.nodes.heading,
                (match) => ({
                  level: match[1]!.length,
                }),
              ),
            ],
          }),
          keymap({
            Backspace: undoInputRule,
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            "Shift-Enter": baseKeymap.Enter!,
          }),
          keymap(baseKeymap),
          history(),
          new Plugin({
            filterTransaction(transaction, state) {
              if (!transaction.docChanged) return true;
              const next = noteText(transaction.doc);
              if (
                next.length <= maxLength ||
                next.length <= noteText(state.doc).length
              ) {
                return true;
              }
              full();
              return false;
            },
          }),
        ],
      }),
      attributes: {
        role: "textbox",
        "aria-label": "Today’s note",
        "aria-multiline": "true",
        "data-placeholder": "Jot anything down. Tomorrow starts a fresh page.",
        class: cn(
          "min-h-full whitespace-pre-wrap [overflow-wrap:anywhere] outline-none [&>*]:m-0",
          "[&>:is(h1,h2,h3,h4,h5,h6)]:font-[580] [&>:is(h1,h2,h3,h4,h5,h6)]:leading-[1.4]",
          "[&>h1]:text-[24px] [&>h2]:text-[20px] [&>:is(h3,h4,h5,h6)]:text-[16px]",
          "before:pointer-events-none before:float-left before:h-0 before:text-app-muted [&:has(>p:only-child>br:only-child)]:before:content-[attr(data-placeholder)]",
        ),
      },
      clipboardTextParser: (text) => new Slice(parseNote(text).content, 0, 0),
      clipboardTextSerializer: (slice) => noteText(slice.content),
      handleDOMEvents: {
        paste(editor, event) {
          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;
          event.preventDefault();
          editor.pasteText(text, event);
          return true;
        },
      },
      dispatchTransaction(transaction) {
        const previous = editor.state.doc;
        editor.updateState(editor.state.apply(transaction));
        if (!previous.eq(editor.state.doc)) changed(noteText(editor.state.doc));
      },
    });
    view.current = editor;
    editor.focus();
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [initialDoc, maxLength]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor && noteText(editor.state.doc) !== value) {
      editor.dispatch(
        editor.state.tr
          .replaceWith(
            0,
            editor.state.doc.content.size,
            parseNote(value).content,
          )
          .setMeta("addToHistory", false),
      );
    }
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      selectionStart() {
        const editor = view.current;
        if (!editor) return 0;
        const { $from } = editor.state.selection;
        let offset = 0;
        editor.state.doc.forEach((node, _position, index) => {
          if (index < $from.index(0))
            offset += prefix(node).length + node.textContent.length + 1;
        });
        return offset + prefix($from.parent).length + $from.parentOffset;
      },
      focusAt(offset) {
        const editor = view.current;
        if (!editor) return;
        let remaining = Math.max(0, offset);
        let position = editor.state.doc.content.size - 1;
        let found = false;
        editor.state.doc.forEach((node, start) => {
          if (found) return;
          const markerLength = prefix(node).length;
          const length = markerLength + node.textContent.length;
          if (remaining <= length) {
            position = start + 1 + Math.max(0, remaining - markerLength);
            found = true;
          } else {
            remaining -= length + 1;
          }
        });
        editor.dispatch(
          editor.state.tr.setSelection(
            TextSelection.create(editor.state.doc, position),
          ),
        );
        editor.focus();
      },
    }),
    [],
  );

  return (
    <div
      className="pocket-note-paper workspace-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-16 text-sm text-app-ink"
      ref={host}
    />
  );
}
