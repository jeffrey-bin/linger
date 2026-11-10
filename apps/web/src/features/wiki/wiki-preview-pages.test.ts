import { expect, it } from "vitest";
import { wikiDocument } from "./wiki.test-support";
import { wikiEntries, wikiPreviewPages } from "./wiki-preview-pages";

const jsonPage = (title: string, description: string) =>
  `---\n${JSON.stringify({ type: "Project", title, description }, null, 2)}\n---\n\n# ${title}\n`;

it("reads each collection page's title and description and leaves the rest out", () => {
  const pages = wikiPreviewPages({
    "projects/atlas.md": jsonPage("Project Atlas", "Delivery analytics"),
    "contacts/tom.md":
      '---\ntitle: "Tom Becker"\ndescription: Northwind sponsor\n---\n',
    "topics/plain.md": "# Plain topic\n\nNo frontmatter.",
    "index.md": "# Index",
    "projects/index.md": "# Projects",
    "sessions/2026-11-01/capture.md": jsonPage("Kickoff", "Meeting"),
  });
  expect(
    pages.map(({ path, collection, name, description }) => ({
      path,
      collection,
      name,
      description,
    })),
  ).toEqual([
    {
      path: "topics/plain.md",
      collection: "topics",
      name: "Plain topic",
      description: "",
    },
    {
      path: "projects/atlas.md",
      collection: "projects",
      name: "Project Atlas",
      description: "Delivery analytics",
    },
    {
      path: "contacts/tom.md",
      collection: "contacts",
      name: "Tom Becker",
      description: "Northwind sponsor",
    },
  ]);
});

it("puts pages being generated first and lets them replace the published version", () => {
  const atlas = wikiDocument("doc-atlas", "atlas.md", "wiki_page");
  atlas.from[0]!.page_key = "projects/atlas.md";
  const launch = wikiDocument("doc-launch", "launch.md", "wiki_page");
  launch.from[0]!.page_key = "projects/launch.md";
  const previews = wikiPreviewPages({
    "projects/atlas.md": jsonPage("Project Atlas", "New budget"),
    "projects/new.md": jsonPage("New project", "Just started"),
    "topics/other.md": jsonPage("Other", "Elsewhere"),
  });
  const entries = wikiEntries([atlas, launch], previews, "projects");
  expect(
    entries.map((entry) =>
      entry.preview
        ? `preview:${entry.preview.name}`
        : `published:${entry.published.id}`,
    ),
  ).toEqual([
    "preview:New project",
    "preview:Project Atlas",
    "published:doc-launch",
  ]);
});
