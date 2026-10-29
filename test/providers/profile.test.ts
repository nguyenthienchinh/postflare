import { describe, expect, it } from "vitest";
import { facebook } from "../../worker/providers/facebook";
import { instagram } from "../../worker/providers/instagram";
import { instagramStandalone } from "../../worker/providers/instagram_standalone";
import { FB_GRAPH, IG_GRAPH, THREADS_GRAPH } from "../../worker/providers/meta-shared";
import { threads } from "../../worker/providers/threads";
import { tiktok } from "../../worker/providers/tiktok";
import type { Provider } from "../../worker/providers/types";
import { mockFetch, testAccount, testContext } from "../helpers";

// `Provider.profile`: the current (signed, expiring) profile picture URL, re-read by the avatar cron (lib/avatars.ts).

const cases: Array<[Provider, string, unknown, string]> = [
  [instagramStandalone, `GET ${IG_GRAPH}/me`, { profile_picture_url: "https://pic/ig" }, "fields=profile_picture_url"],
  [instagram, `GET ${FB_GRAPH}/EXT`, { profile_picture_url: "https://pic/ig" }, "fields=profile_picture_url"],
  [facebook, `GET ${FB_GRAPH}/EXT`, { picture: { data: { url: "https://pic/ig" } } }, "fields=picture.type%28large%29"],
  [threads, `GET ${THREADS_GRAPH}/me`, { threads_profile_picture_url: "https://pic/ig" }, "fields=threads_profile_picture_url"],
  [tiktok, "GET https://open.tiktokapis.com/v2/user/info/", { data: { user: { avatar_url: "https://pic/ig" } }, error: { code: "ok" } }, "avatar_url"],
];

describe("profile()", () => {
  for (const [provider, route, body, query] of cases) {
    it(`${provider.id}: one request, returns the picture URL`, async () => {
      const m = mockFetch([[route, () => body]]);
      const account = testAccount({ provider: provider.id, externalId: "EXT", credentials: { accessToken: "TOKEN" } });
      expect(await provider.profile!(testContext(m.fetch, {}, provider.id), account)).toEqual({ avatarUrl: "https://pic/ig" });
      expect(m.requests).toHaveLength(1);
      expect(m.requests[0].url).toContain(query);
    });
  }

  it("null when the platform has no picture", async () => {
    const m = mockFetch([[`GET ${IG_GRAPH}/me`, () => ({})]]);
    expect(await instagramStandalone.profile!(testContext(m.fetch), testAccount({ credentials: { accessToken: "T" } }))).toEqual({ avatarUrl: null });
  });
});
