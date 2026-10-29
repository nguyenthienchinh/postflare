import { request } from "./http";
import { streamBody, streamingMultipart } from "./multipart";
import type { ProviderContext } from "./types";

/**
 * POST a multipart/form-data body (presigned S3 form fields + one file) while streaming the file,
 * so large videos never sit in memory or pass through JS. Used by Pinterest and Reddit, which hand out S3 POST policies.
 * The body has a Content-Length, which S3 POST requires (no chunked encoding).
 */
export async function postFormStreaming(
  ctx: Pick<ProviderContext, "fetch">,
  url: string,
  fields: Array<[string, string]>,
  file: { field: string; filename: string; type: string; size: number; stream: ReadableStream },
): Promise<Response> {
  const mp = streamingMultipart([
    ...fields.map(([name, value]) => ({ name, value })),
    { name: file.field, filename: file.filename, type: file.type, size: file.size, open: () => file.stream },
  ]);
  return request(ctx, url, streamBody(mp.body, mp.contentType));
}

/** Extract `<Tag>value</Tag>` from an S3 XML response. */
export function xmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m?.[1]?.replace(/&amp;/g, "&");
}
