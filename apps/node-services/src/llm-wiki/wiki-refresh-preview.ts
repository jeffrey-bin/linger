/**
 * Sends a snapshot of completed pages as soon as the first page is written,
 * then on the refresh clock, and the final response as soon as it is ready.
 * The first pages come only after the sources are routed, minutes in, so a
 * clock alone could leave the Wiki empty until it was nearly done.
 */
export function streamWikiCandidateResponse(
  requestSignal: AbortSignal,
  generate: (
    signal: AbortSignal,
    onPage: (path: string, markdown: string | null) => void,
  ) => Promise<Response>,
): Response {
  const stop = new AbortController();
  const signal = AbortSignal.any([requestSignal, stop.signal]);
  const pages = new Map<string, string>();
  const encoder = new TextEncoder();
  let dirty = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
      let previewed = false;
      const preview = () => {
        if (dirty && !signal.aborted && (controller.desiredSize ?? 0) > 0) {
          send({ kind: "preview", pages: Object.fromEntries(pages) });
          dirty = false;
          previewed = true;
        }
      };
      const timer = setInterval(preview, 3 * 60_000);
      try {
        const result = await generate(signal, (path, content) => {
          if (content === null) {
            if (pages.delete(path)) dirty = true;
          } else if (pages.get(path) !== content) {
            pages.set(path, content);
            dirty = true;
          }
          if (!previewed) preview();
        });
        if (!signal.aborted) {
          send({
            kind: "final",
            status: result.status,
            body: await result.json(),
          });
          controller.close();
        } else if (!stop.signal.aborted) {
          controller.error(signal.reason);
        }
      } catch (error) {
        controller.error(error);
      } finally {
        clearInterval(timer);
      }
    },
    cancel() {
      stop.abort();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson" },
  });
}
