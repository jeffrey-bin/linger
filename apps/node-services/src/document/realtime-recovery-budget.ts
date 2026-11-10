// The state bundle budget counts one state with its vector and complete
// references, the same rule TeamHub applies to every Document head.
export function stateBundleFits(input: {
  stateBytes: number;
  stateVectorBytes: number;
  references: { documentAssetIds: string[]; documentThreadIds: string[] };
  limit: number;
}): boolean {
  const referenceBytes = Buffer.byteLength(
    JSON.stringify({
      document_asset_ids: input.references.documentAssetIds,
      document_thread_ids: input.references.documentThreadIds,
    }),
  );
  return (
    input.stateBytes + input.stateVectorBytes + referenceBytes <= input.limit
  );
}
