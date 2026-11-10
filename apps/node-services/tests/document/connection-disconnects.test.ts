import { describe, expect, it } from "vitest";

import { ConnectionDisconnects } from "../../src/document/connection-disconnects.js";

describe("ConnectionDisconnects", () => {
  it("covers an opening connection with a later disconnect", () => {
    const disconnects = new ConnectionDisconnects();
    const actor = disconnects.mark("document_1", "actor_1");
    const other = disconnects.mark("document_1", "actor_2");

    disconnects.record("document_1", "actor_1");

    expect(disconnects.isDisconnected("document_1", "actor_1", actor)).toBe(
      true,
    );
    expect(disconnects.isDisconnected("document_1", "actor_2", other)).toBe(
      false,
    );
    disconnects.record("document_1");
    expect(disconnects.isDisconnected("document_1", "actor_2", other)).toBe(
      true,
    );
  });

  it("drops a Document's counts once no connection holds a mark", () => {
    const disconnects = new ConnectionDisconnects();
    const first = disconnects.mark("document_1", "actor_1");
    const second = disconnects.mark("document_1", "actor_1");
    disconnects.record("document_1", "actor_1");

    first.release();
    first.release();
    expect(disconnects.size).toBe(1);
    second.release();
    expect(disconnects.size).toBe(0);

    // With no holder a disconnect has nothing to cover and keeps no entry.
    disconnects.record("document_2");
    expect(disconnects.size).toBe(0);
    const next = disconnects.mark("document_1", "actor_1");
    expect(disconnects.isDisconnected("document_1", "actor_1", next)).toBe(
      false,
    );
    next.release();
    expect(disconnects.size).toBe(0);
  });
});
