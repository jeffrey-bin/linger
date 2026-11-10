import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  BookOpen01Icon,
  Cancel01Icon,
  PlusSignIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { useId, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import {
  SettingsGroup,
  SettingsGroupAction,
  SettingsRow,
  SettingsRowText,
} from "@/components/ui/settings-group";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { createTeamHubIdempotencyKey } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubSkillManifest,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import { tenantAgentsQueryKey } from "../room-queries";

const acceptedSkillUpload = ".zip,.md,text/markdown,application/zip";

export interface SkillManageHint {
  title: string;
  detail?: string;
}

export function AgentSkillUploadPanel({
  agentId,
  canManage,
  manageHint,
  expanded,
  onToggleExpanded,
  skills,
  tenantId,
  visibleLimit,
}: {
  agentId: string;
  canManage: boolean;
  manageHint: SkillManageHint;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  skills: TeamHubTenantAgent["skill_bindings"];
  tenantId: string;
  visibleLimit?: number;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ input: string; key: string } | undefined>(undefined);
  const [notice, setNotice] = useState<string>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const bindings = useQuery({
    queryKey: agentSkillBindingsQueryKey(tenantId, agentId),
    queryFn: () =>
      teamHubData(
        client.api.GET(
          "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings",
          { params: { path: { tenantId, agentId } } },
        ),
      ),
    enabled: canManage,
  });
  const manifests = useQuery({
    enabled: libraryOpen || skills.some((skill) => !skill.description),
    queryFn: async () => {
      const items: TeamHubSkillManifest[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await teamHubData(
          client.api.GET("/v0/tenants/{tenantId}/skill-manifests", {
            params: {
              path: { tenantId },
              query: cursor ? { cursor } : undefined,
            },
          }),
        );
        items.push(...page.items);
        if (!page.page.has_more) break;
        const next = page.page.next_cursor;
        if (!next || seen.has(next))
          throw new Error("Could not load all Skills. Please retry.");
        seen.add(next);
        cursor = next;
      } while (cursor);
      return { items };
    },
    queryKey: ["teamhub", "skill-manifests", tenantId],
    retry: false,
  });
  const operation = useMutation({
    mutationFn: async (action: () => Promise<void>) => action(),
    onMutate: () => setNotice(undefined),
    onSuccess: async () => {
      setNotice("Saved. Future runs will use the new configuration.");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: agentSkillBindingsQueryKey(tenantId, agentId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentsQueryKey(tenantId),
        }),
      ]);
    },
  });

  function idempotency(value: unknown) {
    const fingerprint = JSON.stringify(value);
    if (attempt.current?.input !== fingerprint)
      attempt.current = {
        input: fingerprint,
        key: createTeamHubIdempotencyKey(),
      };
    return attempt.current.key;
  }

  async function upload(file: File) {
    await client.uploadAgentSkillPackage(
      tenantId,
      agentId,
      file,
      file.name,
      idempotency(["upload", file.name, file.size, file.lastModified]),
    );
  }

  async function install(manifest: TeamHubSkillManifest) {
    const current =
      bindings.data ??
      (await teamHubData(
        client.api.GET(
          "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings",
          { params: { path: { tenantId, agentId } } },
        ),
      ));
    await teamHubData(
      client.api.PUT(
        "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings/{skillId}",
        {
          params: { path: { tenantId, agentId, skillId: manifest.skill_id } },
          body: {
            config: {},
            enabled: true,
            expected_binding_version: current.binding_version,
            manifest_version: manifest.manifest_version,
          },
        },
      ),
    );
  }

  async function remove(skillId: string) {
    const revision = bindings.data?.binding_version;
    if (revision == null) throw new Error("Reload Skill configuration first.");
    await teamHubDone(
      client.api.DELETE(
        "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings/{skillId}",
        {
          params: {
            path: { tenantId, agentId, skillId },
            query: { expected_binding_version: revision },
          },
        },
      ),
    );
  }

  const error = operation.error ?? bindings.error;
  return (
    <SettingsGroup
      action={
        <>
          <SettingsGroupAction
            disabled={!canManage || operation.isPending}
            onClick={() => setLibraryOpen(true)}
          >
            <Icon icon={PlusSignIcon} size={12} />
            Add
          </SettingsGroupAction>
          <UploadSkillButton
            disabled={!canManage || operation.isPending}
            hint={manageHint}
            onClick={() => input.current?.click()}
          />
        </>
      }
      footer={
        notice || error ? (
          <>
            {error ? (
              <p role="alert" className="text-app-danger">
                {skillUploadErrorMessage(error)}
              </p>
            ) : null}
            {notice ? <p role="status">{notice}</p> : null}
          </>
        ) : undefined
      }
      label="Skills"
      meta={<span aria-label={`${skills.length} Skills`}>{skills.length}</span>}
    >
      <input
        ref={input}
        accept={acceptedSkillUpload}
        aria-label="Upload Skill package"
        className="sr-only"
        disabled={!canManage}
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && canManage) operation.mutate(() => upload(file));
        }}
      />
      {libraryOpen ? (
        <SkillLibraryDialog
          installedIds={new Set(skills.map((skill) => skill.skill_id))}
          error={manifests.error ?? operation.error}
          onRetry={() => {
            operation.reset();
            void manifests.refetch();
          }}
          manifests={manifests.data?.items ?? []}
          pending={operation.isPending || manifests.isPending}
          onClose={() => setLibraryOpen(false)}
          onInstall={(manifest) =>
            operation.mutate(() => install(manifest), {
              onSuccess: () => setLibraryOpen(false),
            })
          }
        />
      ) : null}
      {skills.length ? (
        <ul>
          {skills.slice(0, visibleLimit).map((skill) => {
            const description =
              skill.description ??
              manifests.data?.items.find(
                (item) =>
                  item.skill_id === skill.skill_id &&
                  item.manifest_version === skill.manifest_version,
              )?.description;
            const summary = description ? skillSummary(description) : "";
            return (
              <li className="group" key={skill.skill_id}>
                <SettingsRow icon={<Icon icon={BookOpen01Icon} size={16} />}>
                  <SettingsRowText
                    description={
                      summary ? (
                        <span title={description}>{summary}</span>
                      ) : undefined
                    }
                    title={skill.name}
                  />
                  <span className="shrink-0 font-mono text-[12px] tabular-nums tracking-normal text-muted-foreground">
                    {skill.manifest_version}
                  </span>
                  {skill.is_default ? null : (
                    <button
                      type="button"
                      disabled={
                        !canManage ||
                        operation.isPending ||
                        bindings.data == null
                      }
                      aria-label={`Remove ${skill.name}`}
                      className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-45 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100"
                      onClick={() =>
                        operation.mutate(() => remove(skill.skill_id))
                      }
                    >
                      <Icon icon={Cancel01Icon} size={14} />
                    </button>
                  )}
                </SettingsRow>
              </li>
            );
          })}
        </ul>
      ) : (
        <SettingsRow icon={<Icon icon={BookOpen01Icon} size={16} />}>
          <SettingsRowText
            description="Add a Skill to give this Agent a repeatable way to handle a task."
            muted
            title="No Skills added"
          />
        </SettingsRow>
      )}
      {onToggleExpanded ? (
        <button
          aria-expanded={expanded || false}
          className="block w-full text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
          onClick={onToggleExpanded}
          type="button"
        >
          <SettingsRow icon={null}>
            <span className="flex-1 text-[14px] font-medium text-foreground">
              {expanded ? "Show fewer" : `Show all ${skills.length} Skills`}
            </span>
            <Icon
              className="text-muted-foreground"
              icon={expanded ? ArrowUp01Icon : ArrowDown01Icon}
              size={14}
            />
          </SettingsRow>
        </button>
      ) : null}
    </SettingsGroup>
  );
}

