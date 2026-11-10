import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createTeamHubMcpContextResolver,
  createTeamHubMcpContextResolverClient,
} from "../../../src/agent/executor/teamhub-context-resolvers.js";
import { requestBodyText, requestUrlText } from "@linger/service-kit";

describe("TeamHub MCP Context resolver", () => {
  it("accepts a comment-native live-latest Document Context", async () => {
    const resolver = createTeamHubMcpContextResolver({
      async resolveContext() {
        return responseFor("agent-1", {
          kind: "document",
          document_id: "document_1",
        });
      },
    });

    const resolution = await resolver.resolve({
      ref: { kind: "document", agentId: "agent-1", documentId: "document_1" },
      signal: new AbortController().signal,
    });

    expect(resolution.documentCommentRuntime?.commentsMarkdown).toBe(
      "# Document comment thread",
    );
    expect(resolution.documentCommentRuntime?.currentDocument.documentId).toBe(
      "document_1",
    );
  });

  it.each([
    { name: "Document pins", overrides: { document_pins: [] } },
    { name: "Document inputs", overrides: { document_inputs: [] } },
    {
      name: "Document action authority",
      overrides: {
        document_action_authority: { authorization_mode: "agent_native" },
      },
    },
    {
      name: "an Invocation-bound Context",
      overrides: {
        context: {
          kind: "alter_ego",
          task_id: "task-2",
          invocation_id: "invocation-1",
        },
      },
    },
  ])("fails closed for retired $name", async ({ overrides }) => {
    const resolver = createTeamHubMcpContextResolver({
      async resolveContext() {
        return responseFor(
          "agent-1",
          { kind: "alter_ego", task_id: "task-2" },
          overrides,
        );
      },
    });
    await expect(
      resolver.resolve({
        ref: { kind: "alter_ego", agentId: "agent-1", taskId: "task-2" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_resolver_response" });
  });

  it("maps Context identity for an authorization-only resolve", async () => {
    const calls: unknown[] = [];
    const resolver = createTeamHubMcpContextResolver({
      async resolveContext(request) {
        calls.push(request);
        return responseFor(request.agentId, request.context);
      },
    });
    const signal = new AbortController().signal;

    const resolution = await resolver.resolve({
      ref: {
        kind: "alter_ego",
        agentId: "agent-1",
        taskId: "task-2",
      },
      signal,
    });

    expect(calls).toEqual([
      {
        agentId: "agent-1",
        context: { kind: "alter_ego", task_id: "task-2" },
        signal,
      },
    ]);
    expect(resolution).toEqual({});
  });

  it("uses Agent Service authority for runtime resolve", async () => {
    const requests: Array<{
      readonly authorization: string | null;
      readonly body: unknown;
      readonly url: string;
    }> = [];
    const resolver = createTeamHubMcpContextResolverClient({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "agent-service-secret",
      fetch: async (input, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(requestBodyText(init?.body)) as unknown,
          url: requestUrlText(input),
        });
        return Response.json(
          responseFor("agent-1", { kind: "meta", room_id: "room-1" }),
        );
      },
    });

    await resolver.resolve({
      ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
      signal: new AbortController().signal,
    });

    expect(requests).toEqual([
      {
        authorization: "Bearer agent-service-secret",
        body: { context: { kind: "meta", room_id: "room-1" } },
        url: "https://teamhub.example.test/internal/agents/agent-1/mcp-context/actions/resolve",
      },
    ]);
  });

  it("preserves TeamHub's terminal Context identity rejection", async () => {
    const resolver = createTeamHubMcpContextResolverClient({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "agent-service-secret",
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "context_identity_invalid",
              message: "Context identity is no longer valid",
              request_id: "request-1",
            },
          },
          { status: 403 },
        ),
    });

    await expect(
      resolver.resolve({
        ref: {
          kind: "alter_ego",
          agentId: "agent-1",
          taskId: "task-2",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "context_identity_invalid",
      upstream: { code: "context_identity_invalid", status: 403 },
    });
  });

  it.each([
    {
      responseStatus: 503,
      responseCode: "dependency_unavailable",
      expectedCode: "resolver_unavailable",
    },
    {
      responseStatus: 401,
      responseCode: "dependency_unavailable",
      expectedCode: "resolver_rejected",
    },
  ])(
    "classifies TeamHub HTTP $responseStatus as $expectedCode",
    async ({ responseStatus, responseCode, expectedCode }) => {
      const resolver = createTeamHubMcpContextResolverClient({
        baseUrl: "https://teamhub.example.test",
        serviceToken: "agent-service-secret",
        fetch: async () =>
          Response.json(
            {
              error: {
                code: responseCode,
                message: "upstream detail NEVER_EXPOSE",
                request_id: "request-2",
              },
            },
            { status: responseStatus },
          ),
      });

      await expect(
        resolver.resolve({
          ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        code: expectedCode,
        message: expect.not.stringContaining("NEVER_EXPOSE"),
      });
    },
  );

  it("rejects retired Agent Build Runtime authority on a meta Context", async () => {
    const resolver = createTeamHubMcpContextResolver({
      async resolveContext() {
        return responseFor(
          "agent-builder",
          { kind: "meta", room_id: "room-1" },
          {
            agent_build_runtime: {
              build_id: "agent_build_1",
              profile_revision: "agent_builder_v2",
            },
          },
        );
      },
    });

    await expect(
      resolver.resolve({
        ref: { kind: "meta", agentId: "agent-builder", roomId: "room-1" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_resolver_response" });
  });

  it("rejects Agent Build Runtime authority on alterEgo Context resolution", async () => {
    const resolver = createTeamHubMcpContextResolver({
      async resolveContext() {
        return responseFor(
          "agent-builder",
          { kind: "alter_ego", task_id: "task-1" },
          {
            agent_build_runtime: {
              build_id: "agent_build_1",
              profile_revision: "agent_builder_v2",
            },
          },
        );
      },
    });

    await expect(
      resolver.resolve({
        ref: {
          kind: "alter_ego",
          agentId: "agent-builder",
          taskId: "task-1",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_resolver_response" });
  });

  it.each([
    {
      name: "retired Context session",
      override: { context_session_id: "context-session-1" },
    },
    {
      name: "retired Context Generation",
      override: { context_generation_id: null },
    },
    {
      name: "Document projection on a meta Context",
      override: {
        document_comment_runtime: documentCommentRuntime("document_1"),
      },
    },
    {
      name: "retired external MCP servers",
      override: { servers: [] },
    },
    {
      name: "retired MCP binding version",
      override: { binding_version: 7 },
    },
    {
      name: "unknown response field",
      override: { unexpected_field: "value" },
    },
  ])("fails closed for $name", async ({ override }) => {
    const resolver = createTeamHubMcpContextResolver({
      async resolveContext() {
        return responseFor(
          "agent-1",
          { kind: "meta", room_id: "room-1" },
          override,
        );
      },
    });

    await expect(
      resolver.resolve({
        ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: "TeamHubMcpContextResolverError",
      code: "invalid_resolver_response",
    });
  });

  it("does not call TeamHub for an already-cancelled activation", async () => {
    const resolveContext = vi.fn();
    const resolver = createTeamHubMcpContextResolver({ resolveContext });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      resolver.resolve({
        ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it("rejects an invalid local Context identity before calling TeamHub", async () => {
    const resolveContext = vi.fn();
    const resolver = createTeamHubMcpContextResolver({ resolveContext });

    await expect(
      resolver.resolve({
        ref: {
          kind: "alter_ego",
          agentId: "agent-1",
          taskId: "task with spaces",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_resolver_response" });
    expect(resolveContext).not.toHaveBeenCalled();
  });
});

const responseFor = (
  agentId: string,
  context:
    | { readonly kind: "meta"; readonly room_id: string }
    | { readonly kind: "alter_ego"; readonly task_id: string }
    | { readonly kind: "document"; readonly document_id: string },
  overrides: Record<string, unknown> = {},
) => ({
  agent_id: agentId,
  context,
  ...(context.kind === "document"
    ? {
        document_comment_runtime: documentCommentRuntime(context.document_id),
      }
    : {}),
  ...overrides,
});

const documentCommentRuntime = (documentId: string) => {
  const content = Buffer.from("# Current Document\n", "utf8");
  return {
    comments_markdown: "# Document comment thread",
    current_document: {
      content: content.toString("base64"),
      document_id: documentId,
      filename: "Current Document.md",
      media_type: "text/markdown",
      sha256: createHash("sha256").update(content).digest("hex"),
      size_bytes: content.byteLength,
    },
  };
};
