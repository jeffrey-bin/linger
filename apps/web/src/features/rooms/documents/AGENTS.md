# Room Document Web Boundary

- This directory owns the Room Product Client's Room Document editor surface,
  browser collaboration session, IndexedDB persistence, and user-visible
  save-state projection.
- TeamHub's public HTTP contract is the only source for Document metadata and
  collaboration credentials. A credential is a signed connection token, opaque
  to the browser; every reconnect asks TeamHub for a new one, because any
  permission change makes earlier tokens stale. The browser must not call
  TeamHub internal Document State operations or hold service credentials.
- Document Runtime owns Yjs WebSocket sync and awareness. Browser state is a
  recoverable local copy, never a second authority for permissions, durable
  sequence, publication, comments, assets, or lifecycle.
- `Saved` requires both local and remote hydration, an authenticated durable
  ACK, exact durable vector equality, and a newer durable sequence after any
  hydrated state change. Hocuspocus sync alone is never presented as durable
  save evidence. Full-state hashes remain server-side integrity evidence and
  must not be compared across independent browser and Runtime Y.Doc replicas.
- Keep protocol and persistence lifecycle behind the collaboration-session
  interface. React components render that interface and must not parse durable
  ACK envelopes or construct IndexedDB keys themselves.
- Only an editing session keeps a local copy, one per Actor and Document; a
  reopened session saves it under its new token. `room-document-local-copies.ts`
  owns copy names and deletion: a Document's copies go when TeamHub denies
  access to it, and an account's copies go at logout. Close this tab's sessions on a copy before
  deleting it, and close on `versionchange` so other tabs never block a
  deletion. It stays free of editor dependencies because logout imports it.
- Test state invariants through the collaboration-session interface and test
  the real browser workflow with Playwright. Do not inspect provider or
  IndexedDB internals from component tests.
