import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";

import { AgentCreateMenu } from "./agent-create-menu";

describe("AgentCreateMenu", () => {
  it("offers Agent, Room, and template creation", async () => {
    const onCreateFromTemplate = vi.fn();
    renderMenu({ onCreateFromTemplate });

    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Create Agent",
      "Create Room",
      "Agent templates",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Agent templates" }));
    expect(onCreateFromTemplate).toHaveBeenCalledOnce();
  });

  it("creates an Agent on this Computer without a placement choice", async () => {
    const onCreateAgent = vi.fn();
    renderMenu({ onCreateAgent });

    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Create Agent" }),
    );

    expect(onCreateAgent).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

function renderMenu(overrides: Partial<Parameters<typeof AgentCreateMenu>[0]>) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <AgentCreateMenu
            onCreateAgent={vi.fn()}
            onCreateRoom={vi.fn()}
            onCreateFromTemplate={vi.fn()}
            {...overrides}
          />
        ),
        path: "/",
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}
