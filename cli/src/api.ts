// Thin client for the Postflare REST API (`Authorization: Bearer pf_...`).

import { ApiError } from "./errors.js";
import { VERSION } from "./version.js";

export type FetchLike = (input: string, init?: RequestInit & { duplex?: "half" }) => Promise<Response>;

export interface RequestOptions {
  /** JSON body. */
  body?: unknown;
  /** Raw body (uploads); `headers` should then carry content-type / content-length. */
  raw?: RequestInit["body"] | ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
}

export class Api {
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init as RequestInit),
  ) {}

  url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(`${this.baseUrl}/api${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.key}`,
      accept: "application/json",
      "user-agent": `postflare-cli/${VERSION}`,
      ...(opts.headers ?? {}),
    };
    let body: any = opts.raw;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const stream = typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), { method, headers, body, ...(stream ? { duplex: "half" as const } : {}) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ApiError(`Cannot reach ${this.baseUrl}: ${cause?.code ?? cause?.message ?? (err as Error).message}`, 0);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      let message: string = data?.error ?? (text && !text.trimStart().startsWith("<") ? text.slice(0, 300) : `HTTP ${res.status} ${res.statusText}`);
      if (res.status === 401) message += " (check your API key: postflare login)";
      // Hosted instances: the workspace's plan does not allow it (limit reached, no API access, or no active plan).
      if (res.status === 402 && data?.code === "plan_limit" && typeof data.upgradeUrl === "string") message += ` Manage the plan: ${data.upgradeUrl}`;
      throw new ApiError(message, res.status, data);
    }
    if (data === null && text) throw new ApiError(`Unexpected response from ${this.baseUrl} (not JSON). Is the URL right?`, res.status);
    return data as T;
  }

  get<T = any>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>("GET", path, { query });
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, { body: body ?? {} });
  }
  patch<T = any>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, { body });
  }
  delete<T = any>(path: string) {
    return this.request<T>("DELETE", path);
  }
}
