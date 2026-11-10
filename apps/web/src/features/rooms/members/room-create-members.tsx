import { useQuery } from "@tanstack/react-query";
import {
  Cancel01Icon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubActor } from "@/features/teamhub/teamhub-types";

import { eligibleRoomAgents } from "../agent-admission";
import {
  teamHubIdentityQueryOptions,
  tenantActorsQueryOptions,
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryOptions,
} from "../room-queries";
import { ActorAvatar } from "./actor-avatar";

export function RoomCreateMembers({
  disabled,
  onChange,
  selected,
  tenantId,
}: {
  disabled: boolean;
  onChange: (actors: TeamHubActor[]) => void;
  selected: TeamHubActor[];
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const identity = useQuery(teamHubIdentityQueryOptions(client));
  const owner = identity.data?.actors.find(
    (actor) => actor.tenant_id === tenantId,
  );
  const actors = useQuery({
    ...tenantActorsQueryOptions(client, tenantId),
    enabled: open,
    retry: false,
  });
  const agents = useQuery({
    ...tenantAgentsQueryOptions(client, tenantId),
    enabled: open,
    retry: false,
  });
  const availability = useQuery({
    ...tenantAgentAvailabilityQueryOptions(client, tenantId),
    enabled: open,
    retry: false,
  });
  const queries = [identity, actors, agents, availability];
  const loading = queries.some((query) => query.isPending);
  const failed = queries.some((query) => query.isError);
  const candidates = owner
    ? [
        ...(actors.data?.items ?? []).filter(
          (actor) => actor.kind === "human" && actor.id !== owner.id,
        ),
        ...eligibleRoomAgents({
          agents: agents.data?.items ?? [],
          availabilitySnapshots: availability.data?.items ?? [],
          roomMemberIds: new Set([owner.id]),
          sponsorActorId: owner.id,
        }),
      ]
    : [];
  const matches: Record<"human" | "agent", TeamHubActor[]> = {
    human: [],
    agent: [],
  };
  for (const actor of candidates) {
    if (
      actor.display_name
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase())
    ) {
      matches[actor.kind].push(actor);
    }
  }

  useLayoutEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    if (!popup) return;
    popup.showPopover?.();
    function place() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect || !popup) return;
      const height = Math.min(280, window.innerHeight - 16);
      popup.style.width = `${Math.min(280, window.innerWidth - 32)}px`;
      popup.style.maxHeight = `${height}px`;
      popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`;
      popup.style.top = `${Math.max(8, rect.bottom + popup.offsetHeight + 8 < window.innerHeight ? rect.bottom + 6 : rect.top - popup.offsetHeight - 6)}px`;
    }
    place();
    searchRef.current?.focus();
    const observer = new ResizeObserver(place);
    observer.observe(popup);
    let positionTimer: number | undefined;
    function schedulePlace() {
      if (positionTimer !== undefined) return;
      positionTimer = window.setTimeout(() => {
        positionTimer = undefined;
        place();
      }, 16);
    }
    window.addEventListener("resize", schedulePlace);
    window.addEventListener("scroll", schedulePlace, true);
    return () => {
      observer.disconnect();
      window.clearTimeout(positionTimer);
      window.removeEventListener("resize", schedulePlace);
      window.removeEventListener("scroll", schedulePlace, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !popupRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function toggle(actor: TeamHubActor) {
    onChange(
      selected.some((member) => member.id === actor.id)
        ? selected.filter((member) => member.id !== actor.id)
        : [...selected, actor],
    );
  }

  return (
    <section aria-label="Members">
      <h3 className="mb-2 px-2 text-xs font-medium leading-5 text-muted-foreground">
        Members
      </h3>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1 transition-[border-color,box-shadow] duration-150 hover:border-border-hover focus-within:border-foreground focus-within:ring-2 focus-within:ring-ring">
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="Choose existing members"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-app-focus disabled:opacity-50"
          disabled={disabled}
          onClick={() => {
            setSearch("");
            setOpen(!open);
          }}
          ref={triggerRef}
          type="button"
        >
          <Icon icon={PlusSignIcon} size={16} />
        </button>
        {owner ? (
          <span
            className="inline-flex max-w-full items-center gap-1 h-6 rounded-lg bg-muted px-1.5 text-xs text-foreground"
            title="Room owner"
          >
            <ActorAvatar
              actorId={owner.id}
              kind="human"
              name={owner.display_name}
              size="micro"
            />
            <span className="truncate">{owner.display_name}</span>
            <span className="sr-only"> (you, owner)</span>
          </span>
        ) : null}
        {selected.map((actor) => (
          <span
            className="inline-flex max-w-full items-center gap-1 h-6 rounded-lg border border-dashed border-border-hover px-1.5 text-xs text-muted-foreground"
            key={actor.id}
          >
            <ActorAvatar
              actorId={actor.id}
              kind={actor.kind}
              name={actor.display_name}
              size="micro"
            />
            <span className="truncate">{actor.display_name}</span>
            <button
              aria-label={`Remove ${actor.display_name}`}
              className="rounded-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-app-focus"
              disabled={disabled}
              onClick={() => toggle(actor)}
              type="button"
            >
              <Icon icon={Cancel01Icon} size={12} />
            </button>
          </span>
        ))}
      </div>
      {open ? (
        <dialog
          aria-label="Choose members"
          className="app-floating-enter fixed inset-auto z-[100] m-0 flex flex-col overflow-hidden rounded-md bg-popover p-1 text-foreground shadow-md"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const options = Array.from(
                popupRef.current?.querySelectorAll<HTMLButtonElement>(
                  "button[data-member-option]:not(:disabled)",
                ) ?? [],
              );
              const current = options.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              options[
                (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                  options.length
              ]?.focus();
            }
          }}
          popover="manual"
          ref={popupRef}
          open
        >
          <input
            aria-label="Search members"
            className="min-h-9 w-full shrink-0 rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder="Search members..."
            ref={searchRef}
            value={search}
          />
          <div className="workspace-scrollbar min-h-0 overflow-y-auto">
            {loading ? (
              <p className="p-2 text-xs text-muted-foreground" role="status">
                Loading members...
              </p>
            ) : null}
            {failed ? (
              <div className="p-2 text-xs text-app-danger" role="alert">
                Some members could not be loaded.{" "}
                <button
                  className="underline"
                  onClick={() => {
                    for (const query of queries) void query.refetch();
                  }}
                  type="button"
                >
                  Retry
                </button>
              </div>
            ) : null}
            {(["human", "agent"] as const).map((kind) => (
              <section
                aria-label={kind === "human" ? "Human" : "Agent"}
                key={kind}
              >
                <h4 className="px-2 pb-1 pt-2 text-xs text-muted-foreground">
                  {kind === "human" ? "Human" : "Agent"}
                </h4>
                {matches[kind].map((actor) => {
                  const checked = selected.some(
                    (member) => member.id === actor.id,
                  );
                  return (
                    <button
                      aria-pressed={checked}
                      className="flex min-h-[33px] w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-50"
                      data-member-option
                      disabled={
                        disabled || (!checked && selected.length >= 100)
                      }
                      key={actor.id}
                      onClick={() => toggle(actor)}
                      type="button"
                    >
                      <ActorAvatar
                        actorId={actor.id}
                        kind={kind}
                        name={actor.display_name}
                        size="micro"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {actor.display_name}
                      </span>
                      {checked ? <Icon icon={Tick02Icon} size={14} /> : null}
                    </button>
                  );
                })}
              </section>
            ))}
            {!loading &&
            !failed &&
            !matches.human.length &&
            !matches.agent.length ? (
              <p className="p-2 text-xs text-muted-foreground">
                No matching members.
              </p>
            ) : null}
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
