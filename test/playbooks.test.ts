import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLAYBOOK_SECTIONS, SOURCES_SECTION, checklistOf, matchesPlatform, parsePlaybook, sectionsOf, serializePlaybook, splitFrontmatter } from "../shared/playbooks";
import {
  STATS_MAX_POSTS,
  agentPrompt,
  builtinErrors,
  builtinPlaybooks,
  computePlaybookStats,
  confidence,
  getBuiltin,
  median,
  playbookDto,
  searchPlaybooks,
  validatePlaybookInput,
  type StatsPostRow,
} from "../worker/lib/playbooks";
import { getProvider } from "../worker/providers/registry";

describe("built-in playbooks", () => {
  const files = readdirSync("playbooks").filter((f) => f.endsWith(".md"));

  it("are all bundled and valid", () => {
    expect(builtinErrors()).toEqual([]);
    expect(files.length).toBeGreaterThanOrEqual(18);
    expect(builtinPlaybooks().length).toBe(files.length);
  });

  it("have unique kebab ids matching their file names", () => {
    const ids = builtinPlaybooks().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of builtinPlaybooks()) expect(files).toContain(`${p.id}.md`);
  });

  it("have every required section in order, a checklist, hooks and examples", () => {
    for (const p of builtinPlaybooks()) {
      const sections = sectionsOf(p.body);
      expect(sections.map((s) => s.title), p.id).toEqual([...PLAYBOOK_SECTIONS, SOURCES_SECTION]);
      // Built-ins cite what backs their claims.
      expect(sections.at(-1)!.content.match(/https?:\/\//g)?.length ?? 0, `${p.id}: sources`).toBeGreaterThanOrEqual(3);
      for (const s of sections) expect(s.content.length, `${p.id}: ${s.title}`).toBeGreaterThan(40);
      expect(checklistOf(p.body).length, p.id).toBeGreaterThanOrEqual(5);
      expect(p.summary.length, p.id).toBeLessThanOrEqual(160);
      expect(p.inputs.length, p.id).toBeGreaterThan(0);
    }
  });

  it("only target known platforms", () => {
    const groups = ["all", "short-video", "microblog", "professional", "visual"];
    for (const p of builtinPlaybooks()) for (const x of p.platforms) expect(groups.includes(x) || !!getProvider(x), `${p.id}: ${x}`).toBe(true);
  });

  it("include several for mobile apps and games", () => {
    const mobile = builtinPlaybooks().filter((p) => p.tags.includes("mobile-app") || p.tags.includes("game"));
    expect(mobile.length).toBeGreaterThanOrEqual(5);
  });

  it("round-trip through serializePlaybook", () => {
    for (const p of builtinPlaybooks()) {
      const again = parsePlaybook(serializePlaybook({ ...p, id: p.slug }, p.body));
      expect(again.errors, p.id).toEqual([]);
      expect(again.meta).toMatchObject({ id: p.id, name: p.name, goal: p.goal, platforms: p.platforms, formats: p.formats, tags: p.tags, inputs: p.inputs });
    }
  });

  it("build an agent prompt with the workspace accounts and the attribution", () => {
    const p = getBuiltin("launch-announcement")!;
    const dto = playbookDto(p, [
      { id: "acc_x", provider: "x", name: "Tempo", username: "tempoapp" },
      { id: "acc_pin", provider: "pinterest", name: "Pins", username: null },
    ]);
    expect(dto.prompt).toContain('playbookId "launch-announcement"');
    expect(dto.prompt).toContain("pf post --playbook launch-announcement@2");
    expect(dto.prompt).toContain("acc_x");
    expect(dto.prompt).toContain("<playbook>");
    expect(dto.checklist.length).toBeGreaterThan(0);
    expect(dto.markdown.startsWith("---\nid: launch-announcement\n")).toBe(true);
    // Without accounts.read: no account section.
    expect(agentPrompt(p, null)).not.toContain("Target accounts");
  });
});

describe("frontmatter parsing", () => {
  it("parses scalars, quoted values and inline lists", () => {
    const { meta, body } = splitFrontmatter('---\nid: x\nname: "Hello: world"\ntags: [a, "b c", ]\nempty: []\n---\n\n## Body\ntext');
    expect(meta).toEqual({ id: "x", name: "Hello: world", tags: ["a", "b c"], empty: [] });
    expect(body).toBe("## Body\ntext");
  });

  it("reports what is wrong", () => {
    const { errors } = parsePlaybook("---\nid: Bad Id\ngoal: fame\nformats: [gif]\n---\n## When to use\nx");
    expect(errors.join("\n")).toMatch(/kebab-case/);
    expect(errors.join("\n")).toMatch(/goal must be one of/);
    expect(errors.join("\n")).toMatch(/unknown format "gif"/);
    expect(errors.join("\n")).toMatch(/sections must be exactly/);
  });

  it("ignores ## inside code fences when splitting sections", () => {
    expect(sectionsOf("## A\n```\n## not a heading\n```\n## B\nb").map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("matches platforms and groups", () => {
    expect(matchesPlatform(["short-video"], "tiktok")).toBe(true);
    expect(matchesPlatform(["short-video"], "x")).toBe(false);
    expect(matchesPlatform(["x"], "microblog")).toBe(true);
    expect(matchesPlatform(["all"], "reddit")).toBe(true);
    expect(matchesPlatform([], "reddit")).toBe(true);
  });
});

describe("search", () => {
  const all = builtinPlaybooks();

  it("ranks name and tag matches first", () => {
    expect(searchPlaybooks(all, { q: "game clip" })[0].id).toBe("game-clip-hook");
    expect(searchPlaybooks(all, { q: "launch" })[0].id).toBe("launch-announcement");
    expect(searchPlaybooks(all, { q: "thread" })[0].id).toBe("text-thread");
  });

  it("requires every word to match", () => {
    expect(searchPlaybooks(all, { q: "zzqx launch" })).toEqual([]);
  });

  it("filters by platform (ids and groups), goal and format", () => {
    const tiktok = searchPlaybooks(all, { platform: "tiktok" });
    expect(tiktok.some((p) => p.id === "short-video-hook-script")).toBe(true);
    expect(tiktok.some((p) => p.id === "linkedin-story-post")).toBe(false);
    for (const p of searchPlaybooks(all, { goal: "clicks" })) expect(p.goal).toBe("clicks");
    for (const p of searchPlaybooks(all, { format: "carousel" })) expect(p.formats).toContain("carousel");
    expect(searchPlaybooks(all, { platform: "professional" }).some((p) => p.id === "linkedin-story-post")).toBe(true);
  });

  it("lists everything without filters", () => {
    expect(searchPlaybooks(all, {}).length).toBe(all.length);
  });
});

describe("custom playbook input", () => {
  it("merges a markdown file and fields, and derives the slug", () => {
    const md = readFileSync("playbooks/how-to-tip.md", "utf8");
    const v = validatePlaybookInput({ markdown: md.replace("id: how-to-tip", "id: our-tip"), name: "Our how-to tip" });
    expect(v).toMatchObject({ fields: { slug: "our-tip", name: "Our how-to tip", goal: getBuiltin("how-to-tip")!.goal, tags: getBuiltin("how-to-tip")!.tags } });
    // A built-in id cannot be a custom slug.
    expect(validatePlaybookInput({ markdown: md })).toEqual({ errors: ['slug "how-to-tip" is the id of a built-in playbook'] });
  });

  it("refuses built-in slugs, unknown platforms and empty bodies", () => {
    const v = validatePlaybookInput({ name: "X", slug: "how-to-tip", platforms: ["myspace"], body: "" });
    expect("errors" in v && v.errors.join("\n")).toMatch(/built-in playbook[\s\S]*unknown platform "myspace"[\s\S]*body is required/);
  });

  it("strips commas from list items (frontmatter list separator)", () => {
    const v = validatePlaybookInput({ name: "Tips", inputs: ["app name, platform"], body: "## When to use\nx" });
    expect("fields" in v && v.fields.inputs).toEqual(["app name; platform"]);
    expect("fields" in v && v.fields.slug).toBe("tips");
  });
});

describe("stats math", () => {
  const row = (account: string, playbook: string | null, eng: number, exp: number | null, version = 1, variant: string | null = null): StatsPostRow => ({
    account_id: account,
    playbook_id: playbook,
    playbook_version: playbook ? version : null,
    variant,
    eng,
    exp,
  });

  it("median and confidence", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect([confidence(0), confidence(4), confidence(5), confidence(19), confidence(20)]).toEqual(["insufficient", "insufficient", "low", "low", "ok"]);
  });

  it("computes lift against each account's no-playbook median", () => {
    // Account a: baseline rate 0.02 (no-playbook posts), playbook posts at 0.03 → lift +50%.
    // Account b: baseline rate 0.10, playbook posts at 0.08 → lift −20%.
    const rows = [
      row("a", null, 20, 1000),
      row("a", null, 10, 1000),
      row("a", null, 30, 1000),
      row("a", "p1", 30, 1000),
      row("a", "p1", 60, 2000),
      row("b", null, 100, 1000),
      row("b", null, 100, 1000),
      row("b", null, 100, 1000),
      row("b", "p1", 80, 1000),
    ];
    const s = computePlaybookStats(rows, (id) => ({ name: id.toUpperCase(), builtin: false }));
    const p1 = s.playbooks[0];
    expect(p1).toMatchObject({ playbookId: "p1", name: "P1", posts: 3, accounts: 2, liftPosts: 3, confidence: "insufficient" });
    // Lifts 1.5, 1.5, 0.8 → median 1.5 → +0.5.
    expect(p1.lift).toBeCloseTo(0.5);
    expect(p1.medianEngagementRate).toBeCloseTo(0.03);
    expect(p1.meanEngagementRate).toBeCloseTo((0.03 + 0.03 + 0.08) / 3);
    expect(p1.medianViews).toBe(1000);
    expect(s.baseline).toMatchObject({ playbookId: null, posts: 6, accounts: 2 });
    expect(s.baseline.lift).toBeCloseTo(0);
    expect(s.postsAnalyzed).toBe(9);
  });

  it("falls back to all posts of an account when it has too few without a playbook", () => {
    // Only one no-playbook post: baseline = median of all four rates (0.01, 0.02, 0.03, 0.04) = 0.025.
    const rows = [row("a", null, 10, 1000), row("a", "p", 20, 1000), row("a", "p", 30, 1000), row("a", "p", 40, 1000)];
    const s = computePlaybookStats(rows, () => ({ name: "P", builtin: true }));
    expect(s.playbooks[0].lift).toBeCloseTo(0.03 / 0.025 - 1);
  });

  it("uses raw engagements for platforms without exposure", () => {
    const rows = [row("bsky", null, 10, null), row("bsky", null, 10, null), row("bsky", null, 10, null), row("bsky", "p", 25, null)];
    const s = computePlaybookStats(rows, () => ({ name: "P", builtin: true }));
    expect(s.playbooks[0].lift).toBeCloseTo(1.5);
    expect(s.playbooks[0].medianEngagementRate).toBeNull();
  });

  it("splits versions and variants, and ranks rows with enough posts first", () => {
    const rows: StatsPostRow[] = [];
    for (let i = 0; i < 6; i++) rows.push(row("a", null, 10, 1000));
    for (let i = 0; i < 6; i++) rows.push(row("a", "steady", 12, 1000, i < 3 ? 1 : 2, i % 2 ? "A" : "B"));
    for (let i = 0; i < 2; i++) rows.push(row("a", "lucky", 50, 1000));
    const s = computePlaybookStats(rows, (id) => ({ name: id, builtin: true }));
    expect(s.playbooks.map((p) => p.playbookId)).toEqual(["steady", "lucky"]);
    const steady = s.playbooks[0];
    expect(steady.confidence).toBe("low");
    expect(steady.versions.map((v) => [v.version, v.posts])).toEqual([
      [2, 3],
      [1, 3],
    ]);
    expect(steady.variants.map((v) => [v.variant, v.posts])).toEqual([
      ["A", 3],
      ["B", 3],
    ]);
    expect(s.playbooks[1].variants).toEqual([]);
  });

  it("stays fast at the row cap", () => {
    const rows: StatsPostRow[] = [];
    for (let i = 0; i < STATS_MAX_POSTS; i++) rows.push(row(`acc${i % 40}`, i % 3 ? `pb${i % 20}` : null, (i * 7) % 90, 1000 + ((i * 13) % 5000), 1 + (i % 2), i % 4 ? null : "A"));
    const t = performance.now();
    computePlaybookStats(rows, (id) => ({ name: id, builtin: true }));
    // Generous bound for slow CI machines; typically ~1–3 ms.
    expect(performance.now() - t).toBeLessThan(50);
  });
});
