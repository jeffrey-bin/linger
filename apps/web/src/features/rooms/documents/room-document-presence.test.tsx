import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TeamHubRoomMember } from "@/features/teamhub/teamhub-types";

import { RoomDocumentPresence } from "./room-document-presence";
import {
  createRoomDocumentCursor,
  createRoomDocumentCursorRenderer,
  listRoomDocumentParticipants,
  refreshRoomDocumentCursorName,
  type RoomDocumentAwareness,
} from "./room-document-presence-model";

const currentActor = {
  color: "#315fb5",
  displayName: "Alice Chen",
  id: "actor-alice",
};

const members = [
  roomMember("actor-alice", "Alice Chen"),
  roomMember("actor-bob", "Bob Li"),
  roomMember("actor-mia", "Mia Wang"),
];

describe("Room Document presence", () => {
  it("projects unique Actors instead of browser connections", () => {
    const awareness = createAwarenessFake([
      awarenessState(1, "actor-alice", "#315fb5"),
      awarenessState(2, "actor-bob", "#b45309"),
      awarenessState(3, "actor-bob", "#b45309"),
      awarenessState(4, "actor-mia", "#0369a1"),
    ]);

    expect(
      listRoomDocumentParticipants({ awareness, currentActor, members }),
    ).toEqual([
      {
        actorId: "actor-alice",
        clientId: 1,
        color: "#315fb5",
        initials: "AC",
        isCurrent: true,
        name: "Alice Chen",
      },
      {
        actorId: "actor-bob",
        clientId: 2,
        color: "#b45309",
        initials: "BL",
        isCurrent: false,
        name: "Bob Li",
      },
      {
        actorId: "actor-mia",
        clientId: 4,
        color: "#0369a1",
        initials: "MW",
        isCurrent: false,
        name: "Mia Wang",
      },
    ]);
  });

  it("renders nothing for self-only or malformed awareness state", () => {
    const awareness = createAwarenessFake([
      awarenessState(1, "actor-alice", "#315fb5"),
      [2, { user: { actorId: "actor-bob", color: "orange" } }],
      [3, { user: { color: "#b45309" } }],
      [4, {}],
    ]);

    render(
      <RoomDocumentPresence
        awareness={awareness}
        currentActor={currentActor}
        members={members}
      />,
    );

    expect(
      screen.queryByRole("status", { name: /people in this document/i }),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when collaboration awareness is unavailable", () => {
    render(
      <RoomDocumentPresence
        awareness={null}
        currentActor={currentActor}
        members={members}
      />,
    );

    expect(
      screen.queryByRole("status", { name: /people in this document/i }),
    ).not.toBeInTheDocument();
  });

  it("falls back to trusted Actor IDs and caps the visible avatar stack", () => {
    const awareness = createAwarenessFake([
      awarenessState(1, "actor-alice", "#315fb5"),
      awarenessState(2, "actor-bob", "#b45309"),
      awarenessState(3, "actor-mia", "#0369a1"),
      awarenessState(4, "actor-zoe", "#047857"),
    ]);

    render(
      <RoomDocumentPresence
        awareness={awareness}
        currentActor={currentActor}
        members={undefined}
      />,
    );

    expect(
      screen.getByRole("status", {
        name: "4 people in this document: Alice Chen, actor-bob, actor-mia, actor-zoe",
      }),
    ).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(4);
    expect(screen.getByLabelText("actor-bob avatar")).toBeVisible();
  });

  it("updates the header count and clears it when the remote Actor leaves", async () => {
    const awareness = createMutableAwarenessFake([
      awarenessState(1, "actor-alice", "#315fb5"),
    ]);
    render(
      <RoomDocumentPresence
        awareness={awareness}
        currentActor={currentActor}
        members={members}
      />,
    );

    act(() => {
      awareness.setStates([
        awarenessState(1, "actor-alice", "#315fb5"),
        awarenessState(2, "actor-bob", "#b45309"),
      ]);
    });

    const presence = await screen.findByRole("status", {
      name: "2 people in this document: Alice Chen, Bob Li",
    });
    expect(presence).toBeVisible();
    expect(screen.getByLabelText("Alice Chen avatar")).toBeVisible();
    expect(screen.getByLabelText("Bob Li avatar")).toBeVisible();

    act(() => {
      awareness.setStates([awarenessState(1, "actor-alice", "#315fb5")]);
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: /people in this document/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("defers awareness notifications fired during a sibling render", async () => {
    const awareness = createMutableAwarenessFake([
      awarenessState(1, "actor-alice", "#315fb5"),
    ]);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const MutateAwareness = ({ active }: { active: boolean }) => {
      if (active) {
        awareness.setStates([
          awarenessState(1, "actor-alice", "#315fb5"),
          awarenessState(2, "actor-bob", "#b45309"),
        ]);
      }
      return null;
    };
    const view = (active: boolean) => (
      <>
        <RoomDocumentPresence
          awareness={awareness}
          currentActor={currentActor}
          members={members}
        />
        <MutateAwareness active={active} />
      </>
    );
    const { rerender } = render(view(false));

    rerender(view(true));

    expect(
      await screen.findByRole("status", {
        name: "2 people in this document: Alice Chen, Bob Li",
      }),
    ).toBeVisible();
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
      "Cannot update a component",
    );
    consoleError.mockRestore();
  });

  it("renders an always-visible cursor label with the Room member name", () => {
    const cursor = createRoomDocumentCursor(
      {
        actorId: "actor-bob",
        color: "#b45309",
        id: "actor-bob",
        name: "actor-bob",
      },
      new Map([["actor-bob", "Bob Li"]]),
    );

    expect(cursor).toHaveAttribute("data-active");
    expect(cursor).toHaveAttribute("data-actor-id", "actor-bob");
    const label = cursor.querySelector(".bn-collaboration-cursor__label");
    expect(label).toHaveAttribute("aria-label", "Bob Li cursor");
    expect(label).toHaveAttribute("data-collaborator-name", "Bob Li");
    expect(cursor).not.toHaveTextContent("Bob Li");

    const mediumColorCursor = createRoomDocumentCursor(
      { actorId: "actor-mia", color: "#777777" },
      new Map(),
    );
    expect(
      mediumColorCursor.querySelector(".bn-collaboration-cursor__label"),
    ).toHaveStyle({ color: "#1a1a16" });

    refreshRoomDocumentCursorName(
      mediumColorCursor,
      new Map([["actor-mia", "Mia Wang"]]),
    );
    expect(
      mediumColorCursor.querySelector(".bn-collaboration-cursor__label"),
    ).toHaveAttribute("data-collaborator-name", "Mia Wang");
  });

  it("refreshes a cached cursor name while the cursor is detached", () => {
    const renderer = createRoomDocumentCursorRenderer();
    const cursor = renderer.renderCursor({
      actorId: "actor-bob",
      color: "#b45309",
    });
    document.body.append(cursor);
    cursor.remove();

    renderer.setNames(new Map([["actor-bob", "Bob Li"]]));
    document.body.append(cursor);

    expect(
      cursor.querySelector(".bn-collaboration-cursor__label"),
    ).toHaveAttribute("data-collaborator-name", "Bob Li");
    renderer.destroy();
    cursor.remove();
  });
});

function roomMember(id: string, displayName: string): TeamHubRoomMember {
  const actor = {
    display_name: displayName,
    id,
    kind: "human" as const,
    tenant_id: "tenant-one",
  };
  return {
    actor,
    added_by: actor,
    joined_at: "2026-08-14T00:00:00Z",
    role: "member",
    room_id: "room-one",
    updated_at: "2026-08-14T00:00:00Z",
  };
}

function awarenessState(
  clientId: number,
  actorId: string,
  color: string,
): [number, unknown] {
  return [clientId, { user: { actorId, color, id: actorId, name: actorId } }];
}

function createAwarenessFake(
  states: Array<[number, unknown]>,
): RoomDocumentAwareness {
  return {
    clientID: 1,
    getStates: () => new Map(states),
    off: vi.fn(),
    on: vi.fn(),
  } as unknown as RoomDocumentAwareness;
}

function createMutableAwarenessFake(
  states: Array<[number, unknown]>,
): RoomDocumentAwareness & {
  setStates(nextStates: Array<[number, unknown]>): void;
} {
  const listeners = new Set<() => void>();
  let currentStates = new Map(states);
  return {
    clientID: 1,
    getStates: () => currentStates,
    off: (_event: "change", listener: () => void) => listeners.delete(listener),
    on: (_event: "change", listener: () => void) => listeners.add(listener),
    setStates(nextStates: Array<[number, unknown]>) {
      currentStates = new Map(nextStates);
      for (const listener of listeners) listener();
    },
  } as unknown as RoomDocumentAwareness & {
    setStates(nextStates: Array<[number, unknown]>): void;
  };
}
