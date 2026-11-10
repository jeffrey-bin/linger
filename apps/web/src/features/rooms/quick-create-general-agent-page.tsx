import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalRuntimeType,
} from "@/features/teamhub/teamhub-types";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import {
  GENERAL_AGENT_DEFAULT_NAME,
  GENERAL_AGENT_INSTRUCTIONS,
} from "./general-agent-defaults";
import {
  teamHubIdentityQueryOptions,
  tenantActorsQueryKey,
  tenantAgentAvailabilityQueryKey,
  tenantAgentsQueryKey,
  tenantAgentsQueryOptions,
  tenantRoomsQueryKey,
} from "./room-queries";

import { AgentCreationProgress } from "./agent-creation-progress";
import { createTenantAgent } from "./members/create-tenant-agent";

const QUICK_CREATE_ACTOR_PREFIX = "linger.agent.quick-create:";

export interface LocalAgentTarget {
  model: string;
  reasoningEffort?: TeamHubAgentReasoningEffort;
  computerId: string;
  workspaceGrantId: string;
  runtimeType: TeamHubLocalRuntimeType;
}

interface QuickCreateGeneralAgentProps {
  tenantId: string;
  localTarget: LocalAgentTarget;
  onCreated?: () => void;
}

interface AcceptedAgent {
  actorId: string;
}

export function QuickCreateGeneralAgent(props: QuickCreateGeneralAgentProps) {
  const { client } = useTeamHubRuntime();
  const identity = useQuery({
    ...teamHubIdentityQueryOptions(client),
    retry: false,
  });
  const keyScope = quickCreateScope(props.tenantId, props.localTarget);
  if (identity.isError) {
    return (
      <main className="flex flex-col items-center px-4 py-3 text-center">
        <p className="text-sm text-app-muted" role="alert">
          Your account could not be confirmed. Try again.
        </p>
        <Button
          className="mt-5"
          disabled={identity.isFetching}
          onClick={() => void identity.refetch()}
          tone="primary"
        >
          Retry
        </Button>
      </main>
    );
  }
  if (!identity.data) return <AgentCreationProgress stage="preparing" />;
  return (
    <QuickCreateGeneralAgentFlow
      key={JSON.stringify([identity.data.account.id, keyScope])}
      keyScope={keyScope}
      accountId={identity.data.account.id}
      {...props}
    />
  );
}

function QuickCreateGeneralAgentFlow({
  tenantId,
  localTarget,
  onCreated,
  keyScope,
  accountId,
}: QuickCreateGeneralAgentProps & { keyScope: string; accountId: string }) {
  const { client } = useTeamHubRuntime();
  const startedTenant = useRef<string | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const [accepted, setAccepted] = useState(() =>
    readQuickCreateActor(keyScope, accountId),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const create = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    try {
      const actor = await createTenantAgent(client, {
        model: localTarget.model,
        reasoningEffort: localTarget.reasoningEffort,
        placement: {
          type: "local",
          computerId: localTarget.computerId,
          workspaceGrantId: localTarget.workspaceGrantId,
          runtimeType: localTarget.runtimeType,
        },
        agentType: "general",
        instructions: GENERAL_AGENT_INSTRUCTIONS,
        name: GENERAL_AGENT_DEFAULT_NAME,
        skillBindings: [],
        tenantId,
        visibilityScope: "sponsor",
      });
      // A repeated create makes another Agent, so the accepted one is kept
      // across status and Room retries and page reloads.
      const acceptedAgent = { actorId: actor.id };
      rememberQuickCreateActor(keyScope, accountId, acceptedAgent);
      setAccepted(acceptedAgent);
    } catch (cause) {
      if (!mounted.current) return;
      const message =
        cause instanceof Error ? cause.message : "Agent creation failed.";
      setError(message);
    } finally {
      running.current = false;
    }
  }, [client, tenantId, localTarget, keyScope, accountId]);

  useEffect(() => {
    if (accepted || startedTenant.current === tenantId) return;
    startedTenant.current = tenantId;
    void create();
  }, [accepted, create, tenantId]);

  if (accepted) {
    return (
      <AcceptedAgentChat
        actorId={accepted.actorId}
        accountId={accountId}
        tenantId={tenantId}
        keyScope={keyScope}
        onCreated={onCreated}
      />
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col items-center justify-center bg-app-surface px-4 py-3 text-center text-app-ink">
      {error ? (
        <>
          <h1 className="text-base font-semibold">
            Agent could not be created
          </h1>
          <p className="mt-2 max-w-sm text-sm text-app-muted" role="alert">
            {error}
          </p>
          <Button className="mt-5" onClick={() => void create()} tone="primary">
            Retry
          </Button>
        </>
      ) : (
        <AgentCreationProgress stage="creating" />
      )}
    </main>
  );
}

