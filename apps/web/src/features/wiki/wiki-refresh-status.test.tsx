import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { WikiRefreshBanner } from "./wiki-refresh-status";

it("shows one quiet line while a refresh writes pages, and the failure", () => {
  const { rerender } = render(<WikiRefreshBanner failed={false} refreshing />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Another Me is writing your Wiki",
  );
  expect(screen.getByRole("status")).not.toHaveTextContent(/ready/u);
  rerender(<WikiRefreshBanner failed refreshing={false} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Wiki update failed");
  rerender(<WikiRefreshBanner failed={false} refreshing={false} />);
  expect(screen.queryByRole("status")).toBeNull();
});
