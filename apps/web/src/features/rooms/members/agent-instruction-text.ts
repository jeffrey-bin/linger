import { GENERAL_AGENT_INSTRUCTIONS } from "../general-agent-defaults";

export const UNSET_AGENT_INSTRUCTIONS =
  "Instructions haven't been set yet. They'll be written from the first conversation.";

export function presentAgentInstructions(instructions: string) {
  const text = instructions.trim();
  if (!text || text === GENERAL_AGENT_INSTRUCTIONS.trim()) return "";
  const wrapped = text.match(/^<identity>\s*([\s\S]*?)\s*<\/identity>$/);
  return (wrapped?.[1] ?? text).trim();
}
