export type TeamHubCreationMessageSegment =
  | {
      readonly type: "text";
      readonly content: string;
    }
  | {
      readonly type: "reference";
      readonly content: string;
      readonly target: string;
      readonly target_type: "agent" | "user";
    };

export interface TeamHubRoomCreationInput {
  readonly name: string;
  readonly description?: string;
  readonly member_ids: readonly [string, ...string[]];
  readonly artifacts?: readonly [string, ...string[]];
  readonly initial_message_segments: readonly [
    TeamHubCreationMessageSegment,
    ...TeamHubCreationMessageSegment[],
  ];
}
