import { dateTimeFormat } from "@/lib/date-format";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  AiBrain01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  Cancel01Icon,
  CpuIcon,
  Delete02Icon,
  LayoutTemplateIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import {
  lazy,
  Suspense,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { SettingsGroup } from "@/components/ui/settings-group";
import { Icon } from "@/components/ui/icon";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubActor,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";

import {
  teamHubIdentityQueryOptions,
  teamHubQueryRoot,
  tenantActorsQueryKey,
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryKey,
  tenantAgentsQueryOptions,
  tenantRoomsQueryKey,
} from "../room-queries";
import { ActorAvatar } from "./actor-avatar";
import { AgentInfoContent } from "./agent-info-content";
import { DeleteAgentDialog } from "./delete-agent-dialog";
import { canDeleteTenantAgent } from "./agent-permissions";
import { useAgentDeletion } from "./use-agent-deletion";
// Opened on demand; its avatar editor and palette stay off the initial graph.
const EditAgentProfileDialog = lazy(async () => ({
  default: (await import("./edit-agent-profile-dialog")).EditAgentProfileDialog,
}));
const PublishAgentTemplateDialog = lazy(async () => ({
  default: (await import("../agent-templates/publish-agent-template-dialog"))
    .PublishAgentTemplateDialog,
}));
import { AgentInstructions } from "./agent-instructions";
import { EditAgentInstructionsDialog } from "./edit-agent-instructions-dialog";
import type {
  AgentRuntimeField,
  AgentRuntimeUpdateInput,
} from "./edit-agent-runtime-dialog";
const EditAgentRuntimeDialog = lazy(async () => ({
  default: (await import("./edit-agent-runtime-dialog")).EditAgentRuntimeDialog,
}));

const profileDateFormatter = dateTimeFormat({
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** A Human's profile. Agents open their Agent Info panel tab instead. */
export function ActorProfilePanel({
  actor,
  onClose,
  onSelectActor,
  tenantId,
}: {
  actor: TeamHubActor;
  onClose: () => void;
  onSelectActor: (actorId: string) => void;
  tenantId: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => headingRef.current?.focus(), [actor.id]);

  return (
    <aside
      aria-label={`${actor.display_name} profile`}
      className="room-profile-panel flex h-full min-h-0 w-[336px] max-w-[min(21rem,calc(100%-min(22.5rem,45%)))] shrink flex-col border-l border-border bg-background max-sm:w-full max-sm:max-w-none max-sm:border-l-0"
    >
      <header className="shrink-0 px-5 pt-5">
        <div className="flex items-center gap-2.5 border-b border-app-border pb-3.5">
          <ActorAvatar
            actorId={actor.id}
            kind={actor.kind}
            name={actor.display_name}
            size="xs"
          />
          <div className="min-w-0 flex-1">
            <h2
              className="truncate text-base font-semibold text-app-body focus:outline-none"
              ref={headingRef}
              tabIndex={-1}
            >
              {actor.display_name}
            </h2>
            <p className="truncate text-xs text-app-subtle">
              {actor.handle ?? "No public handle"} · Member
            </p>
          </div>
          <Button
            aria-label="Close profile"
            onClick={onClose}
            size="compactIcon"
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} size={14} />
          </Button>
        </div>
      </header>
      <div className="workspace-scrollbar flex-1 overflow-y-auto">
        <HumanProfileContent
          actor={actor}
          onSelectActor={onSelectActor}
          tenantId={tenantId}
        />
      </div>
    </aside>
  );
}

function AgentProfileDialogGroup({
  actor,
  agentAvailability,
  client,
  agentRegistration,
  canEditAgent,
  canEditAvatar,
  deleteAgent,
  deleteOpen,
  profileOpen,
  runtimeOpen,
  setDeleteOpen,
  setProfileOpen,
  setRuntimeOpen,
  tenantId,
  updateAgent,
}: {
  actor: TeamHubActor;
  agentAvailability?: { active_task_count: number };
  client: TeamHubClient;
  agentRegistration?: TeamHubTenantAgent;
  canEditAgent: boolean;
  canEditAvatar: boolean;
  deleteAgent: {
    error: { message: string } | null;
    isPending: boolean;
    mutate: () => void;
  };
  deleteOpen: boolean;
  profileOpen: false | "profile" | "instructions";
  runtimeOpen: false | AgentRuntimeField;
  setDeleteOpen: (open: boolean) => void;
  setProfileOpen: (open: false | "profile" | "instructions") => void;
  setRuntimeOpen: (open: false | AgentRuntimeField) => void;
  tenantId: string;
  updateAgent: {
    error: { message: string } | null;
    isPending: boolean;
    mutate: (
      input:
        | { name: string }
        | { instructions: string }
        | AgentRuntimeUpdateInput,
    ) => void;
    reset: () => void;
  };
}) {
  return (
    <AgentProfileDialogs
      actor={actor}
      client={client}
      agentName={actor.display_name}
      busy={(agentAvailability?.active_task_count ?? 0) > 0}
      canEditAvatar={canEditAvatar}
      canEditName={false}
      canEditProfile={canEditAgent}
      deleteError={deleteAgent.error?.message}
      deleteOpen={deleteOpen}
      deletePending={deleteAgent.isPending}
      instructions={agentRegistration?.instructions ?? ""}
      onCloseDelete={() => setDeleteOpen(false)}
      onCloseProfile={() => {
        setProfileOpen(false);
        updateAgent.reset();
      }}
      onCloseRuntime={() => {
        setRuntimeOpen(false);
        updateAgent.reset();
      }}
      onDelete={() => deleteAgent.mutate()}
      onSaveProfile={(input) => updateAgent.mutate(input)}
      onSaveRuntime={(input) => updateAgent.mutate(input)}
      profileError={updateAgent.error?.message}
      profileOpen={profileOpen}
      profilePending={updateAgent.isPending}
      registration={agentRegistration}
      runtimeError={updateAgent.error?.message}
      runtimeOpen={runtimeOpen}
      runtimePending={updateAgent.isPending}
      tenantId={tenantId}
    />
  );
}

interface AgentProfileContentProps {
  actor: TeamHubActor;
  onAfterDelete?: () => void;
  roomId?: string;
  tenantId: string;
}

function useAgentProfileData(client: TeamHubClient, tenantId: string) {
  const { data: identity } = useSuspenseQuery(
    teamHubIdentityQueryOptions(client),
  );
  const { data: tenantAgents } = useSuspenseQuery(
    tenantAgentsQueryOptions(client, tenantId),
  );
  const { data: tenantAgentAvailability } = useSuspenseQuery(
    tenantAgentAvailabilityQueryOptions(client, tenantId),
  );
  return { identity, tenantAgents, tenantAgentAvailability };
}

export function AgentProfileContent({
  actor,
  onAfterDelete,
  roomId,
  tenantId,
}: AgentProfileContentProps) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState<
    false | AgentRuntimeField
  >(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState<
    false | "profile" | "instructions"
  >(false);
  const { identity, tenantAgents, tenantAgentAvailability } =
    useAgentProfileData(client, tenantId);
  const currentActorId = identity.actors.find(
    (candidate) => candidate.tenant_id === tenantId,
  )?.id;
  const agentRegistration = tenantAgents.items.find(
    (registration) => registration.actor.id === actor.id,
  );
  const agentSnapshot = tenantAgentAvailability.items.find(
    (snapshot) => snapshot.actor_id === actor.id,
  );
  const agentAvailability = agentSnapshot?.availability;
  const agentDescription = agentRegistration?.description ?? "";
  const deleteAgent = useAgentDeletion(tenantId, actor.id, () => {
    setDeleteDialogOpen(false);
    onAfterDelete?.();
  });
  const submitUpdate = useAgentConfigurationUpdate(
    client,
    tenantId,
    actor.id,
    agentRegistration,
  );
  const updateAgent = useMutation({
    mutationFn: submitUpdate,
    onSuccess: async () => {
      setRuntimeDialogOpen(false);
      setProfileDialogOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: tenantActorsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantRoomsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: [...teamHubQueryRoot, tenantId, "room"],
        }),
      ]);
    },
  });
  const {
    canDeleteAgent,
    canEditAgent,
    canEditAvatar,
    canEditName,
    canEditRuntime,
  } = resolveAgentProfilePermissions(agentRegistration, currentActorId);
  const agentBusy = (agentAvailability?.active_task_count ?? 0) > 0;
  const editRuntime = (field: AgentRuntimeField = "runtime") => {
    updateAgent.reset();
    setRuntimeDialogOpen(field);
  };
  const editProfile = () => {
    updateAgent.reset();
    setProfileDialogOpen("profile");
  };
  const editInstructions = () => {
    updateAgent.reset();
    setProfileDialogOpen("instructions");
  };

  return (
    <AgentInfoContent
      canEditIdentity={canEditAvatar}
      canEditName={canEditName && !agentBusy}
      nameBusy={updateAgent.isPending}
      nameError={updateAgent.error?.message}
      onSaveName={(name) => updateAgent.mutateAsync({ name })}
      headerAction={
        canEditAgent && agentRegistration ? (
          <PublishTemplateButton registration={agentRegistration} />
        ) : undefined
      }
      key={actor.id}
      onEditIdentity={editProfile}
      roomId={roomId}
      tenantId={tenantId}
      actor={actor}
      availability={agentAvailability}
      description={agentDescription}
      runtimeDetails={
        <PanelAgentRuntimeDetails
          localRuntime={agentSnapshot?.local_runtime_status}
          placement={agentRegistration?.runtime.placement}
          modelLabel={agentRegistration?.runtime.model}
          reasoning={agentRegistration?.runtime.reasoning_effort}
          canEdit={canEditRuntime}
          busy={agentBusy}
          onEdit={editRuntime}
        />
      }
      details={
        <PanelAgentInfoDetails
          canEdit={canEditAgent}
          instructions={agentRegistration?.instructions ?? ""}
          onEditInstructions={editInstructions}
        />
      }
      detailsActions={
        <PanelAgentInfoActions
          canDelete={canDeleteAgent}
          onDelete={() => setDeleteDialogOpen(true)}
        />
      }
      dialogs={
        <AgentProfileDialogGroup
          actor={actor}
          agentAvailability={agentAvailability}
          client={client}
          agentRegistration={agentRegistration}
          canEditAgent={canEditAgent}
          canEditAvatar={canEditAvatar}
          deleteAgent={deleteAgent}
          deleteOpen={deleteDialogOpen}
          profileOpen={profileDialogOpen}
          runtimeOpen={runtimeDialogOpen}
          setDeleteOpen={setDeleteDialogOpen}
          setProfileOpen={setProfileDialogOpen}
          setRuntimeOpen={setRuntimeDialogOpen}
          tenantId={tenantId}
          updateAgent={updateAgent}
        />
      }
      registration={agentRegistration}
    />
  );
}

