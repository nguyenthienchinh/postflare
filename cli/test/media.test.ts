import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Api } from "../src/api.js";
import { fileInfo, imageSize, mimeFromPath, mp4Info, parseMoov } from "../src/mediainfo.js";
import { planParts, uploadFile } from "../src/upload.js";

const dir = mkdtempSync(join(tmpdir(), "postflare-cli-"));

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

function png(w: number, h: number) {
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii("IHDR"), be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
}

function gif(w: number, h: number) {
  return bytes(ascii("GIF89a"), [w & 255, w >> 8, h & 255, h >> 8], new Array(20).fill(0));
}

function webpVp8x(w: number, h: number) {
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  return bytes(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii("VP8X"), [10, 0, 0, 0], [0, 0, 0, 0], le24(w - 1), le24(h - 1));
}

function webpVp8l(w: number, h: number) {
  const bits = (w - 1) | ((h - 1) << 14);
  return bytes(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii("VP8L"), [5, 0, 0, 0], [0x2f], [bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], new Array(8).fill(0));
}

/** JPEG with an EXIF APP1 (big-endian TIFF, one IFD entry: orientation) and a SOF0. */
function jpeg(w: number, h: number, orientation?: number) {
  const app1: number[] = [];
  if (orientation) {
    const tiff = [...ascii("MM"), ...be16(42), ...be32(8), ...be16(1), ...be16(0x0112), ...be16(3), ...be32(1), ...be16(orientation), 0, 0, ...be32(0)];
    const payload = [...ascii("Exif"), 0, 0, ...tiff];
    app1.push(0xff, 0xe1, ...be16(payload.length + 2), ...payload);
  }
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return bytes([0xff, 0xd8], app0, app1, sof, [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0], [0xff, 0xd9]);
}

const box = (type: string, ...payload: number[][]) => {
  const body = payload.flat();
  return [...be32(body.length + 8), ...ascii(type), ...body];
};

