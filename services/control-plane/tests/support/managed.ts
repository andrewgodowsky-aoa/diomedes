/**
 * Provider spies for the managed gateway tests. A spy is the only transport the
 * gateway is given, so its call count is the number of provider calls, and its
 * log is exactly what left for the provider.
 */
export interface ProviderRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  rawBody: string;
}

export interface ProviderSpy {
  fetch: typeof globalThis.fetch;
  calls: ProviderRequest[];
}

/** Wrap a transport so every call is counted and recorded before it answers. */
export function providerSpy(answer: (request: ProviderRequest) => Response | Promise<Response>): ProviderSpy {
  const calls: ProviderRequest[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const rawBody = await request.text();
    const recorded: ProviderRequest = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
      rawBody,
    };
    calls.push(recorded);
    return answer(recorded);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A stream that hands out exactly these chunks, in order. */
export function chunkedStream(chunks: readonly Uint8Array[], options: { failAfter?: number } = {}): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && index >= options.failAfter) {
        controller.error(new TypeError('network connection lost'));
        return;
      }
      if (index >= chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
  });
}

export async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}
