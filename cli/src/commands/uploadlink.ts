import { str } from "../args.js";
import type { Command } from "../context.js";
import { c, eprintln, fmtWhen, println, printJson } from "../format.js";
import type { MediaDTO } from "../types.js";

interface LinkDTO {
  id: string;
  pageUrl: string;
  putUrl: string;
  expiresAt: number;
}

interface LinkStatus {
  id: string;
  note: string | null;
  expiresAt: number;
  expired: boolean;
  media: MediaDTO[];
}

export const uploadLink: Command = {
  name: "upload-link",
  summary: "Create a one-time upload page (e.g. to send photos from a phone) and optionally wait for the files.",
  description:
    "Open pageUrl on any device and pick files, or PUT bytes to putUrl (headers Content-Type, X-Filename; ≤90MB).\n" +
    "--wait polls until files arrive (and stop arriving for ~10s), then prints their media ids.",
  options: {
    note: { type: "string", arg: "<text>", description: "Shown on the upload page, e.g. what to upload" },
    expires: { type: "string", arg: "<minutes>", description: "Validity (default 120, max 10080)" },
    wait: { type: "boolean", description: "Wait for uploads and print the media ids" },
    timeout: { type: "string", arg: "<minutes>", description: "Stop waiting after this long (default: until the link expires)" },
  },
  max: 0,
  examples: ["postflare upload-link --note \"Photos for Friday's post\" --wait"],
  async run(ctx, { values }) {
    const link = await ctx.api.post<LinkDTO>("/upload-links", { note: str(values.note), expiresMinutes: Number(str(values.expires)) || undefined });
    if (!values.wait) {
      if (ctx.json) return printJson(link);
      println(`Upload page: ${c.bold(c.cyan(link.pageUrl))}`);
      println(`PUT URL:     ${link.putUrl}`);
      println(c.gray(`Expires ${fmtWhen(link.expiresAt)}. Uploaded files appear in: postflare media list (or use --wait).`));
      return;
    }
    // Always on stderr (also with --json): whoever runs this needs the URL while it waits.
    eprintln(`Upload page: ${c.bold(c.cyan(link.pageUrl))}`);
    eprintln(c.gray(`Waiting for files (Ctrl-C to stop)...`));
    const deadline = Math.min(link.expiresAt, Number(str(values.timeout)) ? Date.now() + Number(str(values.timeout)) * 60_000 : Infinity);
    let seen = 0;
    let stableSince = 0;
    let status: LinkStatus | null = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      status = await ctx.api.get<LinkStatus>(`/upload-links/${link.id}`);
      if (status.media.length > seen) {
        for (const m of status.media.slice(seen)) if (!ctx.json) eprintln(`${c.green("✓")} ${m.filename} → ${c.bold(m.id)}`);
        seen = status.media.length;
        stableSince = Date.now();
      }
      if (seen && Date.now() - stableSince >= 10_000) break;
      if (status.expired || Date.now() > deadline) break;
    }
    const ids = status?.media.map((m) => m.id) ?? [];
    if (ctx.json) return printJson({ ...link, media: status?.media ?? [] });
    if (!ids.length) {
      process.exitCode = 1;
      return eprintln("No files were uploaded.");
    }
    println(ids.join(" "));
  },
};
