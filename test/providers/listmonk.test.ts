import { describe, expect, it } from "vitest";
import { listmonk } from "../../worker/providers/listmonk";
import { image, json, mockFetch, testAccount, testContext } from "../helpers";

const URL_ = "https://lists.example.com";
const auth = `Basic ${btoa("api:TOKEN")}`;
const account = () =>
  testAccount({ provider: "listmonk", externalId: URL_, credentials: { url: URL_, username: "api", token: "TOKEN" } });
const post = (settings: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id: "p1",
  content: "Hello <you>\n\nSecond para",
  media: [],
  settings: { subject: "Big News!", list: "3", ...settings },
  ...over,
});
const noExisting: [string, () => unknown] = [`GET ${URL_}/api/campaigns`, () => ({ data: { results: [] } })];

describe("listmonk connect", () => {
  it("verifies credentials and returns the instance", async () => {
    const m = mockFetch([
      [`GET ${URL_}/api/lists`, () => ({ data: { results: [] } })],
      [`GET ${URL_}/api/settings`, () => ({ data: { "app.site_name": "My Newsletter", "app.logo_url": "" } })],
    ]);
    const [acc] = await listmonk.connect!(testContext(m.fetch), { url: `${URL_}/`, username: "api", token: "TOKEN" });
    expect(m.requests[0].headers.authorization).toBe(auth);
    expect(acc).toMatchObject({
      externalId: URL_,
      name: "My Newsletter",
      username: "lists.example.com",
      credentials: { url: URL_, username: "api", token: "TOKEN" },
    });
  });

  it("maps 401 to auth", async () => {
    const m = mockFetch([[`GET ${URL_}/api/lists`, () => json({ message: "invalid credentials" }, 401)]]);
    await expect(listmonk.connect!(testContext(m.fetch), { url: URL_, username: "api", token: "bad" })).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("listmonk options", () => {
  it("lists lists and campaign templates", async () => {
    const m = mockFetch([
      [`GET ${URL_}/api/lists`, () => ({ data: { results: [{ id: 3, name: "Main", subscriber_count: 120 }] } })],
      [
        `GET ${URL_}/api/templates`,
        () => ({ data: [{ id: 1, name: "Default", type: "campaign" }, { id: 2, name: "Tx", type: "tx" }, { id: 4, name: "Visual", type: "campaign_visual" }] }),
      ],
    ]);
    const ctx = testContext(m.fetch);
    expect(await listmonk.options!(ctx, account(), "list", {})).toEqual([{ value: "3", label: "Main (120)" }]);
    expect(new URL(m.requests[0].url).searchParams.get("per_page")).toBe("all");
    expect(await listmonk.options!(ctx, account(), "template", {})).toEqual([
      { value: "", label: "Default template" },
      { value: "1", label: "Default" },
      { value: "4", label: "Visual" },
    ]);
  });
});

describe("listmonk publish", () => {
  it("creates and starts a campaign with images embedded", async () => {
    const m = mockFetch([
      noExisting,
      [`POST ${URL_}/api/campaigns`, () => ({ data: { id: 9, uuid: "uu", status: "draft" } })],
      [`PUT ${URL_}/api/campaigns/9/status`, () => ({ data: { id: 9, status: "running" } })],
    ]);
    const res = await listmonk.publish(
      testContext(m.fetch),
      account(),
      post({ template: "4", preview: "Peek", extraLists: ["5", "3"] }, { media: [image()] }),
    );
    const body = m.requests[1].json;
    expect(body).toMatchObject({
      name: "big-news-p1",
      subject: "Big News!",
      lists: [3, 5],
      type: "regular",
      content_type: "html",
      template_id: 4,
    });
    expect(body.body).toContain("<p>Hello &lt;you&gt;</p>\n<p>Second para</p>");
    expect(body.body).toContain(`<img src="${image().url}" alt="alt text"`);
    expect(body.body).toContain(">Peek&#8203;");
    expect(m.requests[2].json).toEqual({ status: "running" });
    expect(res).toEqual({ status: "published", externalId: "9", url: `${URL_}/admin/campaigns/9`, data: { uuid: "uu" } });
  });

  it("creates a markdown draft without sending", async () => {
    const m = mockFetch([noExisting, [`POST ${URL_}/api/campaigns`, () => ({ data: { id: 10, uuid: "u2", status: "draft" } })]]);
    await listmonk.publish(testContext(m.fetch), account(), post({ sendMode: "draft", contentType: "markdown" }, { content: "# Hi", media: [image()] }));
    expect(m.requests[1].json.content_type).toBe("markdown");
    expect(m.requests[1].json.body).toBe(`# Hi\n\n![alt text](${image().url})`);
    expect(m.requests[1].json.template_id).toBeUndefined();
    expect(m.requests).toHaveLength(2);
  });

  it("keeps HTML content as is", async () => {
    const m = mockFetch([noExisting, [`POST ${URL_}/api/campaigns`, () => ({ data: { id: 1, uuid: "u", status: "draft" } })]]);
    await listmonk.publish(testContext(m.fetch), account(), post({ sendMode: "draft" }, { content: "<h1>Hi</h1>" }));
    expect(m.requests[1].json.body).toBe("<h1>Hi</h1>");
  });

  it("does not create a second campaign on retry", async () => {
    const m = mockFetch([
      [`GET ${URL_}/api/campaigns`, () => ({ data: { results: [{ id: 9, uuid: "uu", name: "big-news-p1", status: "running" }] } })],
    ]);
    const res = await listmonk.publish(testContext(m.fetch), account(), post());
    expect(m.requests).toHaveLength(1);
    expect(res).toMatchObject({ externalId: "9" });
  });

  it("validates extra list ids and requires a list", async () => {
    expect(listmonk.validate!(post({ extraLists: ["abc"] }))).toEqual(['Listmonk: "abc" is not a list id']);
    await expect(listmonk.publish(testContext(mockFetch([]).fetch), account(), post({ list: "" }))).rejects.toMatchObject({ kind: "invalid" });
  });
});
