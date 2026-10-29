import { describe, expect, it } from "vitest";
import {
  MAX_CAMPAIGN_TOKEN,
  appStoreCampaignUrl,
  bioCampaignToken,
  findAppStoreUrls,
  isValidCampaignToken,
  newLinkCode,
  platformShort,
  postCampaignToken,
  LINK_CODE_RE,
} from "../shared/campaigns";
import { isBot, rewriteForCampaign } from "../worker/lib/campaigns";
import { isInternalHost, normalizeRevflareUrl } from "../worker/lib/revflare";
import { getProvider, providers } from "../worker/providers/registry";
import { xWeightedLength } from "../worker/providers/x";
import type { Provider } from "../worker/providers/types";

const P = (id: string) => getProvider(id) as Provider;
const LINK = "https://pf.example.com/a/Ab3dE6gH";
const APP = "1234567890";

describe("campaign tokens", () => {
  it("post tokens: pf-<platform>-<10 chars>, lowercase a-z0-9-, within Apple's 30 characters, for every platform", () => {
    for (const p of providers) {
      for (const id of ["pst_abc", "pst_AAAAAAAAAAAAAAAAAAAAAAAA", `pst_${"Z_-".repeat(30)}`]) {
        const ct = postCampaignToken(p.id, id);
        expect(ct, `${p.id} ${id}`).toMatch(/^pf-[a-z0-9]{1,4}-[a-z0-9]{10}$/);
        expect(ct.length).toBeLessThanOrEqual(MAX_CAMPAIGN_TOKEN);
        expect(ct.length).toBeLessThanOrEqual(40);
        expect(isValidCampaignToken(ct)).toBe(true);
      }
    }
  });

  it("is stable per post and platform and differs between posts, platforms and collision attempts", () => {
    expect(postCampaignToken("x", "pst_one")).toBe(postCampaignToken("x", "pst_one"));
    expect(postCampaignToken("x", "pst_one")).not.toBe(postCampaignToken("x", "pst_two"));
    expect(postCampaignToken("x", "pst_one")).not.toBe(postCampaignToken("threads", "pst_one"));
    expect(postCampaignToken("x", "pst_one", 1)).not.toBe(postCampaignToken("x", "pst_one"));
    expect(postCampaignToken("x", "pst_one", 1)).toBe(postCampaignToken("x", "pst_one", 1));
    expect(postCampaignToken("x", "pst_one")).toMatch(/^pf-x-/);
    expect(postCampaignToken("bluesky", "pst_one")).toMatch(/^pf-bsky-/);
  });

  it("spreads well: no collisions over 20k post ids", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(postCampaignToken("x", `pst_${i.toString(36)}`));
    expect(seen.size).toBe(20_000);
  });

  it("bio tokens and platform shorts", () => {
    expect(bioCampaignToken("instagram_standalone")).toBe("pf-igs-bio");
    expect(bioCampaignToken("tiktok", 2)).toBe("pf-tt-bio-2");
    expect(platformShort("some_new-platform")).toBe("some");
    expect(isValidCampaignToken(bioCampaignToken("tiktok", 99))).toBe(true);
    expect(isValidCampaignToken("Has Space")).toBe(false);
    expect(isValidCampaignToken("a".repeat(31))).toBe(false);
    expect(isValidCampaignToken("-x")).toBe(false);
  });
});

describe("links", () => {
  it("builds Apple's documented campaign link format", () => {
    expect(appStoreCampaignUrl("123456789", "123456", "test1234")).toBe("https://apps.apple.com/app/apple-store/id123456789?pt=123456&ct=test1234&mt=8");
  });

  it("encodes pt and ct, rejects a non-numeric app id", () => {
    const u = new URL(appStoreCampaignUrl("123456789", "12&34", "a b/c"));
    expect(u.searchParams.get("pt")).toBe("12&34");
    expect(u.searchParams.get("ct")).toBe("a b/c");
    expect(u.searchParams.get("mt")).toBe("8");
    expect(() => appStoreCampaignUrl("12x", "1", "c")).toThrow();
    expect(() => appStoreCampaignUrl("1/../evil", "1", "c")).toThrow();
  });

  it("short codes: 8 base62 characters, unique enough", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const c = newLinkCode();
      expect(c).toMatch(/^[0-9A-Za-z]{8}$/);
      expect(LINK_CODE_RE.test(c)).toBe(true);
      seen.add(c);
    }
    expect(seen.size).toBe(5000);
  });

  it("finds App Store URLs of the app only, without their own ct", () => {
    const text = `Get it: https://apps.apple.com/us/app/tempo-focus/id${APP}. Also https://apps.apple.com/app/id999999999 and https://apps.apple.com/app/id${APP}?pt=1&ct=mine`;
    const found = findAppStoreUrls(text, APP);
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe(`https://apps.apple.com/us/app/tempo-focus/id${APP}`);
    expect(findAppStoreUrls(`itunes: https://itunes.apple.com/app/id${APP}?mt=8`, APP)[0].url).toBe(`https://itunes.apple.com/app/id${APP}?mt=8`);
  });
});

