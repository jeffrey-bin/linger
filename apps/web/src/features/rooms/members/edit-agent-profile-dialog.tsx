import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { type FormEvent, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubActor } from "@/features/teamhub/teamhub-types";

import { tenantAgentsQueryKey } from "../room-queries";
import { useAgentAvatarRecord } from "./actor-avatar-image";
import {
  agentAvatarAppearance,
  resolveAgentAvatarKey,
  storeAgentAvatarKey,
  type AgentAvatarKey,
} from "./agent-avatar";
import { AgentAvatarEditor } from "./agent-avatar-picker";
import { agentNameControlSize } from "./agent-name-control";

export function EditAgentProfileDialog({
  actor,
  canEdit,
  canEditName = canEdit,
  error,
  isPending,
  onClose,
  onSave,
}: {
  actor: TeamHubActor;
  /** May change the avatar, and open the dialog at all. */
  canEdit: boolean;
  /** May rename the Agent, Another Me included; defaults to `canEdit`. */
  canEditName?: boolean;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onSave: (input: { name: string }) => void;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const formId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const record = useAgentAvatarRecord(actor.id);
  const [name, setName] = useState(actor.display_name);
  // Drafts stay unset until the Human changes something, so the dialog keeps
  // following TeamHub's record even if it loads after the dialog opened, and
  // an untouched avatar is never written back over it.
  const [draftKey, setDraftKey] = useState<AgentAvatarKey>();
  const [draftImage, setDraftImage] = useState<string>();
  const savedKey = resolveAgentAvatarKey({
    actorId: actor.id,
    name: actor.display_name,
    storedKey: record?.avatarKey,
  });
  const savedImage = record?.image ?? "";
  const avatarKey = draftKey ?? savedKey;
  const image = draftImage ?? savedImage;
  const saveAvatar = useMutation({
    mutationFn: () =>
      teamHubData(
        client.api.PUT("/v0/tenants/{tenantId}/agents/{agentId}/avatar", {
          params: { path: { tenantId: actor.tenant_id, agentId: actor.id } },
          body: {
            avatar_key: avatarKey,
            ...avatarImageChange(avatarKey, draftImage, savedImage),
          },
        }),
      ),
    onSuccess: async () => {
      storeAgentAvatarKey(actor.id, avatarKey);
      await queryClient.invalidateQueries({
        queryKey: tenantAgentsQueryKey(actor.tenant_id),
      });
    },
  });
  const avatarChanged = avatarKey !== savedKey || image !== savedImage;
  const nameChanged = name.trim() !== actor.display_name;
  const saving = isPending || saveAvatar.isPending;
  // The avatar has its own endpoint; the name goes through the profile update.
  // Both stay editable while the Agent works.
  const avatarDisabled = !canEdit || saving;
  const disabled = !canEditName || saving;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (avatarDisabled || !name.trim()) return;
    if (avatarChanged) {
      try {
        await saveAvatar.mutateAsync();
      } catch {
        return;
      }
    }
    if (canEditName && nameChanged) onSave({ name: name.trim() });
    else onClose();
  }

  return (
    <ModalDialog
      description={
        canEditName
          ? "Update your Agent's name and avatar."
          : "Update your Agent's avatar."
      }
      onClose={onClose}
      size="md"
      title={canEditName ? "Edit profile" : "Edit avatar"}
      footer={
        <>
          <Button onClick={onClose} type="button">
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit ? (
            <Button
              disabled={
                avatarDisabled ||
                !name.trim() ||
                (!avatarChanged && !nameChanged)
              }
              form={formId}
              loading={saving}
              tone="primary"
              type="submit"
            >
              Save
            </Button>
          ) : null}
        </>
      }
    >
      <form
        className="px-5 py-4"
        id={formId}
        onSubmit={(event) => void handleSubmit(event)}
      >
        <div className="flex flex-col items-center text-center">
          <AgentAvatarEditor
            compact
            disabled={avatarDisabled}
            image={image}
            onChange={setDraftKey}
            onImageChange={setDraftImage}
            value={avatarKey}
          />
          {canEditName ? (
            <div className="mt-5 flex h-8 max-w-full items-center justify-center gap-0.5 rounded-md border border-transparent px-0.5 transition-[background-color,border-color,box-shadow] duration-150 hover:bg-muted/70 focus-within:border-foreground focus-within:bg-card focus-within:ring-2 focus-within:ring-ring">
              <input
                aria-label="Agent name"
                className="agent-profile-name-control h-7 w-auto max-w-[280px] shrink-0 border-0 bg-transparent px-1 text-center outline-none placeholder:text-muted-foreground focus-visible:ring-0"
                disabled={disabled}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                placeholder="Agent name"
                ref={nameInputRef}
                size={agentNameControlSize(name)}
                value={name}
              />
              {canEditName ? (
                <button
                  aria-label="Edit agent name"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-app-focus disabled:opacity-45"
                  disabled={disabled}
                  onClick={() => {
                    nameInputRef.current?.focus();
                    nameInputRef.current?.select();
                  }}
                  title="Edit agent name"
                  type="button"
                >
                  <Icon icon={PencilEdit02Icon} size={16} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {error || saveAvatar.error ? (
          <p className="mt-4 text-sm text-app-danger" role="alert">
            {error ?? "The avatar could not be saved. Try again."}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}

/**
 * TeamHub stores the picture as a data URL but hands it back by URL, so only a
 * new upload is sent; switching to a character removes a stored picture, and
 * anything else leaves the picture as it is.
 */
function avatarImageChange(
  avatarKey: AgentAvatarKey,
  draftImage: string | undefined,
  savedImage: string,
): { avatar_image?: string } {
  if (agentAvatarAppearance(avatarKey).kind === "image") {
    return draftImage === undefined ? {} : { avatar_image: draftImage };
  }
  return savedImage || draftImage ? { avatar_image: "" } : {};
}
