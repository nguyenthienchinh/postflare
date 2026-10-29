import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, Building2, LogOut, MailPlus, Trash2, UserPlus, Users } from "lucide-react";
import { BillingTab } from "../components/billing/BillingTab";
import { CampaignSections } from "../components/campaigns/CampaignSettings";
import { grantableRoles, InviteDialog } from "../components/InviteDialog";
import { InitialsAvatar } from "../components/ui/Avatar";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input, Select } from "../components/ui/Form";
import { Badge, Card, CardHeader, PageHeader, Skeleton, Tabs } from "../components/ui/Misc";
import { Notice, Section } from "../components/ui/Section";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { useBilling } from "../lib/billing";
import { useSession } from "../lib/session";
import { formatDate, relativeTime } from "../lib/time";
import type { MemberDTO, MeWorkspace, RoleDTO } from "../lib/types";
import { invalidate, useFetch } from "../lib/useFetch";

export function WorkspaceSettingsPage() {
  const { workspace } = useSession();
  const billing = useBilling();
  const [params, setParams] = useSearchParams();
  if (!workspace) return null; // Gate guarantees one.
  // Hosted mode only: a Billing tab (deep link ?tab=billing, where checkouts and 402 answers return to).
  const billingOn = !!billing.data?.enabled;
  const wantsBilling = params.get("tab") === "billing";
  const tab = billingOn && wantsBilling ? "billing" : "general";
  const waiting = wantsBilling && !billing.data && !billing.error && billing.loading;
  return (
    <>
      <PageHeader
        title="Workspace settings"
        description={
          <>
            {workspace.name} · your role: <strong className="font-medium text-zinc-700 dark:text-zinc-300">{workspace.role.name}</strong>
            {workspace.viaAdmin && " (instance admin access)"}
          </>
        }
      />
      {billingOn && (
        <Tabs
          className="mb-6"
          tabs={[
            { value: "general", label: "General" },
            { value: "billing", label: "Billing" },
          ]}
          value={tab}
          onChange={(v) => setParams(v === "billing" ? { tab: "billing" } : {}, { replace: true })}
        />
      )}
      {waiting ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : tab === "billing" ? (
        <BillingTab />
      ) : (
        <div className="space-y-6">
          <GeneralSection workspace={workspace} />
          <MembersCard workspace={workspace} />
          <CampaignSections />
          <DangerZone workspace={workspace} />
        </div>
      )}
    </>
  );
}

