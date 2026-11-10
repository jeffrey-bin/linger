import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";

import { collectTeamHubCursorPages } from "@/features/teamhub/teamhub-cursor-pages";
import { tenantRoomsQueryOptions } from "../room-queries";

import { readStoredAgentAvatarKey } from "../members/agent-avatar";

import { agentTemplateFromAgent } from "./agent-template";
import {
  TemplateContents,
  useTemplateContentGroups,
} from "./agent-template-contents";
import { agentTemplatesQueryKey } from "./agent-template-queries";
import { useAgentConnectorKeys } from "./use-agent-connector-keys";

/**
 * Publishing shares the portable part of this Agent so anyone can create their
 * own from it. Runtime, model, and Local Computer stay with this Agent.
 */
export function PublishAgentTemplateDialog({
  onClose,
  registration,
  tenantId,
}: {
  onClose: () => void;
  registration: TeamHubTenantAgent;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const formId = useId();
  const routines = useQuery({
    queryKey: [
      "teamhub",
      tenantId,
      "agent-template-source-routines",
      registration.actor.id,
    ],
    queryFn: async () => {
      const rooms = await queryClient.fetchQuery({
        ...tenantRoomsQueryOptions(client, tenantId),
        staleTime: 0,
      });
      const room = rooms.items.find(
        (item) => item.direct_peer?.id === registration.actor.id,
      );
      if (!room) return [];
      // A template carries recurring Routines only; one-shot and app
      // listener Routines stay with the source Agent.
      return (
        await collectTeamHubCursorPages((page) =>
          teamHubData(
            client.api.GET("/v0/rooms/{roomId}/routines", {
              params: { path: { roomId: room.id }, query: page },
            }),
          ),
        )
      ).items.flatMap((routine) =>
        routine.cadence && routine.cadence.kind !== "once"
          ? [{ ...routine, cadence: routine.cadence }]
          : [],
      );
    },
    retry: false,
  });
  const [name, setName] = useState(registration.actor.display_name);
  const connectors = useAgentConnectorKeys({
    agentActorId: registration.actor.id,
    tenantId,
  });
  const template = agentTemplateFromAgent(
    registration,
    readStoredAgentAvatarKey(registration.actor.id),
    connectors.keys,
  );
  const groups = useTemplateContentGroups({
    connector_bindings: template.connector_bindings ?? [],
    skill_bindings: template.skill_bindings ?? [],
  });
  const publish = useMutation({
    mutationFn: () =>
      teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/agent-templates", {
          params: { path: { tenantId } },
          body: { ...template, name: name.trim() },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: agentTemplatesQueryKey(tenantId),
      });
      onClose();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      name.trim() &&
      !publish.isPending &&
      !connectors.isPending &&
      routines.isSuccess
    ) {
      publish.mutate();
    }
  }

  return (
    <ModalDialog
      description="Everyone in this deployment will be able to create Agents from it."
      onClose={onClose}
      size="md"
      title="Publish as template"
      footer={
        <>
          <Button onClick={onClose} type="button">
            Cancel
          </Button>
          <Button
            disabled={
              !name.trim() || connectors.isPending || !routines.isSuccess
            }
            form={formId}
            loading={publish.isPending}
            tone="primary"
            type="submit"
          >
            Publish
          </Button>
        </>
      }
    >
      <form className="px-5 py-4" id={formId} onSubmit={submit}>
        <fieldset className="space-y-4" disabled={publish.isPending}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">
              Template name
            </span>
            <input
              aria-label="Template name"
              className="ui-field-control w-full"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>
          <div>
            <p className="mb-2 text-sm font-medium">Shared with others</p>
            {connectors.isPending || routines.isPending ? (
              <p className="text-sm text-app-muted" role="status">
                Checking this Agent&apos;s Routines and Connectors...
              </p>
            ) : (
              <TemplateContents
                connectorNote="Only Connector names are shared. Your connected accounts and credentials stay private, and whoever uses this template authorizes their own."
                groups={groups}
                instructions={registration.instructions}
                routines={routines.data}
              />
            )}
          </div>
          <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm leading-5 text-app-muted">
            Runtime, model, and Local Computer stay private to this Agent. You
            can remove the template later.
          </p>
        </fieldset>
        {routines.error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            Routines could not be loaded.{" "}
            <Button onClick={() => void routines.refetch()} type="button">
              Retry
            </Button>
          </p>
        ) : null}
        {publish.error ? (
          <p className="mt-3 text-sm leading-5 text-app-danger" role="alert">
            {publish.error.message}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}
