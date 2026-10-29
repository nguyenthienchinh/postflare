import type {
  SupportMessageDTO,
  SupportSettingsDTO,
  SupportStatus,
  SupportThreadDTO,
  SupportTicketDTO,
  SupportTicketListDTO,
  AccessRequestDTO,
  AccessRequestInput,
  AccessRequestListDTO,
  AccessRequestReviewDTO,
  AccessRequestReviewInput,
  AccessRequestStatus,
  SignupMode,
  AccountDTO,
  AccountGroupDTO,
  AccountGroupInput,
  AdminBillingDTO,
  AdminBillingInput,
  AdminEmailDTO,
  AdminOverviewDTO,
  AdminPlanDTO,
  AdminSignupDTO,
  AdminLegalDTO,
  AdminTurnstileDTO,
  AdminTurnstileInput,
  AdminWorkspaceBillingDTO,
  AdminWorkspaceBillingInput,
  BillingDTO,
  BillingInterval,
  BillingProviderId,
  BillingProviderInput,
  BillingProviderTestDTO,
  BillingStatus,
  PlanInput,
  PlanLimitErrorDTO,
  PublicPlansDTO,
  SignupDTO,
  SignupInput,
  TurnstileTestDTO,
  AppDTO,
  CampaignLinkDTO,
  CampaignSettingsDTO,
  CampaignSettingsInput,
  CampaignSyncDTO,
  PlaybookStatsSort,
  RevflareTestDTO,
  AnalyticsPostDTO,
  AppLoginPollDTO,
  AppLoginStartDTO,
  DeviceDTO,
  PairingCodeDTO,
  PairingStatusDTO,
  AnalyticsRefreshDTO,
  AnalyticsSummaryDTO,
  PostMetricsDTO,
  ApiKeyDTO,
  AppSettings,
  AuthStatus,
  CreatedInvitationDTO,
  CreateInvitationInput,
  CreatePostsInput,
  InvitationDTO,
  InvitationLookupDTO,
  MeDTO,
  MemberDTO,
  PermissionInfo,
  RoleDTO,
  RoleInput,
  SetupInput,
  UserDTO,
  UpdateStatusDTO,
  UserStatus,
  VersionDTO,
  WorkspaceDTO,
  FieldOption,
  MediaDTO,
  MediaUsageDTO,
  Overview,
  PlatformConfig,
  PlaybookDTO,
  PlaybookInput,
  PlaybookStatsDTO,
  PlaybookSummaryDTO,
  PostDTO,
  PostWithLogs,
  Provider,
  ResolvePostInput,
  ThreadItem,
} from "./types";

export class ApiError extends Error {
  status: number;
  errors: string[];
  /** The `code` of the error body (e.g. "captcha": the Turnstile bot check failed). */
  code?: string;
  /** Sign-in only: the bot check is required from now on (Turnstile configured, 3 recent failures). */
  captchaRequired?: boolean;
  constructor(message: string, status: number, errors: string[] = [], extra: { code?: string; captchaRequired?: boolean } = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.code = extra.code;
    this.captchaRequired = extra.captchaRequired;
  }
}

/** 402 of an action the workspace's plan does not allow (hosted mode): the app shows the upgrade dialog. */
export class PlanLimitError extends ApiError {
  limit: PlanLimitErrorDTO;
  constructor(body: PlanLimitErrorDTO) {
    super(body.error, 402);
    this.limit = body;
  }
}

export const isPlanLimit = (err: unknown): err is PlanLimitError => err instanceof PlanLimitError;

/** Fired with a PlanLimitError as `detail` on every 402 plan_limit answer (the layout's PlanLimitDialog listens). */
export const PLAN_LIMIT_EVENT = "postflare:plan-limit";

/** The PlanLimitError of a 402 `{ code: "plan_limit" }` body (announced to the app), or null for any other error. */
export function planLimitError(status: number, data: unknown): PlanLimitError | null {
  const d = data as Partial<PlanLimitErrorDTO> | null;
  if (status !== 402 || d?.code !== "plan_limit" || typeof d.error !== "string") return null;
  const err = new PlanLimitError(d as PlanLimitErrorDTO);
  window.dispatchEvent(new CustomEvent(PLAN_LIMIT_EVENT, { detail: err }));
  return err;
}