describe("auto-insert / replace", () => {
  const base = { thread: [], settings: {} };

  it("replaces App Store URLs of the app in the text and the follow-ups (first comment)", () => {
    const r = rewriteForCampaign(P("threads"), { ...base, content: `New update! https://apps.apple.com/app/id${APP}`, thread: [{ content: `Link: https://apps.apple.com/us/app/x/id${APP}?l=en`, media: [] }] }, LINK, APP);
    expect(r.changed).toBe(true);
    expect(r.content).toBe(`New update! ${LINK}`);
    expect(r.thread[0].content).toBe(`Link: ${LINK}`);
  });

  it("leaves YouTube Shorts alone (links in Shorts descriptions aren't clickable) but rewrites regular videos", () => {
    const short = rewriteForCampaign(P("youtube"), { ...base, settings: { title: "T", shorts: true }, content: "Play tonight" }, LINK, APP);
    expect(short.changed).toBe(false);
    expect(rewriteForCampaign(P("youtube"), { ...base, content: "Play tonight #Shorts" }, LINK, APP).changed).toBe(false);
    expect(rewriteForCampaign(P("youtube"), { ...base, settings: { title: "T" }, content: "Full walkthrough" }, LINK, APP).content).toBe(`Full walkthrough\n\n${LINK}`);
  });

  it("appends the link when the post has no link, keeps the text when it has one", () => {
    expect(rewriteForCampaign(P("bluesky"), { ...base, content: "Tempo 2.0 is out" }, LINK, APP).content).toBe(`Tempo 2.0 is out\n\n${LINK}`);
    const other = rewriteForCampaign(P("bluesky"), { ...base, content: "Read https://blog.example.com" }, LINK, APP);
    expect(other.changed).toBe(false);
    expect(rewriteForCampaign(P("mastodon"), { ...base, content: "" }, LINK, APP).content).toBe(LINK);
  });

  it("never touches non-clickable platforms (Instagram, TikTok)", () => {
    for (const id of ["instagram", "instagram_standalone", "tiktok", "tiktok_business"]) {
      const input = { ...base, content: `Download https://apps.apple.com/app/id${APP}` };
      const r = rewriteForCampaign(P(id), input, LINK, APP);
      expect(r.changed, id).toBe(false);
      expect(r.content).toBe(input.content);
    }
  });

  it("X: URLs count as 23, so a 270-character post still gets the link; a 260-character one does not", () => {
    const x = P("x");
    const fits = rewriteForCampaign(x, { ...base, content: "a".repeat(255) }, LINK, APP);
    expect(fits.content.endsWith(LINK)).toBe(true);
    expect(xWeightedLength(fits.content)).toBe(255 + 2 + 23);
    const tooLong = rewriteForCampaign(x, { ...base, content: "a".repeat(256) }, LINK, APP);
    expect(tooLong.content).toBe("a".repeat(256));
    expect(tooLong.skipped[0]).toMatch(/length limit/);
    // Replacing a long App Store URL is free on X (both count 23).
    const replaced = rewriteForCampaign(x, { ...base, content: `${"a".repeat(250)} https://apps.apple.com/us/app/a-very-long-name-here/id${APP}` }, LINK, APP);
    expect(replaced.content.endsWith(LINK)).toBe(true);
  });

  it("other platforms: the character limit (Threads 500, Bluesky 300 graphemes)", () => {
    const longLink = `https://postflare.example.com/a/Ab3dE6gH`;
    const th = rewriteForCampaign(P("threads"), { ...base, content: "b".repeat(470) }, longLink, APP);
    expect(th.changed).toBe(false);
    expect(th.skipped).toHaveLength(1);
    const ok = rewriteForCampaign(P("threads"), { ...base, content: "b".repeat(400) }, longLink, APP);
    expect(ok.content.length).toBe(400 + 2 + longLink.length);
    const bs = rewriteForCampaign(P("bluesky"), { ...base, content: "c".repeat(290) }, longLink, APP);
    expect(bs.changed).toBe(false);
  });

  it("Pinterest: fills the destination link instead of the description; Reddit link posts: the URL", () => {
    const pin = rewriteForCampaign(P("pinterest"), { ...base, content: "Pretty plants", settings: { title: "Plants" } }, LINK, APP);
    expect(pin.settings.link).toBe(LINK);
    expect(pin.content).toBe("Pretty plants");
    const pin2 = rewriteForCampaign(P("pinterest"), { ...base, content: "x", settings: { link: `https://apps.apple.com/app/id${APP}` } }, LINK, APP);
    expect(pin2.settings.link).toBe(LINK);
    const pin3 = rewriteForCampaign(P("pinterest"), { ...base, content: "x", settings: { link: "https://example.com" } }, LINK, APP);
    expect(pin3.settings.link).toBe("https://example.com");
    const rd = rewriteForCampaign(P("reddit"), { ...base, content: "", settings: { kind: "link", title: "t", url: `https://apps.apple.com/app/id${APP}` } }, LINK, APP);
    expect(rd.settings.url).toBe(LINK);
    expect(rd.content).toBe("");
    const self = rewriteForCampaign(P("reddit"), { ...base, content: "We made an app", settings: { kind: "self", title: "t" } }, LINK, APP);
    expect(self.content).toBe(`We made an app\n\n${LINK}`);
  });

  it("YouTube: in the description; Telegram: in the message", () => {
    expect(rewriteForCampaign(P("youtube"), { ...base, content: "Devlog", settings: { title: "Devlog" } }, LINK, APP).content).toBe(`Devlog\n\n${LINK}`);
    expect(rewriteForCampaign(P("telegram"), { ...base, content: "Update" }, LINK, APP).content).toBe(`Update\n\n${LINK}`);
  });

  it("is idempotent (a second pass changes nothing)", () => {
    const once = rewriteForCampaign(P("x"), { ...base, content: `Go https://apps.apple.com/app/id${APP}` }, LINK, APP);
    const twice = rewriteForCampaign(P("x"), { ...base, content: once.content }, LINK, APP);
    expect(twice.changed).toBe(false);
  });
});

