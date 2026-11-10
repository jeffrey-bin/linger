import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { AgentRunResendButton, AgentRunStopButton } from "./room-run-controls";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("stops only the selected Run and keeps uncertain cancellation distinct from success", async () => {
  vi.stubGlobal("crypto", {});
  const { client, server } = createTestTeamHubRuntime();
  const cancel = vi
    .fn<TestRouteHandler>()
    .mockImplementationOnce(() => {
      throw new Error("network failure");
    })
    .mockReturnValue({
      run_id: "run-a",
      status: "cancel_requested",
      agent_actor_id: "actor-a",
      message_ids: ["message-a"],
    });
  server.on("POST", "/v0/rooms/{roomId}/runs/{runId}/cancel", cancel);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const runs = [
    { runId: "run-a", agentId: "actor-a", name: "Local" },
    { runId: "run-b", agentId: "actor-b", name: "Reviewer" },
  ];
  const view = render(
    <QueryClientProvider client={queryClient}>
      {runs.map((run) => (
        <AgentRunStopButton
          key={run.runId}
          cancel={(requestId) =>
            teamHubData(
              client.api.POST("/v0/rooms/{roomId}/runs/{runId}/cancel", {
                params: { path: { roomId: "room-1", runId: run.runId } },
                body: { request_id: requestId },
              }),
            )
          }
          controlKey={run.agentId}
          name={run.name}
          scopeKey={["teamhub", "tenant-1", "room-1"]}
          runId={run.runId}
        />
      ))}
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Stop Local's task" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Stop not confirmed",
  );
  expect(cancel).toHaveBeenCalledTimes(1);
  const requestId = (cancel.mock.calls[0]![0].body as { request_id: string })
    .request_id;
  fireEvent.click(screen.getByRole("button", { name: "Stop Local's task" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Stop Local's task" }),
    ).toBeDisabled(),
  );
  expect(
    screen.getByRole("button", { name: "Stop Local's task" }),
  ).toHaveTextContent("Stopping");
  expect(cancel).toHaveBeenLastCalledWith(
    expect.objectContaining({
      body: { request_id: requestId },
      params: { roomId: "room-1", runId: "run-a" },
    }),
  );
  expect(
    screen.getByRole("button", { name: "Stop Reviewer's task" }),
  ).toBeEnabled();
  view.unmount();
  queryClient.clear();
});

it("resends once, waits while pending, surfaces a failure and hides after success", async () => {
  const { client, server } = createTestTeamHubRuntime();
  let release: (() => void) | undefined;
  const redeliver = vi
    .fn<TestRouteHandler>()
    .mockImplementationOnce(() => {
      throw new Error("network failure");
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              run_id: "run-a",
              status: "redelivered",
              redelivered_count: 1,
            });
        }),
    );
  server.on(
    "POST",
    "/v0/rooms/{roomId}/runs/{runId}/redeliver-unconfirmed-inputs",
    redeliver,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AgentRunResendButton
        controlKey="actor-a"
        name="Local"
        redeliver={() =>
          teamHubData(
            client.api.POST(
              "/v0/rooms/{roomId}/runs/{runId}/redeliver-unconfirmed-inputs",
              { params: { path: { roomId: "room-1", runId: "run-a" } } },
            ),
          )
        }
        runId="run-a"
        scopeKey={["teamhub", "tenant-1", "room-1"]}
      />
    </QueryClientProvider>,
  );
  const name = "Resend unconfirmed follow-up to Local";
  fireEvent.click(await screen.findByRole("button", { name }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Resend failed");
  expect(redeliver).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name })).toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name }));
  expect(redeliver).toHaveBeenCalledTimes(2);
  expect(redeliver).toHaveBeenLastCalledWith(
    expect.objectContaining({ params: { roomId: "room-1", runId: "run-a" } }),
  );
  release?.();
  expect(await screen.findByText("Resent")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  view.unmount();
  queryClient.clear();
});

it("says when there is nothing to resend and keeps the outcome across remounts", async () => {
  const queryClient = new QueryClient();
  const redeliver = vi.fn(() =>
    Promise.resolve({
      run_id: "run-a",
      status: "nothing_to_redeliver" as const,
      redelivered_count: 0,
    }),
  );
  const button = (runId: string) => (
    <QueryClientProvider client={queryClient}>
      <AgentRunResendButton
        controlKey="actor-a"
        key={runId}
        name="Local"
        redeliver={redeliver}
        runId={runId}
        scopeKey={["teamhub", "tenant-1", "room-1"]}
      />
    </QueryClientProvider>
  );
  const name = "Resend unconfirmed follow-up to Local";
  const view = render(button("run-a"));
  fireEvent.click(screen.getByRole("button", { name }));
  expect(await screen.findByText("Nothing to resend")).toBeInTheDocument();
  expect(screen.queryByText("Resent")).not.toBeInTheDocument();
  view.unmount();
  // The status line rotating away and back remounts the button.
  const again = render(button("run-a"));
  expect(screen.getByText("Nothing to resend")).toBeInTheDocument();
  again.rerender(button("run-b"));
  expect(screen.getByRole("button", { name })).toBeEnabled();
  expect(redeliver).toHaveBeenCalledTimes(1);
  again.unmount();
  queryClient.clear();
});