function SkillLibraryDialog({
  installedIds,
  error,
  onRetry,
  manifests,
  onClose,
  onInstall,
  pending,
}: {
  installedIds: ReadonlySet<string>;
  error: unknown;
  onRetry: () => void;
  manifests: TeamHubSkillManifest[];
  onClose: () => void;
  onInstall: (manifest: TeamHubSkillManifest) => void;
  pending: boolean;
}) {
  const [query, setQuery] = useState("");
  const available = catalogSkills(manifests, installedIds);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? available.filter((manifest) => {
        const summary = skillSummary(manifest.description);
        return (
          manifest.name.toLowerCase().includes(needle) ||
          summary.toLowerCase().includes(needle)
        );
      })
    : available;
  return (
    <ModalDialog onClose={onClose} size="lg" title="Add Skill">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-app-border px-4 py-3">
          <input
            aria-label="Search Skills"
            className="h-9 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-border-hover focus:border-foreground focus:ring-2 focus:ring-ring"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            value={query}
          />
        </div>
        <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
          {error ? (
            <div className="px-3 py-6 text-sm text-app-danger" role="alert">
              <p>{skillUploadErrorMessage(error)}</p>
              <button
                className="mt-2 underline"
                onClick={onRetry}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : pending && !manifests.length ? (
            <p className="flex items-center gap-2 px-3 py-6 text-sm text-app-muted">
              <Spinner size={15} />
              Loading Skills…
            </p>
          ) : shown.length ? (
            <ul>
              {shown.map((manifest) => {
                const summary = skillSummary(manifest.description);
                return (
                  <li key={`${manifest.skill_id}:${manifest.manifest_version}`}>
                    <button
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-sm px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-45"
                      disabled={pending}
                      onClick={() => onInstall(manifest)}
                      type="button"
                    >
                      <span className="truncate text-sm text-app-ink">
                        {manifest.name} · {manifest.manifest_version}
                      </span>
                      <Icon
                        className="col-start-2 row-span-2 row-start-1 self-center text-app-muted"
                        icon={PlusSignIcon}
                        size={14}
                      />
                      {summary ? (
                        <span className="col-start-1 truncate text-xs text-app-muted">
                          {summary}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-6 text-sm text-app-muted">
              {available.length
                ? "No Skills match that search."
                : "No more built-in Skills to add."}
            </p>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}

function catalogSkills(
  manifests: TeamHubSkillManifest[],
  installedIds: ReadonlySet<string>,
) {
  return manifests
    .filter(
      (manifest) =>
        manifest.availability === "active" &&
        !installedIds.has(manifest.skill_id),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.manifest_version.localeCompare(right.manifest_version, undefined, {
          numeric: true,
        }),
    );
}

function skillSummary(description: string) {
  const lead = description.split(/\n\s*(?:❌|✅|\*\*SKIP|\*\*USE)/)[0] ?? "";
  const plain = lead.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  const sentence = plain.match(/^.{1,160}?[.。](?=\s|$)/)?.[0] ?? plain;
  if (!sentence) return "";
  return sentence.length > 140
    ? `${sentence.slice(0, 137).trimEnd()}…`
    : sentence;
}

function UploadSkillButton({
  disabled,
  hint,
  onClick,
}: {
  disabled: boolean;
  hint: SkillManageHint;
  onClick: () => void;
}) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  function show() {
    setOpen(true);
  }
  function hide() {
    setOpen(false);
  }
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <SettingsGroupAction
        disabled={disabled}
        aria-describedby={open ? tooltipId : undefined}
        aria-label="Upload Skill"
        onBlur={hide}
        onClick={onClick}
        onFocus={show}
        onMouseEnter={show}
      >
        <Icon icon={Upload01Icon} size={12} />
        Upload
      </SettingsGroupAction>
      {open ? (
        <HintPopover detail={hint.detail} id={tooltipId} title={hint.title} />
      ) : null}
    </span>
  );
}

function HintPopover({
  detail,
  id,
  title,
}: {
  detail?: string;
  id: string;
  title: string;
}) {
  return (
    <span
      id={id}
      role="tooltip"
      className="pointer-events-none absolute right-0 top-full z-20 mt-1.5 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-md bg-popover px-3 py-2 text-left shadow-md"
    >
      <span className="block whitespace-nowrap text-sm font-medium leading-[18px] text-app-ink">
        {title}
      </span>
      {detail ? (
        <span className="mt-0.5 block whitespace-nowrap text-xs leading-[18px] text-app-muted">
          {detail}
        </span>
      ) : null}
    </span>
  );
}

function skillUploadErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The Skill operation failed. Please retry.";
}

function agentSkillBindingsQueryKey(tenantId: string, agentId: string) {
  return ["teamhub", "agent-skills", tenantId, agentId] as const;
}
