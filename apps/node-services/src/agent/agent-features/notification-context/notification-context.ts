import type { NotificationContextContributor } from "../inbox-source/types.js";
import { renderTeamProtocolReminder } from "../../prompt/inbox-notification.js";

/**
 * Collaboration context contributed to notification rendering: the Team
 * collaboration protocol reminder. First render and canonical replay share
 * the same input facts.
 */
export const contributeInboxNotificationContext: NotificationContextContributor =
  (input) => {
    const sections: string[] = [];
    const teamProtocolPattern = input.messages.reduce(
      (latest, message) => message.teamProtocol ?? latest,
      "",
    );
    if (teamProtocolPattern && input.inboxId.startsWith("room:"))
      sections.push(renderTeamProtocolReminder(teamProtocolPattern));
    return sections;
  };
