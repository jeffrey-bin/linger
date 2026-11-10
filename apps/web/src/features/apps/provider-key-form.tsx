import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { externalAppsQueryOptions } from "./connected-apps-queries";

// A private deployment without COMPOSIO_API_KEY saves its key here. TeamHub
// checks the key before keeping it and never returns it.
export function ProviderKeyForm({ onSaved }: { onSaved?: () => void } = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const save = useMutation({
    mutationFn: () => client.saveExternalProviderKey(apiKey.trim()),
    onSuccess: async () => {
      setApiKey("");
      await queryClient.invalidateQueries({
        queryKey: externalAppsQueryOptions(client).queryKey,
      });
      onSaved?.();
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.trim()) save.mutate();
      }}
    >
      <Field
        autoComplete="off"
        error={save.error?.message}
        hint="Use a key with full read and write access (Read All and Write All). It is stored encrypted and never shown again."
        label="Composio API key"
        onChange={(event) => setApiKey(event.target.value)}
        spellCheck={false}
        type="password"
        value={apiKey}
      />
      <Button
        disabled={!apiKey.trim()}
        loading={save.isPending}
        tone="primary"
        type="submit"
      >
        {save.isPending ? "Checking key..." : "Save key"}
      </Button>
    </form>
  );
}
