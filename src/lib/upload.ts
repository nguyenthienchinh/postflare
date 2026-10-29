import { ApiError, UNAUTHORIZED_EVENT, planLimitError, request, workspaceHeaders } from "./api";
import type { MediaDTO } from "./types";

const SINGLE_UPLOAD_MAX = 90 * 1024 * 1024;

export const ACCEPTED_MEDIA = "image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,image/avif,video/mp4,video/quicktime,video/webm,video/x-m4v,video/mpeg";

const EXT_MIME: Record<string, string> = {
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
  webm: "video/webm",
  m4v: "video/x-m4v",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
};

export function mimeOf(file: File): string {
  if (file.type) return file.type;
  return EXT_MIME[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export function isMediaFile(file: File): boolean {
  return /^(image|video)\//.test(mimeOf(file));
}

interface Meta {
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** Read dimensions / duration in the browser; null values when the browser cannot decode the file (e.g. HEIC). */
export function readMeta(file: File): Promise<Meta> {
  const mime = mimeOf(file);
  const url = URL.createObjectURL(file);
  const done = (m: Meta) => {
    URL.revokeObjectURL(url);
    return m;
  };
  const empty: Meta = { width: null, height: null, duration: null };
  return new Promise<Meta>((resolve) => {
    const timer = setTimeout(() => resolve(done(empty)), 10000);
    if (mime.startsWith("video/")) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve(
          done({
            width: v.videoWidth || null,
            height: v.videoHeight || null,
            duration: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
          }),
        );
      };
      v.onerror = () => {
        clearTimeout(timer);
        resolve(done(empty));
      };
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => {
        clearTimeout(timer);
        resolve(done({ width: img.naturalWidth || null, height: img.naturalHeight || null, duration: null }));
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(done(empty));
      };
      img.src = url;
    }
  });
}

function xhr<T>(
  method: string,
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.withCredentials = true;
    for (const [k, v] of Object.entries({ ...workspaceHeaders(), ...headers })) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(x.responseText);
      } catch {
        /* not json */
      }
      if (x.status >= 200 && x.status < 300) resolve(data as T);
      else {
        if (x.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        const limit = planLimitError(x.status, data);
        if (limit) return reject(limit);
        reject(new ApiError((data as { error?: string } | null)?.error ?? `Upload failed (${x.status})`, x.status));
      }
    };
    x.onerror = () => reject(new ApiError("Network error during upload", 0));
    x.onabort = () => reject(new ApiError("Upload cancelled", 0));
    signal?.addEventListener("abort", () => x.abort());
    x.send(body);
  });
}

/**
 * Upload a file to the media library. Files up to 90MB go in one request,
 * bigger files use R2 multipart (parts uploaded sequentially). `onProgress` gets 0..1.
 */
export async function uploadFile(file: File, onProgress: (p: number) => void, signal?: AbortSignal): Promise<MediaDTO> {
  const mime = mimeOf(file);
  if (!/^(image|video)\//.test(mime)) throw new Error(`${file.name}: only images and videos are supported`);
  const meta = await readMeta(file);
  onProgress(0);

  if (file.size <= SINGLE_UPLOAD_MAX) {
    const headers: Record<string, string> = { "content-type": mime, "x-filename": encodeURIComponent(file.name) };
    if (meta.width) headers["x-width"] = String(meta.width);
    if (meta.height) headers["x-height"] = String(meta.height);
    if (meta.duration) headers["x-duration"] = String(meta.duration);
    const res = await xhr<MediaDTO>("POST", "/api/media", file, headers, (l) => onProgress(l / file.size), signal);
    onProgress(1);
    return res;
  }

  const init = await request<{ id: string; partSize: number; parts: number }>("POST", "/media/multipart", {
    filename: file.name,
    mime,
    size: file.size,
    ...meta,
  });
  const uploaded: Array<{ partNumber: number; etag: string }> = [];
  try {
    for (let i = 0; i < init.parts; i++) {
      const start = i * init.partSize;
      const slice = file.slice(start, Math.min(start + init.partSize, file.size));
      const part = await xhr<{ partNumber: number; etag: string }>(
        "PUT",
        `/api/media/multipart/${init.id}/${i + 1}`,
        slice,
        { "content-type": "application/octet-stream" },
        (l) => onProgress(Math.min(0.99, (start + l) / file.size)),
        signal,
      );
      uploaded.push(part);
    }
    const res = await request<MediaDTO>("POST", `/media/multipart/${init.id}/complete`, { parts: uploaded });
    onProgress(1);
    return res;
  } catch (err) {
    // Abort the dangling upload so it does not linger in the library.
    await request("DELETE", `/media/${init.id}`).catch(() => {});
    throw err;
  }
}
