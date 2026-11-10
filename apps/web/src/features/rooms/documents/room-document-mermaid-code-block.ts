import {
  createBlockSpec,
  createCodeBlockSpec,
  defaultBlockSpecs,
} from "@blocknote/core";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./room-document-mermaid-code-block.css";

import { writeClipboardText } from "@/lib/clipboard";

import { renderMermaidSvg } from "../mermaid-preview-adapter";
import { MermaidSvgPreview } from "../mermaid-svg-preview";

/**
 * Languages a Document can carry. Pasted source keeps its own label instead of
 * collapsing to plain text, and Mermaid keeps its diagram surface.
 */
const baseCodeBlockSpec = createCodeBlockSpec({
  defaultLanguage: "text",
  supportedLanguages: {
    mermaid: { name: "Mermaid", aliases: ["mmd"] },
    text: { name: "Plain text", aliases: ["txt", "plaintext"] },
    bash: { name: "Shell", aliases: ["sh", "shell", "zsh"] },
    c: { name: "C" },
    cpp: { name: "C++", aliases: ["c++"] },
    csharp: { name: "C#", aliases: ["cs"] },
    css: { name: "CSS" },
    diff: { name: "Diff", aliases: ["patch"] },
    go: { name: "Go", aliases: ["golang"] },
    html: { name: "HTML" },
    java: { name: "Java" },
    javascript: { name: "JavaScript", aliases: ["js", "jsx"] },
    json: { name: "JSON", aliases: ["jsonc"] },
    kotlin: { name: "Kotlin", aliases: ["kt"] },
    markdown: { name: "Markdown", aliases: ["md", "mdx"] },
    php: { name: "PHP" },
    python: { name: "Python", aliases: ["py"] },
    ruby: { name: "Ruby", aliases: ["rb"] },
    rust: { name: "Rust", aliases: ["rs"] },
    sql: { name: "SQL" },
    swift: { name: "Swift" },
    toml: { name: "TOML", aliases: ["ini"] },
    typescript: { name: "TypeScript", aliases: ["ts", "tsx"] },
    xml: { name: "XML" },
    yaml: { name: "YAML", aliases: ["yml"] },
  },
});

/** Languages whose blocks are Mermaid, or carry no language at all. */
export const ROOM_DOCUMENT_UNTYPED_CODE_LANGUAGES = new Set(["", "text"]);
const renderDefaultCodeBlock =
  defaultBlockSpecs.codeBlock.implementation.render.bind({});

type NodeViewMutation = MutationRecord | { target: Node; type: "selection" };

export const roomDocumentCodeBlockSpec = createBlockSpec(
  baseCodeBlockSpec.config,
  {
    ...baseCodeBlockSpec.implementation,
    render(block, editor) {
      return renderRoomDocumentCodeBlock(block, editor);
    },
  },
  baseCodeBlockSpec.extensions,
)();

/**
 * Mermaid diagram headers. A Document can carry a diagram in a code block that
 * lost its language — imported Markdown, an Agent write, an older revision — and
 * those still belong in the diagram surface rather than in a raw text block.
 */
const MERMAID_HEADER =
  /^(?:sequenceDiagram|classDiagram|erDiagram|journey|gantt|mindmap|timeline|gitGraph|requirementDiagram|quadrantChart|C4Context|block-beta|sankey-beta|xychart-beta|architecture-beta|packet-beta|stateDiagram(?:-v2)?|flowchart[ \t]+[A-Za-z]{2}|graph[ \t]+(?:TB|TD|BT|RL|LR)|pie(?:[ \t]+title\b|[ \t]*$))/;

