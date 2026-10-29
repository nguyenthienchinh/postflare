import { describe, expect, it } from "vitest";
import { dribbble } from "../../worker/providers/dribbble";
import { image, json, mockFetch, noCopy, testAccount, testContext } from "../helpers";

const app = { clientId: "CID", clientSecret: "CS" };
const account = () => testAccount({ provider: "dribbble", credentials: { accessToken: "AT" } });
const shot = () => image({ width: 800, height: 600, mime: "image/png", filename: "shot.png" });
const post = (over: any = {}) => ({ id: "p1", content: "Desc", media: [shot()], settings: { title: "My shot" }, ...over });

describe("dribbble oauth", () => {
  it("builds the authorize URL", () => {
    const url = new URL(dribbble.authorize!(testContext(fetch, app, "dribbble"), { state: "S", codeVerifier: "v", codeChallenge: "c" }) as string);
    expect(url.origin + url.pathname).toBe("https://dribbble.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "CID",
      redirect_uri: "https://pf.example.com/oauth/dribbble/callback",
      scope: "public upload",
      state: "S",
    });
  });

  it("exchanges the code and loads the user", async () => {
    const { fetch, requests } = mockFetch([
      ["POST https://dribbble.com/oauth/token", () => ({ access_token: "AT", token_type: "bearer", scope: "public upload" })],
      ["GET https://api.dribbble.com/v2/user", () => ({ id: 1, name: "Dee", login: "dee", avatar_url: "https://a", html_url: "https://dribbble.com/dee" })],
    ]);
    const [acc] = await dribbble.callback!(testContext(fetch, app, "dribbble"), { code: "C", codeVerifier: "v", params: new URLSearchParams() });
    expect(requests[0].form).toMatchObject({ client_id: "CID", client_secret: "CS", code: "C" });
    expect(acc).toMatchObject({ externalId: "1", name: "Dee", username: "dee", credentials: { accessToken: "AT" }, expiresAt: null });
  });

  it("refuses tokens without the upload scope", async () => {
    const { fetch } = mockFetch([[/oauth\/token/, () => ({ access_token: "AT", scope: "public" })]]);
    await expect(dribbble.callback!(testContext(fetch, app), { code: "C", codeVerifier: "v", params: new URLSearchParams() })).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});

describe("dribbble options", () => {
  it("lists teams", async () => {
    const { fetch } = mockFetch([[/v2\/user/, () => ({ id: 1, teams: [{ id: 9, name: "Studio" }] })]]);
    expect(await dribbble.options!(testContext(fetch), account(), "team", {})).toEqual([
      { value: "", label: "No team" },
      { value: "9", label: "Studio" },
    ]);
  });
});

describe("dribbble publish", () => {
  it("uploads a shot", async () => {
    const { fetch, requests } = mockFetch([
      ["POST https://api.dribbble.com/v2/shots", () => new Response(null, { status: 202, headers: { location: "https://api.dribbble.com/v2/shots/4711" } })],
    ]);
    const res = await dribbble.publish(noCopy(testContext(fetch)), account(), post({ settings: { title: "My shot", tags: ["ui", "app"], team: "9", lowProfile: true } }));
    expect(res).toEqual({ status: "published", externalId: "4711", url: "https://dribbble.com/shots/4711" });
    const fd = requests[0].formData!;
    expect(requests[0].headers.authorization).toBe("Bearer AT");
    expect(fd.get("image")).toBeInstanceOf(Blob);
    expect((fd.get("image") as File).size).toBe(shot().size);
    expect(fd.get("title")).toBe("My shot");
    expect(fd.get("description")).toBe("Desc");
    expect(fd.getAll("tags[]")).toEqual(["ui", "app"]);
    expect(fd.get("team_id")).toBe("9");
    expect(fd.get("low_profile")).toBe("true");
  });

  it("validates image size, title and tags", () => {
    expect(dribbble.validate!(post())).toEqual([]);
    expect(dribbble.validate!(post({ media: [image({ width: 1080, height: 1080 })], settings: { title: "" } }))).toEqual([
      "Dribbble shots need a title",
      "Dribbble images must be 4:3, from 400×300 up to 1600×1200 px (e.g. 800×600)",
    ]);
  });

  it("maps 401 to auth and 422 to invalid", async () => {
    const { fetch } = mockFetch([[/shots/, () => json({ message: "Bad credentials" }, 401)]]);
    await expect(dribbble.publish(testContext(fetch), account(), post())).rejects.toMatchObject({ kind: "auth" });
    const { fetch: f2 } = mockFetch([[/shots/, () => json({ message: "Validation failed", errors: [{ attribute: "image", message: "bad" }] }, 422)]]);
    await expect(dribbble.publish(testContext(f2), account(), post())).rejects.toMatchObject({ kind: "invalid" });
  });
});