describe("bot filtering", () => {
  it("skips crawlers, link previews, HTTP libraries and HEAD requests", () => {
    for (const ua of [
      "Twitterbot/1.0",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "TelegramBot (like TwitterBot)",
      "WhatsApp/2.23.20.0 A",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "curl/8.4.0",
      "python-requests/2.31.0",
      "",
    ]) {
      expect(isBot("GET", ua), ua).toBe(true);
    }
    expect(isBot("HEAD", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
  });

  it("counts browsers and in-app browsers", () => {
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0]",
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ]) {
      expect(isBot("GET", ua), ua).toBe(false);
    }
  });
});

describe("Revflare URL validation", () => {
  it("https only, public hosts only; strips /api/v1", () => {
    expect(normalizeRevflareUrl("https://revflare.example.com/")).toEqual({ url: "https://revflare.example.com" });
    expect(normalizeRevflareUrl("https://revflare.example.com/api/v1")).toEqual({ url: "https://revflare.example.com" });
    expect(normalizeRevflareUrl("https://example.com/revflare/api/v1/")).toEqual({ url: "https://example.com/revflare" });
    for (const bad of [
      "http://revflare.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://192.168.1.2:8787",
      "https://172.20.0.1",
      "https://169.254.169.254",
      "https://[::1]",
      "https://[fd00::1]",
      "https://intranet",
      "https://revflare.internal",
      "https://box.local",
      "https://user:pw@revflare.example.com",
      "ftp://revflare.example.com",
      "not a url",
      "https://2130706433",
    ]) {
      expect("error" in normalizeRevflareUrl(bad), bad).toBe(true);
    }
  });

  it("allows http://localhost only when asked (Postflare itself on localhost)", () => {
    expect(normalizeRevflareUrl("http://localhost:8787", { allowLocal: true })).toEqual({ url: "http://localhost:8787" });
    expect("error" in normalizeRevflareUrl("http://localhost:8787")).toBe(true);
    expect("error" in normalizeRevflareUrl("http://10.0.0.1", { allowLocal: true })).toBe(true);
  });

  it("isInternalHost", () => {
    expect(isInternalHost("revflare.ferdi.app")).toBe(false);
    expect(isInternalHost("8.8.8.8")).toBe(false);
    expect(isInternalHost("100.64.0.1")).toBe(true);
    expect(isInternalHost("[::ffff:7f00:1]")).toBe(true);
  });
});
