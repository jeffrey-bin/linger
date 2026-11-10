import type { MessageComposition } from "../message-composer";
import {
  formatDocumentToken,
  type MessageDocumentOption,
} from "../message-composer-references";
import type { VoiceDocumentSelection } from "../../room-drafts";
import { formatMentionToken } from "../message-mentions";

/** Build a normal Message: visible excerpt text plus existing Document segments. */
export function withVoiceMaterials(
  composition: MessageComposition,
  materials: readonly VoiceDocumentSelection[],
  reservedTokens: readonly string[] = [],
): MessageComposition {
  if (!materials.length) return composition;
  const options: MessageDocumentOption[] = [];
  for (const material of materials) {
    if (
      material.documentId &&
      !options.some((item) => item.documentId === material.documentId)
    )
      options.push({
        documentId: material.documentId,
        name: material.title,
        updatedAt: "",
      });
  }
  const references = [...(composition.documentReferences ?? [])];
  const occupiedTokens = new Set([
    ...references.map((reference) => reference.token),
    ...composition.mentions.map(formatMentionToken),
    ...reservedTokens,
  ]);
  const quoted = (quote: string) =>
    quote
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
  const excerpts = materials.map((material) => {
    const { documentId } = material;
    // A Room Message excerpt needs no Document reference.
    if (!documentId) return `Reference material:\n${quoted(material.quote)}`;
    const baseToken = formatDocumentToken(
      { documentId, name: material.title, updatedAt: "" },
      options,
    );
    const existing = references.find(
      (reference) => reference.documentId === documentId,
    );
    let token = existing?.token ?? baseToken;
    let suffix = 1;
    while (!existing && occupiedTokens.has(token))
      token = `${baseToken}_${suffix++}`;
    occupiedTokens.add(token);
    if (
      !references.some(
        (ref) => ref.documentId === documentId && ref.token === token,
      )
    )
      references.push({ documentId, token });
    // A whole file travels as its Document reference; the Agent reads it.
    if (!material.quote) return `Reference material: ${token}`;
    // The Document token keeps the excerpt linked to its source.
    return `Reference material from ${token}:\n${quoted(material.quote)}`;
  });
  // Quoted material first, then what the user said about it.
  const body = [...excerpts, composition.body].filter(Boolean).join("\n\n");
  if (body.length > 50_000)
    throw new Error(
      "Your voice message and references exceed 50,000 characters. Remove a selection or shorten the draft.",
    );
  return {
    ...composition,
    body,
    documentReferences: references,
  };
}

/** An already selected @Document/@Actor may precede dictation; prose may not. */
export function isReferenceOnlyDraft(body: string, tokens: readonly string[]) {
  let remaining = body;
  for (const token of [...tokens].sort((a, b) => b.length - a.length))
    remaining = remaining.replaceAll(token, "");
  return remaining.trim() === "";
}
