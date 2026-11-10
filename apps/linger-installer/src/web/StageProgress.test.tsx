// @vitest-environment jsdom
import { expect, test } from "vitest";
import { render } from "@testing-library/react";
import { StageProgress } from "./StageProgress.js";
import { bytes } from "./SetupChoicePanel.js";
test("small downloads remain readable and speed resets across successive files", () => {
  expect(bytes(200)).toBe("200 B");
  expect(bytes(8 * 1024 ** 2)).toBe("8 MiB");
  const element = (completed: number, total: number, now: number) => (
    <StageProgress progress={{ completed, total, unit: "bytes" }} now={now} />
  );
  const view = render(element(100, 1000, 0));
  view.rerender(element(900, 1000, 1000));
  expect(view.container.textContent).toContain("MiB/s");
  view.rerender(element(200, 1000, 2000));
  expect(view.container.textContent).not.toContain("MiB/s");
  expect(view.container.textContent).toContain("200 B");
  view.rerender(element(800, 2000, 3000));
  expect(view.container.textContent).not.toContain("MiB/s");
  view.unmount();
});
