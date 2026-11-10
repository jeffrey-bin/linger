import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { RoomAvatar } from "./room-avatar";

function members(count: number): TeamHubActorRef[] {
  return Array.from({ length: count }, (_, index) => ({
    display_name: `Member ${index + 1}`,
    id: `actor-${index + 1}`,
    kind: index % 3 === 2 ? "agent" : "human",
    tenant_id: "tenant-a",
  }));
}

function stack(count: number) {
  const { container } = render(<RoomAvatar members={members(count)} />);
  const avatar = container.querySelector<HTMLElement>(".room-avatar")!;
  return {
    faces: [...avatar.querySelectorAll(".room-avatar-tile [aria-label]")].map(
      (face) => face.getAttribute("aria-label"),
    ),
    more: avatar.querySelector(".room-avatar-more")?.textContent ?? null,
    positions: [
      ...avatar.querySelectorAll(".room-avatar-tile, .room-avatar-more"),
    ].map((tile) => tile.getAttribute("data-position")),
  };
}

describe("RoomAvatar", () => {
  it("leads with the first member and stacks up to four faces", () => {
    expect(stack(1).positions).toEqual(["solo"]);
    expect(stack(2).positions).toEqual(["lead", "br"]);
    expect(stack(3).positions).toEqual(["lead-center", "bl", "br"]);
    expect(stack(4).positions).toEqual(["lead", "tr", "bl", "br"]);
    expect(stack(4).faces).toEqual(
      members(4).map((member) => `${member.display_name} avatar`),
    );
  });

  it("counts the members it cannot show in the bottom-right tile", () => {
    const five = stack(5);
    expect(five.faces).toEqual([
      "Member 1 avatar",
      "Member 2 avatar",
      "Member 3 avatar",
    ]);
    expect(five.positions).toEqual(["lead", "tr", "bl", "br"]);
    expect(five.more).toBe("+2");
    expect(stack(9).more).toBe("+6");
    expect(stack(4).more).toBeNull();
  });

  it("falls back to the Room mark while no members are known", () => {
    const { container } = render(<RoomAvatar members={[]} />);
    expect(container.querySelector(".room-avatar-empty svg")).not.toBeNull();
  });
});
