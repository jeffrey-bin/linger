import { FileDropTarget } from "@/components/ui/file-drop-target";

import { MessageForwardDialog } from "./message-forward-dialog";
import { RoomReadStateSync } from "./room-read-state-sync";
import { AnotherMeIntro } from "./another-me-intro";
import { MessageVoiceSelectionControl } from "./voice-mode/message-voice-selection-control";
import { useRoomChatData } from "./use-room-chat-data";
import { useRoomChatConversationState } from "./use-room-chat-conversation-state";
import { useRoomChatTimelineActions } from "./use-room-chat-timeline-actions";
import { RoomChatTimelineSection } from "./room-chat-timeline-section";
import { RoomChatComposerSection } from "./room-chat-composer-section";

export function RoomChatImpl() {
  // The sub-hooks run in this order so their effects keep the order the Room
  // chat relies on: data reads, then conversation state, then actions.
  const data = useRoomChatData();
  const state = useRoomChatConversationState(data);
  const actions = useRoomChatTimelineActions(data, state);
  const { client, forwardMessage, roomId, setForwardMessage, tenantId } = data;
  const { currentActor, interactions, onboarding, timeline } = state;
  return (
    <div className="room-chat-layout flex min-h-0 flex-1">
      {onboarding.introPlaying && onboarding.agent ? (
        <AnotherMeIntro
          agent={onboarding.agent}
          humanName={currentActor?.display_name ?? ""}
          onDone={onboarding.finishIntro}
        />
      ) : null}
      <FileDropTarget
        canAccept={() =>
          interactions.composerRef.current?.canAcceptFiles() ?? false
        }
        className="room-chat-column relative flex min-h-0 min-w-0 flex-1 flex-col"
        key={`${tenantId}/${roomId}`}
        onFiles={(files) => {
          interactions.composerRef.current?.addFiles(files);
        }}
        subtitle="Up to 5 files"
        testId="room-chat-file-drop-target"
        title="Release to add to the current message"
      >
        <RoomChatTimelineSection actions={actions} data={data} state={state} />
        {forwardMessage ? (
          <MessageForwardDialog
            client={client}
            message={forwardMessage}
            onClose={() => setForwardMessage(null)}
            tenantId={tenantId}
          />
        ) : null}
        <MessageVoiceSelectionControl root={timeline.timelineElement} />
        <div>
          <RoomChatComposerSection
            actions={actions}
            data={data}
            state={state}
          />
        </div>
        <RoomReadStateSync
          roomId={roomId}
          tenantId={tenantId}
          throughRoomSeq={data.lastAppliedRoomSeq}
        />
      </FileDropTarget>
    </div>
  );
}
