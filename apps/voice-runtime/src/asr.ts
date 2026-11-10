export interface ASRWord {
  startOffsetMs: number;
  endOffsetMs: number;
  textStart: number;
  textEnd: number;
}

export interface ASREvent {
  kind:
    | "partial"
    | "final"
    | "progress"
    | "utterance_end"
    | "finalization_ack"
    | "turn_finalized";
  startOffsetMs: number;
  endOffsetMs: number;
  committedThroughMs?: number;
  text?: string;
  words?: ASRWord[];
  speakerId?: string;
}

export function speakerIdFromZeroBased(
  index: number | undefined | null,
): string | undefined {
  if (index == null || !Number.isInteger(index) || index < 0) return undefined;
  return `spk_${index + 1}`;
}

export function speakerIdFromOneBased(
  index: number | undefined | null,
): string | undefined {
  if (index == null || !Number.isInteger(index) || index < 1) return undefined;
  return `spk_${index}`;
}

export function asrEventBytes(event: ASREvent) {
  return Buffer.byteLength(event.text ?? "") + (event.words?.length ?? 0) * 32;
}

export function offsetASREvent(event: ASREvent, baseMs: number): ASREvent {
  const result = {
    ...event,
    startOffsetMs: event.startOffsetMs + baseMs,
    endOffsetMs: event.endOffsetMs + baseMs,
  };
  if (event.committedThroughMs !== undefined)
    result.committedThroughMs = event.committedThroughMs + baseMs;
  if (event.words)
    result.words = event.words.map((word) => ({
      ...word,
      startOffsetMs: word.startOffsetMs + baseMs,
      endOffsetMs: word.endOffsetMs + baseMs,
    }));
  return result;
}

export function transcriptCharacters(text: string) {
  const characters: { value: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const character of text) {
    for (const value of character.normalize("NFKC")) {
      if (!/[\s\p{P}]/u.test(value))
        characters.push({
          value,
          start: offset,
          end: offset + character.length,
        });
    }
    offset += character.length;
  }
  return characters;
}

export interface ASRStream {
  sendPCM(frame: Int16Array): Promise<void>;
  /** Writes a non-closing turn boundary; acknowledgement arrives in events(). */
  finalize?(): Promise<void>;
  finish(): Promise<void>;
  events(): AsyncIterable<ASREvent>;
  close(): Promise<void>;
}

export interface ASRProvider {
  open(signal: AbortSignal): Promise<ASRStream>;
}
