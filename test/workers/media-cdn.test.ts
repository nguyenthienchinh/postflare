import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { APP_CSP } from "../../worker/lib/headers";
import { loadMediaItems, mediaDto, thumbKey, type MediaRow } from "../../worker/lib/media";
import { sweepMedia } from "../../worker/lib/media-lifecycle";
import { deleteWorkspace } from "../../worker/lib/users";
import { ORIGIN, sessionCookie } from "./helpers";

// MEDIA_PUBLIC_URL (media URLs straight at the R2 custom domain) and image thumbnails made with the Images binding
// (a fake here). Own D1 instance (MEDIA_CDN_DB); R2 is the shared test bucket (keys are unique media ids).

const CDN = "https://cdn.pf.test";

/** Fake Images binding: records transforms/outputs; `fail` makes the output throw. */
function fakeImages() {
  const state = { fail: false, calls: [] as Array<{ transform?: unknown; output?: unknown }> };
  const binding = {
    input(stream: ReadableStream) {
      const t = {
        transform(o: unknown) {
          state.calls.push({ transform: o });
          return t;
        },
        async output(o: unknown) {
          state.calls.push({ output: o });
          await new Response(stream).arrayBuffer();
          if (state.fail) throw new Error("ImagesError 9412: not an image");
          return { response: () => new Response("WEBPTHUMB", { headers: { "content-type": "image/webp" } }) };
        },
      };
      return t;
    },
  };
  return { state, binding };
}

const images = fakeImages();
const base = { ...env, DB: env.MEDIA_CDN_DB, DEMO_MODE: "false", PUBLIC_URL: ORIGIN, IMAGES: images.binding };
const E_CDN = { ...base, MEDIA_PUBLIC_URL: `${CDN}/` } as unknown as Env;
const E_PLAIN = { ...base, MEDIA_PUBLIC_URL: undefined } as unknown as Env;
const E_NO_IMAGES = { ...base, MEDIA_PUBLIC_URL: CDN, IMAGES: undefined } as unknown as Env;

let key = "";

async function call(E: Env, path: string, opts: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; auth?: boolean } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.auth !== false && key) headers.authorization = `Bearer ${key}`;
  let body = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body }) as any, E, ctx);
  await waitOnExecutionContext(ctx);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers, bytes: buf.byteLength };
}

const upload = (E: Env, filename: string, mime: string, size = 2000, extra: Record<string, string> = {}) =>
  call(E, "/api/media", { raw: new Uint8Array(size).fill(1), headers: { "content-type": mime, "x-filename": filename, "content-length": String(size), ...extra } });

const row = (id: string) => env.MEDIA_CDN_DB.prepare("SELECT * FROM media WHERE id = ?").bind(id).first<MediaRow>();

beforeAll(async () => {
  const setup = await call(E_PLAIN, "/api/auth/setup", { body: { name: "Cy", email: "cy@example.com", password: "password123", workspaceName: "Cy" } });
  expect(setup.status, setup.text).toBe(200);
  const cookie = sessionCookie(setup.headers)!;
  const k = await call(E_PLAIN, "/api/keys", { body: { name: "cdn" }, headers: { cookie } });
  expect(k.status, k.text).toBe(201);
  key = k.json.token;
});

afterEach(() => {
  images.state.fail = false;
  vi.restoreAllMocks();
});

