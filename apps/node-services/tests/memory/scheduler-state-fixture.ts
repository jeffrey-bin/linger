import type {
  MemoryCalendarState,
  MemoryCalendarStore,
} from "../../src/memory/scheduler.js";
import type {
  PendingSessionTrigger,
  SessionTriggerCursor,
  SessionTriggerStore,
} from "../../src/memory/session-triggers.js";

/** An in-memory calendar row; pass the same store to a "restarted" scheduler. */
export class MemoryCalendarFixture implements MemoryCalendarStore {
  saved: MemoryCalendarState | undefined;
  saves = 0;

  async save(state: MemoryCalendarState): Promise<void> {
    // The database stores a copy; later in-place edits must not leak into it.
    this.saved = JSON.parse(JSON.stringify(state)) as MemoryCalendarState;
    this.saves += 1;
  }
}

/** In-memory Session trigger rows that survive a "restarted" monitor. */
export class SessionTriggerFixture implements SessionTriggerStore {
  cursor: SessionTriggerCursor | undefined;
  readonly pending = new Map<string, PendingSessionTrigger>();

  async loadCursor() {
    return this.cursor && { ...this.cursor };
  }
  async saveCursor(cursor: SessionTriggerCursor) {
    this.cursor = { ...cursor };
  }
  async loadPending() {
    return [...this.pending.values()].map(
      (pending) => JSON.parse(JSON.stringify(pending)) as PendingSessionTrigger,
    );
  }
  async savePending(key: string, pending: PendingSessionTrigger) {
    this.pending.set(
      key,
      JSON.parse(JSON.stringify(pending)) as PendingSessionTrigger,
    );
  }
  async removePending(key: string) {
    this.pending.delete(key);
  }
}
