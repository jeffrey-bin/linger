import { describe, expect, it } from "vitest";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import { useDocumentComputation } from "./computation-test-support.js";

const options = {
  computation: useDocumentComputation(),
  teamHubToken: "teamhub-to-runtime-test-token",
};

describe("Document Runtime process probes", () => {
  it("reports process liveness", async () => {
    const response =
      await createDocumentRuntimeApp(options).request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("reports readiness without a lease or fence recovery", async () => {
    const response = await createDocumentRuntimeApp(options).request("/readyz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("closes the connections TeamHub disconnects", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const app = createDocumentRuntimeApp({
      ...options,
      disconnect: (documentId, actorId) => calls.push([documentId, actorId]),
    });
    const request = (path: string, body: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.teamHubToken}`,
          "content-type": "application/json",
        },
        body,
      });

    expect(
      (await request("/internal/v1/documents/document_1/disconnect", "{}"))
        .status,
    ).toBe(204);
    expect(
      (
        await request(
          "/internal/v1/documents/document_1/disconnect",
          JSON.stringify({ actor_id: "actor_1" }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await request(
          "/internal/v1/documents/document_1/disconnect",
          JSON.stringify({ actor_id: "not valid" }),
        )
      ).status,
    ).toBe(400);
    expect(calls).toEqual([
      ["document_1", undefined],
      ["document_1", "actor_1"],
    ]);
  });

  it("does not expose the superseded staged mutation route", async () => {
    const response = await createDocumentRuntimeApp(options).request(
      "/internal/v1/document-staged-mutations/mutation_1/apply",
      {
        method: "POST",
        headers: { authorization: `Bearer ${options.teamHubToken}` },
      },
    );

    expect(response.status).toBe(404);
  });
});
