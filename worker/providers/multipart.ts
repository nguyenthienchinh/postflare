import type { RequestOptions } from "./http";
import type { MediaItem, ProviderContext } from "./types";

// Streaming multipart/form-data and fixed-length bodies, shared by providers that upload files.

export type MultipartPart =
  | { name: string; value: string; type?: string }
  | { name: string; filename: string; type: string; size: number; open: () => Promise<ReadableStream | ArrayBuffer | Blob> | ReadableStream | ArrayBuffer | Blob };

/**
 * multipart/form-data body that streams file parts instead of buffering them (Workers have 128MB).
 * Content-Length is computed up front so platforms that refuse chunked uploads still accept it.
 */
export function streamingMultipart(parts: MultipartPart[]): {
  body: ReadableStream<Uint8Array>;
  headers: Record<string, string>;
  length: number;
  contentType: string;
} {
  const enc = new TextEncoder();
  const boundary = `----postflare${crypto.randomUUID().replace(/-/g, "")}`;
  const esc = (s: string) => s.replace(/"/g, "%22").replace(/\r|\n/g, " ");
  const heads = parts.map((p) =>
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${esc(p.name)}"` +
        ("filename" in p ? `; filename="${esc(p.filename)}"\r\nContent-Type: ${p.type}\r\n\r\n` : `${p.type ? `\r\nContent-Type: ${p.type}` : ""}\r\n\r\n`),
    ),
  );
  const values = parts.map((p) => ("value" in p ? enc.encode(p.value) : null));
  const crlf = enc.encode("\r\n");
  const tail = enc.encode(`--${boundary}--\r\n`);
  const length =
    parts.reduce((n, p, i) => n + heads[i].length + ("value" in p ? values[i]!.length : p.size) + crlf.length, 0) + tail.length;

  // Framing is written from JS, file streams are piped with pipeTo: on Workers R2 -> FixedLengthStream is pumped
  // natively, so file bytes never pass through JS (Free plan CPU budget). Writes wait for the consumer (fetch).
  const { readable, writable } =
    typeof FixedLengthStream !== "undefined" ? new FixedLengthStream(length) : new TransformStream<Uint8Array, Uint8Array>();
  const write = async (chunk: Uint8Array) => {
    const w = writable.getWriter();
    try {
      await w.write(chunk);
    } finally {
      w.releaseLock();
    }
  };
  (async () => {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      await write(heads[i]);
      if ("value" in p) await write(values[i]!);
      else {
        const src = await p.open();
        if (src instanceof ArrayBuffer) await write(new Uint8Array(src));
        else await (src instanceof Blob ? src.stream() : src).pipeTo(writable as WritableStream, { preventClose: true });
      }
      await write(crlf);
    }
    await write(tail);
    await writable.close();
  })().catch((err) => writable.abort(err).catch(() => {}));
  const contentType = `multipart/form-data; boundary=${boundary}`;
  return {
    body: readable as ReadableStream<Uint8Array>,
    length,
    contentType,
    headers: { "content-type": contentType, "content-length": String(length) },
  };
}

/** Whole media file as a fixed-length, zero-copy stream: pass it straight as a raw fetch body. */
export const mediaBody = (ctx: ProviderContext, item: MediaItem) => ctx.media.rangeStream(item, 0, item.size);

/** File part for a media item, streamed from R2. */
export const mediaPart = (ctx: ProviderContext, name: string, item: MediaItem): MultipartPart => ({
  name,
  filename: item.filename,
  type: item.mime,
  size: item.size,
  open: () => ctx.media.stream(item),
});

/** Wraps a stream so Workers sends Content-Length (some APIs reject chunked uploads). No-op outside Workers. */
export function fixedLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  if (typeof FixedLengthStream === "undefined") return stream;
  const fls = new FixedLengthStream(length);
  stream.pipeTo(fls.writable).catch(() => {});
  return fls.readable as ReadableStream<Uint8Array>;
}

/** Request options for a streamed body (`duplex` is required by Node/undici, ignored by Workers). */
export function streamBody(body: ReadableStream, contentType: string): RequestOptions {
  return { method: "POST", body, headers: { "content-type": contentType }, duplex: "half" } as RequestOptions;
}
