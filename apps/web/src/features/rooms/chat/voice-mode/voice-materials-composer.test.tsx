import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageComposer, type MessageComposition } from "../message-composer";
import {
  VoiceMaterialsProvider,
  useOptionalVoiceMaterials,
} from "./voice-materials-context";
import type { VoiceModeControls } from "./voice-mode-controls";
import type { VoiceModeRoomBinding } from "./voice-mode-session";
import type { ReactNode } from "react";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import { readRoomComposerDraft } from "../../room-drafts";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

// The composer binds its turn callbacks to the app-level session; capture
// that binding to drive Voice Mode presentation and turns directly.
const voice = vi.hoisted(() => {
  const state = {
    binding: undefined as undefined | VoiceModeRoomBinding,
    props: undefined as undefined | Parameters<typeof VoiceModeControls>[0],
  };
  const api = {
    bind: (_roomId: string, binding: VoiceModeRoomBinding) => {
      state.binding = binding;
      return () => {
        if (state.binding === binding) state.binding = undefined;
      };
    },
    session: undefined,
  };
  return Object.assign(state, { api });
});
vi.mock("./voice-mode-session", () => ({
  VoiceModeSessionProvider: ({ children }: { children: ReactNode }) => children,
  useOptionalVoiceModeSession: () => voice.api,
}));
vi.mock("./voice-mode-controls", () => ({
  VoiceModeControls: (props: Parameters<typeof VoiceModeControls>[0]) => {
    voice.props = props;
    return (
      <button
        onClick={() =>
          voice.binding!.onChange({
            entered: true,
            text: "",
            sourceId: "source-1",
          })
        }
      >
        Start Voice Mode
      </button>
    );
  },
}));

const scope = {
  accountId: "voice-material-account",
  tenantId: "tenant-1",
  roomId: "room-1",
};
const selection = {
  documentId: "document-plan",
  title: "Project plan",
  quote: "Only implement the reviewed scope.",
};
function PickMaterial() {
  const materials = useOptionalVoiceMaterials();
  return (
    <button onClick={() => materials?.addSelection(selection)}>
      Select document paragraph
    </button>
  );
}
function mount(props: Partial<Parameters<typeof MessageComposer>[0]> = {}) {
  const onSend = vi.fn<(value: MessageComposition) => Promise<void>>(
    async () => undefined,
  );
  const resolveDocumentLink = vi.fn(async () => ({
    documentId: selection.documentId,
    name: selection.title,
    tenantId: scope.tenantId,
    updatedAt: "",
  }));
  const view = render(
    <VoiceMaterialsProvider scope={scope} enabled>
      <PickMaterial />
      <MessageComposer
        voiceModeTarget={{ roomId: scope.roomId, tenantId: scope.tenantId }}
        onSend={onSend}
        resolveDocumentLink={resolveDocumentLink}
        {...props}
      />
    </VoiceMaterialsProvider>,
  );
  return { ...view, onSend, resolveDocumentLink };
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  voice.props = undefined;
});

