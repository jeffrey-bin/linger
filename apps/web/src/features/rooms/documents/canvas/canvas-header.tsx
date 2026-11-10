import { LinkSquare02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { RoomDocumentCollaborationSession } from "../room-document-collaboration";
import type { RoomDocumentEditor } from "../room-document-comment-schema";
import { type CanvasDocument, canvasText, readCanvas } from "./canvas-document";
import { canvasStatusKeys } from "./canvas-targets";

const agentEditingQuietMs = 3_000;

/**
 * Reads the canvas header block live and tells whether the Agent is writing:
 * Agents edit through the server, so a remote change to an already loaded
 * canvas while no other person is connected to the Document is theirs.
 */
export function useCanvas(
  editor: RoomDocumentEditor,
  awareness: RoomDocumentCollaborationSession["awareness"] | null | undefined,
) {
  const [canvas, setCanvas] = useState(() => readCanvas(editor.document));
  const [agentEditing, setAgentEditing] = useState(false);
  useLayoutEffect(() => {
    setCanvas(readCanvas(editor.document));
    // The initial sync arrives as remote changes too; only content that
    // changes after the canvas has loaded counts as the Agent writing.
    let loaded = readCanvas(editor.document)
      ? JSON.stringify(editor.document)
      : undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = editor.onChange((changed, { getChanges }) => {
      const next = readCanvas(changed.document);
      setCanvas(next);
      const previous = loaded;
      loaded = next ? JSON.stringify(changed.document) : undefined;
      const remote = getChanges().some(
        (change) => change.source.type === "yjs-remote",
      );
      const othersPresent = (awareness?.getStates().size ?? 0) > 1;
      if (!remote || !previous || previous === loaded || othersPresent) return;
      setAgentEditing(true);
      clearTimeout(quiet);
      quiet = setTimeout(() => setAgentEditing(false), agentEditingQuietMs);
    });
    return () => {
      clearTimeout(quiet);
      unsubscribe?.();
    };
  }, [awareness, editor]);
  return { agentEditing, canvas };
}

/** Hides the header code block in the editor; the header shows it instead. */
export function canvasHiddenBlockRule(scope: string, canvas?: CanvasDocument) {
  return canvas
    ? `[data-knowledge-scope=${JSON.stringify(scope)}] .bn-block-outer[data-id=${JSON.stringify(canvas.blockId)}] { display: none; }`
    : "";
}

export function CanvasHeader({
  agentEditing,
  canvas,
  editable,
  editor,
}: {
  agentEditing: boolean;
  canvas: CanvasDocument;
  editable: boolean;
  editor: RoomDocumentEditor;
}) {
  const save = (key: string, value: string) => {
    if ((canvas.fields[key] ?? "") === value) return;
    editor.updateBlock(canvas.blockId, {
      content: canvasText({
        ...canvas,
        fields: { ...canvas.fields, [key]: value },
      }),
    });
  };
  const fields =
    canvas.target.fields.length > 0
      ? canvas.target.fields
      : Object.keys(canvas.fields)
          .filter(
            (key) => !(canvasStatusKeys as readonly string[]).includes(key),
          )
          .map((key) => ({ key, label: key, placeholder: undefined }));

  return (
    <section
      aria-label={`${canvas.target.label} canvas`}
      className="mb-6"
      data-canvas-target={canvas.target.id}
    >
      <div className="flex min-h-8 items-center gap-2 text-[12px] text-app-muted">
        <span className="font-medium text-app-ink">{canvas.target.label}</span>
        <CanvasStatus canvas={canvas} />
        {agentEditing ? (
          <span
            className="ml-auto inline-flex items-center gap-1"
            role="status"
          >
            <Icon icon={PencilEdit01Icon} size={14} />
            Agent is editing…
          </span>
        ) : null}
      </div>
      {/* Mail-client style: one hairline-separated row per field, no card. */}
      <dl className="border-t border-app-border">
        {fields.map((field) => (
          <div
            className="flex items-center gap-3 border-b border-app-border"
            key={field.key}
          >
            <dt className="w-16 shrink-0 text-sm text-app-muted">
              <label htmlFor={`canvas-field-${field.key}`}>{field.label}</label>
            </dt>
            <dd className="min-w-0 flex-1">
              <CanvasField
                editable={editable}
                id={`canvas-field-${field.key}`}
                onSave={(value) => save(field.key, value)}
                placeholder={field.placeholder}
                value={canvas.fields[field.key] ?? ""}
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CanvasStatus({ canvas }: { canvas: CanvasDocument }) {
  if (canvas.status === "editing") return null;
  const label = canvas.status === "sent" ? "Sent" : "Draft saved";
  return canvas.link ? (
    <a
      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
      href={canvas.link}
      rel="noreferrer"
      target="_blank"
    >
      {label}
      <Icon icon={LinkSquare02Icon} size={12} />
    </a>
  ) : (
    <span>{label}</span>
  );
}

function CanvasField({
  editable,
  id,
  onSave,
  placeholder,
  value,
}: {
  editable: boolean;
  id: string;
  onSave: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  // The Agent may rewrite a field while it is shown; keep what is being typed.
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return (
    <input
      className="h-11 w-full bg-transparent text-sm text-app-ink outline-none placeholder:text-app-muted"
      id={id}
      onBlur={() => {
        focused.current = false;
        onSave(draft.trim());
      }}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing)
          event.currentTarget.blur();
      }}
      placeholder={placeholder}
      readOnly={!editable}
      value={draft}
    />
  );
}
