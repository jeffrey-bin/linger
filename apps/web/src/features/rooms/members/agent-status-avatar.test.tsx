import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentStatusAvatar } from "./agent-status-avatar";
import { AgentAvatarStatusContext } from "./agent-avatar-status-context";

describe("Agent status avatar", () => {
  it("opens the Agent profile on an idle avatar click and activity from its hover card", () => {
    const onOpenProfile = vi.fn();
    const onOpenActivityLog = vi.fn();
    render(
      <AgentAvatarStatusContext.Provider
        value={{ statuses: new Map(), onOpenProfile, onOpenActivityLog }}
      >
        <AgentStatusAvatar actorId="codex" name="Codex" />
      </AgentAvatarStatusContext.Provider>,
    );
    const avatar = screen.getByRole("button", { name: "Open Codex profile" });
    fireEvent.click(avatar);
    expect(onOpenProfile).toHaveBeenCalledWith("codex");
    fireEvent.pointerEnter(avatar, { pointerType: "mouse" });
    expect(
      screen.queryByRole("menuitem", { name: "Open Agent info" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "View activity" }));
    expect(onOpenActivityLog).toHaveBeenCalledWith("codex");
  });

  it("shows the live status and opens Activity without opening the profile", () => {
    const onOpenProfile = vi.fn();
    const onOpenActivityLog = vi.fn();
    render(
      <AgentAvatarStatusContext.Provider
        value={{ statuses: new Map(), onOpenProfile, onOpenActivityLog }}
      >
        <AgentStatusAvatar
          actorId="codex"
          name="Codex"
          status={{
            status: "Working",
            activities: [{ id: "a", label: "Read document" }],
          }}
        />
      </AgentAvatarStatusContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Codex status" }));
    expect(screen.getByText("Read document")).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "View activity" }));
    expect(onOpenActivityLog).toHaveBeenCalledWith("codex");
    expect(onOpenProfile).not.toHaveBeenCalled();
  });
});