function GeneralSection({ workspace }: { workspace: MeWorkspace }) {
  const { can, refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const editable = can("workspace.manage");
  useEffect(() => setName(workspace.name), [workspace.name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.workspaces.rename(workspace.id, name.trim());
      await refresh();
      toast.success("Workspace renamed");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={<Building2 />} title="General" description="Accounts, posts, media and API keys belong to this workspace.">
      <form onSubmit={save} className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Workspace name" className="flex-1" help={editable ? undefined : "Only workspace admins can rename it."}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} maxLength={100} />}
        </Field>
        {editable && (
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || name.trim() === workspace.name}>
            Save
          </Button>
        )}
      </form>
    </Section>
  );
}

function MembersCard({ workspace }: { workspace: MeWorkspace }) {
  const { can, user } = useSession();
  const { tz } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const manage = can("members.manage");
  const members = useFetch(`members:${workspace.id}`, () => api.workspaces.members(workspace.id), ["members"]);
  const roles = useFetch("roles", api.roles.list, ["roles"]);
  const invites = useFetch(manage ? `invites:${workspace.id}` : null, () => api.invitations.list(workspace.id), ["invitations"]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const grantable = useMemo(() => grantableRoles(roles.data, workspace.permissions), [roles.data, workspace.permissions]);
  const roleById = useMemo(() => new Map((roles.data ?? []).map((r) => [r.id, r])), [roles.data]);
  const mine = new Set<string>(workspace.permissions);
  /** Members whose role has permissions I don't have (e.g. an Owner, for an Admin) are out of reach. */
  const reachable = (m: MemberDTO) => (roleById.get(m.role.id)?.permissions ?? []).every((p) => mine.has(p));

  async function changeRole(m: MemberDTO, roleId: string) {
    setBusy(m.userId);
    try {
      await api.workspaces.setMemberRole(workspace.id, m.userId, roleId);
      toast.success(`${m.name} is now ${roleById.get(roleId)?.name ?? "updated"}`);
      invalidate("members");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function remove(m: MemberDTO) {
    const ok = await confirm({
      title: `Remove ${m.name}?`,
      message: `They lose access to “${workspace.name}” and their API keys for it stop working. Posts they created stay.`,
      confirmLabel: "Remove member",
      danger: true,
    });
    if (!ok) return;
    setBusy(m.userId);
    try {
      await api.workspaces.removeMember(workspace.id, m.userId);
      toast.success(`${m.name} removed`);
      invalidate("members");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card className="min-w-0 overflow-hidden">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Users className="size-4 text-zinc-400" /> Members
              {members.data && <span className="font-normal text-zinc-400">{members.data.length}</span>}
            </span>
          }
          description="People with access to this workspace and what they can do."
          action={
            manage && (
              <Button variant="primary" size="sm" icon={<UserPlus className="size-4" />} onClick={() => setInviteOpen(true)}>
                Invite
              </Button>
            )
          }
        />
        {!members.data ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {members.data.map((m) => {
              const self = m.userId === user.id;
              const editable = manage && reachable(m);
              // Keep the current role selectable even when it is not grantable (shown, but cannot be picked again).
              const options: Array<Pick<RoleDTO, "id" | "name">> = grantable.some((r) => r.id === m.role.id) ? grantable : [m.role, ...grantable];
              return (
                <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3 sm:flex-nowrap">
                  <InitialsAvatar name={m.name} seed={m.userId} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      <span className="truncate">{m.name}</span>
                      {self && <Badge tone="brand">You</Badge>}
                      {m.status === "disabled" && <Badge tone="red">Disabled</Badge>}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {m.email} · joined {formatDate(m.joinedAt, tz)}
                      {m.lastLoginAt ? ` · active ${relativeTime(m.lastLoginAt)}` : ""}
                    </p>
                  </div>
                  <div className={editable ? "flex w-full items-center gap-1 sm:w-auto" : "flex items-center"}>
                    {editable ? (
                      <Select
                        aria-label={`Role of ${m.name}`}
                        value={m.role.id}
                        disabled={busy === m.userId}
                        onChange={(e) => void changeRole(m, e.target.value)}
                        className="w-full sm:w-36"
                      >
                        {options.map((r) => (
                          <option key={r.id} value={r.id} disabled={!grantable.some((g) => g.id === r.id)}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge className="sm:mr-1">{m.role.name}</Badge>
                    )}
                    {editable && !self && (
                      <IconButton label={`Remove ${m.name}`} size="sm" variant="danger" disabled={busy === m.userId} onClick={() => void remove(m)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {manage && invites.data && invites.data.length > 0 && (
          <div className="border-t border-zinc-100 dark:border-zinc-800">
            <p className="px-5 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-zinc-400">Pending invitations</p>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {invites.data.map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
                    <MailPlus className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{inv.email ?? "Anyone with the link"}</p>
                    <p className="truncate text-xs text-zinc-500">
                      {inv.workspaceRole?.name ?? "Member"} · invited by {inv.invitedBy?.name ?? "a former user"} · expires {relativeTime(inv.expiresAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await api.invitations.revoke(inv.id);
                        toast.success("Invitation revoked");
                        invalidate("invitations");
                      } catch (err) {
                        toast.error(err);
                      }
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} mode="workspace" workspaceId={workspace.id} onCreated={() => invalidate("invitations")} />
    </>
  );
}

function DangerZone({ workspace }: { workspace: MeWorkspace }) {
  const { can, user, refresh } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canDelete = can("workspace.delete");
  // Every demo visitor is the same user: leaving would lock everybody out (the server refuses it too).
  const isMember = !workspace.viaAdmin && !user.demo;
  if (!isMember && !canDelete) return null;

  async function leave() {
    const ok = await confirm({
      title: `Leave “${workspace.name}”?`,
      message: "You lose access to its accounts, posts and media. Someone has to invite you again to come back.",
      confirmLabel: "Leave workspace",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.workspaces.removeMember(workspace.id, user.id);
      toast.success(`You left “${workspace.name}”`);
      await refresh(); // The session moves on to another workspace.
      navigate("/");
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <Section icon={<AlertTriangle />} title="Danger zone" description="Leaving or deleting cannot be undone." className="ring-red-200 dark:ring-red-950">
      <div className="space-y-4">
        {isMember && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1 text-sm">
              <p className="font-medium">Leave workspace</p>
              <p className="text-zinc-500">A workspace must keep at least one owner.</p>
            </div>
            <Button icon={<LogOut className="size-4" />} onClick={() => void leave()}>
              Leave
            </Button>
          </div>
        )}
        {canDelete && (
          <div className="flex flex-col gap-3 border-t border-zinc-100 pt-4 sm:flex-row sm:items-center dark:border-zinc-800">
            <div className="flex-1 text-sm">
              <p className="font-medium">Delete workspace</p>
              <p className="text-zinc-500">Deletes its accounts, posts, media files and API keys, and cancels scheduled posts.</p>
            </div>
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          </div>
        )}
      </div>
      <DeleteWorkspaceDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} workspace={workspace} />
    </Section>
  );
}

function DeleteWorkspaceDialog({ open, onClose, workspace }: { open: boolean; onClose: () => void; workspace: MeWorkspace }) {
  const { refresh } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (typed.trim() !== workspace.name) return;
    setBusy(true);
    try {
      await api.workspaces.remove(workspace.id);
      toast.success(`“${workspace.name}” deleted`);
      onClose();
      await refresh();
      navigate("/");
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Delete workspace">
      <form onSubmit={submit}>
        <div className="space-y-4 p-5">
          <Notice tone="red">
            This permanently deletes <strong>{workspace.name}</strong> with all its accounts, posts and media. Scheduled posts will not be published.
          </Notice>
          <Field label={<>Type <strong className="font-semibold">{workspace.name}</strong> to confirm</>}>
            {(id) => <Input id={id} data-autofocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={typed.trim() !== workspace.name}>
            Delete workspace
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
