// File type and dimensions without dependencies: image headers (JPEG/PNG/WebP/GIF) and MP4/MOV boxes.

import { open } from "node:fs/promises";
import { extname } from "node:path";

export const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  qt: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
};

export function mimeFromPath(path: string): string | null {
  return EXT_MIME[extname(path).slice(1).toLowerCase()] ?? null;
}

export interface MediaInfo {
  width?: number;
  height?: number;
  /** Seconds (videos). */
  duration?: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** EXIF orientation (1-8) from an APP1 segment payload, or 1. */
function exifOrientation(seg: Uint8Array): number {
  if (seg.length < 14 || ascii(seg, 0, 6) !== "Exif\0\0") return 1;
  const t = 6;
  const le = ascii(seg, t, 2) === "II";
  const r16 = (o: number) => (le ? u16le(seg, t + o) : u16be(seg, t + o));
  const r32 = (o: number) => (le ? (u16le(seg, t + o) | (u16le(seg, t + o + 2) << 16)) >>> 0 : u32be(seg, t + o));
  const ifd = r32(4);
  if (t + ifd + 2 > seg.length) return 1;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (t + e + 12 > seg.length) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/**
 * Width/height from the first bytes of an image (JPEG, PNG, GIF, WebP), null when unknown. JPEG dimensions follow the
 * EXIF orientation (like browsers do), so a portrait phone photo is reported as portrait.
 */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24) return null;
  // PNG: signature, IHDR first.
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") return { width: u32be(b, 16), height: u32be(b, 20) };
  // GIF
  if (ascii(b, 0, 4) === "GIF8") return { width: u16le(b, 6), height: u16le(b, 8) };
  // WebP
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP" && b.length >= 30) {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG: walk the segments to the first SOFn.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    let orientation = 1;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) return null;
      const marker = b[o + 1];
      if (marker === 0xff) {
        o++; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = u16be(b, o + 2);
      if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b.subarray(o + 4, o + 2 + len));
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) {
        if (o + 9 > b.length) return null;
        const height = u16be(b, o + 5);
        const width = u16be(b, o + 7);
        return orientation >= 5 ? { width: height, height: width } : { width, height };
      }
      if (marker === 0xda || marker === 0xd9) return null; // start of scan / end: no SOF before
      o += 2 + len;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// MP4 / MOV (ISO BMFF): duration from moov/mvhd, display size from the video track's tkhd (rotation applied).

interface Reader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

interface Box {
  type: string;
  start: number;
  /** Payload offset and end (absolute). */
  data: number;
  end: number;
}

/** Child boxes of a buffer region. */
function boxesIn(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > to) break;
      size = u32be(b, o + 8) * 2 ** 32 + u32be(b, o + 12);
      header = 16;
    } else if (size === 0) size = to - o;
    if (size < header || o + size > to) break;
    out.push({ type, start: o, data: o + header, end: o + size });
    o += size;
  }
  return out;
}

/** Parse a `moov` box payload. */
export function parseMoov(b: Uint8Array): MediaInfo {
  const info: MediaInfo = {};
  const top = boxesIn(b, 0, b.length);
  const mvhd = top.find((x) => x.type === "mvhd");
  if (mvhd) {
    const v = b[mvhd.data];
    const p = mvhd.data + 4;
    const timescale = v === 1 ? u32be(b, p + 16) : u32be(b, p + 8);
    const duration = v === 1 ? u32be(b, p + 20) * 2 ** 32 + u32be(b, p + 24) : u32be(b, p + 12);
    if (timescale && duration && duration !== 0xffffffff) info.duration = Math.round((duration / timescale) * 100) / 100;
  }
  for (const trak of top.filter((x) => x.type === "trak")) {
    const kids = boxesIn(b, trak.data, trak.end);
    const tkhd = kids.find((x) => x.type === "tkhd");
    const mdia = kids.find((x) => x.type === "mdia");
    const hdlr = mdia && boxesIn(b, mdia.data, mdia.end).find((x) => x.type === "hdlr");
    if (hdlr && ascii(b, hdlr.data + 8, 4) !== "vide") continue;
    if (!tkhd) continue;
    // tkhd ends with: matrix (36 bytes), width (16.16), height (16.16).
    const w = u32be(b, tkhd.end - 8) / 65536;
    const h = u32be(b, tkhd.end - 4) / 65536;
    if (!w || !h) continue;
    const m = tkhd.end - 8 - 36;
    const a = u32be(b, m) | 0;
    const bb = u32be(b, m + 4) | 0;
    const rotated = a === 0 && Math.abs(bb) === 0x10000; // 90° or 270°
    info.width = Math.round(rotated ? h : w);
    info.height = Math.round(rotated ? w : h);
    break;
  }
  return info;
}

/** Find `moov` among the top-level boxes (it can be at the end of the file) and parse it. */
export async function mp4Info(r: Reader, maxMoov = 64 * 1024 * 1024): Promise<MediaInfo | null> {
  let o = 0;
  for (let i = 0; i < 1000 && o + 8 <= r.size; i++) {
    const h = await r.read(o, 16);
    if (h.length < 8) return null;
    let size = u32be(h, 0);
    const type = ascii(h, 4, 4);
    let header = 8;
    if (size === 1) {
      size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
      header = 16;
    } else if (size === 0) size = r.size - o;
    if (size < header) return null;
    if (i === 0 && type !== "ftyp" && type !== "wide" && type !== "mdat" && type !== "moov" && type !== "free") return null;
    if (type === "moov") {
      if (size - header > maxMoov) return null;
      return parseMoov(await r.read(o + header, size - header));
    }
    o += size;
  }
  return null;
}

/** Dimensions/duration of a local file; {} when unknown (the upload works without them). */
export async function fileInfo(path: string, mime: string): Promise<MediaInfo> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const read = async (offset: number, length: number) => {
      const buf = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return buf.subarray(0, bytesRead);
    };
    if (mime.startsWith("image/")) {
      // SOF usually comes within the first few KB, after EXIF (≤64KB per segment) and thumbnails.
      return imageSize(await read(0, 512 * 1024)) ?? {};
    }
    if (mime === "video/mp4" || mime === "video/quicktime" || mime === "video/x-m4v") {
      return (await mp4Info({ size, read })) ?? {};
    }
    return {};
  } catch {
    return {};
  } finally {
    await fh.close();
  }
}
