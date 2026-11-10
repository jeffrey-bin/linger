import {
  AlertCircleIcon,
  Cancel01Icon,
  Key01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { ConnectorsNotConfiguredMessage } from "@/features/apps/connect-app-flow";
import { externalAppsQueryOptions } from "@/features/apps/connected-apps-queries";
import { ProviderKeyForm } from "@/features/apps/provider-key-form";
import { ComposioKeyGuide } from "@/features/apps/provider-key-guide";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { CardActions, CardError, CardRow } from "./approval-card-parts";
import { CardBox, CardDone, type ReceiptTone } from "./card-shell";
import { connectedAppDisplayName } from "./connected-app-names";
import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

const label = "Composio API key requested";

/**
 * Asks the Agent's Human for the deployment's Composio API key, which every
 * Connected App needs. The key goes from the dialog to TeamHub's key setting,
 * never into the chat; TeamHub resolves the card once a key is saved, and
 * that wakes the Agent to ask for the app itself.
 */
export function ProviderKeyDecision({
  card,
  currentActorId,
  messageId,
  onDecision,
}: {
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
}) {
  const { client } = useTeamHubRuntime();
  const catalog = useQuery(externalAppsQueryOptions(client));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owner = currentActorId === card.decision_owner.id;
  const appKey = card.provider_key?.app_key;

  async function decline() {
    setBusy(true);
    setError("");
    try {
      await onDecision({
        decision: "deny",
        expectedVersion: card.version,
        messageId,
        requestId: card.decision_id,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The card could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  const result = card.status === "pending" ? null : keyResult(card);
  return (
    <>
      <CardBox heading={card.title} label={label}>
        <CardRow
          detail={
            appKey
              ? `Needed to connect ${connectedAppDisplayName(appKey)}`
              : "Every connected app needs it"
          }
          icon={<Icon icon={Key01Icon} size={16} />}
          title="Composio API key"
        />
        {result ? (
          <CardDone icon={result.icon} text={result.text} tone={result.tone} />
        ) : owner ? (
          <CardActions>
            <Button
              disabled={busy}
              onClick={() => setOpen(true)}
              size="large"
              tone="primary"
            >
              Add key
            </Button>
            <Button
              disabled={busy}
              onClick={() => void decline()}
              size="large"
              tone="subtle"
            >
              Not now
            </Button>
          </CardActions>
        ) : null}
        {error ? <CardError>{error}</CardError> : null}
      </CardBox>
      {open && owner && !result ? (
        <ModalDialog
          className="app-key-dialog"
          closeOnBackdrop
          description={`${card.requester.display_name} continues once the key is saved.`}
          onClose={() => setOpen(false)}
          size="md"
          title="Add a Composio API key"
        >
          <div className="space-y-4 px-5 py-5 text-sm text-app-body">
            {catalog.data?.provider_key.can_save === false ? (
              <ConnectorsNotConfiguredMessage />
            ) : (
              <>
                <ComposioKeyGuide />
                <ProviderKeyForm onSaved={() => setOpen(false)} />
              </>
            )}
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
}

/** How a settled key request ended, in a few words. */
function keyResult(card: DecisionMessageCard): {
  icon: IconSvgElement;
  text: string;
  tone: ReceiptTone;
} {
  if (card.answer?.decision === "configured")
    return { icon: Tick02Icon, text: "Key added", tone: "success" };
  if (card.status === "denied")
    return { icon: Cancel01Icon, text: "No key added", tone: "muted" };
  return { icon: AlertCircleIcon, text: "Not completed", tone: "danger" };
}
