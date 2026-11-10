import { Logout01Icon, Settings01Icon } from "@hugeicons/core-free-icons";

import { ActionMenu } from "@/components/ui/action-menu";
import { Icon } from "@/components/ui/icon";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import type { TeamHubCurrentIdentity } from "@/features/teamhub/teamhub-types";

export function AccountMenu({
  identity,
  tenantId,
  isPending,
  onLogout,
  onNavigate,
  onOpenSettings,
  settingsOpen = false,
}: {
  identity: TeamHubCurrentIdentity;
  tenantId: string;
  isPending: boolean;
  onLogout: () => void;
  onNavigate: () => void;
  onOpenSettings: () => void;
  settingsOpen?: boolean;
}) {
  const currentActor = identity.actors.find(
    (actor) => actor.tenant_id === tenantId,
  );
  const name = currentActor?.display_name || identity.account.email;
  const identifier = identity.account.email;
  const inSettings = settingsOpen;
  return (
    <ActionMenu
      label="Account menu"
      placement="top-start"
      buttonClassName={`flex size-11 items-center justify-center rounded-full outline-none transition-colors hover:bg-sidebar-muted aria-expanded:bg-sidebar-muted focus-visible:ring-2 focus-visible:ring-ring md:size-8 ${inSettings ? "bg-sidebar-muted" : ""}`}
      trigger={
        <ActorAvatar
          actorId={currentActor?.id}
          kind="human"
          name={name}
          size="xs"
        />
      }
      header={
        <>
          <p className="truncate text-sm font-semibold" title={name}>
            {name}
          </p>
          <p className="truncate text-xs text-app-muted" title={identifier}>
            {identifier}
          </p>
        </>
      }
      iconClassName="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      itemClassName="flex min-h-[33px] w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11"
      items={[
        {
          label: "Settings",
          icon: <Icon icon={Settings01Icon} size={14} />,
          onSelect: () => {
            onNavigate();
            onOpenSettings();
          },
        },
        {
          label: isPending ? "Logging out..." : "Log out",
          icon: <Icon icon={Logout01Icon} size={14} />,
          disabled: isPending,
          separatorBefore: true,
          onSelect: () => {
            onNavigate();
            onLogout();
          },
        },
      ]}
    />
  );
}
