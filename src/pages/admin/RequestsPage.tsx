import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CheckCircle2, ExternalLink, Inbox, Link2, Mail, RefreshCw, Search, UserCheck, XCircle } from "lucide-react";
import { ProviderLogo } from "../../components/ProviderLogo";
import { InitialsAvatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Drawer } from "../../components/ui/Dialog";
import { Checkbox, Input, Textarea } from "../../components/ui/Form";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, Tabs } from "../../components/ui/Misc";
import { Notice } from "../../components/ui/Section";
import { useToast } from "../../components/ui/Toast";
import { PLATFORMS, ROLE_LABELS, STATUS_LABELS, STATUS_TONES, VOLUME_LABELS, platformName } from "../../lib/accessRequests";
import { api } from "../../lib/api";
import { useApp } from "../../lib/app";
import { cn } from "../../lib/format";
import { useSession } from "../../lib/session";
import { formatDateTime, relativeTime } from "../../lib/time";
import type { AccessRequestDTO, AccessRequestListDTO, AccessRequestReviewDTO, AccessRequestStatus } from "../../lib/types";
import { invalidate, useFetch } from "../../lib/useFetch";

type Filter = AccessRequestStatus | "all";

/** Admin → Requests: "Request access" applications (signup_mode apply), reviewed one by one. `?id=` opens one (admin email link). */
export function RequestsPage() {
  const { canInstance } = useSession();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>("pending");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [more, setMore] = useState<AccessRequestDTO[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const list = useFetch(`access-requests:${filter}:${query}`, () => api.accessRequests.list({ status: filter, q: query || undefined }), ["requests"]);
  const signup = useFetch(canInstance("instance.settings.manage") ? "admin-signup" : null, api.admin.signup, ["settings"]);
  const openId = params.get("id");

  // Search after a short pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setMore([]);
    setNextBefore(list.data?.nextBefore ?? null);
  }, [list.data]);

  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const page = await api.accessRequests.list({ status: filter, q: query || undefined, before: nextBefore });
      setMore((m) => [...m, ...page.items]);
      setNextBefore(page.nextBefore);
    } finally {
      setLoadingMore(false);
    }
  }

  const items = [...(list.data?.items ?? []), ...more];
  const counts = list.data?.counts;
  const open = (id: string | null) => setParams(id ? { id } : {}, { replace: true });
  const tabs: Array<{ value: Filter; label: string; count?: number }> = [
    { value: "pending", label: "Pending", count: counts?.pending },
    { value: "approved", label: "Approved", count: counts?.approved },
    { value: "rejected", label: "Rejected", count: counts?.rejected },
    { value: "all", label: "All", count: counts ? counts.pending + counts.approved + counts.rejected + counts.withdrawn : undefined },
  ];

  return (
    <>
      <PageHeader title="Requests" description="People who asked for access on /apply. Approving sends them an invitation into a workspace of their own." />
      {signup.data && signup.data.mode !== "apply" && (
        <Notice className="mb-4">
          {signup.data.mode === "open" ? "Public sign-up is open, so the request form is off." : "The request form is off: this instance is invitation only."} Change it in{" "}
          <Link to="/admin/settings#signup" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            Instance settings → Sign-up
          </Link>
          .
        </Notice>
      )}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs tabs={tabs} value={filter} onChange={setFilter} />
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input aria-label="Search requests" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, company or link" className="pl-8" />
        </div>
      </div>
      <Card className="min-w-0 overflow-hidden">
        {!list.data ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : !items.length ? (
          <EmptyState
            icon={<Inbox />}
            title={query ? "No matching requests" : filter === "pending" ? "No requests waiting" : "No requests"}
            description={filter === "pending" && !query ? "New requests show up here, and instance admins get a notification." : undefined}
          />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {items.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => open(r.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  <InitialsAvatar name={r.name} seed={r.email} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{r.name}</span>
                      {r.company && <span className="truncate font-normal text-zinc-500">· {r.company}</span>}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {r.email} · {ROLE_LABELS[r.role] ?? r.role}
                    </p>
                  </div>
                  <div className="hidden shrink-0 -space-x-1 md:flex">
                    {r.platforms.slice(0, 6).map((p) => (
                      <ProviderLogo key={p} provider={PLATFORMS.find((x) => x.id === p)} size="sm" className="rounded-full ring-2 ring-white dark:ring-zinc-900" />
                    ))}
                  </div>
                  <span className="hidden w-28 shrink-0 text-right text-xs text-zinc-500 sm:block">{relativeTime(r.createdAt)}</span>
                  <StatusBadge r={r} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {nextBefore && (
          <div className="border-t border-zinc-100 p-3 text-center dark:border-zinc-800">
            <Button size="sm" variant="ghost" loading={loadingMore} onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
      <RequestDrawer id={openId} list={list.data} onClose={() => open(null)} />
    </>
  );
}

function StatusBadge({ r }: { r: AccessRequestDTO }) {
  if (r.status === "approved" && r.invitationAccepted) return <Badge tone="green">Joined</Badge>;
  return (
    <Badge tone={STATUS_TONES[r.status]} dot={r.status === "pending"}>
      {STATUS_LABELS[r.status]}
    </Badge>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "") + new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function RequestDrawer({ id, list, onClose }: { id: string | null; list: AccessRequestListDTO | undefined; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { tz } = useApp();
  // From the list when it is there; fetched for links straight to one request.
  const fromList = list?.items.find((r) => r.id === id);
  const fetched = useFetch(id && !fromList ? `access-request:${id}` : null, () => api.accessRequests.get(id!), ["requests"]);
  const [result, setResult] = useState<AccessRequestReviewDTO | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const r = result?.request.id === id ? result.request : (fromList ?? fetched.data);

  useEffect(() => {
    setResult(null);
    setRejecting(false);
    setNote("");
    setNotify(true);
  }, [id]);

  async function review(status: "approved" | "rejected") {
    if (!r) return;
    if (status === "approved" && !(await confirm({ title: `Approve ${r.name}?`, message: `${r.email} gets an invitation link into a new workspace, valid for 7 days.`, confirmLabel: "Approve" }))) return;
    setBusy(true);
    try {
      const res = await api.accessRequests.review(r.id, { status, ...(note.trim() ? { note: note.trim() } : {}), notify: status === "rejected" ? notify : true });
      setResult(res);
      setRejecting(false);
      toast.success(
        status === "rejected"
          ? `${r.name} rejected${res.emailed ? ", email sent" : ""}`
          : res.existingUser
            ? `${r.name} already has an account: marked approved`
            : res.emailed
              ? `Invitation emailed to ${r.email}`
              : "Approved: copy the invitation link and send it",
      );
      invalidate("requests", "invitations");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const canApprove = r && (r.status === "pending" || r.status === "rejected" || r.status === "withdrawn");
  const canRelink = r && r.status === "approved" && !r.invitationAccepted && !r.existingUser && !!r.invitationId;
  const canReject = r && (r.status === "pending" || (r.status === "approved" && !r.invitationAccepted));

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width="max-w-lg"
      title={
        r ? (
          <span className="flex items-center gap-2">
            <span className="truncate">{r.name}</span>
            <StatusBadge r={r} />
          </span>
        ) : (
          "Request"
        )
      }
      footer={
        r &&
        !rejecting && (
          <>
            {canApprove && (
              <Button variant="primary" icon={<CheckCircle2 className="size-4" />} loading={busy} onClick={() => void review("approved")}>
                Approve
              </Button>
            )}
            {canRelink && (
              <Button icon={<RefreshCw className="size-4" />} loading={busy} onClick={() => void review("approved")} title="The previous link stops working">
                New invitation link
              </Button>
            )}
            {canReject && (
              <Button variant="ghost" icon={<XCircle className="size-4" />} disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            )}
          </>
        )
      }
    >
      {!r ? (
        fetched.error ? (
          <p className="p-5 text-sm text-zinc-500">{fetched.error.message}</p>
        ) : (
          <div className="space-y-3 p-5">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        )
      ) : (
        <div className="space-y-5 p-5 text-sm">
          {result?.invitation && (
            <div className="rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200 dark:bg-emerald-950/30 dark:ring-emerald-900">
              <p className="flex items-center gap-2 font-medium text-emerald-900 dark:text-emerald-200">
                <Link2 className="size-4" /> Invitation link
              </p>
              <p className="mt-1 text-emerald-900/80 dark:text-emerald-200/80">
                {result.emailed ? `Emailed to ${r.email}. ` : "Not emailed: send this link to them yourself. "}It only works for {r.email} and expires {relativeTime(result.invitation.expiresAt)}.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-700 ring-1 ring-emerald-200 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-emerald-900">
                  {result.invitation.url}
                </code>
                <CopyButton text={result.invitation.url} />
              </div>
            </div>
          )}
          {result?.existingUser && (
            <Notice>
              <span className="flex items-center gap-2">
                <UserCheck className="size-4 shrink-0" /> {r.email} already has an account, so no invitation was needed. Marked approved.
              </span>
            </Notice>
          )}
          {rejecting && (
            <div className="space-y-3 rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-800">
              <p className="font-medium">Reject this request</p>
              <Textarea
                aria-label="Note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                placeholder="Optional note. If they are emailed, it is included in the message."
                data-autofocus
              />
              <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
                <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                Email them a short, polite note (when email is set up)
              </label>
              <div className="flex gap-2">
                <Button variant="danger" loading={busy} onClick={() => void review("rejected")}>
                  Reject
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5">
            <Row label="Email">
              <a href={`mailto:${r.email}`} className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
                <Mail className="size-3.5" /> {r.email}
              </a>
              {r.existingUser && !r.invitationAccepted && <span className="ml-2 text-xs text-zinc-500">(has an account)</span>}
            </Row>
            <Row label="Company or brand">{r.company ?? <span className="text-zinc-400">–</span>}</Row>
            <Row label="Link">
              <a href={r.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
                <span className="truncate">{hostOf(r.url)}</span> <ExternalLink className="size-3.5 shrink-0" />
              </a>
            </Row>
            <Row label="Describes them">{ROLE_LABELS[r.role] ?? r.role}</Row>
            <Row label="Platforms">
              <span className="flex flex-wrap gap-1.5">
                {r.platforms.map((p) => (
                  <Badge key={p}>{platformName(p)}</Badge>
                ))}
              </span>
            </Row>
            <Row label="Accounts">{r.accounts ?? <span className="text-zinc-400">–</span>}</Row>
            <Row label="Posts per month">{r.volume ? VOLUME_LABELS[r.volume] : <span className="text-zinc-400">Not sure yet</span>}</Row>
            <Row label="Heard about us">{r.referral ?? <span className="text-zinc-400">–</span>}</Row>
          </dl>

          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">Use case</p>
            <p className="whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 leading-relaxed text-zinc-800 ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:text-zinc-200 dark:ring-zinc-800">{r.useCase}</p>
          </div>

          <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-zinc-100 pt-4 text-xs text-zinc-500 dark:border-zinc-800">
            <Row label="Requested">
              {formatDateTime(r.createdAt, tz, { year: "numeric" })}
              {r.updatedAt !== r.createdAt && r.status === "pending" && ` · updated ${relativeTime(r.updatedAt)}`}
            </Row>
            {r.reviewedAt && (
              <Row label={r.status === "rejected" ? "Rejected" : "Approved"}>
                {formatDateTime(r.reviewedAt, tz, { year: "numeric" })} by {r.reviewedBy?.name ?? "a former admin"}
              </Row>
            )}
            {r.reviewNote && <Row label="Note">{r.reviewNote}</Row>}
            {r.status === "approved" && r.invitationId && <Row label="Invitation">{r.invitationAccepted ? "Accepted: they have joined" : "Sent, not accepted yet"}</Row>}
            <Row label="From">
              {[r.country, r.ip].filter(Boolean).join(" · ") || "–"}
              {r.userAgent && <span className={cn("mt-0.5 block truncate")} title={r.userAgent}>{r.userAgent}</span>}
            </Row>
          </dl>
        </div>
      )}
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
