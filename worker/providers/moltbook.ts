import { ProviderError } from "./errors";
import { checkedCommit, requestJson, type RequestOptions } from "./http";
import type { AccountRecord, Provider, ProviderContext } from "./types";

// Always the www host: the bare domain redirects and drops the Authorization header.
const API = "https://www.moltbook.com/api/v1";

/** Moltbook answers `{ success: false, error, hint }`, sometimes with a 2xx status. */
async function molt<T = any>(ctx: ProviderContext, path: string, opts: RequestOptions = {}): Promise<T> {
  // A 2xx `success: false` on a commit created nothing (checkedCommit keeps it a plain refusal).
  return checkedCommit(
    ctx,
    () => requestJson<any>(ctx, `${API}${path}`, opts),
    (res) => {
      if (res && res.success === false) throw new ProviderError(`Moltbook: ${res.error || "request failed"}${res.hint ? ` (${res.hint})` : ""}`, "invalid", 200, res);
    },
  ) as Promise<T>;
}

const token = (account: AccountRecord) => String(account.credentials.accessToken);

/** Title from the first line of the content when none is set (Moltbook titles max 300 chars). */
export function moltTitle(title: unknown, content: string): string {
  const t = String(title ?? "").trim() || content.trim().split("\n")[0].trim();
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}

/** Moltbook: the social network for AI agents. Each account is an agent identified by its API key. */
export const moltbook: Provider = {
  id: "moltbook",
  name: "Moltbook",
  color: "E01B24",
  category: "community",
  auth: "credentials",
  appFields: [],
  credentialFields: [
    { key: "apiKey", label: "Agent API key", type: "password", help: "Leave empty and fill in the agent name to register a new agent." },
    { key: "name", label: "New agent name", type: "text", help: "Only to register a new agent." },
    { key: "description", label: "New agent description", type: "text", placeholder: "Social media scheduler" },
  ],
  settingsFields: [
    { key: "submolt", label: "Submolt", type: "text", default: "general", placeholder: "general" },
    { key: "title", label: "Title", type: "text", maxLength: 300, help: "Defaults to the first line of the post." },
    { key: "url", label: "Link", type: "url", help: "Makes this a link post (the text is not sent)." },
  ],
  capabilities: {
    maxLength: 40_000,
    text: "required",
    media: { images: 0, videos: 0, mixed: false, required: false },
    thread: true,
    threadLabel: "Comments",
  },
  docsUrl: "https://www.moltbook.com/skill.md",
  setupNotes:
    "No developer app needed. Connect with an existing agent **API key**, or leave the key empty and enter a new agent name: " +
    "Postflare registers the agent and shows its API key and claim URL. Open the claim URL to verify the agent, then connect again with the API key. " +
    "Moltbook allows about 1 post per 30 minutes per agent.",

  async connect(ctx, values) {
    const apiKey = values.apiKey?.trim();
    if (!apiKey) {
      const name = values.name?.trim();
      if (!name) throw new ProviderError("Enter an agent API key, or a name to register a new agent", "invalid");
      const { agent } = await molt(ctx, "/agents/register", {
        method: "POST",
        json: { name, description: values.description?.trim() || "Postflare social media scheduler" },
      });
      // The contract has no multi-step connect: surface the key and claim URL to the user and let them reconnect.
      throw new ProviderError(
        `Agent registered. Save this API key: ${agent.api_key} — then open ${agent.claim_url} to claim the agent` +
          `${agent.verification_code ? ` (verification code ${agent.verification_code})` : ""}, and connect again with the API key.`,
        "invalid",
      );
    }
    const status = await molt(ctx, "/agents/status", { token: apiKey });
    if (status?.status && status.status !== "claimed") {
      throw new ProviderError("This agent is not claimed yet: open its claim URL to verify it, then connect again", "invalid");
    }
    const { agent } = await molt(ctx, "/agents/me", { token: apiKey });
    return [
      {
        externalId: String(agent.name || agent.id),
        name: agent.display_name || agent.name,
        username: agent.name ?? null,
        avatarUrl: agent.avatar_url ?? null,
        profileUrl: agent.name ? `https://www.moltbook.com/u/${agent.name}` : null,
        credentials: { accessToken: apiKey },
      },
    ];
  },

  async publish(ctx, account, post) {
    const s = post.settings;
    const title = moltTitle(s.title, post.content);
    if (!title) throw new ProviderError("Moltbook posts need a title or text", "invalid");
    const res = await molt(ctx, "/posts", {
      method: "POST",
      token: token(account),
      json: { submolt: String(s.submolt || "general").replace(/^m\//, ""), title, ...(s.url ? { url: String(s.url) } : { content: post.content }) },
      commit: true,
    });
    const id = String(res.post.id);
    return { status: "published", externalId: id, url: `https://www.moltbook.com/post/${id}` };
  },

  async reply(ctx, account, target, post) {
    const res = await molt(ctx, `/posts/${encodeURIComponent(target.rootId)}/comments`, {
      method: "POST",
      token: token(account),
      json: { content: post.content, ...(target.parentId !== target.rootId ? { parent_id: target.parentId } : {}) },
      commit: true,
    });
    return { externalId: String(res.comment.id), url: `https://www.moltbook.com/post/${target.rootId}`, urlIsPost: true };
  },
};
