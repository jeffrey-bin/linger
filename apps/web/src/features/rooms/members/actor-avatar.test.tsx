import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { accountProfileQueryKey } from "@/features/settings/account-profile-queries";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { ActorAvatar } from "./actor-avatar";
import { ActorAvatarImageProvider } from "./actor-avatar-image";

describe("ActorAvatar", () => {
  it("presents a stable accessible human identity with initials", () => {
    render(<ActorAvatar kind="human" name="Jenny Bin" />);

    const avatar = screen.getByRole("img", { name: "Jenny Bin avatar" });
    expect(avatar).toHaveTextContent("JB");
    expect(avatar).toHaveAttribute("title", "Jenny Bin");
    // Same tile as an Agent: a rounded square on a palette tint, never a flat circle.
    expect(avatar).toHaveClass("rounded-[20%]", "size-10");
    expect(avatar).not.toHaveClass("rounded-full", "bg-app-border");
    expect(avatar.className).toMatch(/bg-\[var\(--app-[a-z-]+-surface\)\]/);
  });

  it("takes one initial from each of the first two name words", () => {
    const { rerender } = render(<ActorAvatar kind="human" name="Tony" />);
    expect(screen.getByRole("img", { name: "Tony avatar" })).toHaveTextContent(
      /^T$/,
    );
    rerender(<ActorAvatar kind="human" name="Tony Zhang" />);
    expect(
      screen.getByRole("img", { name: "Tony Zhang avatar" }),
    ).toHaveTextContent(/^TZ$/);
    rerender(<ActorAvatar kind="human" name="weihao liu" />);
    expect(
      screen.getByRole("img", { name: "weihao liu avatar" }),
    ).toHaveTextContent(/^WL$/);
  });

  it("keeps one tint per Actor across sizes and gives different Actors different tints", () => {
    const tintOf = (element: HTMLElement) =>
      element.className.match(/bg-\[var\(--app-[a-z-]+-surface\)\]/)?.[0];
    const { rerender } = render(
      <ActorAvatar actorId="actor-jenny" kind="human" name="Jenny Bin" />,
    );
    const first = tintOf(screen.getByRole("img", { name: "Jenny Bin avatar" }));
    rerender(
      <ActorAvatar
        actorId="actor-jenny"
        kind="human"
        name="Jenny Bin"
        size="nav"
      />,
    );
    const nav = screen.getByRole("img", { name: "Jenny Bin avatar" });
    expect(tintOf(nav)).toBe(first);
    expect(nav).toHaveClass("size-8", "rounded-[20%]");
    const tints = new Set(
      ["actor-a", "actor-b", "actor-c", "actor-d", "actor-e"].map((id) => {
        rerender(<ActorAvatar actorId={id} kind="human" name="Someone" />);
        return tintOf(screen.getByRole("img", { name: "Someone avatar" }));
      }),
    );
    expect(tints.size).toBeGreaterThan(1);
  });

  it("draws an Agent as its animal character on a rounded square", () => {
    render(
      <ActorAvatar
        avatarKey="figure:dog:5A8F66"
        kind="agent"
        name="Codex"
        size="nav"
      />,
    );

    const avatar = screen.getByRole("img", { name: "Codex avatar" });
    expect(avatar).toHaveAttribute("title", "Codex");
    expect(avatar).toHaveClass("size-8", "rounded-[20%]", "overflow-hidden");
    const tile = avatar.querySelector<HTMLElement>(".agent-avatar-tile")!;
    expect(tile.style.backgroundColor).toBe("rgb(90, 143, 102)");
    expect(tile.querySelector("img")?.getAttribute("src")).toContain("dog.svg");
    expect(avatar).not.toHaveTextContent("CO");
  });

  it("uses Unicode initials and an accessible fallback for missing names", () => {
    const { rerender } = render(
      <ActorAvatar kind="human" name="Émile" size="lg" />,
    );

    expect(screen.getByRole("img", { name: "Émile avatar" })).toHaveTextContent(
      /^É$/,
    );
    expect(screen.getByRole("img", { name: "Émile avatar" })).toHaveClass(
      "size-16",
    );

    rerender(<ActorAvatar kind="agent" name="   " size="xs" />);

    const fallback = screen.getByRole("img", { name: "Unknown Actor avatar" });
    expect(fallback).toHaveAttribute("title", "Unknown Actor");
    expect(fallback).toHaveClass("size-7");
    expect(fallback.querySelector(".agent-avatar-tile img")).not.toBeNull();
  });

  it("shows the Settings profile picture wherever the Actor appears", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const identity = runtime.seed.identity;
    const actor = identity.actors[0]!;
    queryClient.setQueryData(accountProfileQueryKey(actor.tenant_id), {
      avatar_image: "data:image/png;base64,AAAA",
      name: actor.display_name,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <ActorAvatarImageProvider
            identity={identity}
            tenantId={actor.tenant_id}
          >
            <ActorAvatar
              actorId={actor.id}
              kind="human"
              name={actor.display_name}
              size="nav"
            />
          </ActorAvatarImageProvider>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    const avatar = await screen.findByRole("img", {
      name: `${actor.display_name} avatar`,
    });
    await waitFor(() =>
      expect(avatar).toHaveAttribute("src", "data:image/png;base64,AAAA"),
    );
    expect(avatar.tagName).toBe("IMG");
    expect(avatar).not.toHaveTextContent("JB");
  });
});
