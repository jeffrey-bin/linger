import "@blocknote/mantine/style.css";
/* oxlint-disable react-doctor/no-giant-component -- The editor coordinates BlockNote, comments, mentions, and collaboration lifecycle; splitting it is outside this permission MR. */
import "./room-document-blocknote.css";
import "@/components/knowledge-document.css";

import { CommentsExtension } from "@blocknote/core/comments";
import { BlockNoteView } from "@blocknote/mantine";
import {
  FilePanel,
  FilePanelController,
  SuggestionMenuController,
  type FilePanelProps,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
} from "@blocknote/react";
import { useQuery } from "@tanstack/react-query";
import { TextSelection } from "@tiptap/pm/state";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MutableRefObject,
} from "react";
import { useNavigate } from "react-router";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { collectTeamHubCursorPages } from "@/features/teamhub/teamhub-cursor-pages";
import { roomMembersQueryOptions } from "../room-queries";
import {
  documentDetailPath,
  parseInternalRoomDocumentLink,
} from "../files/document-detail-routes";

import type { RoomDocumentCollaborationSession } from "./room-document-collaboration";
import {
  createRoomDocumentAssetUrlResolver,
  uploadRoomDocumentAsset,
} from "./room-document-assets";
import {
  roomDocumentCommentSchema,
  type RoomDocumentEditor,
} from "./room-document-comment-schema";
import {
  bindRoomDocumentImagePreviewStore,
  createRoomDocumentImagePreviewStore,
  createRoomDocumentOptimisticUpload,
  insertRoomDocumentOptimisticImages,
} from "./room-document-image-preview";
import { insertRoomDocumentClipboardLink } from "./room-document-clipboard-link";
import {
  pasteRoomDocumentMarkdown,
  pasteRoomDocumentRichHtml,
  pasteRoomDocumentSourceCode,
} from "./room-document-markdown-paste";
import {
  DocumentMentionMessageComposer,
  RoomDocumentCommentComposer,
} from "./room-document-comment-composer";
import { roomDocumentBlocksAreEmpty } from "./room-document-blocks";
import {
  RoomDocumentCommentsController,
  RoomDocumentCommentsOpenProvider,
} from "./room-document-comments-sidebar";
import {
  createTeamHubDocumentThreadStore,
  type RoomDocumentCommentAnchor,
  roomDocumentCommentThreadsQueryOptions,
} from "./room-document-comments";
import { commentBodyFromComposition } from "./room-document-comment-body";
import { ReadOnlySelectionCommentControl } from "./room-document-readonly-comment-control";
import { continueTableCellList } from "./room-document-table-list";
import { filterRoomDocumentSlashMenuItems } from "./room-document-slash-menu";
import { createRoomDocumentCursorRenderer } from "./room-document-presence-model";
import { restoreRoomDocumentCollaborationUndo } from "./room-document-undo";
import {
  knowledgeHiddenBlockIds,
  useKnowledgePresentation,
} from "./room-document-knowledge-presentation";
import {
  CanvasHeader,
  canvasHiddenBlockRule,
  useCanvas,
} from "./canvas/canvas-header";

const ignoreCommentsOpenChange = () => undefined;

export interface RoomDocumentBlockNoteEditorProps {
  client: TeamHubClient;
  commentsOpen?: boolean;
  commentsPortalTarget?: HTMLElement | null;
  canComment: boolean;
  currentActorId: string;
  documentId: string;
  editable: boolean;
  knowledgeDocumentTitle?: string;
  surfaceEditorRef?: MutableRefObject<RoomDocumentEditor | null>;
  /** Reports whether the Document is a canvas that has already been sent. */
  onCanvasSentChange?: (sent: boolean) => void;
  onHeadingsChange?: (headings: RoomDocumentHeading[]) => void;
  onCommentsOpenChange?: (open: boolean) => void;
  onReadOnlySessionResync?: () => void;
  roomId?: string;
  session: RoomDocumentCollaborationSession;
  tenantId: string;
}

