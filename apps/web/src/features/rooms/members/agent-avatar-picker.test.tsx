import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { AgentAvatarEditor } from "./agent-avatar-picker";

function Harness({
  initialImage = "",
  initialKey = "figure:rabbit:1C1921",
  uploads = true,
}: {
  initialImage?: string;
  initialKey?: string;
  uploads?: boolean;
}) {
  const [value, setValue] = useState(initialKey);
  const [image, setImage] = useState(initialImage);
  return (
    <>
      <AgentAvatarEditor
        image={image}
        onChange={setValue}
        onImageChange={uploads ? setImage : undefined}
        value={value}
      />
      <output data-testid="avatar-key">{value}</output>
    </>
  );
}

function avatarKey() {
  return screen.getByTestId("avatar-key").textContent;
}

describe("AgentAvatarEditor", () => {
  it("opens the characters from the avatar, each on its own background", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Choose avatar" }));
    const gallery = await screen.findByRole("radiogroup", { name: "Avatars" });
    expect(within(gallery).getAllByRole("radio")).toHaveLength(150);
    expect(
      within(gallery).getByRole("radio", { name: "Avatar 3" }),
    ).toHaveAttribute("aria-checked", "true");

    // A character comes with the background it was drawn on.
    fireEvent.click(within(gallery).getByRole("radio", { name: "Avatar 6" }));
    expect(avatarKey()).toBe("figure:panda:A1A572");
    expect(
      screen.queryByRole("radiogroup", { name: "Avatars" }),
    ).not.toBeInTheDocument();
  });

  it("recolors the background behind the chosen character", () => {
    render(<Harness />);
    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Avatar background color hue" }),
      { key: "ArrowRight", shiftKey: true },
    );
    expect(avatarKey()).toMatch(/^figure:rabbit:[0-9A-F]{6}$/);
    expect(avatarKey()).not.toBe("figure:rabbit:1C1921");
  });

  it("ends the gallery with an upload tile only where images can be stored", async () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar" }));
    expect(
      await screen.findByRole("button", { name: "Upload image" }),
    ).toBeInTheDocument();
    unmount();

    render(<Harness uploads={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar" }));
    await screen.findByRole("radiogroup", { name: "Avatars" });
    expect(
      screen.queryByRole("button", { name: "Upload image" }),
    ).not.toBeInTheDocument();
  });

  it("keeps an uploaded image framed by its background color", () => {
    render(
      <Harness
        initialImage="data:image/png;base64,AAAA"
        initialKey="image:FFFFFF"
      />,
    );
    const tile = screen
      .getByTestId("agent-avatar-hero")
      .querySelector<HTMLElement>(".agent-avatar-tile")!;
    expect(tile).toHaveAttribute("data-kind", "image");
    expect(tile.querySelector("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,AAAA",
    );
    fireEvent.keyDown(
      screen.getByRole("slider", {
        name: "Avatar background color saturation and brightness",
      }),
      { key: "ArrowDown", shiftKey: true },
    );
    expect(avatarKey()).toMatch(/^image:/);
  });
});
