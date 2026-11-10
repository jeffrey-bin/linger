import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ArtifactContentRenderer } from "./artifact-content-renderer";
import { ArtifactContentRendererLoader } from "./artifact-content-renderer-loader";

vi.mock("./office-preview-adapter-loader", () => ({
  OfficePreviewAdapterLoader: ({ filename }: { filename: string }) => (
    <div data-testid="office-preview-adapter">{filename}</div>
  ),
}));
vi.mock("./pdf-preview-adapter-loader", () => ({
  PdfPreviewAdapterLoader: ({ filename }: { filename: string }) => (
    <section aria-label={`PDF preview ${filename}`} role="document" />
  ),
}));
vi.mock("./data-preview-adapter-loader", () => ({
  DataPreviewAdapterLoader: ({ filename }: { filename: string }) => (
    <section aria-label={`Data preview ${filename}`} role="table" />
  ),
}));
vi.mock("./media-preview-adapter-loader", () => ({
  MediaPreviewAdapterLoader: ({
    filename,
    mediaType,
    objectUrl,
  }: {
    filename: string;
    mediaType: string;
    objectUrl: string;
  }) => (
    <section aria-label={`Media preview ${filename}`}>
      {mediaType} {objectUrl}
    </section>
  ),
}));

describe("ArtifactContentRenderer", () => {
  it("keeps filename chrome out of image, text, html, and svg bodies", () => {
    const { rerender } = render(
      <ArtifactContentRenderer
        filename="shot.png"
        kind="image"
        objectUrl="blob:png"
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("img", { name: "shot.png" })).toBeVisible();

    rerender(
      <ArtifactContentRenderer
        filename="notes.txt"
        kind="text"
        textContent="hello"
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();

    rerender(
      <ArtifactContentRenderer
        filename="page.html"
        kind="html"
        previewUrl="https://preview.example.test/site/index.html"
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByTitle("Preview page.html")).toBeVisible();

    rerender(
      <ArtifactContentRenderer
        filename="mark.svg"
        kind="svg"
        objectUrl="blob:svg"
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("img", { name: "mark.svg" })).toBeVisible();
  });

  it("keeps image zoom inside the neutral preview canvas", () => {
    render(
      <ArtifactContentRenderer
        filename="shot.png"
        kind="image"
        objectUrl="blob:png"
      />,
    );

    expect(screen.getByText("100%")).toBeVisible();
    expect(screen.getByRole("img", { name: "shot.png" })).toHaveClass(
      "m-auto",
      "shrink-0",
    );
    expect(screen.getByRole("img", { name: "shot.png" })).toHaveStyle({
      zoom: "1",
    });
    expect(screen.getByRole("img", { name: "shot.png" })).not.toHaveStyle({
      transform: "scale(1)",
    });
    fireEvent.click(screen.getByRole("button", { name: "Zoom image in" }));
    expect(screen.getByText("110%")).toBeVisible();
    expect(screen.getByRole("img", { name: "shot.png" })).toHaveStyle({
      zoom: "1.1",
    });
    expect(screen.getByTestId("image-preview-canvas")).toHaveClass("bg-muted");
  });

  it("keeps filename chrome out of office, pdf, csv, and media adapters", () => {
    const { rerender } = render(
      <ArtifactContentRendererLoader
        blob={new Blob(["office"])}
        filename="quarterly-report.xlsx"
        kind="office"
        mediaType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onError={() => undefined}
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();

    rerender(
      <ArtifactContentRendererLoader
        blob={new Blob(["pdf"])}
        filename="quarterly-report.pdf"
        kind="pdf"
        mediaType="application/pdf"
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();

    rerender(
      <ArtifactContentRendererLoader
        blob={new Blob(["name,value\nJenny,1"])}
        filename="accounts.csv"
        kind="csv"
        mediaType="text/csv"
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();

    rerender(
      <ArtifactContentRendererLoader
        filename="meeting.mp4"
        kind="media"
        mediaType="video/mp4"
        objectUrl="/v0/artifact-versions/version-1/content"
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("routes Office files through the isolated preview adapter", () => {
    render(
      <ArtifactContentRendererLoader
        blob={new Blob(["office"])}
        filename="quarterly-report.xlsx"
        kind="office"
        mediaType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onError={() => undefined}
      />,
    );

    expect(screen.getByTestId("office-preview-adapter")).toHaveTextContent(
      "quarterly-report.xlsx",
    );
  });
  it("explains an adapter whose content never arrived instead of rendering nothing", async () => {
    const onError = vi.fn();
    render(
      <ArtifactContentRendererLoader
        filename="deck.pptx"
        kind="office"
        mediaType="application/vnd.openxmlformats-officedocument.presentationml.presentation"
        onError={onError}
      />,
    );

    // A blank pane is indistinguishable from a preview of an empty file.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This Office preview could not start because its content was unavailable.",
    );
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "This Office preview could not start because its content was unavailable.",
      ),
    );
    expect(
      screen.queryByTestId("office-preview-adapter"),
    ).not.toBeInTheDocument();
  });

  it("routes PDF files through the project preview adapter", () => {
    render(
      <ArtifactContentRendererLoader
        blob={new Blob(["pdf"])}
        filename="quarterly-report.pdf"
        kind="pdf"
        mediaType="application/pdf"
      />,
    );

    expect(
      screen.getByRole("document", {
        name: "PDF preview quarterly-report.pdf",
      }),
    ).toBeVisible();
    expect(screen.queryByTitle("Preview quarterly-report.pdf")).toBeNull();
  });
  it("routes CSV files through the Worker-backed data adapter", () => {
    render(
      <ArtifactContentRendererLoader
        blob={new Blob(["name,value\nJenny,1"])}
        filename="accounts.csv"
        kind="csv"
        mediaType="text/csv"
      />,
    );

    expect(
      screen.getByRole("table", { name: "Data preview accounts.csv" }),
    ).toBeVisible();
  });
  it("routes audio and video through the lazy media adapter", () => {
    render(
      <ArtifactContentRendererLoader
        filename="meeting.mp4"
        kind="media"
        mediaType="video/mp4"
        objectUrl="/v0/artifact-versions/version-1/content"
      />,
    );

    expect(
      screen.getByRole("region", { name: "Media preview meeting.mp4" }),
    ).toHaveTextContent("video/mp4 /v0/artifact-versions/version-1/content");
  });
  it("recreates the media adapter when its object URL changes", () => {
    const { rerender } = render(
      <ArtifactContentRendererLoader
        filename="meeting.webm"
        kind="media"
        mediaType="video/webm"
        objectUrl="blob:media-first"
      />,
    );
    const firstPreview = screen.getByRole("region", {
      name: "Media preview meeting.webm",
    });

    rerender(
      <ArtifactContentRendererLoader
        filename="meeting.webm"
        kind="media"
        mediaType="video/webm"
        objectUrl="blob:media-second"
      />,
    );

    expect(
      screen.getByRole("region", { name: "Media preview meeting.webm" }),
    ).not.toBe(firstPreview);
  });
  it("renders Markdown through the shared safe BlockNote document", async () => {
    render(
      <ArtifactContentRendererLoader
        filename="tracking.md"
        kind="markdown"
        textContent="![Customer chart](https://tracker.example.test/pixel.png)"
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      await screen.findByText("Customer chart", undefined, {
        timeout: 10_000,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("article", { name: "Read-only Markdown document" }),
    ).toHaveAttribute("data-content-renderer", "blocknote");
  });

  it("renders authored HTML in an origin-isolated sandbox", () => {
    render(
      <ArtifactContentRenderer
        filename="unsafe.html"
        kind="html"
        previewUrl="https://preview.example.test/v0/document-previews/token/index.html"
      />,
    );

    const frame = screen.getByTitle("Preview unsafe.html");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute(
      "src",
      "https://preview.example.test/v0/document-previews/token/index.html",
    );
    expect(frame).not.toHaveAttribute("srcdoc");
    expect(document.querySelector("script")).toBeNull();
  });

  it("keeps non-Room HTML content in the existing scriptless sandbox", () => {
    render(
      <ArtifactContentRenderer
        filename="wiki.html"
        kind="html"
        textContent="<script>window.parent.pwned=true</script><h1>Preview</h1>"
      />,
    );

    const frame = screen.getByTitle("Preview wiki.html");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
  });

  it("keeps code-like text readable in the shared preview", () => {
    render(
      <ArtifactContentRenderer
        filename="workspace.yaml"
        kind="text"
        textContent="workspace: northstar"
      />,
    );

    const preview = screen.getByText("workspace: northstar").closest("pre");
    expect(preview).toHaveAttribute("data-content-renderer", "text");
    expect(preview).toHaveClass("text-[15px]");
  });

  it("renders SVG as an image so its animation runs without scripts", () => {
    render(
      <ArtifactContentRenderer
        filename="pelican.svg"
        kind="svg"
        objectUrl="blob:pelican"
      />,
    );

    const image = screen.getByRole("img", { name: "pelican.svg" });
    expect(image).toHaveAttribute("src", "blob:pelican");
    expect(image).toHaveStyle({ height: "100%", width: "100%" });
    expect(screen.queryByTitle("Preview pelican.svg")).toBeNull();
  });
});
