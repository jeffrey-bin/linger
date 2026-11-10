import type { TeamHubRoomCreationInput } from "../types.js";
import {
  createRoomInputSchema,
  createRoomOutputSchema,
  type CreateRoomInput,
} from "./creation-schemas.js";

export const createRoomSchema = {
  input: createRoomInputSchema,
  output: createRoomOutputSchema,
};

export function cloneRoomCreationInput(
  input: CreateRoomInput,
): TeamHubRoomCreationInput {
  const memberIds = [...input.member_ids];
  const segments = input.initial_message_segments.map((segment) =>
    Object.freeze({ ...segment }),
  );
  const memberIdsTuple: readonly [string, ...string[]] = [
    memberIds[0]!,
    ...memberIds.slice(1),
  ];
  const segmentTuple: TeamHubRoomCreationInput["initial_message_segments"] = [
    segments[0]!,
    ...segments.slice(1),
  ];
  const artifacts = input.artifacts;
  return Object.freeze({
    name: input.name,
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    member_ids: memberIdsTuple,
    ...(artifacts === undefined
      ? {}
      : {
          artifacts: [artifacts[0]!, ...artifacts.slice(1)] as const,
        }),
    initial_message_segments: segmentTuple,
  });
}

export function normalizeRoomCreationInput(
  input: TeamHubRoomCreationInput,
): TeamHubRoomCreationInput {
  const memberIds = [...input.member_ids].sort();
  const memberIdsTuple: readonly [string, ...string[]] = [
    memberIds[0]!,
    ...memberIds.slice(1),
  ];
  return Object.freeze({
    name: input.name.trim(),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    member_ids: memberIdsTuple,
    ...(input.artifacts === undefined
      ? {}
      : {
          artifacts: [input.artifacts[0], ...input.artifacts.slice(1)] as const,
        }),
    initial_message_segments: input.initial_message_segments.map((segment) =>
      Object.freeze({ ...segment }),
    ) as [
      TeamHubRoomCreationInput["initial_message_segments"][number],
      ...TeamHubRoomCreationInput["initial_message_segments"][number][],
    ],
  });
}
