import type { ReactNode } from "react";

export interface AgentLiveActivity {
  id: string;
  label: string;
  detail?: string;
}

export function AgentInfoSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-xs font-medium leading-[18px] text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function AgentLiveActivities({
  activities,
}: {
  activities: readonly AgentLiveActivity[];
}) {
  if (!activities.length) return null;
  return (
    <AgentInfoSection title="Live activities">
      <ul className="space-y-2">
        {activities.map((activity) => (
          <li
            key={activity.id}
            className="flex min-h-7 items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs leading-4 text-app-muted"
          >
            <span className="min-w-0 flex-1 break-words">{activity.label}</span>
            {activity.detail ? (
              <span className="shrink-0 text-2xs text-app-subtle">
                {activity.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </AgentInfoSection>
  );
}
