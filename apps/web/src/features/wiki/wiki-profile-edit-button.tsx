import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { personalProfileQueryOptions } from "@/features/settings/personal-profile-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

/** The Wiki header's page-level Edit action for the Profile tab; the Profile
 * page shows its form while the URL carries `edit=1`. */
export function WikiProfileEditButton({ tenantId }: { tenantId: string }) {
  const { client } = useTeamHubRuntime();
  const profile = useQuery(personalProfileQueryOptions(client, tenantId));
  const [searchParams, setSearchParams] = useSearchParams();
  if (!profile.data?.current || searchParams.get("edit") === "1") return null;
  const building = Boolean(profile.data.building_since);
  return (
    <Button
      className="ml-auto"
      disabled={building}
      onClick={() => setSearchParams({ edit: "1" })}
      size="compact"
      title={
        building ? "Another Me is updating your profile" : "Edit your profile"
      }
      tone="ghost"
    >
      <Icon icon={PencilEdit02Icon} size={14} className="shrink-0" />
      Edit profile
    </Button>
  );
}