/** Fired when the session is gone; the app shell listens and sends the user to /login. */
export const UNAUTHORIZED_EVENT = "postflare:unauthorized";
/** Fired when the server does not know (or no longer grants access to) the workspace in `X-Workspace-Id`. */
export const WORKSPACE_NOT_FOUND_EVENT = "postflare:workspace-not-found";

/** Workspace sent as `X-Workspace-Id` with every request (set by the session provider). */
let currentWorkspaceId: string | null = null;

export function setApiWorkspace(id: string | null) {
  currentWorkspaceId = id;
}

export function workspaceHeaders(): Record<string, string> {
  return currentWorkspaceId ? { "x-workspace-id": currentWorkspaceId } : {};
}

export async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { ...workspaceHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/") && !path.startsWith("/invitations/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const d = (data ?? {}) as { error?: string; errors?: string[]; code?: unknown; captchaRequired?: unknown };
    if (res.status === 404 && d.error === "Workspace not found" && currentWorkspaceId) window.dispatchEvent(new Event(WORKSPACE_NOT_FOUND_EVENT));
    const limit = planLimitError(res.status, data);
    if (limit) throw limit;
    throw new ApiError(d.error || `Request failed (${res.status})`, res.status, d.errors ?? [], {
      code: typeof d.code === "string" ? d.code : undefined,
      captchaRequired: d.captchaRequired === true,
    });
  }
  return data as T;
}

export const get = <T>(path: string) => request<T>("GET", path);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

type PostPatch = Partial<Pick<PostDTO, "content" | "media" | "settings" | "playbookId" | "playbookVersion" | "variant" | "appId" | "autoLink">> & {
  thread?: ThreadItem[];
  scheduledAt?: CreatePostsInput["scheduledAt"];
};

export interface PostQuery {
  from?: number;
  to?: number;
  status?: string;
  accountId?: string;
  /** Posts of the accounts in this account group ("none" = ungrouped accounts). */
  accountGroupId?: string;
  groupId?: string;
  order?: "asc" | "desc";
  limit?: number;
}

export type AnalyticsSort = "views" | "engagements" | "engagementRate" | "publishedAt" | "clicks" | "downloads" | "proceeds";

export interface AnalyticsQuery {
  from: number;
  to: number;
  tz?: string;
  accountId?: string;
  provider?: string;
}

