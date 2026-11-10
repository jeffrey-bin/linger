import {
  Delete02Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  teamHubIdentityQueryKey,
  tenantActorsQueryKey,
} from "@/features/rooms/room-queries";
import {
  personalProfileGenerationsQueryOptions,
  personalInsightsQueryKey,
  personalInsightsQueryOptions,
} from "./personal-profile-queries";
import {
  accountProfileQueryKey,
  accountProfileQueryOptions,
} from "./account-profile-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubPersonalInsight } from "@/features/teamhub/teamhub-types";

import { AccountProfileHero } from "./account-profile-hero";

export function AccountProfileSettings({
  client,
  tenantId,
}: {
  client: TeamHubClient;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const accountQuery = useQuery(accountProfileQueryOptions(client, tenantId));
  const generationsQuery = useQuery(
    personalProfileGenerationsQueryOptions(client, tenantId),
  );
  const insightsQuery = useQuery(
    personalInsightsQueryOptions(client, tenantId),
  );
  const [bio, setBio] = useState("");
  const [organization, setOrganization] = useState("");
  const dirtyRef = useRef(false);
  const updateAccount = useMutation({
    mutationFn: () =>
      teamHubData(
        client.api.PATCH("/v0/tenants/{tenantId}/account-profile", {
          params: { path: { tenantId } },
          // The display name is edited on the profile card above.
          body: { bio, organization },
        }),
      ),
    onSuccess: async (account) => {
      dirtyRef.current = false;
      setBio(account.bio);
      setOrganization(account.organization);
      queryClient.setQueryData(accountProfileQueryKey(tenantId), account);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: teamHubIdentityQueryKey }),
        queryClient.invalidateQueries({
          queryKey: tenantActorsQueryKey(tenantId),
        }),
      ]);
    },
  });
  const deleteInsight = useMutation({
    mutationFn: (insightId: string) =>
      client.deletePersonalInsight(tenantId, insightId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: personalInsightsQueryKey(tenantId),
      });
    },
  });

  // Generations fill Insights and unedited Account fields; refresh them while
  // one runs and once it finishes.
  const generations = generationsQuery.data?.items ?? [];
  const latestGeneration = generations[0];
  const generating = generations.some((item) =>
    ["queued", "running"].includes(item.status),
  );
  const wasGenerating = useRef(false);

  useEffect(() => {
    if (accountQuery.data && !dirtyRef.current) {
      setBio(accountQuery.data.bio);
      setOrganization(accountQuery.data.organization);
    }
  }, [accountQuery.data]);

  useEffect(() => {
    if (generating) {
      wasGenerating.current = true;
      const timer = window.setInterval(() => {
        void queryClient.invalidateQueries({
          queryKey: accountProfileQueryKey(tenantId),
        });
        void queryClient.invalidateQueries({
          queryKey: personalInsightsQueryKey(tenantId),
        });
      }, 2_000);
      return () => window.clearInterval(timer);
    }
    if (!wasGenerating.current) return;
    wasGenerating.current = false;
    void queryClient.invalidateQueries({
      queryKey: accountProfileQueryKey(tenantId),
    });
    void queryClient.invalidateQueries({
      queryKey: personalInsightsQueryKey(tenantId),
    });
  }, [generating, queryClient, tenantId]);

  useEffect(() => {
    if (latestGeneration?.status !== "succeeded") return;
    void queryClient.invalidateQueries({
      queryKey: personalInsightsQueryKey(tenantId),
    });
  }, [latestGeneration?.id, latestGeneration?.status, queryClient, tenantId]);

  if (accountQuery.isPending) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading Account profile"
        className="rounded-2xl border border-border p-6"
        role="status"
      >
        <span className="sr-only">Loading Account profile...</span>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-5 h-40 w-full" />
      </div>
    );
  }

  if (accountQuery.error) {
    return (
      <p
        className="rounded-xl border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] p-4 text-sm text-app-danger"
        role="alert"
      >
        {accountQuery.error.message}
      </p>
    );
  }

  const hasChanges =
    bio !== accountQuery.data.bio ||
    organization !== accountQuery.data.organization;

  return (
    <>
      <AccountProfileHero
        account={accountQuery.data}
        client={client}
        tenantId={tenantId}
      />
      <AccountIdentityPanel
        bio={bio}
        hasChanges={hasChanges}
        organization={organization}
        saveError={updateAccount.error?.message}
        savePending={updateAccount.isPending}
        saveSuccess={updateAccount.isSuccess}
        onBioChange={(value) => {
          dirtyRef.current = true;
          updateAccount.reset();
          setBio(value);
        }}
        onOrganizationChange={(value) => {
          dirtyRef.current = true;
          updateAccount.reset();
          setOrganization(value);
        }}
        onSave={() => updateAccount.mutate()}
      />

      <PersonalInsightsPanel
        deletingId={
          deleteInsight.isPending ? deleteInsight.variables : undefined
        }
        error={insightsQuery.error?.message ?? deleteInsight.error?.message}
        items={insightsQuery.data?.items ?? []}
        pending={insightsQuery.isPending}
        onDelete={(insightId) => deleteInsight.mutate(insightId)}
      />
    </>
  );
}

