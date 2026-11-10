import {
  Camera01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import background from "./profile-background.png";
import { Button } from "@/components/ui/button";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { accountProfileQueryKey } from "./account-profile-queries";
import {
  teamHubIdentityQueryKey,
  teamHubIdentityQueryOptions,
  tenantActorsQueryKey,
} from "@/features/rooms/room-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubAccountProfile,
  TeamHubAccountProfileUpdate,
} from "@/features/teamhub/teamhub-types";
import { prepareProfileImage } from "./profile-image";

export function AccountProfileHero({
  account,
  client,
  tenantId,
}: {
  account: TeamHubAccountProfile;
  client: TeamHubClient;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  // The Actor ID seeds the initials tint, so this avatar matches the rail's.
  const actorId = useQuery(
    teamHubIdentityQueryOptions(client),
  ).data?.actors.find((actor) => actor.tenant_id === tenantId)?.id;
  const avatarInput = useRef<HTMLInputElement>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [processing, setProcessing] = useState(false);
  const [imageError, setImageError] = useState("");
  const update = useMutation({
    mutationFn: (input: TeamHubAccountProfileUpdate) =>
      teamHubData(
        client.api.PATCH("/v0/tenants/{tenantId}/account-profile", {
          params: { path: { tenantId } },
          body: input,
        }),
      ),
    onSuccess: async (next) => {
      queryClient.setQueryData(accountProfileQueryKey(tenantId), next);
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: teamHubIdentityQueryKey }),
        queryClient.invalidateQueries({
          queryKey: tenantActorsQueryKey(tenantId),
        }),
      ]);
    },
  });
  const busy = processing || update.isPending;
  async function upload(file: File | undefined, avatar: boolean) {
    if (!file) return;
    setImageError("");
    update.reset();
    setProcessing(true);
    try {
      const image = await prepareProfileImage(file, avatar);
      await update.mutateAsync(
        avatar ? { avatar_image: image } : { background_image: image },
      );
    } catch (error) {
      setImageError(
        error instanceof Error
          ? error.message
          : "Could not upload image. Try again.",
      );
    } finally {
      setProcessing(false);
    }
  }
  return (
    <section aria-label="Profile appearance">
      <div className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-2xl border border-border bg-muted px-4 py-8">
        <img
          alt=""
          src={account.background_image || background}
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute right-3 top-3 z-10">
          <Button
            className="bg-card shadow-md"
            size="compact"
            disabled={busy}
            onClick={() => backgroundInput.current?.click()}
          >
            <Icon icon={Camera01Icon} size={14} />
            Change cover
          </Button>
        </div>
        <div className="relative flex w-48 flex-col items-center gap-5 rounded-2xl bg-card/90 px-3 pb-3 pt-7 text-foreground shadow-md backdrop-blur-md">
          <button
            type="button"
            aria-label="Upload profile photo"
            className="relative rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={busy}
            onClick={() => avatarInput.current?.click()}
          >
            {account.avatar_image ? (
              <img
                alt={`${account.name} avatar`}
                src={account.avatar_image}
                className="size-16 rounded-full object-cover"
              />
            ) : (
              <ActorAvatar
                actorId={actorId}
                kind="human"
                name={account.name}
                size="lg"
              />
            )}
            <span className="absolute -bottom-0.5 -right-1 flex size-5 items-center justify-center rounded-full border border-card bg-primary text-primary-foreground">
              <Icon icon={PlusSignIcon} size={14} />
            </span>
          </button>
          {editing ? (
            <form
              className="w-full"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim() && !busy) update.mutate({ name: name.trim() });
              }}
            >
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor
                autoFocus
                aria-label="Profile display name"
                className="ui-field-control w-full text-center"
                maxLength={120}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
              <div className="mt-2 flex justify-center gap-2">
                <Button
                  size="compact"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="compact"
                  disabled={busy || !name.trim()}
                  tone="primary"
                >
                  Save
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              aria-label="Edit display name"
              disabled={busy}
              onClick={() => {
                setName(account.name);
                setEditing(true);
                update.reset();
              }}
              className="flex min-h-8 w-full items-center justify-center gap-2 rounded-lg bg-foreground/5 px-2 text-sm font-medium transition-colors duration-150 hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{account.name}</span>
              <Icon icon={PencilEdit02Icon} size={14} className="shrink-0" />
            </button>
          )}
        </div>
      </div>
      <input
        ref={avatarInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="Profile photo file"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          void upload(event.target.files?.[0], true);
          event.target.value = "";
        }}
      />
      <input
        ref={backgroundInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="Profile cover file"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          void upload(event.target.files?.[0], false);
          event.target.value = "";
        }}
      />
      {busy ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Saving profile…
        </p>
      ) : null}
      {imageError || update.error ? (
        <p role="alert" className="mt-2 text-sm text-app-danger">
          {imageError || update.error?.message}
        </p>
      ) : null}
    </section>
  );
}