export interface RoomDocumentHeading {
  id: string;
  level: number;
  text: string;
}

export type { RoomDocumentEditor } from "./room-document-comment-schema";

export function RoomDocumentBlockNoteEditor({
  client,
  canComment,
  commentsOpen,
  commentsPortalTarget,
  currentActorId,
  documentId,
  editable,
  knowledgeDocumentTitle,
  surfaceEditorRef,
  onCanvasSentChange,
  onHeadingsChange,
  onCommentsOpenChange,
  onReadOnlySessionResync,
  roomId,
  session,
  tenantId,
}: RoomDocumentBlockNoteEditorProps) {
  const navigate = useNavigate();
  const openDocument = (path: string) => {
    void navigate(path);
  };
  const editorRef = useRef<RoomDocumentEditor | null>(null);
  const editorRootRef = useRef<HTMLElement | null>(null);
  const readOnlyAnchorRef = useRef<RoomDocumentCommentAnchor | null>(null);
  const [readOnlyCommentPending, setReadOnlyCommentPending] = useState(false);
  const cancelReadOnlyComment = () => {
    readOnlyAnchorRef.current = null;
    setReadOnlyCommentPending(false);
  };
  const assetUrlResolver = useMemo(
    () => createRoomDocumentAssetUrlResolver(client),
    [client],
  );
  useEffect(() => assetUrlResolver.retain(), [assetUrlResolver]);
  const imagePreviewStore = useMemo(
    () => createRoomDocumentImagePreviewStore(),
    [],
  );
  const threadStore = useMemo(
    () =>
      createTeamHubDocumentThreadStore({
        attachSelectionAnchors: session.readOnly === true,
        client,
        currentContext:
          roomId === undefined
            ? undefined
            : { binding_kind: "room", context_id: roomId },
        currentActorId,
        documentId,
        getCurrentAnchor: () =>
          readOnlyAnchorRef.current ?? currentCommentAnchor(editorRef.current),
        getDurableHead: () => {
          const snapshot = session.getSaveSnapshot();
          const head = snapshot.durableHead;
          return snapshot.status === "Saved" &&
            head !== undefined &&
            head.state_hash_version === 1
            ? {
                persisted_seq: head.persisted_seq,
                state_hash: head.state_hash,
                state_hash_version: 1,
              }
            : undefined;
        },
        // Only a read-only session needs a resync; an editable session already
        // holds the Comment mark in its own Yjs document.
        onSelectionAnchorAttached:
          session.readOnly === true ? onReadOnlySessionResync : undefined,
      }),
    [
      client,
      currentActorId,
      documentId,
      onReadOnlySessionResync,
      roomId,
      session,
    ],
  );
  const comments = useMemo(
    () =>
      CommentsExtension({
        resolveUsers: async (userIds) =>
          Promise.all(
            userIds.map(async (userId) => {
              const actor = await teamHubData(
                client.api.GET("/v0/tenants/{tenantId}/actors/{actorId}", {
                  params: { path: { tenantId, actorId: userId } },
                }),
              );
              return {
                avatarUrl: "",
                id: actor.id,
                username: actor.display_name,
              };
            }),
          ),
        schema: roomDocumentCommentSchema,
        threadStore,
      }),
    [client, tenantId, threadStore],
  );
  const commentScopeId = roomId ?? documentId;
  const threads = useQuery(
    roomDocumentCommentThreadsQueryOptions(
      client,
      tenantId,
      commentScopeId,
      documentId,
    ),
  );
  const members = useQuery({
    ...roomMembersQueryOptions(client, tenantId, roomId ?? ""),
    enabled: roomId !== undefined,
  });
  const agentMentionCandidates = useQuery({
    queryFn: () =>
      collectTeamHubCursorPages(
        (page) =>
          teamHubData(
            client.api.GET(
              "/v0/documents/{documentId}/agent-mention-candidates",
              { params: { path: { documentId }, query: page } },
            ),
          ),
        { pageSize: 100 },
      ),
    queryKey: [
      "document-agent-mention-candidates",
      tenantId,
      documentId,
    ] as const,
    staleTime: 10_000,
  });
  // A comment mentions only Agents. A Room Agent is usually also a Document
  // candidate; offer each Agent once.
  const mentionOptions = useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...(agentMentionCandidates.data?.items.map(
              (candidate) => candidate.actor,
            ) ?? []),
            ...(members.data?.items.flatMap((member) =>
              member.actor.kind === "agent" ? [member.actor] : [],
            ) ?? []),
          ].map((actor) => [actor.id, actor]),
        ).values(),
      ),
    [agentMentionCandidates.data, members.data],
  );
  const commentActors = useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...(members.data?.items.map((member) => member.actor) ?? []),
            ...mentionOptions,
          ].map((actor) => [actor.id, actor]),
        ).values(),
      ),
    [members.data, mentionOptions],
  );
  const cursorRenderer = useMemo(
    () => createRoomDocumentCursorRenderer(),
    // A new Document session needs a fresh renderer for its awareness states.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session is an intentional reset key
    [session],
  );
  useLayoutEffect(() => {
    cursorRenderer.setNames(
      new Map(
        (members.data?.items ?? []).map((member) => [
          member.actor.id,
          member.actor.display_name,
        ]),
      ),
    );
  }, [cursorRenderer, members.data]);
  useEffect(() => () => cursorRenderer.destroy(), [cursorRenderer]);
  useEffect(() => {
    if (threads.data !== undefined) {
      threadStore.replaceThreads(threads.data);
    }
  }, [threadStore, threads.data]);
  const editor = useCreateBlockNote(
    {
      collaboration: {
        fragment: session.document.getXmlFragment("prosemirror"),
        ...(session.awareness
          ? { provider: { awareness: session.awareness } }
          : {}),
        renderCursor: cursorRenderer.renderCursor,
        showCursorLabels: "always",
        user: session.user,
      },
      extensions: [comments],
      pasteHandler: ({ defaultPasteHandler, editor: target, event }) =>
        pasteRoomDocumentRichHtml(target, event.clipboardData) ||
        pasteRoomDocumentMarkdown(target, event.clipboardData) ||
        pasteRoomDocumentSourceCode(target, event.clipboardData) ||
        defaultPasteHandler(),
      resolveFileUrl: (reference) => assetUrlResolver.resolve(reference),
      schema: roomDocumentCommentSchema,
      ...(editable
        ? {
            uploadFile: createRoomDocumentOptimisticUpload({
              getEditor: () => editorRef.current!,
              previewStore: imagePreviewStore,
              prime: (reference, file) =>
                assetUrlResolver.prime(reference, file),
              upload: (file, blockId) =>
                uploadRoomDocumentAsset(client, documentId, file, blockId),
            }),
          }
        : {}),
    },
    [
      assetUrlResolver,
      client,
      comments,
      cursorRenderer,
      documentId,
      imagePreviewStore,
      editable,
      session,
    ],
  );
  useEffect(() => {
    const release = imagePreviewStore.retain();
    const unbind = bindRoomDocumentImagePreviewStore(editor, imagePreviewStore);
    return () => {
      unbind();
      release();
    };
  }, [editor, imagePreviewStore]);
  useEffect(() => {
    if (editable) {
      restoreRoomDocumentCollaborationUndo(editor);
    }
  }, [editable, editor]);
  const [isEmptyDocument, setIsEmptyDocument] = useState(() =>
    roomDocumentBlocksAreEmpty(editor.document),
  );
  const knowledgeTitle = editable ? undefined : knowledgeDocumentTitle;
  const knowledge = useKnowledgePresentation(editor, knowledgeTitle);
  const { agentEditing, canvas } = useCanvas(editor, session.awareness);
  const canvasRule = canvasHiddenBlockRule(knowledge.scope, canvas);
  const canvasSent = canvas?.status === "sent";
  useEffect(() => {
    onCanvasSentChange?.(canvasSent);
  }, [canvasSent, onCanvasSentChange]);
  useLayoutEffect(() => {
    editorRef.current = editor;
    if (surfaceEditorRef) surfaceEditorRef.current = editor;
    setIsEmptyDocument(roomDocumentBlocksAreEmpty(editor.document));
    return () => {
      editorRef.current = null;
      if (surfaceEditorRef) surfaceEditorRef.current = null;
    };
  }, [editor, surfaceEditorRef]);

  return (
    <section
      ref={editorRootRef}
      aria-label="Room Document editor"
      className="room-document-blocknote relative min-h-[420px]"
      data-editable={String(editable)}
      data-empty={String(isEmptyDocument)}
      data-knowledge-presentation={
        knowledgeTitle !== undefined ? "true" : undefined
      }
      data-knowledge-scope={knowledge.scope}
      onClickCapture={(event) => {
        if (openInternalDocumentLink(event.target, tenantId, openDocument))
          event.preventDefault();
      }}
      onKeyDownCapture={(event) => {
        if (
          event.key.toLowerCase() === "a" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          event.target instanceof Element &&
          editor.domElement?.contains(event.target) &&
          !event.target.closest("button, input, textarea, select")
        ) {
          event.preventDefault();
          event.stopPropagation();
          // Resolve text endpoints across all blocks, including code, before
          // focusing the editor so DOM and editor selections stay in sync.
          editor.transact((tr) =>
            tr.setSelection(
              TextSelection.between(
                tr.doc.resolve(0),
                tr.doc.resolve(tr.doc.content.size),
              ),
            ),
          );
          editor.focus();
          return;
        }
        if (event.key !== "Enter") return;
        if (
          editable &&
          !event.defaultPrevented &&
          event.target instanceof Node &&
          editor.domElement?.contains(event.target) &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.nativeEvent.isComposing &&
          editor.domElement?.getAttribute("aria-expanded") !== "true" &&
          continueTableCellList(editor)
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (openInternalDocumentLink(event.target, tenantId, openDocument))
          event.preventDefault();
      }}
      onPasteCapture={(event) =>
        handleDocumentPaste(event, {
          editable,
          editor,
          imagePreviewStore,
          tenantId,
        })
      }
    >
      {knowledge.rules ? <style>{knowledge.rules}</style> : null}
      {canvasRule ? <style>{canvasRule}</style> : null}
      {canvas ? (
        <CanvasHeader
          agentEditing={agentEditing}
          canvas={canvas}
          editable={editable}
          editor={editor}
        />
      ) : null}
      <BlockNoteView
        className={
          editable
            ? "room-document-blocknote__view"
            : "room-document-blocknote__view room-document-blocknote__view--read-only"
        }
        comments={false}
        editable={editable}
        editor={editor}
        filePanel={false}
        onChange={(changedEditor) => {
          imagePreviewStore.reconcile(changedEditor);
          setIsEmptyDocument(
            roomDocumentBlocksAreEmpty(changedEditor.document),
          );
          onHeadingsChange?.(
            extractDocumentHeadings(
              changedEditor.document,
              knowledgeTitle === undefined
                ? undefined
                : knowledgeHiddenBlockIds(
                    changedEditor.document,
                    knowledgeTitle,
                  ),
            ),
          );
        }}
        slashMenu={false}
        theme="light"
      >
        <SuggestionMenuController
          floatingUIOptions={{
            elementProps: { className: "room-document-slash-popover" },
          }}
          getItems={(query) =>
            Promise.resolve(filterRoomDocumentSlashMenuItems(editor, query))
          }
          triggerCharacter="/"
        />
        <FilePanelController filePanel={RoomDocumentFilePanel} />
        <DocumentCommentsControl
          pendingSelection={readOnlyCommentPending}
          pendingAnchor={
            readOnlyCommentPending ? readOnlyAnchorRef.current : null
          }
          onCancelSelection={cancelReadOnlyComment}
          composer={
            readOnlyCommentPending ? (
              <DocumentMentionMessageComposer
                ariaLabel="New selection comment"
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor
                autoFocus
                mentionOptions={mentionOptions}
                onSubmit={async (composition) => {
                  await threadStore.createThread({
                    initialComment: {
                      body: commentBodyFromComposition(composition),
                    },
                  });
                }}
                onSubmitted={cancelReadOnlyComment}
              />
            ) : (
              <RoomDocumentCommentComposer
                mentionDirectoryError={agentMentionCandidates.isError}
                mentionDirectoryLoading={agentMentionCandidates.isPending}
                mentionOptions={mentionOptions}
              />
            )
          }
          actorDirectory={commentActors}
          commentsOpen={commentsOpen}
          error={threads.isError}
          mentionOptions={mentionOptions}
          onCommentsOpenChange={onCommentsOpenChange}
          portalTarget={commentsPortalTarget}
          retry={() => void threads.refetch()}
          threadStore={threadStore}
        />
      </BlockNoteView>
      {!readOnlyCommentPending && (
        <ReadOnlySelectionCommentControl
          anchorRef={readOnlyAnchorRef}
          canComment={canComment}
          editable={editable}
          editorRootRef={editorRootRef}
          onStartComment={() => setReadOnlyCommentPending(true)}
        />
      )}
    </section>
  );
}

