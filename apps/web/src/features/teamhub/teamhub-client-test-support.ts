export class FakeXmlHttpRequest {
  aborted = false;
  body: Document | XMLHttpRequestBodyInit | null = null;
  headers = new Headers();
  method = "";
  onabort: ((event: ProgressEvent) => void) | null = null;
  onerror: ((event: ProgressEvent) => void) | null = null;
  onload: ((event: ProgressEvent) => void) | null = null;
  ontimeout: ((event: ProgressEvent) => void) | null = null;
  responseText = "";
  sendError: Error | null = null;
  status = 0;
  timeout = 0;
  upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
  };
  url = "";
  withCredentials = false;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  abort() {
    this.aborted = true;
    this.onabort?.({ type: "abort" } as ProgressEvent);
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    if (this.sendError) {
      throw this.sendError;
    }
    this.body = body;
  }

  reportProgress(loaded: number, total: number) {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent);
  }

  complete(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.({ type: "load" } as ProgressEvent);
  }

  timeOut() {
    this.ontimeout?.({ type: "timeout" } as ProgressEvent);
  }
}

export interface SentRequestInit {
  body?: BodyInit | null;
  credentials?: RequestCredentials;
  headers: Headers;
  keepalive?: boolean;
  method?: string;
  signal?: AbortSignal | null;
}

/**
 * Reads what a fetch test double received as `[url, init]` pairs. The typed
 * TeamHub client sends one Request per call, whose body is read as text;
 * bounded downloads still call fetch with a URL and an init.
 */
export async function sentRequests(fetchRequest: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): Promise<Array<[string, SentRequestInit]>> {
  return Promise.all(
    fetchRequest.mock.calls.map(async ([input, init]) => {
      if (input instanceof Request) {
        const body = input.body ? await input.clone().text() : undefined;
        return [
          input.url,
          {
            ...(body === undefined ? {} : { body }),
            credentials: input.credentials,
            headers: input.headers,
            keepalive: input.keepalive,
            method: input.method,
            signal: input.signal,
          },
        ] satisfies [string, SentRequestInit];
      }
      const requestInit = (init ?? {}) as RequestInit;
      return [
        String(input),
        { ...requestInit, headers: new Headers(requestInit.headers) },
      ] satisfies [string, SentRequestInit];
    }),
  );
}

/** Adapts a `(url, init)` fetch test double to the Request the client sends. */
export function fetchDouble(
  handler: (url: string, init: SentRequestInit) => Promise<Response> | Response,
): typeof fetch {
  return async (input, init) => {
    const [sent] = await sentRequests({ mock: { calls: [[input, init]] } });
    return handler(...sent!);
  };
}