/** moov with mvhd (timescale 1000, duration ms) and one video trak (tkhd w×h, optional 90° matrix). */
function moov(w: number, h: number, durationMs: number, rotate90 = false) {
  const mvhd = box("mvhd", [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(durationMs), new Array(80).fill(0));
  const matrix = rotate90 ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  const tkhd = box("tkhd", [0, 0, 0, 3], new Array(20).fill(0), be32(0), new Array(16).fill(0), matrix.flatMap((v) => be32(v >>> 0)), be32(w * 65536), be32(h * 65536));
  const hdlr = box("hdlr", [0, 0, 0, 0], be32(0), ascii("vide"), new Array(12).fill(0), [0]);
  const soundTrak = box("trak", box("tkhd", [0, 0, 0, 3], new Array(76).fill(0), be32(0), be32(0)), box("mdia", box("hdlr", [0, 0, 0, 0], be32(0), ascii("soun"), new Array(13).fill(0))));
  const trak = box("trak", tkhd, box("mdia", hdlr));
  return box("moov", mvhd, soundTrak, trak);
}

describe("image headers", () => {
  it("PNG, GIF, WebP (VP8X, VP8L)", () => {
    expect(imageSize(png(1080, 1350))).toEqual({ width: 1080, height: 1350 });
    expect(imageSize(gif(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageSize(webpVp8x(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(imageSize(webpVp8l(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("JPEG, with EXIF orientation applied", () => {
    expect(imageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpeg(4032, 3024, 1))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpeg(4032, 3024, 6))).toEqual({ width: 3024, height: 4032 }); // rotated 90°: portrait
  });

  it("unknown or truncated data", () => {
    expect(imageSize(new Uint8Array(10))).toBeNull();
    expect(imageSize(new Uint8Array(100))).toBeNull();
    expect(imageSize(jpeg(10, 10).subarray(0, 24))).toBeNull();
  });
});

describe("MP4/MOV boxes", () => {
  it("duration from mvhd, display size from the video track (rotation swaps)", () => {
    const m = new Uint8Array(moov(1920, 1080, 12_345));
    expect(parseMoov(m.subarray(8))).toEqual({ duration: 12.35, width: 1920, height: 1080 });
    const r = new Uint8Array(moov(1920, 1080, 30_000, true));
    expect(parseMoov(r.subarray(8))).toEqual({ duration: 30, width: 1080, height: 1920 });
  });

  it("finds moov after mdat (not fast-start) in a file", async () => {
    const ftyp = box("ftyp", ascii("isom"), be32(512), ascii("isommp41"));
    const mdat = box("mdat", new Array(5000).fill(7));
    const file = join(dir, "clip.mp4");
    writeFileSync(file, new Uint8Array([...ftyp, ...mdat, ...moov(1080, 1920, 15_000)]));
    expect(await fileInfo(file, "video/mp4")).toEqual({ duration: 15, width: 1080, height: 1920 });
    // Not an MP4: nothing.
    const bogus = new Uint8Array(64).fill(1);
    expect(await mp4Info({ size: 64, read: async (o, n) => bogus.subarray(o, o + n) })).toBeNull();
  });

  it("mime from the extension", () => {
    expect(mimeFromPath("a/b/Photo.JPG")).toBe("image/jpeg");
    expect(mimeFromPath("clip.mov")).toBe("video/quicktime");
    expect(mimeFromPath("doc.pdf")).toBeNull();
  });
});

describe("uploads", () => {
  it("plans equal parts, the last one shorter, numbered from 1", () => {
    expect(planParts(10, 4)).toEqual([
      { partNumber: 1, start: 0, end: 4 },
      { partNumber: 2, start: 4, end: 8 },
      { partNumber: 3, start: 8, end: 10 },
    ]);
    expect(planParts(8, 4)).toHaveLength(2);
    expect(planParts(1, 50 * 1024 * 1024)).toEqual([{ partNumber: 1, start: 0, end: 1 }]);
    expect(() => planParts(10, 0)).toThrow();
  });

  /** Fake API: records requests, reads streamed bodies. */
  function fakeServer(opts: { failPartOnce?: number; partSize?: number } = {}) {
    const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: Uint8Array | null }> = [];
    let failed = false;
    const fetch = async (url: string, init: any = {}) => {
      const u = new URL(url);
      const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null;
      calls.push({ method: init.method, path: u.pathname, headers: init.headers, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (init.method === "POST" && u.pathname === "/api/media") {
        return json({ id: "med_single", filename: decodeURIComponent(init.headers["x-filename"]), size: body!.length, alt: null });
      }
      if (init.method === "PATCH" && u.pathname === "/api/media/med_single") return json({ id: "med_single", alt: JSON.parse(new TextDecoder().decode(body!)).alt });
      if (init.method === "POST" && u.pathname === "/api/media/multipart") {
        const meta = JSON.parse(new TextDecoder().decode(body!));
        return json({ id: "med_multi", partSize: opts.partSize ?? 400, parts: Math.ceil(meta.size / (opts.partSize ?? 400)) });
      }
      const part = /^\/api\/media\/multipart\/med_multi\/(\d+)$/.exec(u.pathname);
      if (init.method === "PUT" && part) {
        if (Number(part[1]) === opts.failPartOnce && !failed) {
          failed = true;
          return json({ error: "temporary" }, 503);
        }
        return json({ partNumber: Number(part[1]), etag: `etag${part[1]}` });
      }
      if (init.method === "POST" && u.pathname === "/api/media/multipart/med_multi/complete") return json({ id: "med_multi", parts: JSON.parse(new TextDecoder().decode(body!)).parts });
      if (init.method === "DELETE") return json({ ok: true });
      return json({ error: "unexpected" }, 500);
    };
    return { calls, api: new Api("https://pf.test", "pf_test", fetch) };
  }

  it("single streamed request with metadata headers, then alt text", async () => {
    const file = join(dir, "photo.png");
    writeFileSync(file, png(1080, 1350));
    const { calls, api } = fakeServer();
    const progress: number[] = [];
    const m = await uploadFile(api, file, { alt: "A chart", onProgress: (s) => progress.push(s) });
    expect(m).toMatchObject({ id: "med_single", alt: "A chart" });
    expect(calls[0].headers).toMatchObject({ "content-type": "image/png", "content-length": "33", "x-filename": "photo.png", "x-width": "1080", "x-height": "1350", authorization: "Bearer pf_test" });
    expect(calls[0].body).toEqual(png(1080, 1350));
    expect(calls[1]).toMatchObject({ method: "PATCH", path: "/api/media/med_single" });
    expect(progress[progress.length - 1]).toBe(33);
  });

  it("multipart: streams every byte range, retries a failed part, completes with all etags", async () => {
    const file = join(dir, "big.mp4");
    const ftyp = box("ftyp", ascii("isom"), be32(512), ascii("isommp41"));
    const data = new Uint8Array([...ftyp, ...moov(1080, 1920, 9_000), ...box("mdat", Array.from({ length: 1000 }, (_, i) => i % 251))]);
    writeFileSync(file, data);
    const { calls, api } = fakeServer({ failPartOnce: 2, partSize: 400 });
    const m: any = await uploadFile(api, file, { singleUploadMax: 100, retries: 2 });
    const init = JSON.parse(new TextDecoder().decode(calls[0].body!));
    expect(init).toMatchObject({ filename: "big.mp4", mime: "video/mp4", size: data.length, width: 1080, height: 1920, duration: 9 });
    const parts = calls.filter((x) => x.method === "PUT");
    const expected = Math.ceil(data.length / 400);
    expect(parts).toHaveLength(expected + 1); // one retry
    const ok = parts.filter((p, i) => !(p.path.endsWith("/2") && i === 1));
    const joined = new Uint8Array(ok.flatMap((p) => [...p.body!]));
    expect(joined).toEqual(data);
    expect(ok.map((p) => p.headers["content-length"])).toEqual(ok.map((p) => String(p.body!.length)));
    expect(m.parts.map((p: any) => p.partNumber)).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
  }, 20_000);

  it("multipart: aborts (deletes) the upload when a part fails for good", async () => {
    const file = join(dir, "big2.mp4");
    writeFileSync(file, new Uint8Array(1000));
    const { calls, api } = fakeServer({ partSize: 400 });
    const broken = new Api("https://pf.test", "pf_test", async (url, init: any) => {
      if (init.method === "PUT") return new Response(JSON.stringify({ error: "Upload not found" }), { status: 404 });
      return (api as any).fetchImpl(url, init);
    });
    await expect(uploadFile(broken, file, { singleUploadMax: 100 })).rejects.toThrow("Upload not found");
    expect(calls.some((x) => x.method === "DELETE" && x.path === "/api/media/med_multi")).toBe(true);
  });

  it("rejects unsupported and missing files", async () => {
    const { api } = fakeServer();
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "hi");
    await expect(uploadFile(api, txt)).rejects.toThrow(/unsupported file type/);
    await expect(uploadFile(api, join(dir, "missing.jpg"))).rejects.toThrow(/File not found/);
  });
});