function handleDocumentPaste(
  event: ReactClipboardEvent<HTMLElement>,
  input: {
    editable: boolean;
    editor: RoomDocumentEditor;
    imagePreviewStore: ReturnType<typeof createRoomDocumentImagePreviewStore>;
    tenantId: string;
  },
): void {
  if (!input.editable) return;
  const hasHtmlTable = /<table[\s>]/i.test(
    event.clipboardData.getData("text/html"),
  );
  if (
    !hasHtmlTable &&
    insertRoomDocumentOptimisticImages(
      input.editor,
      Array.from(event.clipboardData.files),
      input.imagePreviewStore,
    )
  ) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (
    insertRoomDocumentClipboardLink(
      input.editor,
      event.clipboardData,
      window.location.origin,
      input.tenantId,
    )
  ) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function openInternalDocumentLink(
  target: EventTarget | null,
  tenantId: string,
  openDocument: (path: string) => void,
): boolean {
  const anchor = (target as Element | null)?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  const link = parseInternalRoomDocumentLink(
    anchor.href,
    window.location.origin,
  );
  if (!link || link.tenantId !== tenantId) return false;
  openDocument(documentDetailPath(link));
  return true;
}

type DocumentCommentsControlProps = Pick<
  Parameters<typeof RoomDocumentCommentsController>[0],
  | "actorDirectory"
  | "mentionOptions"
  | "portalTarget"
  | "threadStore"
  | "composer"
  | "pendingSelection"
  | "pendingAnchor"
  | "onCancelSelection"
> & {
  commentsOpen?: boolean;
  error: boolean;
  onCommentsOpenChange?: (open: boolean) => void;
  retry: () => void;
};

function DocumentCommentsControl({
  composer,
  pendingSelection,
  pendingAnchor,
  onCancelSelection,
  actorDirectory,
  commentsOpen,
  error,
  mentionOptions,
  onCommentsOpenChange,
  portalTarget,
  retry,
  threadStore,
}: DocumentCommentsControlProps) {
  const controller = (
    <RoomDocumentCommentsController
      composer={composer}
      pendingSelection={pendingSelection}
      pendingAnchor={pendingAnchor}
      onCancelSelection={onCancelSelection}
      actorDirectory={actorDirectory}
      error={error}
      mentionOptions={mentionOptions}
      onRetry={retry}
      portalTarget={portalTarget}
      showTrigger={commentsOpen === undefined}
      threadStore={threadStore}
    />
  );
  return commentsOpen === undefined ? (
    controller
  ) : (
    <RoomDocumentCommentsOpenProvider
      onOpenChange={onCommentsOpenChange ?? ignoreCommentsOpenChange}
      open={commentsOpen}
    >
      {controller}
    </RoomDocumentCommentsOpenProvider>
  );
}

function extractDocumentHeadings(
  blocks: RoomDocumentEditor["document"],
  hidden?: Set<string>,
): RoomDocumentHeading[] {
  const headings: RoomDocumentHeading[] = [];
  const visit = (items: RoomDocumentEditor["document"]) => {
    for (const block of items) {
      if (hidden?.has(block.id)) continue;
      if (block.type === "heading") {
        const text = Array.isArray(block.content)
          ? block.content
              .flatMap((item) => ("text" in item ? [item.text] : []))
              .join("")
              .trim()
          : "";
        if (text) {
          headings.push({
            id: block.id,
            level: Number(block.props.level),
            text,
          });
        }
      }
      if (block.children.length > 0) visit(block.children);
    }
  };
  visit(blocks);
  return headings;
}

function currentCommentAnchor(editor: RoomDocumentEditor | null): {
  block_id: string;
  context_after: string;
  context_before: string;
  quoted_text: string;
} {
  if (editor === null) {
    throw new Error("Document editor is unavailable");
  }
  const quotedText = editor.getSelectedText();
  if (quotedText.trim() === "") {
    throw new Error("Select Document text before creating a Comment");
  }
  const selectedBlock = editor.getSelection()?.blocks[0];
  const blockId = selectedBlock?.id ?? editor.getTextCursorPosition().block.id;
  const { doc, selection } = editor.prosemirrorState;
  return {
    block_id: blockId,
    context_after: firstCodePoints(
      doc.textBetween(selection.to, doc.content.size, "\n", "\n"),
      2000,
    ),
    context_before: lastCodePoints(
      doc.textBetween(0, selection.from, "\n", "\n"),
      2000,
    ),
    quoted_text: quotedText,
  };
}

function firstCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function lastCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(-limit).join("");
}

