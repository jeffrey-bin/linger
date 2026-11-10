import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CreationMessagePreview } from "./creation-message-preview";

describe("CreationMessagePreview", () => {
  it("labels an artifact tree segment as a directory delivery", () => {
    render(
      <CreationMessagePreview
        segments={[
          {
            content: "Published morrow",
            directory_count: 2,
            file_count: 4,
            publication_group_id: "publication-group-1",
            root_path: "morrow",
            total_bytes: 128,
            type: "artifact_tree",
          },
        ]}
      />,
    );

    expect(screen.getByText("Artifact directory: morrow")).toBeInTheDocument();
  });
});
