import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadOnlyBlockNoteDocument } from "./read-only-blocknote-document";
import { renderMermaidSvg } from "@/features/rooms/mermaid-preview-adapter";

vi.mock("@/features/rooms/mermaid-preview-adapter", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/rooms/mermaid-preview-adapter")
  >()),
  renderMermaidSvg: vi
    .fn()
    .mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><text>Diagram</text></svg>',
    ),
}));

describe("ReadOnlyBlockNoteDocument", () => {
  beforeEach(() =>
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    ),
  );
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("renders knowledge Mermaid as a diagram without source or editor chrome", async () => {
    const view = render(
      <ReadOnlyBlockNoteDocument
        ariaLabel="Wiki page"
        presentation="knowledge"
        markdown={"```mermaid\nsequenceDiagram\n  User->>Agent: Hi\n```"}
      />,
    );
    expect(await screen.findByTitle("Mermaid diagram preview")).toBeVisible();
    expect(view.container.querySelector(".mermaid-svg-preview")).toHaveStyle({
      aspectRatio: "320 / 120",
    });
    expect(
      view.container.querySelector(".room-document-mermaid__source"),
    ).not.toBeVisible();
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Code block language" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Zoom diagram in" }),
    ).toBeVisible();
  });

  it("reports a Mermaid error without showing raw source in reading mode", async () => {
    vi.mocked(renderMermaidSvg).mockRejectedValueOnce(
      new Error("Invalid diagram"),
    );
    const view = render(
      <ReadOnlyBlockNoteDocument
        ariaLabel="Wiki page"
        presentation="knowledge"
        markdown={"```mermaid\ninvalid diagram\n```"}
      />,
    );
    expect(
      await screen.findByText("Mermaid syntax error: Invalid diagram"),
    ).toBeVisible();
    expect(
      view.container.querySelector(".room-document-mermaid__source"),
    ).not.toBeVisible();
  });

  it("shows the newest five Interaction History entries until View more, and the whole Change Log", () => {
    const entries = Array.from(
      { length: 7 },
      (_, index) =>
        `- 2026-10-0${7 - index}: Call ${index + 1} [R${index + 1}].`,
    );
    const view = render(
      <ReadOnlyBlockNoteDocument
        ariaLabel="Wiki page"
        presentation="knowledge"
        markdown={[
          "Casey leads hardware [R1][R2]. Owns the hardware prototype [R3].",
          "",
          "## Interaction History",
          "",
          ...entries,
          "",
          "## Change Log",
          "",
          "- 2026-10-07 Update 1.",
          "- 2026-10-06 Update 2.",
        ].join("\n")}
      />,
    );
    const article = screen.getByRole("article", { name: "Wiki page" });
    expect(article.textContent).not.toMatch(/\[R\d/u);
    expect(screen.getByText(/Casey leads hardware\./u)).toBeVisible();
    expect(screen.getByText("Call 5.", { exact: false })).toBeVisible();
    expect(screen.getByText("Call 6.", { exact: false })).not.toBeVisible();
    expect(screen.getByText("Call 7.", { exact: false })).not.toBeVisible();
    expect(screen.getByText("Update 2.", { exact: false })).toBeVisible();
    expect(
      view.container.querySelector(".knowledge-change-log-date"),
    ).toHaveTextContent("2026-10-07");
    expect(
      view.container.querySelectorAll(
        ".bn-block-outer.knowledge-change-log-entry",
      ),
    ).toHaveLength(2);
    expect(
      view.container.querySelectorAll(".knowledge-change-log-entry--last"),
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "View more" })).toHaveLength(
      1,
    );

    act(() => screen.getByRole("button", { name: "View more" }).click());
    expect(screen.getByText("Call 7.", { exact: false })).toBeVisible();
    act(() => screen.getByRole("button", { name: "Show less" }).click());
    expect(screen.getByText("Call 7.", { exact: false })).not.toBeVisible();
  });

  it("renders Markdown through BlockNote without editable UI", () => {
    render(
      <ReadOnlyBlockNoteDocument
        ariaLabel="Shared document"
        markdown={
          "# Architecture\n\n- TeamHub owns state\n- Web renders projections"
        }
      />,
    );

    const document = screen.getByRole("article", { name: "Shared document" });
    expect(document).toHaveAttribute("data-content-renderer", "blocknote");
    expect(document).toHaveAttribute("data-editable", "false");
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "Architecture" })).toBeVisible();
    expect(screen.getByText("TeamHub owns state")).toBeVisible();
  });

  it("does not create network-capable media from untrusted Markdown", () => {
    render(
      <ReadOnlyBlockNoteDocument
        ariaLabel="Safe document"
        markdown={"![Customer chart](https://tracker.example.test/pixel.png)"}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Customer chart")).toBeVisible();
  });

  it.each(["png", "jpeg", "gif", "webp"])(
    "renders embedded Base64 %s images without a preview base URL",
    (format) => {
      const url = `data:image/${format};base64,aGVsbG8=`;
      render(
        <ReadOnlyBlockNoteDocument
          ariaLabel="Embedded document"
          markdown={`![Embedded chart](${url})`}
        />,
      );
      expect(
        screen.getByRole("img", { name: "Embedded chart" }),
      ).toHaveAttribute("src", url);
    },
  );

  it.each([
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:text/html;base64,PGgxPkhlbGxvPC9oMT4=",
    "data:image/png,plain-text",
    "data:image/png;base64,invalid!",
    "data:image/png;base64,a",
  ])("omits unsupported or malformed embedded image %s", (url) => {
    render(
      <ReadOnlyBlockNoteDocument
        ariaLabel="Embedded document"
        markdown={`![Rejected chart](${url})`}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("loads only relative images inside the Room preview snapshot", () => {
    render(
      <ReadOnlyBlockNoteDocument
        ariaLabel="Room document"
        assetBaseUrl="https://preview.example.test/v0/document-previews/token/readme.md"
        markdown={
          "![Local chart](./images/chart.png)\n\n![Outside](../../healthz)\n\n[Guide](./guide.md) [Escape](../../healthz)"
        }
      />,
    );

    expect(screen.getByRole("img", { name: "Local chart" })).toHaveAttribute(
      "src",
      "https://preview.example.test/v0/document-previews/token/images/chart.png",
    );
    expect(screen.queryByRole("img", { name: "Outside" })).toBeNull();
    expect(screen.getByText("Outside")).toBeVisible();
    expect(screen.getByRole("link", { name: "Guide" })).toHaveAttribute(
      "href",
      "https://preview.example.test/v0/document-previews/token/guide.md",
    );
    expect(screen.queryByRole("link", { name: "Escape" })).toBeNull();
    expect(screen.getByText("Escape")).toBeVisible();
  });
});
