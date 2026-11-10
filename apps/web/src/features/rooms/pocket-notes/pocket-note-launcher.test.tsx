import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubPocketNote,
  TeamHubPocketNotePage,
} from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import type { VoiceModeEvent } from "../chat/voice-mode/voice-mode-controller";
import { PocketNoteLauncher } from "./pocket-note-launcher";

const voice = vi.hoisted(() => ({
  open: vi.fn(),
  // Draining the last words takes a moment, as it does against a real Runtime.
  close: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 40))),
  receive: undefined as ((event: VoiceModeEvent) => void) | undefined,
}));

vi.mock("../chat/voice-mode/voice-mode-transport", () => ({
  openVoiceMode: voice.open,
}));

beforeEach(() => {
  // JSDOM has no text-range layout; browser coverage exercises caret scrolling.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  voice.receive = undefined;
  voice.close.mockClear();
  voice.open
    .mockReset()
    .mockImplementation(
      async (input: { receive: (event: VoiceModeEvent) => void }) => {
        voice.receive = input.receive;
        return { commit: async () => undefined, close: voice.close };
      },
    );
});

const page: TeamHubPocketNotePage = {
  items: [
    {
      date: "2026-09-30",
      text: "Yesterday's idea",
      updated_at: "2026-09-30T10:00:00Z",
    },
  ],
  page: { has_more: false },
  today: "2026-10-01",
};

/** The TeamHub answers a test depends on, keyed by the call they stand for. */
interface PocketNoteRoutes {
  deletePocketNote?: (tenantId: string, date: string) => unknown;
  getVoiceMediaPolicy?: () => unknown;
  listPocketNotes: (
    tenantId: string,
    cursor: string | undefined,
  ) => Promise<TeamHubPocketNotePage>;
  putTodayPocketNote?: (
    tenantId: string,
    text: string,
  ) => Promise<TeamHubPocketNote> | undefined;
}

function renderLauncher(routes: PocketNoteRoutes, anotherMeRoomId?: string) {
  const runtime = createTestTeamHubRuntime();
  runtime.server.on(
    "GET",
    "/v0/tenants/{tenantId}/me/pocket-notes",
    ({ params, query }) =>
      routes.listPocketNotes(
        params.tenantId!,
        query.get("cursor") ?? undefined,
      ),
  );
  const { deletePocketNote, getVoiceMediaPolicy, putTodayPocketNote } = routes;
  if (putTodayPocketNote)
    runtime.server.on(
      "PUT",
      "/v0/tenants/{tenantId}/me/pocket-notes/today",
      ({ body, params }) =>
        putTodayPocketNote(params.tenantId!, (body as { text: string }).text),
    );
  if (deletePocketNote)
    runtime.server.on(
      "DELETE",
      "/v0/tenants/{tenantId}/me/pocket-notes/{noteDate}",
      ({ params }) => deletePocketNote(params.tenantId!, params.noteDate!),
    );
  if (getVoiceMediaPolicy)
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/voice-media-policy",
      getVoiceMediaPolicy,
    );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <PocketNoteLauncher
          anotherMeRoomId={anotherMeRoomId}
          tenantId="tenant-1"
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

