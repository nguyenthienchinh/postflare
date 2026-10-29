import { describe, expect, it } from "vitest";
import { Api } from "../src/api.js";
import { ApiError } from "../src/errors.js";

// Hosted instances answer 402 { code: "plan_limit", upgradeUrl } when the workspace's plan does not allow an action.
describe("402 plan_limit", () => {
  it("prints the API's message with where to manage the plan", async () => {
    const body = { error: "Plan limit reached: Free allows 30 posts this month (used: 30).", code: "plan_limit", limit: "posts_per_month", used: 30, max: 30, upgradeUrl: "https://pf.example.com/workspace?tab=billing" };
    const api = new Api("https://pf.example.com", "pf_x", async () => new Response(JSON.stringify(body), { status: 402 }));
    const err = await api.post("/posts", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(402);
    expect(err.message).toBe("Plan limit reached: Free allows 30 posts this month (used: 30). Manage the plan: https://pf.example.com/workspace?tab=billing");
    expect(err.body).toEqual(body);
  });
});
