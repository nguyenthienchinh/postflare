import { str } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { c, eprintln, fmtBytes, fmtDate, fmtDuration, println, printJson, table } from "../format.js";
import type { MediaDTO } from "../types.js";
import { progressBar, uploadFile } from "../upload.js";

/** Upload files one by one with a progress bar (TTY, not --json). */
export async function uploadAll(ctx: Ctx, files: string[], alt?: string): Promise<MediaDTO[]> {
  const out: MediaDTO[] = [];
  for (const f of files) {
    const bar = ctx.json ? { onProgress: () => {}, done: () => {} } : progressBar(f.split("/").pop() ?? f);
    try {
      out.push(await uploadFile(ctx.api, f, { alt, onProgress: bar.onProgress }));
    } finally {
      bar.done();
    }
    if (!ctx.json) eprintln(`${c.green("✓")} Uploaded ${f} → ${c.bold(out[out.length - 1].id)}`);
  }
  return out;
}

const dims = (m: MediaDTO) => (m.width && m.height ? `${m.width}x${m.height}` : "");

function mediaTable(rows: MediaDTO[]) {
  return table(
    [
      { header: "ID" },
      { header: "KIND" },
      { header: "FILENAME", flex: true },
      { header: "SIZE", align: "right" },
      { header: "DIMENSIONS" },
      { header: "LENGTH", align: "right" },
      { header: "ALT", flex: true },
      { header: "CREATED" },
    ],
    rows.map((m) => [m.id, m.kind, m.filename, fmtBytes(m.size), dims(m), m.kind === "video" ? fmtDuration(m.duration) : "", m.alt ?? "", fmtDate(m.createdAt)]),
  );
}

export const mediaUpload: Command = {
  name: "media upload",
  args: "<files...>",
  summary: "Upload images/videos to the media library (streamed; files over 90MB use multipart, up to 5GB).",
  description: "Width/height (JPEG, PNG, WebP, GIF) and video duration/size (MP4, MOV) are read from the file headers.",
  options: { alt: { type: "string", arg: "<text>", description: "Alt text (applied to every file)" } },
  min: 1,
  examples: ["postflare media upload photo.jpg", "postflare media upload clip.mp4 --alt \"Demo of the new feature\"", "postflare media upload *.jpg --json"],
  async run(ctx, { values, positionals }) {
    const media = await uploadAll(ctx, positionals, str(values.alt));
    if (ctx.json) return printJson(media);
    println(mediaTable(media));
  },
};

export const mediaList: Command = {
  name: "media list",
  summary: "List the media library (newest first).",
  options: { limit: { type: "string", arg: "<n>", description: "How many (default 30, max 200)" } },
  max: 0,
  async run(ctx, { values }) {
    const rows = await ctx.api.get<MediaDTO[]>("/media", { limit: Number(str(values.limit)) || 30 });
    if (ctx.json) return printJson(rows);
    if (!rows.length) return println("The media library is empty. Upload with: postflare media upload <files>");
    println(mediaTable(rows));
  },
};

export const mediaAlias: Command = { ...mediaList, name: "media", hidden: true };

export const mediaImport: Command = {
  name: "media import",
  args: "<url>",
  summary: "Import an image or video from a public URL into the media library.",
  options: {
    filename: { type: "string", arg: "<name>", description: "File name to store (default: from the URL)" },
    alt: { type: "string", arg: "<text>", description: "Alt text" },
  },
  min: 1,
  max: 1,
  examples: ["postflare media import https://example.com/launch.jpg --alt \"Launch banner\""],
  async run(ctx, { values, positionals }) {
    const m = await ctx.api.post<MediaDTO>("/media/from-url", { url: positionals[0], filename: str(values.filename), alt: str(values.alt) });
    if (ctx.json) return printJson(m);
    println(`${c.green("✓")} Imported ${c.bold(m.id)}`);
    println(mediaTable([m]));
  },
};

export const mediaRm: Command = {
  name: "media rm",
  args: "<ids...>",
  summary: "Delete media from the library (posts that already use them keep their copies on the platforms).",
  min: 1,
  async run(ctx, { positionals }) {
    for (const id of positionals) await ctx.api.delete(`/media/${encodeURIComponent(id)}`);
    if (ctx.json) return printJson({ deleted: positionals });
    println(`${c.green("✓")} Deleted ${positionals.join(", ")}`);
  },
};
