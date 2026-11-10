import { HashtagIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, useState } from "react";
import { useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import { requireRoomRouteParam } from "./room-route-params";

// Opened on demand, so it stays off the initial JavaScript graph.
const RoomCreateDialog = lazy(async () => ({
  default: (await import("./room-create-dialog")).RoomCreateDialog,
}));

export function RoomEmptyPage() {
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <main className="flex flex-1 items-center justify-center bg-app-surface p-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon icon={HashtagIcon} size={20} />
        </span>
        <h1 className="mt-4 text-lg">Create the first Room</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Rooms keep Human and Agent members, Messages, and shared files in one
          collaboration context.
        </p>
        <Button
          className="mt-5"
          onClick={() => setCreateOpen(true)}
          tone="primary"
        >
          <Icon icon={PlusSignIcon} size={16} />
          Create Room
        </Button>
      </div>
      {createOpen ? (
        <Suspense fallback={null}>
          <RoomCreateDialog
            onClose={() => setCreateOpen(false)}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
    </main>
  );
}
