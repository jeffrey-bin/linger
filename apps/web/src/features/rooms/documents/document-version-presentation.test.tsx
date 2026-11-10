import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedRoomUpload,
} from "@/test/document-scenarios";
import { DocumentVersionPreview } from "./document-version-preview";

vi.mock("@/features/rooms/files/artifact-content-renderer-loader", () => ({
  ArtifactContentRendererLoader: ({
    presentation,
  }: {
    presentation: string;
  }) => <div data-testid="presentation">{presentation}</div>,
}));

describe("Document Version knowledge presentation", () => {
  it.each(["wiki_source", "wiki_page", "room"] as const)(
    "uses knowledge presentation only for generated Wiki pages, not %s sources",
    async (bindingKind) => {
      const runtime = createDocumentTestRuntime();

      const document = await seedRoomUpload(
        runtime,
        `presentation-${bindingKind}`,
        {
          file: new File(
            ["# Original\n\n## Sources\n\nKeep this."],
            "original.md",
            {
              type: "text/markdown",
            },
          ),
          representationFormat: "markdown",
        },
        "tenant-northstar",
      );
      render(
        <DocumentVersionPreview
          client={runtime.client}
          document={{
            ...document,
            from: [{ binding_kind: bindingKind, context_id: "context" }],
          }}
        />,
      );
      expect(await screen.findByTestId("presentation")).toHaveTextContent(
        bindingKind === "wiki_page" ? "knowledge" : "default",
      );
    },
  );
});