function pasteText(editor: HTMLElement, text: string) {
  fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

describe("PocketNoteLauncher", () => {
  // Keep real lazy-module preparation outside the interaction wait budget.
  beforeAll(async () => {
    await import("./pocket-note-panel");
  }, 30_000);

  it("shows Pocket Notes as an icon button named in its tooltip", () => {
    renderLauncher({ listPocketNotes: vi.fn(async () => page) });
    const button = screen.getByRole("button", { name: "Pocket Notes" });
    expect(button).toHaveTextContent("");
    expect(button).toHaveAttribute("title", "Pocket Notes");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("opens on today's blank page and autosaves what the Human writes", async () => {
    const putTodayPocketNote = vi.fn(
      async (_tenantId: string, text: string) => ({
        date: "2026-10-01",
        text,
        updated_at: "2026-10-01T02:00:00Z",
      }),
    );
    renderLauncher({
      listPocketNotes: vi.fn(async () => page),
      putTodayPocketNote,
    });

    fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
    const editor = await screen.findByRole("textbox", {
      name: "Today’s note",
    });
    expect(editor).toHaveTextContent("");
    expect(screen.getByText("Today · Oct 1")).toBeInTheDocument();

    pasteText(editor, "Buy milk");
    await waitFor(() =>
      expect(putTodayPocketNote).toHaveBeenCalledWith("tenant-1", "Buy milk"),
    );
    expect(putTodayPocketNote).toHaveBeenCalledTimes(1);
  });

  it("lists every page and opens a past day read-only", async () => {
    renderLauncher({
      listPocketNotes: vi.fn(async () => page),
      putTodayPocketNote: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "All notes" }));
    expect(screen.getByRole("button", { name: /Today/ })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /^(?!Delete).*Sep 30/ }),
    );

    expect(screen.getByText("Yesterday's idea")).toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("loads earlier notes by the page cursor", async () => {
    const listPocketNotes = vi.fn(
      async (_tenantId: string, cursor: string | undefined) =>
        cursor
          ? {
              ...page,
              items: [
                {
                  date: "2026-09-01",
                  text: "Older idea",
                  updated_at: "2026-09-01T10:00:00Z",
                },
              ],
            }
          : { ...page, page: { has_more: true, next_cursor: "2026-09-30" } },
    );
    renderLauncher({ listPocketNotes });

    fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "All notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Load earlier notes" }));
    await waitFor(() =>
      expect(listPocketNotes).toHaveBeenLastCalledWith(
        "tenant-1",
        "2026-09-30",
      ),
    );
    expect(
      await screen.findByRole("button", { name: /Sep 1\b/ }),
    ).toBeVisible();
  });

  it("deletes a past day from its All notes card after confirming, but never today", async () => {
    const deletePocketNote = vi.fn(async () => undefined);
    renderLauncher({
      deletePocketNote,
      listPocketNotes: vi.fn(async () => page),
      putTodayPocketNote: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "All notes" }));
    // Today's page stays editable and has nothing to delete.
    expect(
      screen.queryByRole("button", { name: "Delete Today" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete Sep 30/ }));
    expect(deletePocketNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(deletePocketNote).toHaveBeenCalledWith("tenant-1", "2026-09-30"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Yesterday's idea")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Today/ })).toBeInTheDocument();
  });

  it("saves the last words when the notepad closes inside the autosave delay", async () => {
    const putTodayPocketNote = vi.fn(
      async (_tenantId: string, text: string) => ({
        date: "2026-10-01",
        text,
        updated_at: "2026-10-01T02:00:00Z",
      }),
    );
    renderLauncher({
      listPocketNotes: vi.fn(async () => page),
      putTodayPocketNote,
    });

    fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
    pasteText(
      await screen.findByRole("textbox", { name: "Today’s note" }),
      "One line before leaving",
    );
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(putTodayPocketNote).toHaveBeenCalledWith(
        "tenant-1",
        "One line before leaving",
      ),
    );
  });

  describe("dictation", () => {
    const savedNote = () =>
      vi.fn(async (_tenantId: string, text: string) => ({
        date: "2026-10-01",
        text,
        updated_at: "2026-10-01T02:00:00Z",
      }));
    const dictationClient = (
      putTodayPocketNote: ReturnType<typeof savedNote>,
      supported = true,
    ) => ({
      listPocketNotes: vi.fn(async () => ({
        ...page,
        items: [
          {
            date: "2026-10-01",
            text: "First line",
            updated_at: "2026-10-01T01:00:00Z",
          },
          ...page.items,
        ],
      })),
      putTodayPocketNote,
      getVoiceMediaPolicy: vi.fn(async () => ({
        voice_media_supported: supported,
      })),
    });
    const hear = (event: VoiceModeEvent) => act(() => voice.receive?.(event));
    // The microphone control comes back at once on stop; the page turns
    // editable only after the last words drain.
    const editorReturns = async () => {
      await waitFor(() =>
        expect(
          document.querySelector('[contenteditable="true"]'),
        ).not.toBeNull(),
      );
      return screen.getByRole("textbox", { name: "Today’s note" });
    };

    it("shows listening once the microphone is live, before transcription is ready", async () => {
      let ready!: () => void;
      voice.open.mockImplementation(
        async (input: {
          microphone?: (microphone: { setMuted: () => Promise<void> }) => void;
        }) => {
          input.microphone?.({ setMuted: async () => undefined });
          await new Promise<void>((resolve) => {
            ready = resolve;
          });
          return { commit: async () => undefined, close: voice.close };
        },
      );
      renderLauncher(dictationClient(savedNote()), "room-another-me");
      fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));

      // The Runtime buffers this audio until its ASR stream opens.
      expect(await screen.findByText("Listening…")).toBeInTheDocument();
      expect(screen.queryByText("Connecting…")).toBeNull();
      ready();
    });

    it("starts one paragraph per dictation and shows the words in progress in gray", async () => {
      const putTodayPocketNote = savedNote();
      renderLauncher(dictationClient(putTodayPocketNote), "room-another-me");
      fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));

      await waitFor(() => expect(voice.receive).toBeDefined());
      expect(voice.open).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: "room-another-me" }),
      );
      expect(await screen.findByText("Listening…")).toBeInTheDocument();
      hear({ kind: "partial", text: "Tomorrow buy", endOffsetMs: 400 });
      const page = screen.getByRole("textbox", { name: "Today’s note" });
      expect(page).toHaveTextContent("First line Tomorrow buy");
      expect(screen.getByText("Tomorrow buy")).toHaveClass("text-app-ink/40");

      hear({
        kind: "turn",
        id: "t1",
        text: "Tomorrow buy milk",
        endOffsetMs: 900,
      });
      // The first turn of a dictation starts its own line.
      await waitFor(() =>
        expect(putTodayPocketNote).toHaveBeenCalledWith(
          "tenant-1",
          "First line\nTomorrow buy milk",
        ),
      );

      // Stopping keeps the unfinished sentence, continuing the same paragraph.
      hear({
        kind: "speech",
        id: "s2",
        text: "and eggs",
        endOffsetMs: 1400,
      });
      fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
      const editor = await editorReturns();
      expect(Array.from(editor.children, (node) => node.textContent)).toEqual([
        "First line",
        "Tomorrow buy milk and eggs",
      ]);
      // The caret comes back right after the dictated words.
      expect(editor).toHaveFocus();
      expect(window.getSelection()?.focusOffset).toBe(
        "Tomorrow buy milk and eggs".length,
      );
      expect(voice.close).toHaveBeenCalled();
    });

    it("stops dictation on the first Escape and closes on the second", async () => {
      const putTodayPocketNote = savedNote();
      renderLauncher(dictationClient(putTodayPocketNote), "room-another-me");
      fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
      await waitFor(() => expect(voice.receive).toBeDefined());
      hear({
        kind: "speech",
        id: "s1",
        text: "Said before leaving",
        endOffsetMs: 500,
      });

      fireEvent.keyDown(document, { key: "Escape" });
      await editorReturns();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(putTodayPocketNote).toHaveBeenCalledWith(
          "tenant-1",
          "First line\nSaid before leaving",
        ),
      );
    });

    it("settles the last words before an outside click closes the notepad", async () => {
      const putTodayPocketNote = savedNote();
      renderLauncher(dictationClient(putTodayPocketNote), "room-another-me");
      fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
      await waitFor(() => expect(voice.receive).toBeDefined());
      hear({ kind: "partial", text: "Last sentence", endOffsetMs: 300 });

      fireEvent.pointerDown(document.body);
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(putTodayPocketNote).toHaveBeenCalledWith(
          "tenant-1",
          "First line\nLast sentence",
        ),
      );
    });

    it("settles the last words when the notepad trigger closes it", async () => {
      const putTodayPocketNote = savedNote();
      renderLauncher(dictationClient(putTodayPocketNote), "room-another-me");
      const trigger = screen.getByRole("button", { name: "Pocket Notes" });
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
      await waitFor(() => expect(voice.receive).toBeDefined());
      hear({ kind: "partial", text: "Quick aside", endOffsetMs: 300 });

      fireEvent.click(trigger);
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(putTodayPocketNote).toHaveBeenCalledWith(
          "tenant-1",
          "First line\nQuick aside",
        ),
      );
    });

    it("keeps the dictated words as said once dictation stops", async () => {
      const putTodayPocketNote = savedNote();
      renderLauncher(dictationClient(putTodayPocketNote), "room-another-me");
      fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
      await waitFor(() => expect(voice.receive).toBeDefined());
      hear({
        kind: "turn",
        id: "t1",
        text: "um so tomorrow send the quote",
        endOffsetMs: 900,
      });
      fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));

      const editor = await editorReturns();
      expect(Array.from(editor.children, (node) => node.textContent)).toEqual([
        "First line",
        "um so tomorrow send the quote",
      ]);
      expect(screen.queryByText("Tidying…")).toBeNull();
      expect(screen.queryByRole("button", { name: /Auto-tidy/ })).toBeNull();
      await waitFor(() =>
        expect(putTodayPocketNote).toHaveBeenLastCalledWith(
          "tenant-1",
          "First line\num so tomorrow send the quote",
        ),
      );
    });

    it("offers no microphone without Another Me or server dictation", async () => {
      renderLauncher(dictationClient(savedNote(), false), "room-1");
      fireEvent.click(screen.getByRole("button", { name: "Pocket Notes" }));
      await screen.findByRole("textbox", { name: "Today’s note" });
      await act(async () => undefined);
      expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
    });
  });
});
