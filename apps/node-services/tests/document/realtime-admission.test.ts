import { describe, expect, it, vi } from "vitest";

import {
  RealtimeAdmissionController,
  RealtimeAdmissionError,
} from "../../src/document/realtime-admission.js";

describe("RealtimeAdmissionController", () => {
  it("bounds global and session connections and releases capacity", () => {
    const admission = new RealtimeAdmissionController({
      maxConnections: 2,
      maxConnectionsPerSession: 1,
    });
    const first = admission.reserveConnection();
    first.promote("session_one");
    const second = admission.reserveConnection();
    expect(() => second.promote("session_one")).toThrow(RealtimeAdmissionError);
    second.release();
    const replacement = admission.reserveConnection();
    replacement.promote("session_two");
    expect(() => admission.reserveConnection()).toThrow(RealtimeAdmissionError);
    first.release();
    replacement.release();
    expect(() => admission.reserveConnection()).not.toThrow();
  });

  it("limits connections per session, not per account", () => {
    const admission = new RealtimeAdmissionController();
    expect(admission.limits).toMatchObject({
      maxConnections: 1_000,
      maxConnectionsPerSession: 4,
    });
    const connections = Array.from({ length: 21 }, (_, index) => {
      const connection = admission.reserveConnection();
      connection.promote(`document_session_${index}`);
      return connection;
    });
    for (const connection of connections) connection.release();
  });

  it("reclaims connection capacity when authentication never completes", () => {
    vi.useFakeTimers();
    try {
      const admission = new RealtimeAdmissionController({
        authenticationTimeoutMs: 10,
        maxConnections: 1,
      });
      admission.reserveConnection();
      expect(() => admission.reserveConnection()).toThrow(
        RealtimeAdmissionError,
      );
      vi.advanceTimersByTime(10);
      expect(() => admission.reserveConnection()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds resident Documents independently from connections", () => {
    const admission = new RealtimeAdmissionController({
      maxResidentDocuments: 1,
    });
    const first = admission.reserveResidentDocument("document_one");
    expect(() => admission.reserveResidentDocument("document_two")).toThrow(
      RealtimeAdmissionError,
    );
    first.release();
    expect(() =>
      admission.reserveResidentDocument("document_two"),
    ).not.toThrow();
  });

  it("serializes recoveries behind the configured concurrency budget", async () => {
    const admission = new RealtimeAdmissionController({
      maxConcurrentRecoveries: 1,
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const first = admission.runRecovery(async () => {
      started.push("first");
      await firstBlocked;
    });
    const second = admission.runRecovery(async () => {
      started.push("second");
    });
    await vi.waitFor(() => expect(started).toEqual(["first"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["first", "second"]);
  });
});
