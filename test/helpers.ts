import type { AccountRecord, MediaItem, ProviderContext } from "../worker/providers/types";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** Parsed JSON body or urlencoded form (as object), when applicable. */
  json?: any;
  form?: Record<string, string>;
  /** Raw body when it was FormData, or the parsed multipart body when it was streamed. */
  formData?: FormData;
  /** Body size in bytes (also set when the body was too big to keep in `body`). */
  bodySize?: number;
}

/** Bodies above this are counted but not kept (2GB upload tests stream through the mock). */
const MAX_RECORDED_BODY = 56 * 1024 * 1024;

type Handler = (req: RecordedRequest) => Response | Promise<Response> | unknown;

/**
 * Fake fetch: routes are matched in order by `METHOD url-prefix` (or RegExp on the URL).
 * A handler may return a Response or any JSON-serialisable value (sent as 200 JSON).
 */
export function mockFetch(routes: Array<[string | RegExp, Handler]>) {
  const requests: RecordedRequest[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as any, init as any);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const recorded: RecordedRequest = { method: req.method, url: req.url, headers, body: null };
    const ct = headers["content-type"] ?? "";
    if (init?.body instanceof FormData) {
      recorded.formData = init.body;
    } else if (req.body) {
      const reader = req.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size <= MAX_RECORDED_BODY) chunks.push(value);
      }
      recorded.bodySize = size;
      if (size <= MAX_RECORDED_BODY) {
        const buf = new Uint8Array(size);
        let o = 0;
        for (const c of chunks) {
          buf.set(c, o);
          o += c.byteLength;
        }
        recorded.body = new TextDecoder().decode(buf);
        if (ct.includes("json")) recorded.json = JSON.parse(recorded.body || "null");
        if (ct.includes("x-www-form-urlencoded")) recorded.form = Object.fromEntries(new URLSearchParams(recorded.body));
        // Streamed multipart bodies are parsed back so tests can inspect them like FormData.
        if (ct.startsWith("multipart/form-data")) recorded.formData = await new Response(buf, { headers: { "content-type": ct } }).formData();
      }
    }
    requests.push(recorded);
    for (const [matcher, handler] of routes) {
      const hit =
        typeof matcher === "string"
          ? (() => {
              const [m, prefix] = matcher.includes(" ") ? matcher.split(" ", 2) : ["*", matcher];
              return (m === "*" || m === req.method) && req.url.startsWith(prefix);
            })()
          : matcher.test(req.url);
      if (!hit) continue;
      const out = await handler(recorded);
      if (out instanceof Response) return out;
      return new Response(out === undefined ? "" : JSON.stringify(out), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }), { status: 599 });
  };
  return { fetch: fn as typeof fetch, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function testContext(fetchFn: typeof fetch, app: Record<string, string> = {}, providerId = "test"): ProviderContext & {
  logs: string[];
} {
  const logs: string[] = [];
  const bytes = (n: number) => new Uint8Array(n).fill(7).buffer;
  return {
    env: {} as Env,
    fetch: fetchFn,
    app,
    redirectUri: `https://pf.example.com/oauth/${providerId}/callback`,
    baseUrl: "https://pf.example.com",
    logs,
    log: (level, message) => logs.push(`${level}: ${message}`),
    media: {
      stream: async (item, range) => lazyStream(range ? Math.max(0, Math.min(range.length, item.size - range.offset)) : item.size),
      bytes: async (item) => bytes(item.size),
      rangeStream: async (item, offset, length) => lazyStream(Math.max(0, Math.min(length, item.size - offset))),
      range: async (item, offset, length) => bytes(Math.max(0, Math.min(length, item.size - offset))),
      blob: async (item) => new Blob([bytes(item.size)], { type: item.mime }),
      image: async (item, opts) => new Blob([bytes(Math.min(item.size, 500_000))], { type: opts.format ?? "image/jpeg" }),
    },
  };
}

const FILL = new Uint8Array(1024 * 1024).fill(7);

/** `n` bytes of 7s, generated as they are read (no big allocation for multi-GB test files). */
export function lazyStream(n: number): ReadableStream<Uint8Array> {
  let left = n;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const k = Math.min(left, FILL.byteLength);
      left -= k;
      controller.enqueue(k === FILL.byteLength ? FILL : FILL.subarray(0, k));
    },
  });
}

/** Media streams of 1 byte: for request-count tests with multi-GB files (bytes are irrelevant there). */
export function hollowMedia<T extends ProviderContext>(ctx: T): T {
  ctx.media.stream = async () => lazyStream(1);
  ctx.media.rangeStream = async () => lazyStream(1);
  return ctx;
}

/** Fails the test if the provider copies media bytes into memory instead of streaming them. */
export function noCopy<T extends ProviderContext>(ctx: T): T {
  const fail = async () => {
    throw new Error("media bytes must be streamed, not copied into memory");
  };
  ctx.media.bytes = fail;
  ctx.media.range = fail;
  ctx.media.blob = fail;
  return ctx;
}

export function testAccount(over: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: "acc_1",
    provider: "test",
    externalId: "ext_1",
    name: "Test Account",
    username: "test",
    credentials: { accessToken: "AT", refreshToken: "RT" },
    expiresAt: null,
    meta: {},
    ...over,
  };
}

export function image(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "med_img",
    kind: "image",
    mime: "image/jpeg",
    filename: "photo.jpg",
    size: 200_000,
    width: 1080,
    height: 1080,
    duration: null,
    alt: "alt text",
    url: "https://pf.example.com/m/med_img/sig/photo.jpg",
    ...over,
  };
}

export function video(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "med_vid",
    kind: "video",
    mime: "video/mp4",
    filename: "clip.mp4",
    size: 12_000_000,
    width: 1080,
    height: 1920,
    duration: 20,
    alt: null,
    url: "https://pf.example.com/m/med_vid/sig/clip.mp4",
    ...over,
  };
}
