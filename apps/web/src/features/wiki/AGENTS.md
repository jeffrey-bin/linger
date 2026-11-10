# Personal Wiki Surface

- Own the authenticated Human's Tenant-scoped Personal Wiki navigation, output reading, and manual source upload UI. Memory views (Timeline graph, reports, Meetings) live in `features/memory`.
- Call TeamHub through the generated client (`client.api`) and generated Personal Wiki types; do not handwrite URLs or wire DTOs in components.
- Treat the current published Markdown Revision as derived reading state, not source evidence or Agent memory.
- Keep selected output-file identity in the route URL and retain visible source references.
- Reuse the Artifact file icon mapping, preview policy, file-type renderers, and shared read-only BlockNote Markdown renderer; do not fork file-type or document-view presentation inside Wiki.
- Published Wiki output and provenance snapshots are always read-only. Human-owned
  Personal Wiki source files may append a new source version through TeamHub;
  they reuse the shared BlockNote visual language but do not become Room
  Documents or bypass Wiki source versioning.
- A Wiki page is a read-only Markdown file Document: open it with the file preview and the knowledge presentation, never a collaboration session.
- Web observes generation state. It does not call LLM Wiki directly or orchestrate compilation.

- Wiki navigation owns Profile, Timeline, Projects, Topics, People, and Companies. Timeline, People
  and Companies are the display labels for the existing `graph`, `contacts` and
  `clients` entries; keep their routes and data keys.
  Wiki routes show the overview and collection pages without a sidebar; the directory
  appears only beside an opened Wiki page and lists that page's own collection,
  following links into other collections, until Back.
  Opened files keep unified Document routes. Keep/Delete are browser-local display
  decisions scoped to the current Account and Tenant (`wiki-display-state.ts`, shared
  with `features/memory`). Filter displayed graph nodes and edges only; never issue
  backend mutations for these decisions.
