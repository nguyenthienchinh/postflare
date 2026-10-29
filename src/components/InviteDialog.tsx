import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, Building2, Check, Copy, Share2, UserPlus } from "lucide-react";
import { api, isPlanLimit } from "../lib/api";
import { cn, copyText } from "../lib/format";
import { useSession } from "../lib/session";
import { formatDateTime } from "../lib/time";
import { useApp } from "../lib/app";
import type { CreatedInvitationDTO, RoleDTO, WorkspaceDTO } from "../lib/types";
import { useFetch } from "../lib/useFetch";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field, Input, Select } from "./ui/Form";
import { useToast } from "./ui/Toast";

/** Workspace roles the current user may hand out in a workspace: those whose permissions are a subset of their own. */
export function grantableRoles(roles: RoleDTO[] | undefined, myPermissions: readonly string[]): RoleDTO[] {
  const mine = new Set(myPermissions);
  return (roles ?? []).filter((r) => r.scope === "workspace" && r.permissions.every((p) => mine.has(p)));
}

/** Prefer Editor, else the least powerful grantable role. */
function defaultRole(roles: RoleDTO[]): string {
  return roles.find((r) => r.id === "role_ws_editor")?.id ?? [...roles].sort((a, b) => a.permissions.length - b.permissions.length)[0]?.id ?? "";
}

/**
 * Create an invitation link. `mode: "workspace"` invites into the given workspace (members.manage);
 * `mode: "admin"` (instance.users.manage) also picks the instance role and an existing or new workspace.
 */
export function InviteDialog({
  open,
  onClose,
  mode,
  workspaceId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  mode: "workspace" | "admin";
  workspaceId?: string;
  onCreated?: () => void;
}) {
  const { workspaces: myWorkspaces } = useSession();
  const toast = useToast();
  const roles = useFetch(open ? "roles" : null, api.roles.list, ["roles"]);
  const allWorkspaces = useFetch<WorkspaceDTO[]>(open && mode === "admin" ? "workspaces" : null, api.workspaces.list, ["workspaces"]);
  const [email, setEmail] = useState("");
  const [instanceRoleId, setInstanceRoleId] = useState("role_instance_member");
  const [target, setTarget] = useState<"existing" | "new">(mode === "admin" ? "new" : "existing");
  const [pickedWsId, setWsId] = useState(workspaceId ?? "");
  const [pickedRoleId, setRoleId] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvitationDTO | null>(null);

  const workspaceChoices = mode === "admin" ? (allWorkspaces.data ?? []) : myWorkspaces;
  // Derived (not synced with effects) so a choice made while data loads is never overwritten.
  const wsId = pickedWsId || workspaceChoices[0]?.id || "";
  const selectedWs = workspaceChoices.find((w) => w.id === wsId);
  const grantable = useMemo(() => grantableRoles(roles.data, selectedWs?.permissions ?? []), [roles.data, selectedWs]);
  const roleId = grantable.some((r) => r.id === pickedRoleId) ? pickedRoleId : defaultRole(grantable);
  const instanceRoles = (roles.data ?? []).filter((r) => r.scope === "instance");

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setInstanceRoleId("role_instance_member");
    setTarget(mode === "admin" ? "new" : "existing");
    setWsId(workspaceId ?? "");
    setNewName("");
    setRoleId("");
    setError(null);
    setCreated(null);
  }, [open, mode, workspaceId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const existing = target === "existing";
      const res = await api.invitations.create({
        email: email.trim() || null,
        instanceRoleId: mode === "admin" ? instanceRoleId : "role_instance_member",
        workspaceId: existing ? wsId : null,
        workspaceRoleId: existing ? roleId : null,
        newWorkspaceName: existing ? null : newName.trim() || null,
      });
      setCreated(res);
      onCreated?.();
    } catch (err) {
      if (!isPlanLimit(err)) setError((err as Error).message); // plan limits: PlanLimitDialog
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "admin" ? "Invite user" : "Invite member";
  if (created) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="Invitation link created"
        description="Send this link yourself (Postflare does not send email)."
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <InviteLink invitation={created} onError={(err) => toast.error(err)} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={mode === "admin" ? "Creates a link for a new user. You choose where they land." : `They join “${selectedWs?.name ?? "this workspace"}” with the role you pick.`}
    >
      <form onSubmit={submit}>
        <div className="space-y-5 p-5">
          <Field label="Email" help="Optional. When set, only this address can accept the invitation.">
            {(id) => <Input id={id} data-autofocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />}
          </Field>

          {mode === "admin" && (
            <>
              <Field label="Instance role" help="Admins manage users, platforms and instance settings.">
                {(id) => (
                  <Select id={id} value={instanceRoleId} onChange={(e) => setInstanceRoleId(e.target.value)}>
                    {instanceRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div>
                <p className="mb-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">Workspace</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <TargetOption
                    active={target === "new"}
                    onClick={() => setTarget("new")}
                    icon={<Building2 className="size-4" />}
                    title="New workspace"
                    description="Created for them; they become its owner."
                  />
                  <TargetOption
                    active={target === "existing"}
                    onClick={() => setTarget("existing")}
                    icon={<UserPlus className="size-4" />}
                    title="Existing workspace"
                    description="They join a workspace with a role."
                  />
                </div>
              </div>
            </>
          )}

          {target === "new" ? (
            <Field label="Workspace name" help="Leave empty to name it after them.">
              {(id) => <Input id={id} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Alex" maxLength={100} />}
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {mode === "admin" && (
                <Field label="Workspace">
                  {(id) => (
                    <Select id={id} value={wsId} onChange={(e) => setWsId(e.target.value)}>
                      {workspaceChoices.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label="Role" className={mode === "admin" ? undefined : "sm:col-span-2"} help={grantable.find((r) => r.id === roleId)?.description ?? undefined}>
                {(id) => (
                  <Select id={id} value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={!grantable.length}>
                    {grantable.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={target === "existing" && (!wsId || !roleId)}>
            Create invitation link
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TargetOption({ active, onClick, icon, title, description }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; description: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex gap-3 rounded-xl p-3 text-left ring-1 transition",
        active
          ? "bg-brand-50 ring-2 ring-brand-500 dark:bg-brand-950/40"
          : "ring-zinc-200 hover:bg-zinc-50 dark:ring-zinc-700 dark:hover:bg-zinc-800/60",
      )}
    >
      <span className={cn("mt-0.5", active ? "text-brand-600 dark:text-brand-400" : "text-zinc-400")}>{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-zinc-500">{description}</span>
      </span>
    </button>
  );
}

/** The one-time invitation URL with copy and (on mobile) share buttons. */
export function InviteLink({ invitation, onError }: { invitation: CreatedInvitationDTO; onError: (err: unknown) => void }) {
  const { tz } = useApp();
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="space-y-4 p-5">
      <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        Copy the link now: it is shown only once. Anyone with it can accept the invitation.
      </div>
      <Input readOnly value={invitation.url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" aria-label="Invitation link" />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          onClick={async () => {
            try {
              await copyText(invitation.url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch (err) {
              onError(err);
            }
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </Button>
        {canShare && (
          <Button
            icon={<Share2 className="size-4" />}
            onClick={() => navigator.share({ title: "Join me on Postflare", url: invitation.url }).catch((err: Error) => err.name !== "AbortError" && onError(err))}
          >
            Share
          </Button>
        )}
      </div>
      <p className="text-xs text-zinc-500">Expires {formatDateTime(invitation.expiresAt, tz, { year: "numeric" })}.</p>
    </div>
  );
}
