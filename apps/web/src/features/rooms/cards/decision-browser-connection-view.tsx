import {
  AlertCircleIcon,
  Cancel01Icon,
  Clock01Icon,
  Globe02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { lazy, Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";

import { CardActions, CardError, CardRow } from "./approval-card-parts";
import { CardBox, CardDone, type ReceiptTone } from "./card-shell";
import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

const BrowserConnectionDialog = lazy(() =>
  import("@/features/local-computer/browser-connection/browser-connection-dialog").then(
    (module) => ({ default: module.BrowserConnectionDialog }),
  ),
);

const label = "Browser connection requested";

/**
 * Asks the owner of an Agent's Local Computer to connect their everyday
 * Chrome. The token goes from the dialog to that Computer only; TeamHub
 * resolves the card once the Computer confirms the connection, and that wakes
 * the Agent. Closing the dialog leaves the card waiting.
 */
export function BrowserConnectionDecision({
  card,
  currentActorId,
  messageId,
  onDecision,
  tenantId,
}: {
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
  tenantId: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owner = currentActorId === card.decision_owner.id;
  const agentName = card.requester.display_name;

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

  const result = card.status === "pending" ? null : browserResult(card);
  return (
    <>
      <CardBox heading={card.title} label={label}>
        <CardRow
          icon={<Icon icon={Globe02Icon} size={16} />}
          title="Everyday Chrome"
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
              Connect
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
        <Suspense fallback={null}>
          <BrowserConnectionDialog
            computerId={card.browser_connection?.computer_id ?? ""}
            onClose={() => setOpen(false)}
            reason={`${agentName} continues once you connect.`}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/** How a settled browser connection ended, in a few words. */
function browserResult(card: DecisionMessageCard): {
  icon: IconSvgElement;
  text: string;
  tone: ReceiptTone;
} {
  if (card.answer?.decision === "connected")
    return { icon: Tick02Icon, text: "Connected", tone: "success" };
  switch (card.status) {
    case "denied":
      return { icon: Cancel01Icon, text: "Not connected", tone: "muted" };
    case "expired":
      return { icon: Clock01Icon, text: "Expired", tone: "muted" };
    default:
      return {
        icon: AlertCircleIcon,
        text: "Failed: the connection did not complete",
        tone: "danger",
      };
  }
}
