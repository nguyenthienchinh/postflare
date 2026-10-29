import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mediaAccess } from "../../worker/lib/media";
import { streamingMultipart } from "../../worker/providers/multipart";

// On workerd, a fixed-length stream cannot be piped into another one ("Inter-TransformStream pipeTo"): a multipart
// body built from `rangeStream` never ends and the upload hangs until the Workflow step times out (X video, Oct 2026).
describe("streamed multipart from R2", () => {
  it("completes with the announced length for a ranged file part", async () => {
    const size = 9 * 1024 * 1024 + 123;
    await env.MEDIA.put("test/stream.mp4", new Uint8Array(size).fill(7));
    const item = { id: "m", kind: "video", mime: "video/mp4", filename: "v.mp4", size, r2Key: "test/stream.mp4" } as never;
    const media = mediaAccess(env as never);
    for (const [offset, length] of [
      [0, 4 * 1024 * 1024],
      [8 * 1024 * 1024, 4 * 1024 * 1024],
    ]) {
      const part = Math.min(length, size - offset);
      const mp = streamingMultipart([
        { name: "segment_index", value: "0" },
        { name: "media", filename: "chunk", type: "application/octet-stream", size: part, open: () => media.stream(item, { offset, length }) },
      ]);
      const buf = await Promise.race([
        new Response(mp.body).arrayBuffer(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("multipart body stalled")), 4000)),
      ]);
      expect(buf.byteLength).toBe(mp.length);
    }
  });
});