function PersonalInsightsPanel({
  deletingId,
  error,
  items,
  onDelete,
  pending,
}: {
  deletingId?: string;
  error?: string;
  items: TeamHubPersonalInsight[];
  onDelete: (insightId: string) => void;
  pending: boolean;
}) {
  return (
    <section className="rounded-2xl border border-border bg-background p-6">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Insights</h2>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-app-danger" role="alert">
          {error}
        </p>
      ) : null}
      {pending && items.length === 0 ? (
        <div className="mt-4 flex min-h-16 items-center gap-2 text-sm text-muted-foreground">
          <Icon icon={Loading03Icon} className="animate-spin" size={16} />
          Loading insights...
        </div>
      ) : items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No insights yet.</p>
      ) : (
        <div className="mt-3 divide-y divide-border">
          {items.map((item) => (
            <div
              className="flex min-h-20 items-start justify-between gap-5 py-4"
              key={item.id}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">
                  {item.dimension}
                </p>
                <p className="mt-1 text-sm text-foreground">{item.statement}</p>
              </div>
              <Button
                aria-label={`Delete ${item.dimension} insight`}
                disabled={deletingId === item.id}
                onClick={() => onDelete(item.id)}
                size="compactIcon"
                title="Delete insight"
                tone="ghost"
              >
                {deletingId === item.id ? (
                  <Icon
                    icon={Loading03Icon}
                    className="animate-spin"
                    size={16}
                  />
                ) : (
                  <Icon icon={Delete02Icon} size={16} />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AccountIdentityPanel({
  bio,
  hasChanges,
  onBioChange,
  onOrganizationChange,
  onSave,
  organization,
  saveError,
  savePending,
  saveSuccess,
}: {
  bio: string;
  hasChanges: boolean;
  onBioChange: (value: string) => void;
  onOrganizationChange: (value: string) => void;
  onSave: () => void;
  organization: string;
  saveError?: string;
  savePending: boolean;
  saveSuccess: boolean;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hasChanges && !savePending) {
      onSave();
    }
  }

  return (
    <section className="min-w-0 rounded-2xl border border-border bg-background p-6">
      <form onSubmit={handleSubmit}>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-foreground">
            Bio
          </span>
          <textarea
            aria-label="Bio"
            className="ui-field-control min-h-[88px] w-full resize-y disabled:cursor-not-allowed disabled:bg-app-surface-soft disabled:text-muted-foreground"
            disabled={savePending}
            maxLength={500}
            onChange={(event) => onBioChange(event.target.value)}
            placeholder="A short description of how you work."
            value={bio}
          />
        </label>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium text-foreground">
            Organization
          </span>
          <input
            aria-label="Organization"
            className="ui-field-control w-full disabled:cursor-not-allowed disabled:bg-app-surface-soft disabled:text-muted-foreground"
            disabled={savePending}
            maxLength={120}
            onChange={(event) => onOrganizationChange(event.target.value)}
            placeholder="Your company or organization"
            value={organization}
          />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          Hand-edited fields stay yours. Later generations fill only the fields
          you have not changed.
        </p>

        {saveError ? (
          <p className="mt-4 text-sm text-app-danger" role="alert">
            {saveError}
          </p>
        ) : null}
        {saveSuccess ? (
          <p
            className="mt-4 flex items-center gap-2 text-sm text-app-success"
            role="status"
          >
            <Icon icon={Tick02Icon} size={16} />
            Account saved
          </p>
        ) : null}

        {hasChanges || savePending ? (
          <Button
            className="mt-5"
            disabled={savePending}
            type="submit"
            tone="primary"
          >
            {savePending ? "Saving..." : "Save"}
          </Button>
        ) : null}
      </form>
    </section>
  );
}
