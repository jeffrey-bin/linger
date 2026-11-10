/* eslint-disable jsx-a11y/no-autofocus -- The name input is mounted only after an explicit edit action. */
import { useQuery } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AgentConnectors } from "@/features/apps/agent-connectors";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActor,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";

import {
  teamHubIdentityQueryOptions,
  tenantAgentsQueryOptions,
} from "../room-queries";
import { ActorAvatar } from "./actor-avatar";
import { AgentSkillUploadPanel } from "./agent-skill-upload-panel";
import { AgentStatus } from "./agent-status";

const skillUploadHint = {
  title: "ZIP or SKILL.md",
  detail: "Same name upgrades this Skill.",
};

const RemindersPanel = lazy(() =>
  import("../task-sidebar/reminders-panel").then((module) => ({
    default: module.RemindersPanel,
  })),
);

const AGENT_INFO_TABS = [
  ["basic", "Details"],
  ["routines", "Routines"],
  ["connectors", "Connectors"],
] as const;

type AgentInfoTab = (typeof AGENT_INFO_TABS)[number][0];

export function AgentInfoContent({
  actor,
  availability,
  canEditIdentity = false,
  canEditName = false,
  nameBusy = false,
  nameError,
  onSaveName,
  details,
  detailsActions,
  dialogs,
  description,
  headerAction,
  onEditIdentity,
  registration,
  roomId,
  runtimeDetails,
  tenantId,
}: {
  actor: TeamHubActor;
  tenantId: string;
  availability?: TeamHubTenantAgentAvailabilitySnapshot["availability"];
  canEditIdentity?: boolean;
  canEditName?: boolean;
  nameBusy?: boolean;
  nameError?: string;
  onSaveName?: (name: string) => Promise<unknown>;
  details: ReactNode;
  /** Basic info actions placed after the Skills, such as removing the Agent. */
  detailsActions?: ReactNode;
  dialogs?: ReactNode;
  runtimeDetails?: ReactNode;
  description?: string;
  /** A compact action pinned to the identity header's top-right corner. */
  headerAction?: ReactNode;
  onEditIdentity?: () => void;
  registration?: TeamHubTenantAgent;
  /** Routines are listed per Room, so the Routines tab needs the open Room. */
  roomId?: string;
}) {
  const { client } = useTeamHubRuntime();
  const identityQuery = useQuery(teamHubIdentityQueryOptions(client));
  const { data: agents } = useQuery(tenantAgentsQueryOptions(client, tenantId));
  const liveRegistration =
    agents?.items.find((item) => item.actor.id === actor.id) ?? registration;
  const currentActorId = identityQuery.data?.actors.find(
    (candidate) => candidate.tenant_id === tenantId,
  )?.id;
  const isSponsor = liveRegistration?.created_by.id === currentActorId;
  const canManageSkills = Boolean(identityQuery.isSuccess && isSponsor);
  const skillManageHint = !identityQuery.isSuccess
    ? skillUploadHint
    : !isSponsor
      ? { title: "Only the Sponsor can change Skills" }
      : skillUploadHint;
  const [tab, setTab] = useState<AgentInfoTab>("basic");
  const [showAllSkills, setShowAllSkills] = useState(false);
  const skills = liveRegistration?.skill_bindings ?? [];
  const tabId = useId();
  return (
    <div className="agent-info-content flex h-full min-h-0 min-w-0 flex-col bg-sidebar/50">
      <AgentInfoIdentity
        actor={actor}
        availability={availability}
        action={headerAction}
        canEdit={canEditIdentity}
        canEditName={canEditName}
        nameBusy={nameBusy}
        nameError={nameError}
        onSaveName={onSaveName}
        description={
          liveRegistration?.agent_type === "anotherme" ? undefined : description
        }
        onEdit={onEditIdentity}
      />
      <div className="shrink-0 px-4 pb-4">
        <div
          className="mx-auto flex w-fit max-w-full gap-1.5"
          role="tablist"
          aria-label="Agent settings"
        >
          {AGENT_INFO_TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              onKeyDown={(event) => {
                const index = AGENT_INFO_TABS.findIndex(([key]) => key === id);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % AGENT_INFO_TABS.length
                    : event.key === "ArrowLeft"
                      ? (index + AGENT_INFO_TABS.length - 1) %
                        AGENT_INFO_TABS.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? AGENT_INFO_TABS.length - 1
                          : undefined;
                if (next === undefined) return;
                event.preventDefault();
                const key = AGENT_INFO_TABS[next]![0];
                setTab(key);
                document.getElementById(`${tabId}-tab-${key}`)?.focus();
              }}
              aria-controls={`${tabId}-${id}`}
              id={`${tabId}-tab-${id}`}
              onClick={() => setTab(id)}
              className={`h-7 w-[92px] min-w-0 shrink truncate rounded-full px-3 font-(family-name:--app-room-font) transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                tab === id
                  ? "bg-sidebar-muted text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-muted/50 hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        hidden={tab !== "basic"}
        className="agent-settings-column workspace-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-6 [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
        role="tabpanel"
        id={`${tabId}-basic`}
        aria-labelledby={`${tabId}-tab-basic`}
      >
        {details}
        <AgentSkillUploadPanel
          agentId={actor.id}
          canManage={canManageSkills}
          manageHint={skillManageHint}
          skills={skills}
          tenantId={tenantId}
          visibleLimit={showAllSkills ? undefined : 5}
          expanded={showAllSkills}
          onToggleExpanded={
            skills.length > 5
              ? () => setShowAllSkills((value) => !value)
              : undefined
          }
        />
        {detailsActions}
      </div>
      {tab === "routines" ? (
        <div
          className="agent-settings-column flex min-h-0 flex-1 flex-col"
          role="tabpanel"
          id={`${tabId}-routines`}
          aria-labelledby={`${tabId}-tab-routines`}
        >
          <AgentRoutines actor={actor} roomId={roomId} tenantId={tenantId} />
        </div>
      ) : null}
      {tab === "connectors" ? (
        <div
          className="agent-settings-column workspace-scrollbar min-h-0 flex-1 overflow-y-auto pb-6 [scrollbar-gutter:stable_both-edges]"
          role="tabpanel"
          id={`${tabId}-connectors`}
          aria-labelledby={`${tabId}-tab-connectors`}
        >
          {runtimeDetails ? <div hidden>{runtimeDetails}</div> : null}
          <AgentConnectors agentActorId={actor.id} tenantId={tenantId} />
        </div>
      ) : null}
      {dialogs}
    </div>
  );
}

function AgentRoutines({
  actor,
  roomId,
  tenantId,
}: {
  actor: TeamHubActor;
  roomId?: string;
  tenantId: string;
}) {
  if (!roomId) {
    return (
      <p
        className="px-6 py-8 text-center text-xs text-muted-foreground"
        role="status"
      >
        Open this Agent from a Room to see its routines there.
      </p>
    );
  }
  return (
    <Suspense fallback={null}>
      <RemindersPanel
        agentActorId={actor.id}
        mentionOptions={[actor]}
        roomId={roomId}
        tenantId={tenantId}
      />
    </Suspense>
  );
}

function AgentInfoIdentity({
  action,
  actor,
  availability,
  canEdit,
  canEditName,
  nameBusy,
  nameError,
  onSaveName,
  description,
  onEdit,
}: {
  action?: ReactNode;
  description?: string;
  actor: TeamHubActor;
  availability?: TeamHubTenantAgentAvailabilitySnapshot["availability"];
  canEdit: boolean;
  canEditName: boolean;
  nameBusy: boolean;
  nameError?: string;
  onSaveName?: (name: string) => Promise<unknown>;
  onEdit?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(actor.display_name);
  const [focusAfterError, setFocusAfterError] = useState(false);
  const saving = useRef(false);
  const editNameButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      editNameButton.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (editing && focusAfterError && !nameBusy) {
      nameInput.current?.focus();
      setFocusAfterError(false);
    }
  }, [editing, focusAfterError, nameBusy]);
  async function saveName() {
    if (saving.current) return;
    const name = draft.trim();
    if (!name || name === actor.display_name) {
      setDraft(actor.display_name);
      setEditing(false);
      return;
    }
    saving.current = true;
    try {
      await onSaveName?.(name);
      setEditing(false);
    } catch {
      // Restore keyboard focus after the input is enabled again.
      if (restoreFocus.current) setFocusAfterError(true);
      restoreFocus.current = false;
    } finally {
      saving.current = false;
    }
  }
  const avatar = (
    <ActorAvatar
      actorId={actor.id}
      kind="agent"
      name={actor.display_name}
      size="card"
    />
  );
  return (
    <div className="relative mx-auto flex w-full max-w-[780px] flex-col items-center px-5 pb-4 pt-5 text-center">
      {action ? <div className="absolute right-3 top-3">{action}</div> : null}
      {canEdit ? (
        <button
          aria-label="Edit avatar"
          className="rounded-[20%] outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-app-focus"
          onClick={onEdit}
          type="button"
        >
          {avatar}
        </button>
      ) : (
        avatar
      )}
      {editing ? (
        <input
          aria-label="Agent name"
          ref={nameInput}
          autoFocus
          className="mt-2.5 max-w-full rounded-md bg-card px-2 text-center text-[15px] font-semibold leading-5 text-foreground shadow-outline outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
          disabled={nameBusy}
          maxLength={120}
          onBlur={() => void saveName()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              restoreFocus.current = true;
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              restoreFocus.current = true;
              setDraft(actor.display_name);
              setEditing(false);
            }
          }}
          value={draft}
        />
      ) : canEditName ? (
        <h2 className="mt-2.5 max-w-full text-[15px] font-semibold leading-5 text-foreground">
          <button
            ref={editNameButton}
            aria-label={`Edit name ${actor.display_name}`}
            className="max-w-full break-words rounded-md px-2 py-0.5 hover:bg-sidebar-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus disabled:opacity-50"
            disabled={nameBusy}
            onClick={() => {
              setDraft(actor.display_name);
              setEditing(true);
            }}
            type="button"
          >
            {actor.display_name}
          </button>
        </h2>
      ) : (
        <h2 className="mt-2.5 break-words text-[15px] font-semibold leading-5 text-foreground">
          {actor.display_name}
        </h2>
      )}
      {editing && nameError ? (
        <p className="mt-1 text-xs text-app-danger" role="alert">
          {nameError}
        </p>
      ) : null}
      {description ? (
        <p className="mt-1 line-clamp-2 max-w-[22rem] text-xs leading-[18px] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {availability ? (
        <p className="mt-1 text-xs">
          <AgentStatus availability={availability} />
        </p>
      ) : null}
    </div>
  );
}