function HumanProfileContent({
  actor,
  onSelectActor,
  tenantId,
}: {
  actor: TeamHubActor;
  onSelectActor: (actorId: string) => void;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const { data: tenantAgents } = useSuspenseQuery(
    tenantAgentsQueryOptions(client, tenantId),
  );
  const createdAgents = tenantAgents.items.flatMap((registration) =>
    registration.created_by.id === actor.id ? [registration.actor] : [],
  );
  return (
    <div className="px-6 pb-10 pt-6">
      <section className="mb-3 rounded-2xl border border-border bg-background p-5">
        <ActorAvatar
          actorId={actor.id}
          kind={actor.kind}
          name={actor.display_name}
          size="lg"
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <h3 className="text-lg">{actor.display_name}</h3>
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
            Human
          </span>
        </div>
        <p className="mt-1 text-sm text-app-subtle">
          {actor.handle ?? "No public handle"}
        </p>
      </section>
      <ProfileSection>
        <p className="mb-4 text-sm text-app-subtle">No description</p>
        <ProfileField label="Role" value={actor.kind} />
        <ProfileField
          icon={<Icon icon={Calendar03Icon} size={14} />}
          label="Joined"
          value={formatProfileDate(actor.created_at)}
        />
      </ProfileSection>
      <HumanProfileSections
        createdAgents={createdAgents}
        onSelectActor={onSelectActor}
      />
    </div>
  );
}

function AgentProfileDialogs({
  actor,
  client,
  agentName,
  busy,
  canEditAvatar,
  canEditName,
  canEditProfile,
  deleteError,
  deleteOpen,
  deletePending,
  instructions,
  onCloseDelete,
  onCloseProfile,
  onCloseRuntime,
  onDelete,
  onSaveProfile,
  onSaveRuntime,
  profileError,
  profileOpen,
  profilePending,
  registration,
  runtimeError,
  runtimeOpen,
  runtimePending,
  tenantId,
}: {
  actor: TeamHubActor;
  client: TeamHubClient;
  agentName: string;
  /** Locks only the Runtime; the profile stays editable while the Agent works. */
  busy: boolean;
  canEditAvatar: boolean;
  canEditName: boolean;
  canEditProfile: boolean;
  deleteError?: string;
  deleteOpen: boolean;
  deletePending: boolean;
  instructions: string;
  onCloseDelete: () => void;
  onCloseProfile: () => void;
  onCloseRuntime: () => void;
  onDelete: () => void;
  onSaveProfile: (input: { name: string } | { instructions: string }) => void;
  onSaveRuntime: (input: AgentRuntimeUpdateInput) => void;
  profileError?: string;
  profileOpen: false | "profile" | "instructions";
  profilePending: boolean;
  registration?: TeamHubTenantAgent;
  runtimeError?: string;
  runtimeOpen: false | AgentRuntimeField;
  runtimePending: boolean;
  tenantId: string;
}) {
  return (
    <>
      {deleteOpen ? (
        <DeleteAgentDialog
          agentName={agentName}
          error={deleteError}
          isPending={deletePending}
          onClose={onCloseDelete}
          onDelete={onDelete}
        />
      ) : null}
      {profileOpen === "profile" ? (
        <Suspense fallback={null}>
          <EditAgentProfileDialog
            actor={actor}
            canEdit={canEditAvatar}
            canEditName={canEditName}
            error={profileError}
            isPending={profilePending}
            onClose={onCloseProfile}
            onSave={onSaveProfile}
          />
        </Suspense>
      ) : null}
      {profileOpen === "instructions" ? (
        <EditAgentInstructionsDialog
          instructions={instructions}
          canEdit={canEditProfile}
          error={profileError}
          isPending={profilePending}
          onClose={onCloseProfile}
          onSave={onSaveProfile}
        />
      ) : null}
      {runtimeOpen && registration ? (
        <Suspense fallback={null}>
          <EditAgentRuntimeDialog
            busy={busy}
            field={runtimeOpen || "runtime"}
            client={client}
            error={runtimeError}
            isPending={runtimePending}
            onClose={onCloseRuntime}
            onSave={onSaveRuntime}
            registration={registration}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function useAgentConfigurationUpdate(
  client: TeamHubClient,
  tenantId: string,
  actorId: string,
  registration: TeamHubTenantAgent | undefined,
) {
  return (
    input: Omit<
      TeamHubTenantAgentUpdateInput,
      "expected_configuration_revision"
    >,
  ) => {
    if (!registration) throw new Error("Agent profile is unavailable.");
    return teamHubData(
      client.api.PATCH("/v0/tenants/{tenantId}/agents/{agentId}", {
        params: { path: { tenantId, agentId: actorId } },
        body: {
          expected_configuration_revision: registration.configuration_revision,
          ...input,
        },
      }),
    );
  };
}

/**
 * Publishes the portable part of this Agent as a template others can create
 * their own Agent from; the dialog lists what is shared and what stays private.
 */
function PublishTemplateButton({
  registration,
}: {
  registration: TeamHubTenantAgent;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label="Publish as template"
        className="agent-publish-button"
        onClick={() => setOpen(true)}
        title="Publish as template"
        type="button"
      >
        <Icon icon={LayoutTemplateIcon} size={14} />
        Publish
      </button>
      {open ? (
        <Suspense fallback={null}>
          <PublishAgentTemplateDialog
            onClose={() => setOpen(false)}
            registration={registration}
            tenantId={registration.actor.tenant_id}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function resolveAgentProfilePermissions(
  registration: TeamHubTenantAgent | undefined,
  currentActorId: string | undefined,
) {
  const sponsorOwned = registration?.created_by.id === currentActorId;
  if (!sponsorOwned || !registration) {
    return {
      canDeleteAgent: false,
      canEditAgent: false,
      canEditAvatar: false,
      canEditName: false,
      canEditRuntime: false,
    };
  }
  return {
    canDeleteAgent: canDeleteTenantAgent(registration, currentActorId),
    canEditAgent: registration.agent_type !== "anotherme",
    // The avatar is appearance only, so Another Me's Human may change it too.
    canEditAvatar: true,
    // Another Me may be renamed; its description and instructions stay fixed.
    canEditName: true,
    canEditRuntime: true,
  };
}

function HumanProfileSections({
  createdAgents,
  onSelectActor,
}: {
  createdAgents: TeamHubActor[];
  onSelectActor?: (actorId: string) => void;
}) {
  return (
    <>
      <ProfileSection
        title={
          <>
            Created Agents{" "}
            <span className="text-xs font-normal text-muted-foreground">
              {createdAgents.length}
            </span>
          </>
        }
      >
        {createdAgents.length ? (
          <div className="space-y-2">
            {createdAgents.map((createdAgent) => (
              <button
                className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-300 hover:bg-muted/70"
                key={createdAgent.id}
                onClick={() => onSelectActor?.(createdAgent.id)}
                type="button"
              >
                <ActorAvatar
                  actorId={createdAgent.id}
                  kind="agent"
                  name={createdAgent.display_name}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {createdAgent.display_name}
                  </span>
                  <span className="block truncate text-xs text-app-subtle">
                    Agent
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-app-subtle">No created Agents.</p>
        )}
      </ProfileSection>
    </>
  );
}

function PanelAgentRuntimeDetails({
  localRuntime,
  placement,
  modelLabel,
  reasoning,
  canEdit,
  busy,
  onEdit,
}: {
  localRuntime?: TeamHubTenantAgentAvailabilitySnapshot["local_runtime_status"];
  placement?: TeamHubTenantAgent["runtime"]["placement"];
  modelLabel?: string;
  reasoning?: string;
  canEdit: boolean;
  busy: boolean;
  onEdit: (field?: AgentRuntimeField) => void;
}) {
  const type = placement?.runtime_type ?? "codex";
  const name = { codex: "Codex", claude: "Claude Code", pi: "Pi" }[type];
  const computer =
    localRuntime?.display_name || placement?.computer_id || "Local Computer";
  const status = localRuntime?.computer_status ?? "unknown";
  return (
    <section className="mx-4 mt-4 space-y-3" aria-label="Runtime configuration">
      <div className="overflow-hidden rounded-xl border border-app-border">
        <InfoRow
          icon={<Icon icon={ServerStack01Icon} size={16} />}
          label="Runs on"
          value={`Local · ${computer}${status === "online" ? " · Online" : status === "offline" ? " · Offline" : ""}`}
          chevron={canEdit}
          onClick={canEdit ? () => onEdit("computer") : undefined}
        />
        <InfoRow
          icon={<Icon icon={CpuIcon} size={16} />}
          label="Runtime"
          value={name}
          chevron={canEdit}
          onClick={canEdit ? () => onEdit("runtime") : undefined}
        />
        {/* The model dialog also sets its reasoning effort, so one row
            names both. */}
        <InfoRow
          icon={<Icon icon={AiBrain01Icon} size={16} />}
          label="Model"
          value={
            modelLabel && reasoning
              ? `${modelLabel} · ${reasoning}`
              : modelLabel || reasoning
          }
          chevron={canEdit}
          onClick={canEdit ? () => onEdit("model") : undefined}
        />
      </div>
      {localRuntime ? (
        <details className="px-1 text-xs text-app-muted">
          <summary className="cursor-pointer">Runtime details</summary>
          <dl className="mt-2 space-y-1">
            <div>
              <dt className="inline">Status: </dt>
              <dd className="inline">{localRuntime.status}</dd>
            </div>
            {localRuntime.version ? (
              <div>
                <dt className="inline">Version: </dt>
                <dd className="inline">{localRuntime.version}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
      {busy ? (
        <p className="px-1 text-xs text-app-muted">
          Runtime settings can't change while this Agent is working.
        </p>
      ) : null}
    </section>
  );
}

function PanelAgentInfoDetails({
  canEdit,
  instructions,
  onEditInstructions,
}: {
  canEdit: boolean;
  instructions: string;
  onEditInstructions: () => void;
}) {
  return (
    <AgentInstructions
      instructions={instructions}
      onEdit={canEdit ? onEditInstructions : undefined}
    />
  );
}

function PanelAgentInfoActions({
  canDelete,
  onDelete,
}: {
  canDelete: boolean;
  onDelete: () => void;
}) {
  if (!canDelete) return null;
  return (
    <SettingsGroup ariaLabel="Agent actions">
      <button
        className="flex min-h-11 w-full items-center justify-center gap-2 px-3.5 text-[14px] font-medium text-destructive transition-colors duration-150 hover:bg-destructive/5 focus-visible:bg-destructive/5 focus-visible:outline-none"
        onClick={onDelete}
        type="button"
      >
        <Icon icon={Delete02Icon} size={16} />
        Remove Agent
      </button>
    </SettingsGroup>
  );
}

function InfoRow({
  chevron = false,
  icon,
  label,
  onClick,
  value,
}: {
  chevron?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  value?: string;
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 shrink-0 text-app-muted">{icon}</span>
        <span className="min-w-0">
          <span className="block text-xs font-medium text-app-ink">
            {label}
          </span>
          {value ? (
            <span className="mt-0.5 line-clamp-2 break-words text-xs text-app-muted">
              {value}
            </span>
          ) : null}
        </span>
      </span>
      {chevron ? (
        <Icon
          className="shrink-0 text-app-muted"
          icon={ArrowRight01Icon}
          size={16}
        />
      ) : null}
    </>
  );
  const className =
    "flex min-h-12 w-full items-center justify-between gap-3 border-b border-app-border px-4 py-3 text-left last:border-b-0";
  if (onClick) {
    return (
      <button
        aria-label={label}
        className={`${className} transition-colors duration-150 hover:bg-accent/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-app-focus`}
        onClick={onClick}
        type="button"
      >
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

function ProfileSection({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title?: ReactNode;
}) {
  return (
    <section className="mb-3 rounded-2xl border border-border bg-background p-4 last:mb-0">
      {title ? (
        <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-app-body">{title}</h4>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function ProfileField({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-h-10 items-start justify-between gap-4 py-1.5 text-sm">
      <span className="flex items-center gap-1.5 text-app-subtle">
        {icon}
        {label}
      </span>
      <span className="min-w-0 max-w-[60%] break-words text-right font-medium text-app-body">
        {value}
      </span>
    </div>
  );
}

function formatProfileDate(value: string) {
  return profileDateFormatter.format(new Date(value));
}
