// Playbook files: Markdown with a small YAML-like frontmatter (one `key: value` per line, inline `[a, b]` lists).
// Shared by the worker (built-ins bundled from playbooks/*.md, custom playbooks), the web app and the tests.

import type { PlaybookFormat, PlaybookGoal } from "./types";

export const PLAYBOOK_GOALS: readonly PlaybookGoal[] = ["engagement", "reach", "clicks", "followers", "conversions"];
export const PLAYBOOK_FORMATS: readonly PlaybookFormat[] = ["text", "thread", "image", "carousel", "video"];
/** Body sections of a built-in playbook, in this order (custom playbooks may deviate). */
export const PLAYBOOK_SECTIONS = ["When to use", "Structure", "Platform notes", "Hooks", "Examples", "Avoid", "Checklist"] as const;
/** Optional last section: links backing the playbook's claims (every built-in has one). */
export const SOURCES_SECTION = "Sources";

/** Platform groups usable in `platforms` next to provider ids. */
export const PLATFORM_GROUPS: Record<string, { label: string; providers: string[] }> = {
  all: { label: "All platforms", providers: [] },
  "short-video": { label: "Short video (TikTok, Shorts, Reels)", providers: ["tiktok", "tiktok_business", "youtube", "instagram", "instagram_standalone", "facebook"] },
  microblog: { label: "Microblogs (X, Bluesky, Threads, Mastodon)", providers: ["x", "bluesky", "threads", "mastodon", "farcaster", "nostr"] },
  professional: { label: "LinkedIn", providers: ["linkedin", "linkedin_page"] },
  visual: { label: "Visual (Instagram, Pinterest)", providers: ["instagram", "instagram_standalone", "pinterest"] },
};

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Does a playbook targeting `platforms` (ids and groups) apply to `platform` (a provider id or a group)? */
export function matchesPlatform(platforms: readonly string[], platform: string): boolean {
  if (!platforms.length || platforms.includes("all") || platforms.includes(platform)) return true;
  const wanted = PLATFORM_GROUPS[platform]?.providers ?? [platform];
  return platforms.some((p) => (PLATFORM_GROUPS[p]?.providers ?? [p]).some((id) => wanted.includes(id)));
}

export interface PlaybookMeta {
  id: string;
  version: number;
  name: string;
  summary: string;
  goal: PlaybookGoal;
  platforms: string[];
  formats: PlaybookFormat[];
  tags: string[];
  inputs: string[];
}

const unquote = (s: string) => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};

function parseValue(raw: string): string | string[] {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map(unquote).filter(Boolean) : [];
  }
  return unquote(v);
}

/** Splits `---` frontmatter from the body. No frontmatter: empty meta, the whole text is the body. */
export function splitFrontmatter(markdown: string): { meta: Record<string, string | string[]>; body: string } {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = parseValue(line.slice(i + 1));
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);
const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(", ") : (v ?? "")).trim();

/** `## Heading` sections of a body, in order (text before the first heading is ignored). */
export function sectionsOf(body: string): Array<{ title: string; content: string }> {
  const out: Array<{ title: string; content: string }> = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^## (?!#)(.+?)\s*$/.exec(line);
    if (h) out.push({ title: h[1].trim(), content: "" });
    else if (out.length) out[out.length - 1].content += line + "\n";
  }
  return out.map((s) => ({ title: s.title, content: s.content.trim() }));
}

/** Items of the Checklist section (`- [ ] ...` or plain `- ...` lines). */
export function checklistOf(body: string): string[] {
  const section = sectionsOf(body).find((s) => /^checklist/i.test(s.title));
  if (!section) return [];
  return section.content
    .split("\n")
    .map((l) => /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x);
}

/**
 * Parses and validates a playbook file. `strict` (built-ins) also requires the seven sections in order and a
 * version; otherwise only the metadata is checked.
 */
export function parsePlaybook(markdown: string, strict = true): { meta: PlaybookMeta; body: string; errors: string[] } {
  const { meta: m, body } = splitFrontmatter(markdown);
  const errors: string[] = [];
  const id = str(m.id);
  const version = Number(str(m.version) || (strict ? NaN : 1));
  const goal = str(m.goal) as PlaybookGoal;
  const formats = list(m.formats) as PlaybookFormat[];
  const meta: PlaybookMeta = {
    id,
    version,
    name: str(m.name),
    summary: str(m.summary),
    goal,
    platforms: list(m.platforms),
    formats,
    tags: list(m.tags).map((t) => t.toLowerCase()),
    inputs: list(m.inputs),
  };
  if (strict && !SLUG_RE.test(id)) errors.push(`id must be kebab-case (got "${id}")`);
  if (!Number.isInteger(version) || version < 1) errors.push("version must be a positive integer");
  if (!meta.name) errors.push("name is required");
  if (meta.name.length > 80) errors.push("name is longer than 80 characters");
  if (strict && !meta.summary) errors.push("summary is required");
  if (meta.summary.length > 300) errors.push("summary is longer than 300 characters");
  if (!PLAYBOOK_GOALS.includes(goal)) errors.push(`goal must be one of ${PLAYBOOK_GOALS.join(", ")}`);
  for (const f of formats) if (!PLAYBOOK_FORMATS.includes(f)) errors.push(`unknown format "${f}"`);
  if (strict && !meta.platforms.length) errors.push("platforms is required");
  if (strict && !formats.length) errors.push("formats is required");
  if (!body.trim()) errors.push("body is empty");
  if (strict) {
    const titles = sectionsOf(body).map((s) => s.title);
    const core = titles[titles.length - 1] === SOURCES_SECTION ? titles.slice(0, -1) : titles;
    if (core.join("|") !== PLAYBOOK_SECTIONS.join("|"))
      errors.push(`sections must be exactly: ${PLAYBOOK_SECTIONS.join(", ")}, optionally followed by ${SOURCES_SECTION} (got ${titles.join(", ") || "none"})`);
    if (!checklistOf(body).length) errors.push("the Checklist section has no items");
  }
  return { meta, body, errors };
}

/** The playbook as a file (frontmatter + body). */
export function serializePlaybook(meta: PlaybookMeta, body: string): string {
  const l = (xs: string[]) => `[${xs.join(", ")}]`;
  return [
    "---",
    `id: ${meta.id}`,
    `version: ${meta.version}`,
    `name: ${meta.name}`,
    `summary: ${meta.summary}`,
    `goal: ${meta.goal}`,
    `platforms: ${l(meta.platforms)}`,
    `formats: ${l(meta.formats)}`,
    `tags: ${l(meta.tags)}`,
    `inputs: ${l(meta.inputs)}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}