export function mermaidSourceFromCodeBlock(
  language: string,
  source: string,
): string | undefined {
  const fencedSource = source.match(
    /^[ \t]*```(?:mermaid|mmd)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n)?$/i,
  )?.[1];
  if (fencedSource !== undefined) {
    return fencedSource;
  }
  if (language === "mermaid") {
    return source;
  }
  // Only a block with no language of its own is worth sniffing; an explicit
  // Python or SQL block stays code even when a line reads like a diagram.
  return ROOM_DOCUMENT_UNTYPED_CODE_LANGUAGES.has(language) &&
    MERMAID_HEADER.test(source.trimStart())
    ? source
    : undefined;
}

function renderRoomDocumentCodeBlock(
  block: Parameters<typeof baseCodeBlockSpec.implementation.render>[0],
  editor: Parameters<typeof baseCodeBlockSpec.implementation.render>[1],
) {
  const initialSource = codeBlockSource(block);
  const initialMermaidSource = mermaidSourceFromCodeBlock(
    block.props.language,
    initialSource,
  );
  if (initialMermaidSource === undefined) {
    return renderDefaultCodeBlock(block, editor);
  }
  const wrapper = document.createDocumentFragment();
  const surface = document.createElement("div");
  surface.className = "room-document-mermaid";
  const startsEmpty = initialMermaidSource.trim() === "";
  let mode: "preview" | "source" = startsEmpty ? "source" : "preview";
  surface.dataset.mode = mode;
  const toolbar = document.createElement("div");
  toolbar.className = "room-document-mermaid__toolbar";
  toolbar.contentEditable = "false";
  toolbar.hidden = !editor.isEditable;
  // A Mermaid block stays a Mermaid block: switching it to plain text only ever
  // produced an unrenderable block, so the language control is a label.
  const language = document.createElement("span");
  language.className = "room-document-mermaid__language";
  language.textContent = "Mermaid";
  const sourceButton = modeButton("Source", mode === "source");
  const previewButton = modeButton("Preview", mode === "preview");
  const copyButton = modeButton("Copy source", false);
  copyButton.classList.add("room-document-mermaid__copy");
  copyButton.removeAttribute("aria-pressed");
  const modes = document.createElement("div");
  modes.className = "room-document-mermaid__modes";
  modes.append(sourceButton, previewButton);
  toolbar.append(language, modes, copyButton);

  const source = document.createElement("pre");
  source.className = "room-document-mermaid__source";
  source.hidden = mode === "preview";
  const code = document.createElement("code");
  source.appendChild(code);
  const preview = document.createElement("div");
  preview.className = "room-document-mermaid__preview";
  preview.contentEditable = "false";
  preview.hidden = mode !== "preview";
  const previewRoot = createRoot(preview);
  surface.append(toolbar, source, preview);
  wrapper.appendChild(surface);

  let timer: number | undefined;
  let activeRender: AbortController | undefined;
  let renderVersion = 0;
  let renderedMermaidSource: string | undefined;
  const currentCodeBlockSource = () => {
    const current = editor.getBlock(block.id);
    return current?.type === "codeBlock" ? codeBlockSource(current) : "";
  };
  const currentMermaidSource = () => {
    const current = editor.getBlock(block.id);
    const currentLanguage =
      current?.type === "codeBlock"
        ? current.props.language
        : block.props.language;
    return mermaidSourceFromCodeBlock(
      currentLanguage,
      currentCodeBlockSource(),
    );
  };
  const setMode = (next: typeof mode) => {
    mode = next;
    surface.dataset.mode = next;
    sourceButton.setAttribute("aria-pressed", String(next === "source"));
    previewButton.setAttribute("aria-pressed", String(next === "preview"));
    if (next === "source") {
      preview.hidden = true;
      source.hidden = false;
      return;
    }
    const mermaidSource = currentMermaidSource();
    if (
      mermaidSource !== undefined &&
      mermaidSource === renderedMermaidSource
    ) {
      preview.hidden = false;
      source.hidden = true;
      return;
    }
    schedulePreview();
  };
  const schedulePreview = (delay = 0) => {
    const mermaidSource = currentMermaidSource();
    if (mermaidSource !== undefined && mermaidSource.trim() === "") {
      window.clearTimeout(timer);
      activeRender?.abort();
      preview.dataset.renderVersion = String(++renderVersion);
      renderedMermaidSource = mermaidSource;
      previewRoot.render(
        createElement("p", null, "Add Mermaid source to see the diagram."),
      );
      return;
    }
    if (mermaidSource === undefined) {
      if (mode === "preview") {
        previewRoot.render(
          createElement("p", null, "Mermaid source is unavailable."),
        );
        preview.hidden = false;
        source.hidden = true;
      }
      return;
    }
    window.clearTimeout(timer);
    const version = ++renderVersion;
    preview.dataset.renderVersion = String(version);
    timer = window.setTimeout(() => {
      activeRender?.abort();
      activeRender = new AbortController();
      void renderMermaidPreview(
        preview,
        previewRoot,
        mermaidSource,
        version,
        activeRender.signal,
        () => {
          renderedMermaidSource = mermaidSource;
          if (mode === "preview" && currentMermaidSource() === mermaidSource) {
            preview.hidden = false;
            source.hidden = true;
          }
        },
      );
    }, delay);
  };
  const showSource = () => setMode("source");
  const showPreview = () => setMode("preview");
  const copySource = () => {
    void writeClipboardText(currentCodeBlockSource())
      .then(() => {
        copyButton.textContent = "Copied";
      })
      .catch(() => {
        copyButton.textContent = "Select source to copy";
      })
      .finally(() => {
        window.setTimeout(() => {
          copyButton.textContent = "Copy source";
        }, 1_500);
      });
  };
  const stopToolbarEvent = (event: Event) => event.stopPropagation();
  const keepButtonFocusOutOfEditor = (event: MouseEvent) => {
    event.stopPropagation();
    if (event.target instanceof HTMLButtonElement) event.preventDefault();
  };
  sourceButton.addEventListener("click", showSource);
  previewButton.addEventListener("click", showPreview);
  copyButton.addEventListener("click", copySource);
  toolbar.addEventListener("click", stopToolbarEvent);
  toolbar.addEventListener("mousedown", keepButtonFocusOutOfEditor);
  const sourceObserver = new MutationObserver(() => {
    // Editing happens in Source, where the diagram is not on screen. Running
    // the Mermaid parser on every keystroke or paste blocks the editor, so the
    // render waits for the switch back to Preview.
    if (mode !== "preview") return;
    schedulePreview(250);
  });
  sourceObserver.observe(code, {
    characterData: true,
    childList: true,
    subtree: true,
  });
  let lastEditable = editor.isEditable;
  const syncEditableChrome = () => {
    const editable = editor.isEditable;
    toolbar.hidden = !editable;
    if (editable === lastEditable) return;
    lastEditable = editable;
    if (!editable) setMode("preview");
  };
  // ProseMirror rewrites its root's contenteditable whenever the editor turns
  // editable or read-only, so watching that attribute replaces polling.
  const editableObserver = new MutationObserver(syncEditableChrome);
  const attachEditableObserver = () => {
    const root = surface.closest(".ProseMirror");
    if (root) {
      editableObserver.observe(root, {
        attributeFilter: ["contenteditable"],
        attributes: true,
      });
    }
    const host = surface.closest("[data-editable]");
    if (host) {
      editableObserver.observe(host, {
        attributeFilter: ["data-editable"],
        attributes: true,
      });
    }
    syncEditableChrome();
  };
  timer = window.setTimeout(() => {
    attachEditableObserver();
    schedulePreview();
  }, 0);

  return {
    contentDOM: code,
    destroy() {
      renderVersion += 1;
      window.clearTimeout(timer);
      activeRender?.abort();
      previewRoot.unmount();
      sourceObserver.disconnect();
      editableObserver.disconnect();
      sourceButton.removeEventListener("click", showSource);
      previewButton.removeEventListener("click", showPreview);
      copyButton.removeEventListener("click", copySource);
      toolbar.removeEventListener("click", stopToolbarEvent);
      toolbar.removeEventListener("mousedown", keepButtonFocusOutOfEditor);
    },
    dom: wrapper,
    ignoreMutation(mutation: NodeViewMutation) {
      if (mutation.type === "selection") return false;
      return mutation.target !== code && !code.contains(mutation.target);
    },
  };
}

function codeBlockSource(block: { content: Array<unknown> | undefined }) {
  return (block.content ?? [])
    .map((content) =>
      typeof content === "object" &&
      content !== null &&
      "text" in content &&
      typeof content.text === "string"
        ? content.text
        : "",
    )
    .join("");
}

function modeButton(label: string, pressed: boolean) {
  const button = document.createElement("button");
  button.className = "room-document-mermaid__mode";
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-pressed", String(pressed));
  return button;
}

async function renderMermaidPreview(
  host: HTMLDivElement,
  root: Root,
  source: string,
  version: number,
  signal: AbortSignal,
  onReady: () => void,
) {
  try {
    const sanitized = await renderMermaidSvg(source, { signal });
    if (signal.aborted || version !== currentRenderVersion(host)) return;
    root.render(
      createElement(MermaidSvgPreview, {
        key: version,
        svg: sanitized,
        title: "Mermaid diagram preview",
        fitContent: true,
        onLoad: () => {
          if (!signal.aborted && version === currentRenderVersion(host))
            onReady();
        },
      }),
    );
  } catch (error) {
    if (signal.aborted) return;
    if (version !== currentRenderVersion(host)) return;
    const message =
      error instanceof Error
        ? `Mermaid syntax error: ${error.message}`
        : "Mermaid syntax error.";
    root.render(
      createElement(
        "p",
        { className: "room-document-mermaid__error" },
        message,
      ),
    );
    onReady();
  }
}

function currentRenderVersion(host: HTMLElement) {
  return Number(host.dataset.renderVersion ?? "0");
}
