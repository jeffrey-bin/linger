import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { externalConnectionsQueryKey } from "@/features/apps/connected-apps-queries";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubExternalConnection } from "@/features/teamhub/teamhub-types";

export function DisconnectAccountDialog({
  client,
  connection,
  onClose,
}: {
  client: TeamHubClient;
  connection: TeamHubExternalConnection;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const disconnect = useMutation({
    mutationFn: () =>
      client.disconnectExternalConnection(connection.id, {
        expected_revision: connection.revision,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
      onClose();
    },
  });

  return (
    <ModalDialog
      description={
        <>
          {connection.identity_label ?? connection.provider}. Agent access and
          source cleanup stay on Apps.
        </>
      }
      onClose={onClose}
      size="sm"
      title="Disconnect account?"
      footer={
        <>
          <Button onClick={onClose} size="compact">
            Cancel
          </Button>
          <Button
            loading={disconnect.isPending}
            onClick={() => disconnect.mutate()}
            size="compact"
            tone="danger"
          >
            Disconnect
          </Button>
        </>
      }
    >
      {disconnect.error ? (
        <p className="px-5 py-4 text-sm text-app-danger" role="alert">
          {disconnect.error.message}
        </p>
      ) : null}
    </ModalDialog>
  );
}