describe("MEDIA_PUBLIC_URL", () => {
  it("returns CDN URLs (file and thumbnail) when set, signed /m/ links when not, and /m/ keeps serving", async () => {
    images.state.calls = [];
    const up = await upload(E_CDN, "My photo.png", "image/png");
    expect(up.status, up.text).toBe(200);
    const id: string = up.json.id;
    expect(up.json.url).toBe(`${CDN}/${id}/My_photo.png`);
    expect(up.json.thumbUrl).toBe(`${CDN}/${id}/thumb/480.webp`);
    // One transformation: max 480 px, scale-down, WebP, first frame only.
    expect(images.state.calls).toEqual([
      { transform: { width: 480, height: 480, fit: "scale-down" } },
      { output: { format: "image/webp", quality: 80, anim: false } },
    ]);
    expect(await (await env.MEDIA.get(thumbKey(id)))!.text()).toBe("WEBPTHUMB");
    expect((await row(id))!.has_thumb).toBe(1);
    const ev = await env.MEDIA_CDN_DB.prepare("SELECT images_tx FROM usage_events WHERE kind = 'media_upload' ORDER BY rowid DESC LIMIT 1").first<{ images_tx: number }>();
    expect(ev?.images_tx).toBe(1);

    const listed = (await call(E_CDN, "/api/media")).json.find((m: any) => m.id === id);
    expect(listed).toMatchObject({ url: `${CDN}/${id}/My_photo.png`, thumbUrl: `${CDN}/${id}/thumb/480.webp` });

    const plain = (await call(E_PLAIN, "/api/media")).json.find((m: any) => m.id === id);
    expect(plain.url).toMatch(new RegExp(`^${ORIGIN}/m/${id}/[^/]+/My_photo\\.png$`));
    const sig = plain.url.split("/")[5];
    expect(plain.thumbUrl).toBe(`${ORIGIN}/m/${id}/${sig}/thumb/480.webp`);

    // The signed links work with and without the CDN (URLs already handed out keep resolving).
    for (const E of [E_PLAIN, E_CDN]) {
      const file = await call(E, new URL(plain.url).pathname, { auth: false });
      expect(file.status).toBe(200);
      expect(file.bytes).toBe(2000);
      const thumb = await call(E, new URL(plain.thumbUrl).pathname, { auth: false });
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get("content-type")).toBe("image/webp");
      expect(thumb.text).toBe("WEBPTHUMB");
    }
    const head = await call(E_PLAIN, new URL(plain.thumbUrl).pathname, { method: "HEAD", auth: false });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("9");
    expect((await call(E_PLAIN, `/m/${id}/${sig.slice(0, 10)}/thumb/480.webp`, { auth: false })).status).toBe(404);
  });

  it("hands CDN URLs to providers (loadMediaItems)", async () => {
    const up = await upload(E_CDN, "clip.mp4", "video/mp4");
    const [item] = await loadMediaItems(E_CDN, ORIGIN, [up.json.id]);
    expect(item.url).toBe(`${CDN}/${up.json.id}/clip.mp4`);
    const [signed] = await loadMediaItems(E_PLAIN, ORIGIN, [up.json.id]);
    expect(signed.url).toMatch(new RegExp(`^${ORIGIN}/m/${up.json.id}/`));
  });

  it("never gives unfinished uploads a CDN URL; multipart completion makes the thumbnail", async () => {
    const start = await call(E_CDN, "/api/media/multipart", { body: { filename: "big.jpg", mime: "image/jpeg", size: 3000 } });
    expect(start.status, start.text).toBe(200);
    const id: string = start.json.id;
    const pending = await mediaDto(E_CDN, ORIGIN, (await row(id))!);
    expect(pending.url).toMatch(new RegExp(`^${ORIGIN}/m/${id}/`));
    expect(pending.thumbUrl).toBeNull();
    await expect(loadMediaItems(E_CDN, ORIGIN, [id])).rejects.toThrow(/not finished uploading/);
    expect((await call(E_CDN, "/api/media")).json.some((m: any) => m.id === id)).toBe(false);
    expect((await call(E_CDN, new URL(pending.url).pathname, { auth: false })).status).toBe(404);

    const part = await call(E_CDN, `/api/media/multipart/${id}/1`, { method: "PUT", raw: new Uint8Array(3000).fill(2) });
    expect(part.status, part.text).toBe(200);
    images.state.calls = [];
    const done = await call(E_CDN, `/api/media/multipart/${id}/complete`, { body: { parts: [part.json] } });
    expect(done.status, done.text).toBe(200);
    expect(done.json).toMatchObject({ url: `${CDN}/${id}/big.jpg`, thumbUrl: `${CDN}/${id}/thumb/480.webp`, size: 3000 });
    expect(images.state.calls).toHaveLength(2);
    expect(await env.MEDIA.head(thumbKey(id))).not.toBeNull();
  });

  it("makes thumbnails for imports from a URL", async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new Request(input as any, init).url;
      if (url === "https://img.example/pic.webp") return new Response(new Uint8Array(1500), { headers: { "content-type": "image/webp", "content-length": "1500" } });
      return realFetch(input as any, init);
    });
    const res = await call(E_CDN, "/api/media/from-url", { body: { url: "https://img.example/pic.webp" } });
    expect(res.status, res.text).toBe(200);
    expect(res.json.thumbUrl).toBe(`${CDN}/${res.json.id}/thumb/480.webp`);
  });

  it("skips the thumbnail for videos, small images, a missing binding or a failed transform (the upload still works)", async () => {
    images.state.calls = [];
    const video = await upload(E_CDN, "v.mp4", "video/mp4");
    expect(video.json.thumbUrl).toBeNull();
    const small = await upload(E_CDN, "icon.png", "image/png", 2000, { "x-width": "200", "x-height": "120" });
    expect(small.json.thumbUrl).toBeNull();
    expect(images.state.calls).toHaveLength(0);

    const noBinding = await upload(E_NO_IMAGES, "a.png", "image/png");
    expect(noBinding.status).toBe(200);
    expect(noBinding.json).toMatchObject({ url: `${CDN}/${noBinding.json.id}/a.png`, thumbUrl: null });

    images.state.fail = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = await upload(E_CDN, "broken.png", "image/png");
    expect(failed.status).toBe(200);
    expect(failed.json.thumbUrl).toBeNull();
    expect((await row(failed.json.id))!.has_thumb).toBe(0);
    expect(await env.MEDIA.head(thumbKey(failed.json.id))).toBeNull();
  });

  it("deletes the thumbnail with the media (delete, lifecycle sweep, workspace deletion)", async () => {
    const a = await upload(E_CDN, "del.png", "image/png");
    const aKey = (await row(a.json.id))!.r2_key;
    expect((await call(E_CDN, `/api/media/${a.json.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await env.MEDIA.head(aKey)).toBeNull();
    expect(await env.MEDIA.head(thumbKey(a.json.id))).toBeNull();

    // Expired, unused media (retention default: 30 days).
    const b = await upload(E_CDN, "old.png", "image/png");
    const bKey = (await row(b.json.id))!.r2_key;
    await env.MEDIA_CDN_DB.prepare("UPDATE media SET created_at = ? WHERE id = ?").bind(Date.now() - 40 * 24 * 3600_000, b.json.id).run();
    expect((await sweepMedia(E_CDN)).expired).toBeGreaterThanOrEqual(1);
    expect(await env.MEDIA.head(bKey)).toBeNull();
    expect(await env.MEDIA.head(thumbKey(b.json.id))).toBeNull();

    const c = await upload(E_CDN, "ws.png", "image/png");
    const cKey = (await row(c.json.id))!.r2_key;
    const ws = (await row(c.json.id))!.workspace_id!;
    expect(await env.MEDIA.head(thumbKey(c.json.id))).not.toBeNull();
    await deleteWorkspace(E_CDN, ws);
    expect(await env.MEDIA.head(cKey)).toBeNull();
    expect(await env.MEDIA.head(thumbKey(c.json.id))).toBeNull();
  });
});

describe("CSP", () => {
  it("lets the app load images and videos from the media domain", () => {
    const directive = (name: string) => APP_CSP.split("; ").find((d) => d.startsWith(`${name} `))!.split(" ").slice(1);
    // `https:` (any HTTPS origin) covers MEDIA_PUBLIC_URL; static pages get the same policy from public/_headers.
    expect(directive("img-src")).toContain("https:");
    expect(directive("media-src")).toContain("https:");
  });
});