function AcceptedAgentChat({
  actorId,
  accountId,
  tenantId,
  keyScope,
  onCreated,
}: {
  actorId: string;
  accountId: string;
  tenantId: string;
  keyScope: string;
  onCreated?: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openingStarted = useRef(false);
  const registration = useQuery({
    ...tenantAgentsQueryOptions(client, tenantId),
    // A newly accepted Actor may be absent from an otherwise fresh directory.
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
  const agent = registration.data?.items.find(
    (item) => item.actor.id === actorId,
  );
  const { mutate: openChat, ...chat } = useMutation({
    mutationFn: async () => {
      const { id: roomId } = await teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/direct-rooms", {
          params: { path: { tenantId } },
          body: { peer_actor_id: actorId },
        }),
      );
      await Promise.all(
        [
          tenantActorsQueryKey,
          tenantAgentsQueryKey,
          tenantRoomsQueryKey,
          tenantAgentAvailabilityQueryKey,
        ].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey: queryKey(tenantId) }),
        ),
      );
      return roomId;
    },
  });
  const open = useCallback(() => {
    openChat(undefined, {
      // Mutation observer callbacks stop after this UI unmounts. A late Room
      // response must not navigate away from the user's next page or tenant.
      onSuccess: (roomId) => {
        void (async () => {
          await navigate(`/t/${tenantId}/rooms/${roomId}/chat`, {
            replace: true,
            state: { focusComposer: true },
          });
          clearQuickCreateActor(keyScope, accountId);
          onCreated?.();
        })();
      },
    });
  }, [openChat, navigate, tenantId, keyScope, accountId, onCreated]);
  // Creation commits the Agent in TeamHub, so a listed Agent can open its
  // chat at once; it waits for its Computer only when it first runs.
  const agentListed = agent !== undefined;
  useEffect(() => {
    if (
      !agentListed ||
      !registration.isFetchedAfterMount ||
      registration.isFetching ||
      registration.isError ||
      openingStarted.current
    )
      return;
    openingStarted.current = true;
    open();
  }, [
    agentListed,
    registration.isFetchedAfterMount,
    registration.isFetching,
    registration.isError,
    open,
  ]);

  const statusError =
    registration.isSuccess && registration.isFetchedAfterMount && !agentListed
      ? "This Agent is no longer available."
      : null;
  const error = registration.error ?? chat.error;
  const errorMessage = error instanceof Error ? error.message : statusError;
  return (
    <main className="flex h-full min-h-0 flex-1 flex-col items-center justify-center bg-app-surface px-4 py-3 text-center text-app-ink">
      {errorMessage ? (
        <>
          <h1 className="text-base font-semibold">
            {chat.isError
              ? "Chat could not be opened"
              : "Agent setup needs attention"}
          </h1>
          <p className="mt-2 max-w-sm text-sm text-app-muted" role="alert">
            {errorMessage}
          </p>
          <Button
            className="mt-5"
            disabled={registration.isFetching || chat.isPending}
            onClick={() => {
              if (chat.isError && agentListed) open();
              else void registration.refetch();
            }}
            tone="primary"
          >
            Retry
          </Button>
        </>
      ) : (
        <AgentCreationProgress stage="opening" />
      )}
    </main>
  );
}

function quickCreateScope(tenantId: string, localTarget: LocalAgentTarget) {
  // A changed Local registration request must not reuse an earlier Actor.
  return `${tenantId}:local:${JSON.stringify([
    localTarget.computerId,
    localTarget.workspaceGrantId,
    localTarget.runtimeType,
    localTarget.model,
    localTarget.reasoningEffort ?? null,
  ])}`;
}

function clearQuickCreateActor(scope: string, accountId: string) {
  try {
    sessionStorage.removeItem(quickCreateActorKey(scope, accountId));
  } catch {
    // Storage may be unavailable; the next entry then creates a new Agent.
  }
}

function quickCreateActorKey(scope: string, accountId: string) {
  return `${QUICK_CREATE_ACTOR_PREFIX}${scope}:actor:${accountId}`;
}

function readQuickCreateActor(
  scope: string,
  accountId: string,
): AcceptedAgent | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(quickCreateActorKey(scope, accountId)) ?? "null",
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "accountId" in value &&
      value.accountId === accountId &&
      "actorId" in value &&
      typeof value.actorId === "string" &&
      value.actorId
    ) {
      return { actorId: value.actorId };
    }
  } catch {
    // Storage may be unavailable or contain a record from an interrupted write.
  }
  return null;
}

function rememberQuickCreateActor(
  scope: string,
  accountId: string,
  accepted: AcceptedAgent,
) {
  try {
    sessionStorage.setItem(
      quickCreateActorKey(scope, accountId),
      JSON.stringify({ ...accepted, accountId }),
    );
  } catch {
    // The mounted flow still retains the accepted Actor when storage is unavailable.
  }
}