function RoomDocumentFilePanel({ blockId }: FilePanelProps) {
  const editor = useBlockNoteEditor();
  const components = useComponentsContext();
  const uploading = useRef(false);
  const [uploadFailure, setUploadFailure] = useState<string>();
  if (components === undefined) {
    return null;
  }
  const block = editor.getBlock(blockId);
  if (block === undefined) {
    return null;
  }
  const acceptedTypes =
    editor.schema.blockSpecs[
      block.type
    ].implementation.meta?.fileBlockAccept?.join(",");
  const upload = async (file: File | null) => {
    if (file === null || editor.uploadFile === undefined || uploading.current) {
      return;
    }
    uploading.current = true;
    setUploadFailure(undefined);
    try {
      const result = await editor.uploadFile(file, blockId);
      try {
        editor.updateBlock(
          blockId,
          typeof result === "string"
            ? { props: { name: file.name, url: result } }
            : result,
        );
      } catch {
        setUploadFailure(
          "The file was uploaded, but the Document block could not be updated. Try inserting it again.",
        );
      }
    } catch (error) {
      setUploadFailure(
        error instanceof Error
          ? error.message
          : "Document Asset upload failed.",
      );
    } finally {
      uploading.current = false;
    }
  };
  return (
    <FilePanel
      blockId={blockId}
      tabs={[
        {
          name: "Upload",
          tabPanel: (
            <components.FilePanel.TabPanel className="bn-tab-panel">
              <components.FilePanel.FileInput
                accept={acceptedTypes || "*/*"}
                className="bn-file-input"
                data-test="upload-input"
                onChange={(file) => void upload(file)}
                placeholder="Choose a file"
                value={null}
              />
              {uploadFailure ? (
                <div className="bn-error-text" role="alert">
                  {uploadFailure}
                </div>
              ) : null}
            </components.FilePanel.TabPanel>
          ),
        },
      ]}
    />
  );
}
