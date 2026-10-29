import { useState } from "react";
import { Ban, CheckCircle2, MailPlus, Trash2, UserPlus } from "lucide-react";
import { InviteDialog } from "../../components/InviteDialog";
import { InitialsAvatar } from "../../components/ui/Avatar";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Select } from "../../components/ui/Form";
import { Badge, Card, CardHeader, PageHeader, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { cn } from "../../lib/format";
import { useSession } from "../../lib/session";
import { relativeTime } from "../../lib/time";
import type { UserDTO } from "../../lib/types";
import { invalidate, useFetch } from "../../lib/useFetch";

export function UsersPage() {
  const { user: me, refresh } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const users = useFetch("users", api.users.list, ["users"]);
  const roles = useFetch("roles", api.roles.list, ["roles"]);
  const invites = useFetch("invitations:all", () => api.invitations.list(), ["invitations"]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const instanceRoles = (roles.data ?? []).filter((r) => r.scope === "instance");

  async function run(u: UserDTO, fn: () => Promise<unknown>, success: string) {
    setBusy(u.id);
    try {
      await fn();
      toast.success(success);
      invalidate("users", "members");
      void refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  const toggleStatus = async (u: UserDTO) => {
    if (u.status === "active") {
      const ok = await confirm({
        title: `Disable ${u.name}?`,
        message: "They are signed out everywhere and their API keys stop working. Their posts stay scheduled.",
        confirmLabel: "Disable",
        danger: true,
      });
      if (!ok) return;
    }
    await run(u, () => api.users.update(u.id, { status: u.status === "active" ? "disabled" : "active" }), u.status === "active" ? `${u.name} disabled` : `${u.name} enabled`);
  };

  const remove = async (u: UserDTO) => {
    const ok = await confirm({
      title: `Delete ${u.name}?`,
      message: "Their memberships, sessions and API keys are deleted. Accounts, posts and media they created stay in their workspaces.",
      confirmLabel: "Delete user",
      danger: true,
    });
    if (ok) await run(u, () => api.users.remove(u.id), `${u.name} deleted`);
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with an account on this instance."
        actions={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviteOpen(true)}>
            Invite user
          </Button>
        }
      />
      <Card className="min-w-0 overflow-hidden">
        {!users.data ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="px-5 py-3 font-medium">User</th>
                  <th className="px-3 py-3 font-medium">Instance role</th>
                  <th className="px-3 py-3 font-medium">Workspaces</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Last login</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {users.data.map((u) => {
                  const self = u.id === me.id;
                  return (
                    <tr key={u.id} className={cn(u.status === "disabled" && "opacity-60")}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <InitialsAvatar name={u.name} seed={u.id} />
                          <div className="min-w-0">
                            <p className="flex items-center gap-2 font-medium">
                              <span className="truncate">{u.name}</span>
                              {self && <Badge tone="brand">You</Badge>}
                            </p>
                            <p className="truncate text-xs text-zinc-500">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <Select
                          aria-label={`Instance role of ${u.name}`}
                          value={u.role.id}
                          disabled={self || busy === u.id}
                          title={self ? "You cannot change your own instance role" : undefined}
                          onChange={(e) => {
                            const role = instanceRoles.find((r) => r.id === e.target.value);
                            void run(u, () => api.users.update(u.id, { roleId: e.target.value }), `${u.name} is now ${role?.name ?? "updated"}`);
                          }}
                          className="w-32"
                        >
                          {(instanceRoles.some((r) => r.id === u.role.id) ? instanceRoles : [u.role, ...instanceRoles]).map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {u.workspaces.length ? (
                            u.workspaces.map((w) => (
                              <Badge key={w.id}>
                                {w.name} <span className="text-zinc-400">· {w.role.name}</span>
                              </Badge>
                            ))
                          ) : (
                            <span className="text-xs text-zinc-400">None</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {u.status === "active" ? (
                          <Badge tone="green" dot>
                            Active
                          </Badge>
                        ) : u.status === "pending" ? (
                          <Badge tone="amber" title="Signed up, email not confirmed yet (deleted after 7 days)">
                            Pending
                          </Badge>
                        ) : (
                          <Badge tone="red">Disabled</Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-zinc-500">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : "Never"}</td>
                      <td className="px-5 py-3">
                        {!self && (
                          <div className="flex justify-end gap-1">
                            <IconButton label={u.status === "active" ? "Disable" : u.status === "pending" ? "Activate (skip email confirmation)" : "Enable"} size="sm" disabled={busy === u.id} onClick={() => void toggleStatus(u)}>
                              {u.status === "active" ? <Ban className="size-4" /> : <CheckCircle2 className="size-4 text-emerald-600" />}
                            </IconButton>
                            <IconButton label="Delete" size="sm" variant="danger" disabled={busy === u.id} onClick={() => void remove(u)}>
                              <Trash2 className="size-4" />
                            </IconButton>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {invites.data && invites.data.length > 0 && (
        <Card className="mt-6 min-w-0 overflow-hidden">
          <CardHeader title="Pending invitations" description="Links that have not been accepted yet. They expire after 7 days." />
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {invites.data.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
                  <MailPlus className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{inv.email ?? "Anyone with the link"}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {inv.workspaceId ? `${inv.workspaceName ?? "Workspace"} as ${inv.workspaceRole?.name ?? "member"}` : `New workspace “${inv.newWorkspaceName ?? "named after them"}”`} ·{" "}
                    {inv.instanceRole.name} · by {inv.invitedBy?.name ?? "a former user"} · expires {relativeTime(inv.expiresAt)}
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
        </Card>
      )}
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} mode="admin" onCreated={() => invalidate("invitations")} />
    </>
  );
}