describe("voice material composer", () => {
  it.each([
    [false, false, "Send message"],
    [true, false, "Start Voice Mode"],
    [false, true, "Start Voice Mode"],
  ])(
    "on an empty draft shows the right corner by the voice policy (dictation %s, live %s)",
    async (dictation, live, shown) => {
      const runtime = createTestTeamHubRuntime();
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/voice-media-policy",
        () => ({ voice_media_supported: dictation, live_supported: live }),
      );
      const view = render(
        <TeamHubRuntimeProvider runtime={runtime}>
          <MessageComposer
            voiceModeTarget={{ roomId: scope.roomId, tenantId: scope.tenantId }}
            onSend={vi.fn()}
          />
        </TeamHubRuntimeProvider>,
      );
      expect(await screen.findByRole("button", { name: shown })).toBeVisible();
      const other =
        shown === "Send message" ? "Start Voice Mode" : "Send message";
      expect(screen.queryByRole("button", { name: other })).toBeNull();
      view.unmount();
    },
  );

  it("shows selected material, authorizes it, and freezes it even if removed before delivery/retry", async () => {
    const f = mount();
    fireEvent.click(screen.getByText("Select document paragraph"));
    expect(screen.getByLabelText("Selected voice materials")).toHaveTextContent(
      selection.quote,
    );
    fireEvent.click(await screen.findByText("Start Voice Mode"));
    let dispatch!: () => Promise<void>;
    act(() => {
      dispatch = voice.binding!.prepareSend("Break this into steps", "turn-1");
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove selection from Project plan",
      }),
    );
    await act(async () => dispatch());
    expect(f.resolveDocumentLink).toHaveBeenCalledWith({
      documentId: selection.documentId,
      tenantId: scope.tenantId,
      bindToRoom: true,
    });
    const first = f.onSend.mock.calls[0]![0];
    expect(first).toMatchObject({
      body: expect.stringContaining(selection.quote),
      documentReferences: [
        { documentId: selection.documentId, token: "@Project_plan" },
      ],
      messageIdempotencyKey: "voice-mode:turn-1",
    });
    await act(async () => dispatch());
    expect(f.onSend.mock.calls[1]![0]).toEqual(first);
    expect(readRoomComposerDraft(scope).voiceMaterials ?? []).toEqual([]);
  });

  it("sends selected material with one voice message only, then clears it", async () => {
    const f = mount();
    fireEvent.click(screen.getByText("Select document paragraph"));
    fireEvent.click(await screen.findByText("Start Voice Mode"));
    let first!: () => Promise<void>;
    let second!: () => Promise<void>;
    act(() => {
      first = voice.binding!.prepareSend("Explain this", "turn-1");
      second = voice.binding!.prepareSend("And then?", "turn-2");
    });
    await act(async () => first());
    await act(async () => second());
    expect(f.onSend.mock.calls[0]![0].body).toBe(
      `Reference material from @Project_plan:\n> ${selection.quote}\n\nExplain this`,
    );
    expect(f.onSend.mock.calls[1]![0].body).toBe("And then?");
    expect(screen.queryByLabelText("Selected voice materials")).toBeNull();
  });

  it("keeps the spoken draft out of the composer while Voice Mode is active", async () => {
    const onDraftStateChange = vi.fn();
    const f = mount({ onDraftStateChange });
    fireEvent.click(await screen.findByText("Start Voice Mode"));
    act(() =>
      voice.binding!.onChange({
        entered: true,
        text: "Explain this",
        sourceId: "source-1",
      }),
    );

    expect(screen.getByLabelText("Message Room")).toHaveValue("");
    expect(onDraftStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: "Explain this" }),
    );
    await act(async () =>
      voice.binding!.prepareSend("Explain this", "turn-visible-once")(),
    );
    expect(f.onSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Explain this" }),
    );
  });

  it("fails closed if material authorization fails, retaining the excerpt and spoken draft", async () => {
    const f = mount({
      resolveDocumentLink: async () => {
        throw new Error("Document access denied");
      },
    });
    fireEvent.click(screen.getByText("Select document paragraph"));
    fireEvent.click(await screen.findByText("Start Voice Mode"));
    act(() =>
      voice.binding!.onChange({
        entered: true,
        text: "Explain this",
        sourceId: "source-1",
      }),
    );
    await expect(
      voice.binding!.prepareSend("Explain this", "turn-2")(),
    ).rejects.toThrow("access denied");
    expect(f.onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message Room")).toHaveValue("");
    expect(screen.getByLabelText("Selected voice materials")).toHaveTextContent(
      selection.quote,
    );
  });

  it("offers only Send once the draft addresses someone", async () => {
    const codex = {
      display_name: "Codex",
      id: "actor-codex",
      kind: "agent" as const,
      tenant_id: scope.tenantId,
    };
    // Render the Document-reference draft first: it resolves the lazy Voice Mode
    // chunk, so a later absence is the rule at work rather than a pending import.
    const documentDraft = mount({
      initialValue: "@Project_plan",
      initialDocumentReferences: [
        { documentId: selection.documentId, token: "@Project_plan" },
      ],
      documentOptions: [
        {
          documentId: selection.documentId,
          name: selection.title,
          updatedAt: "",
        },
      ],
    });
    expect(await screen.findByText("Start Voice Mode")).toBeVisible();
    documentDraft.unmount();

    mount({
      initialValue: "@Codex",
      initialMentions: [codex],
      mentionOptions: [codex],
    });

    expect(
      await screen.findByRole("button", { name: "Send message" }),
    ).toBeVisible();
    expect(screen.queryByText("Start Voice Mode")).toBeNull();
  });

  it("allows a structured document prefix without overwriting it with ASR", async () => {
    const f = mount({
      initialValue: "@Project_plan",
      initialDocumentReferences: [
        { documentId: selection.documentId, token: "@Project_plan" },
      ],
      documentOptions: [
        {
          documentId: selection.documentId,
          name: selection.title,
          updatedAt: "",
        },
      ],
    });
    expect(await screen.findByText("Start Voice Mode")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeVisible();
    fireEvent.click(screen.getByText("Start Voice Mode"));
    act(() =>
      voice.binding!.onChange({
        entered: true,
        text: "Summarize this",
        sourceId: "source-1",
      }),
    );
    expect(screen.getByLabelText("Message Room")).toHaveValue("@Project_plan");
    await act(async () =>
      voice.binding!.prepareSend("Summarize this", "turn-3")(),
    );
    expect(f.onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "@Project_plan\nSummarize this",
        documentReferences: [
          { documentId: selection.documentId, token: "@Project_plan" },
        ],
      }),
    );
  });

  it("keeps a selected message available for Voice Mode and captures explicit context IDs", async () => {
    const message = {
      id: "message-source",
      raw_message: "Original decision",
      author: {
        id: "actor-1",
        display_name: "Teammate",
        kind: "human",
        tenant_id: scope.tenantId,
      },
    } as TeamHubMessage;
    const f = mount({ selectedContextMessages: [message] });
    fireEvent.click(await screen.findByText("Start Voice Mode"));
    await act(async () =>
      voice.binding!.prepareSend("Review that decision", "turn-4")(),
    );
    expect(f.onSend).toHaveBeenCalledWith(
      expect.objectContaining({ contextMessages: [message] }),
    );
  });

  it("keeps references when exiting to edit and then using ordinary Send", async () => {
    const f = mount();
    fireEvent.click(screen.getByText("Select document paragraph"));
    fireEvent.click(await screen.findByText("Start Voice Mode"));
    act(() =>
      voice.binding!.onChange({
        entered: false,
        text: "Corrected request",
        sourceId: "source-1",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(f.onSend).toHaveBeenCalled());
    expect(f.onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(selection.quote),
      }),
    );
    expect(f.resolveDocumentLink).toHaveBeenCalled();
  });

  it("does not expose or attach the main Room selections to a Thread composer", async () => {
    const f = mount({ voiceModeTarget: undefined });
    fireEvent.click(screen.getByText("Select document paragraph"));
    expect(
      screen.queryByLabelText("Selected voice materials"),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message Room"), {
      target: { value: "Thread reply" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(f.onSend).toHaveBeenCalledWith({
      body: "Thread reply",
      files: [],
      mentions: [],
    });
    expect(f.resolveDocumentLink).not.toHaveBeenCalled();
  });
});
