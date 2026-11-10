// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { normalizeOfficePreviewOnce } from "./office-preview-normalization";

describe("Office preview normalization", () => {
  it("removes legacy PowerPoint master placeholder text without removing real slide content", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <article>
        <div class="ofv-ppt-binary-shape ofv-ppt-binary-master-shape">
          <div class="ofv-ppt-binary-text">
            Click to edit the outline text format
            Second Outline Level
            Third Outline Level
          </div>
        </div>
        <div class="ofv-ppt-binary-shape">
          <div class="ofv-ppt-binary-text">Structured visual reasoning</div>
        </div>
      </article>
    `;

    normalizeOfficePreviewOnce(container, "sample.ppt");

    expect(container).not.toHaveTextContent("Click to edit");
    expect(container).toHaveTextContent("Structured visual reasoning");
  });

  it("repairs a PPTX slide when the renderer produces black text on a black background", () => {
    const container = createPptxPreview({
      background: "rgb(0, 0, 0)",
      color: "rgb(0, 0, 0)",
    });

    normalizeOfficePreviewOnce(container, "sample.pptx");

    expect(pptxCanvas(container).style.backgroundColor).toBe(
      "rgb(255, 255, 255)",
    );
    expect(pptxCanvas(container)).toHaveAttribute(
      "data-linger-background-repaired",
      "true",
    );
  });

  it("keeps an intentional dark PPTX slide when its text remains readable", () => {
    const container = createPptxPreview({
      background: "rgb(0, 0, 0)",
      color: "rgb(255, 255, 255)",
    });

    normalizeOfficePreviewOnce(container, "dark-deck.pptx");

    expect(pptxCanvas(container).style.backgroundColor).toBe("rgb(0, 0, 0)");
    expect(pptxCanvas(container)).not.toHaveAttribute(
      "data-linger-background-repaired",
    );
  });
});

function createPptxPreview({
  background,
  color,
}: {
  background: string;
  color: string;
}) {
  const container = document.createElement("div");
  container.innerHTML = `
    <div class="ofv-pptx-viewer">
      <div>
        <div>
          <div style="background-color: ${background}">
            <div><span style="color: ${color}">Slide title</span></div>
            <div><span style="color: ${color}">Slide body</span></div>
          </div>
        </div>
      </div>
    </div>
  `;
  return container;
}

function pptxCanvas(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    ".ofv-pptx-viewer > div > div > div",
  )!;
}