export function qs(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const api = {
  auth: {
    status: () => get<AuthStatus>("/auth/status"),
    setup: (input: SetupInput) => request<{ ok: true }>("POST", "/auth/setup", input),
    login: (email: string, password: string, turnstileToken?: string) => request<{ ok: true }>("POST", "/auth/login", { email, password, turnstileToken }),
    logout: () => request<{ ok: true }>("POST", "/auth/logout"),
    magicLink: (email: string, turnstileToken?: string) => request<{ ok: true }>("POST", "/auth/magic-link", { email, turnstileToken }),
    verifyMagicLink: (token: string) => request<{ ok: true }>("POST", "/auth/magic-link/verify", { token }),
    signup: (input: SignupInput) => request<SignupDTO>("POST", "/auth/signup", input),
    verifySignup: (token: string) => request<{ ok: true; workspaceId: string }>("POST", "/auth/signup/verify", { token }),
    /** "Request access" (/apply, signup_mode apply): `{ ok }` whether or not the email applied before. */
    apply: (input: AccessRequestInput) => request<{ ok: true }>("POST", "/access-requests", input),
    /** Sign in with the iOS app (docs/app-login-spec.md): the secret stays in the page and proves this browser. */
    appLogin: {
      start: (body: { kind: "qr" } | { kind: "push"; email: string; turnstileToken?: string }) => request<AppLoginStartDTO>("POST", "/auth/app-login", body),
      poll: (id: string, secret: string) => request<AppLoginPollDTO>("GET", `/auth/app-login/${encodeURIComponent(id)}`, undefined, { headers: { "x-login-secret": secret } }),
      cancel: (id: string, secret: string) => request<{ ok: true }>("DELETE", `/auth/app-login/${encodeURIComponent(id)}`, undefined, { headers: { "x-login-secret": secret } }),
    },
  },
  /** iOS app installs of the signed-in user (Profile → Postflare for iPhone). */
  devices: {
    list: () => get<{ items: DeviceDTO[]; push: boolean }>("/devices"),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/devices/${encodeURIComponent(id)}`),
    test: (id: string) => request<{ ok: true }>("POST", `/devices/${encodeURIComponent(id)}/test`, {}),
    pairingCode: () => request<PairingCodeDTO>("POST", "/pairing-codes", {}),
    pairingStatus: (id: string) => get<PairingStatusDTO>(`/pairing-codes/${encodeURIComponent(id)}`),
  },
  billing: {
    get: () => get<BillingDTO>("/billing"),
    /** Public pricing table (empty while billing is off). */
    plans: () => get<PublicPlansDTO>("/billing/plans"),
    checkout: (planId: string, interval: BillingInterval) => request<{ url: string }>("POST", "/billing/checkout", { planId, interval }),
    portal: () => request<{ url: string }>("POST", "/billing/portal", {}),
  },
  me: {
    get: () => get<MeDTO>("/me"),
    update: (body: { name?: string; email?: string }) => request<MeDTO["user"]>("PATCH", "/me", body),
    changePassword: (current: string, next: string) => request<{ ok: true }>("POST", "/me/password", { current, next }),
    setWorkspace: (workspaceId: string) => request<{ ok: true; currentWorkspaceId: string }>("POST", "/me/workspace", { workspaceId }),
  },
  workspaces: {
    list: () => get<WorkspaceDTO[]>("/workspaces"),
    create: (name: string) => request<WorkspaceDTO>("POST", "/workspaces", { name }),
    rename: (id: string, name: string) => request<WorkspaceDTO>("PATCH", `/workspaces/${id}`, { name }),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/workspaces/${id}`),
    members: (id: string) => get<MemberDTO[]>(`/workspaces/${id}/members`),
    setMemberRole: (id: string, userId: string, roleId: string) => request<MemberDTO>("PATCH", `/workspaces/${id}/members/${userId}`, { roleId }),
    removeMember: (id: string, userId: string) => request<{ ok: true }>("DELETE", `/workspaces/${id}/members/${userId}`),
  },
  roles: {
    list: () => get<RoleDTO[]>("/roles"),
    permissions: () => get<PermissionInfo[]>("/permissions"),
    create: (input: RoleInput) => request<RoleDTO>("POST", "/roles", input),
    update: (id: string, input: Partial<Omit<RoleInput, "scope">>) => request<RoleDTO>("PATCH", `/roles/${id}`, input),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/roles/${id}`),
  },
  users: {
    list: () => get<UserDTO[]>("/users"),
    update: (id: string, body: { roleId?: string; status?: UserStatus; name?: string }) => request<UserDTO>("PATCH", `/users/${id}`, body),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/users/${id}`),
  },
  /** Admin → Requests (instance.users.manage). */
  accessRequests: {
    list: (q: { status?: AccessRequestStatus | "all"; q?: string; limit?: number; before?: number } = {}) => get<AccessRequestListDTO>(`/access-requests${qs(q)}`),
    count: () => get<{ pending: number }>("/access-requests/count"),
    get: (id: string) => get<AccessRequestDTO>(`/access-requests/${encodeURIComponent(id)}`),
    review: (id: string, input: AccessRequestReviewInput) => request<AccessRequestReviewDTO>("PATCH", `/access-requests/${encodeURIComponent(id)}`, input),
  },
  support: {
    list: (q: { status?: SupportStatus | "all"; q?: string; mine?: boolean; limit?: number; before?: number } = {}) =>
      get<SupportTicketListDTO>(`/admin/support/conversations${qs({ ...q, mine: q.mine ? "1" : undefined })}`),
    count: () => get<{ unread: number; open: number }>("/admin/support/count"),
    get: (id: string) => get<SupportThreadDTO<SupportTicketDTO>>(`/admin/support/conversations/${encodeURIComponent(id)}`),
    reply: (id: string, body: { body: string; note?: boolean; status?: SupportStatus }) =>
      request<{ message: SupportMessageDTO; conversation: SupportTicketDTO }>("POST", `/admin/support/conversations/${encodeURIComponent(id)}/messages`, body),
    update: (id: string, body: { status?: SupportStatus; assigneeId?: string | null; subject?: string }) =>
      request<{ conversation: SupportTicketDTO }>("PATCH", `/admin/support/conversations/${encodeURIComponent(id)}`, body),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/admin/support/conversations/${encodeURIComponent(id)}`),
    staff: () => get<{ items: Array<{ id: string; name: string; email: string }> }>("/admin/support/staff"),
    settings: () => get<SupportSettingsDTO>("/admin/support/settings"),
    saveSettings: (body: { enabled?: boolean; teamName?: string; greeting?: string }) => request<SupportSettingsDTO>("PATCH", "/admin/support/settings", body),
  },
  invitations: {
    create: (input: CreateInvitationInput) => request<CreatedInvitationDTO>("POST", "/invitations", input),
    list: (workspaceId?: string) => get<InvitationDTO[]>(`/invitations${qs({ workspaceId })}`),
    revoke: (id: string) => request<{ ok: true }>("DELETE", `/invitations/${id}`),
    lookup: (token: string) => get<InvitationLookupDTO>(`/invitations/lookup/${encodeURIComponent(token)}`),
    accept: (body: { token: string; name?: string; email?: string; password?: string }) =>
      request<{ ok: true; workspaceId: string }>("POST", "/invitations/accept", body),
  },
  providers: () => get<Provider[]>("/providers"),
  platforms: {
    get: (id: string) => get<PlatformConfig>(`/platforms/${id}`),
    save: (id: string, values: Record<string, string>) => request<{ ok: true }>("PUT", `/platforms/${id}`, { values }),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/platforms/${id}`),
  },
  accounts: {
    list: () => get<AccountDTO[]>("/accounts"),
    setStatus: (id: string, status: "active" | "disabled") => request<AccountDTO>("PATCH", `/accounts/${id}`, { status }),
    setGroup: (id: string, groupId: string | null) => request<AccountDTO>("PATCH", `/accounts/${id}`, { groupId }),
    /** Move many accounts at once (one request); `groupId: null` ungroups them. */
    moveToGroup: (accountIds: string[], groupId: string | null) =>
      request<{ ok: true; updated: number; groupId: string | null }>("POST", "/accounts/group", { accountIds, groupId }),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/accounts/${id}`),
    refresh: (id: string) => request<AccountDTO>("POST", `/accounts/${id}/refresh`),
    composerInfo: (id: string) => get<Record<string, unknown>>(`/accounts/${id}/composer-info`),
    options: (id: string, key: string, settings: Record<string, unknown>) =>
      get<FieldOption[]>(`/accounts/${id}/options/${encodeURIComponent(key)}?settings=${encodeURIComponent(JSON.stringify(settings))}`),
  },
  connect: {
    /** `switchAccount`: force the platform's login to pick another account (providers with `switchAccount` only). */
    url: (provider: string, opts: { switchAccount?: boolean } = {}) =>
      get<{ url: string }>(`/connect/${provider}/url${opts.switchAccount ? "?switchAccount=1" : ""}`),
    credentials: (provider: string, values: Record<string, string>) =>
      request<{ ids: string[] }>("POST", `/connect/${provider}`, { values }),
  },
  media: {
    list: (limit = 60, before?: number) => get<MediaDTO[]>(`/media${qs({ limit, before })}`),
    usage: () => get<MediaUsageDTO>("/media/usage"),
    setAlt: (id: string, alt: string | null) => request<MediaDTO>("PATCH", `/media/${id}`, { alt }),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/media/${id}`),
    fromUrl: (url: string) => request<MediaDTO>("POST", "/media/from-url", { url }),
  },
  posts: {
    list: (q: PostQuery = {}) => get<PostDTO[]>(`/posts${qs(q)}`),
    get: (id: string) => get<PostWithLogs>(`/posts/${id}`),
    validate: (input: CreatePostsInput) => request<{ errors: string[] }>("POST", "/posts/validate", input),
    create: (input: CreatePostsInput) => request<PostDTO[]>("POST", "/posts", input),
    update: (id: string, patch: PostPatch) => request<PostDTO>("PATCH", `/posts/${id}`, patch),
    retry: (id: string) => request<PostDTO>("POST", `/posts/${id}/retry`),
    /** needs_check only: mark it published (optionally with the live URL) or publish it again. */
    resolve: (id: string, input: ResolvePostInput) => request<PostDTO>("POST", `/posts/${id}/resolve`, input),
    cancel: (id: string) => request<PostDTO>("POST", `/posts/${id}/cancel`),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/posts/${id}`),
  },
  accountGroups: {
    list: () => get<AccountGroupDTO[]>("/account-groups"),
    create: (input: AccountGroupInput) => request<AccountGroupDTO>("POST", "/account-groups", input),
    update: (id: string, input: AccountGroupInput) => request<AccountGroupDTO>("PATCH", `/account-groups/${encodeURIComponent(id)}`, input),
    remove: (id: string) => request<{ ok: true; ungrouped: number }>("DELETE", `/account-groups/${encodeURIComponent(id)}`),
  },
  overview: () => get<Overview>("/overview"),
  playbooks: {
    list: (q: { q?: string; platform?: string; goal?: string; format?: string; source?: "builtin" | "custom" } = {}) => get<PlaybookSummaryDTO[]>(`/playbooks${qs(q)}`),
    get: (id: string, q: { version?: number; accountId?: string } = {}) => get<PlaybookDTO>(`/playbooks/${encodeURIComponent(id)}${qs(q)}`),
    create: (input: PlaybookInput) => request<PlaybookDTO>("POST", "/playbooks", input),
    update: (id: string, input: PlaybookInput) => request<PlaybookDTO>("PATCH", `/playbooks/${encodeURIComponent(id)}`, input),
    duplicate: (id: string, body: { name?: string; slug?: string } = {}) => request<PlaybookDTO>("POST", `/playbooks/${encodeURIComponent(id)}/duplicate`, body),
    archive: (id: string) => request<{ ok: true }>("DELETE", `/playbooks/${encodeURIComponent(id)}`),
    stats: (q: { days?: number; platform?: string; accountId?: string; sort?: PlaybookStatsSort } = {}) => get<PlaybookStatsDTO>(`/playbooks/stats${qs(q)}`),
  },
  analytics: {
    summary: (q: AnalyticsQuery) => get<AnalyticsSummaryDTO>(`/analytics/summary${qs(q)}`),
    posts: (q: AnalyticsQuery & { sort?: AnalyticsSort; limit?: number; offset?: number }) => get<AnalyticsPostDTO[]>(`/analytics/posts${qs(q)}`),
    postMetrics: (id: string) => get<PostMetricsDTO>(`/posts/${id}/metrics`),
    refresh: (body: { postId: string } | { accountId: string }) => request<AnalyticsRefreshDTO>("POST", "/analytics/refresh", body),
  },
  apps: {
    list: () => get<AppDTO[]>("/apps"),
    add: (appStoreId: string, name?: string) => request<AppDTO>("POST", "/apps", { appStoreId, ...(name ? { name } : {}) }),
    import: () => request<{ imported: number; apps: AppDTO[] }>("POST", "/apps/import", {}),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/apps/${id}`),
  },
  campaigns: {
    settings: () => get<CampaignSettingsDTO>("/campaigns/settings"),
    save: (input: CampaignSettingsInput) => request<CampaignSettingsDTO>("PUT", "/campaigns/settings", input),
    test: (input: CampaignSettingsInput = {}) => request<RevflareTestDTO>("POST", "/campaigns/test", input),
    sync: () => request<CampaignSyncDTO>("POST", "/campaigns/sync", {}),
    links: (q: { postId?: string; accountId?: string; appId?: string; kind?: "post" | "bio"; limit?: number } = {}) => get<CampaignLinkDTO[]>(`/campaigns/links${qs(q)}`),
    bioLink: (accountId: string, appId: string) => request<CampaignLinkDTO>("POST", "/campaigns/bio-links", { accountId, appId }),
  },
  settings: {
    get: () => get<AppSettings>("/settings"),
    save: (body: { publicUrl?: string; timezone?: string; experimentalIntegrations?: boolean; mediaRetentionDays?: number; workspaceProviders?: string[] | null }) => request<{ ok: true }>("PUT", "/settings", body),
  },
  version: () => get<VersionDTO>("/version"),
  admin: {
    overview: (days: number) => get<AdminOverviewDTO>(`/admin/overview?days=${days}`),
    email: () => get<AdminEmailDTO>("/admin/email"),
    setEmail: (enabled: boolean) => request<AdminEmailDTO>("PATCH", "/admin/email", { enabled }),
    testEmail: () => request<{ ok: true; to: string }>("POST", "/admin/email/test", {}),
    signup: () => get<AdminSignupDTO>("/admin/signup"),
    setSignup: (mode: SignupMode) => request<AdminSignupDTO>("PATCH", "/admin/signup", { mode }),
    legal: () => get<AdminLegalDTO>("/admin/legal"),
    saveLegal: (input: AdminLegalDTO) => request<AdminLegalDTO>("PUT", "/admin/legal", input),
    turnstile: () => get<AdminTurnstileDTO>("/admin/turnstile"),
    saveTurnstile: (input: AdminTurnstileInput) => request<AdminTurnstileDTO>("PUT", "/admin/turnstile", input),
    removeTurnstile: () => request<AdminTurnstileDTO>("DELETE", "/admin/turnstile"),
    testTurnstile: (secretKey?: string) => request<TurnstileTestDTO>("POST", "/admin/turnstile/test", { secretKey }),
    billing: {
      get: () => get<AdminBillingDTO>("/admin/billing"),
      update: (input: AdminBillingInput) => request<AdminBillingDTO>("PATCH", "/admin/billing", input),
      saveProvider: (id: BillingProviderId, input: BillingProviderInput) => request<AdminBillingDTO>("PUT", `/admin/billing/providers/${id}`, input),
      removeProvider: (id: BillingProviderId) => request<AdminBillingDTO>("DELETE", `/admin/billing/providers/${id}`),
      testProvider: (id: BillingProviderId) => request<BillingProviderTestDTO>("POST", `/admin/billing/providers/${id}/test`, {}),
      plans: () => get<AdminPlanDTO[]>("/admin/billing/plans"),
      createPlan: (input: PlanInput) => request<AdminPlanDTO>("POST", "/admin/billing/plans", input),
      suggestedPlans: () => request<AdminPlanDTO[]>("POST", "/admin/billing/plans/suggested", {}),
      updatePlan: (id: string, input: Partial<PlanInput>) => request<AdminPlanDTO>("PATCH", `/admin/billing/plans/${id}`, input),
      removePlan: (id: string) => request<{ ok: true; archived?: true }>("DELETE", `/admin/billing/plans/${id}`),
      workspaces: (status: BillingStatus[] = []) => get<AdminWorkspaceBillingDTO[]>(`/admin/billing/workspaces${qs({ status: status.join(",") })}`),
      setWorkspace: (id: string, input: AdminWorkspaceBillingInput) => request<AdminWorkspaceBillingDTO>("PATCH", `/admin/workspaces/${id}/billing`, input),
    },
  },
  updates: {
    get: () => get<UpdateStatusDTO>("/updates"),
    check: () => request<UpdateStatusDTO>("POST", "/updates/check"),
  },
  keys: {
    list: () => get<ApiKeyDTO[]>("/keys"),
    create: (name: string) => request<{ id: string; token: string }>("POST", "/keys", { name }),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/keys/${id}`),
  },
};
