import { WorkerDocumentNormalizer } from "../../src/document-normalizer/document-normalizer.js";

import { startHttpHost, type HttpHost } from "../../src/http-host.js";
import { WikiServer } from "../../src/llm-wiki/wiki-server.js";

const hosts: HttpHost[] = [];

type WikiServerOptions = ConstructorParameters<typeof WikiServer>[0];

/** Mounts a Wiki server on its own loopback listener, as the service does on the shared one. */
export async function startWikiServer(
  options: Omit<WikiServerOptions, "http" | "normalizer"> &
    Partial<Pick<WikiServerOptions, "normalizer">>,
): Promise<string> {
  const http = await startHttpHost({ host: "127.0.0.1", port: 0 });
  hosts.push(http);
  new WikiServer({
    normalizer: new WorkerDocumentNormalizer(),
    ...options,
    http,
  }).start();
  http.finishStartup();
  return http.url;
}

export async function closeWikiServers(): Promise<void> {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
}
