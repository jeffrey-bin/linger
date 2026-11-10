import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";

import { AuthenticatedRouteLoading } from "./route-loading-surface";

describe("AuthenticatedRouteLoading", () => {
  it("names the destination Room for assistive tech but draws only shapes", async () => {
    const runtime = createTestTeamHubRuntime();

    const rooms = await teamHubData(
      runtime.client.api.GET("/v0/tenants/{tenantId}/rooms", {
        params: { path: { tenantId: "tenant-northstar" } },
      }),
    );

    render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/rooms/room-gtm-launch/chat"
        rooms={rooms.items}
      />,
    );

    expect(
      screen.getByRole("status", { name: "Loading gtm-launch" }),
    ).toHaveAttribute("data-loading-route", "room");
    // No title or status text lands ahead of the rest of the Room.
    expect(screen.queryByText("gtm-launch")).toBeNull();
  });

  it.each([
    ["/t/tenant-northstar/documents/document-1", "Document", "document"],
    ["/t/tenant-northstar/dashboard/work-item-a", "Dashboard", "dashboard"],
    ["/t/tenant-northstar/library/my-documents", "Library", "library"],
    ["/t/tenant-northstar/library/wiki", "Wiki", "library"],
    ["/t/tenant-northstar/computers", "Local computers", "page"],
  ])("maps %s to the %s loading surface", (pathname, label, kind) => {
    render(<AuthenticatedRouteLoading pathname={pathname} rooms={[]} />);

    expect(
      screen.getByRole("status", { name: `Loading ${label}` }),
    ).toHaveAttribute("data-loading-route", kind);
  });

  it("keeps Library chrome stable while only the Document body is loading", () => {
    render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/documents/document-1"
        rooms={[]}
      />,
    );

    expect(screen.getByText("Overview")).toBeVisible();
    expect(screen.getByText("My pages")).toBeVisible();
    expect(screen.getByText("Shared with me")).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Loading Document body" }),
    ).toBeVisible();
  });

  it("keeps the Library sidebar while a Library route module loads", () => {
    render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/library/meetings"
        rooms={[]}
      />,
    );

    for (const item of ["Overview", "Search", "Wiki", "My pages"]) {
      expect(screen.getByText(item)).toBeVisible();
    }
  });
});
