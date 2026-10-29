import { useEffect, useState, type FormEvent } from "react";
import { Check, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select, Textarea } from "../../components/ui/Form";
import { Card, CardHeader, PageHeader, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { cn } from "../../lib/format";
import type { PermissionInfo, PermissionKey, RoleDTO, RoleScope } from "../../lib/types";
import { invalidate, useFetch } from "../../lib/useFetch";

const SCOPES: Array<{ scope: RoleScope; title: string; description: string }> = [
  { scope: "instance", title: "Instance roles", description: "Every user has one. Controls users, platforms and instance settings." },
  { scope: "workspace", title: "Workspace roles", description: "A member has one per workspace. Controls accounts, posts, media and members there." },
];

export function RolesPage() {
  const roles = useFetch("roles", api.roles.list, ["roles"]);
  const perms = useFetch("permissions", api.roles.permissions);
  const [editing, setEditing] = useState<{ role: RoleDTO | null; scope: RoleScope } | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  async function remove(r: RoleDTO) {
    const ok = await confirm({ title: `Delete role “${r.name}”?`, message: "Only roles that nobody uses can be deleted.", confirmLabel: "Delete role", danger: true });
    if (!ok) return;
    try {
      await api.roles.remove(r.id);
      toast.success("Role deleted");
      invalidate("roles");
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <>
      <PageHeader
        title="Roles"
        description="Roles are named bundles of permissions. Built-in roles cannot be changed; create custom ones for anything else."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ role: null, scope: "workspace" })}>
            New role
          </Button>
        }
      />
      <div className="space-y-6">
        {SCOPES.map(({ scope, title, description }) => {
          // Built-ins from most to least powerful (Owner, Admin, Editor, Viewer), custom roles after them.
          const list = (roles.data ?? [])
            .filter((r) => r.scope === scope)
            .sort((a, b) => Number(b.builtin) - Number(a.builtin) || (a.builtin ? b.permissions.length - a.permissions.length : a.createdAt - b.createdAt));
          const rows = (perms.data ?? []).filter((p) => p.scope === scope);
          return (
            <Card key={scope} className="min-w-0 overflow-hidden">
              <CardHeader
                title={title}
                description={description}
                action={
                  <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ role: null, scope })}>
                    Custom role
                  </Button>
                }
              />
              {!roles.data || !perms.data ? (
                <div className="p-5">
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-800">
                        <th className="sticky left-0 z-10 min-w-56 bg-white px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                          Permission
                        </th>
                        {list.map((r) => (
                          <th key={r.id} className="min-w-28 px-3 py-3 text-center align-bottom font-medium">
                            <div className="flex flex-col items-center gap-1">
                              <span className="flex items-center gap-1">
                                {r.builtin && <Lock className="size-3 text-zinc-400" aria-label="Built-in" />}
                                {r.name}
                              </span>
                              <span className="text-xs font-normal text-zinc-400" title="Users or memberships with this role">
                                {r.assigned} assigned
                              </span>
                              {!r.builtin && (
                                <span className="flex gap-0.5">
                                  <IconButton label={`Edit ${r.name}`} size="sm" onClick={() => setEditing({ role: r, scope })}>
                                    <Pencil className="size-3.5" />
                                  </IconButton>
                                  <IconButton label={`Delete ${r.name}`} size="sm" variant="danger" onClick={() => void remove(r)}>
                                    <Trash2 className="size-3.5" />
                                  </IconButton>
                                </span>
                              )}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {rows.map((p) => (
                        <tr key={p.key} className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30">
                          <td className="sticky left-0 z-10 bg-white px-5 py-2.5 dark:bg-zinc-900">
                            <p className="font-medium">{p.label}</p>
                            <p className="max-w-sm text-xs text-zinc-500">{p.description}</p>
                          </td>
                          {list.map((r) => (
                            <td key={r.id} className="px-3 py-2.5 text-center">
                              {r.permissions.includes(p.key) ? (
                                <Check className="mx-auto size-4 text-emerald-600 dark:text-emerald-400" aria-label="Granted" />
                              ) : (
                                <span className="text-zinc-300 dark:text-zinc-700" aria-label="Not granted">
                                  –
                                </span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <RoleDialog
        open={!!editing}
        role={editing?.role ?? null}
        initialScope={editing?.scope ?? "workspace"}
        permissions={perms.data ?? []}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

function RoleDialog({
  open,
  role,
  initialScope,
  permissions,
  onClose,
}: {
  open: boolean;
  role: RoleDTO | null;
  initialScope: RoleScope;
  permissions: PermissionInfo[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [scope, setScope] = useState<RoleScope>(initialScope);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<PermissionKey>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setScope(role?.scope ?? initialScope);
    setName(role?.name ?? "");
    setDescription(role?.description ?? "");
    setSelected(new Set(role?.permissions ?? []));
    setError(null);
  }, [open, role, initialScope]);

  const rows = permissions.filter((p) => p.scope === scope);
  const toggle = (key: PermissionKey) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const perms = rows.map((p) => p.key).filter((k) => selected.has(k));
    try {
      if (role) await api.roles.update(role.id, { name: name.trim(), description: description.trim() || null, permissions: perms });
      else await api.roles.create({ scope, name: name.trim(), description: description.trim() || null, permissions: perms });
      toast.success(role ? "Role saved" : "Role created");
      invalidate("roles");
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={role ? `Edit “${role.name}”` : "New custom role"} description={role ? `${role.assigned} assigned` : undefined}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              {(id) => <Input id={id} data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="e.g. Publisher" />}
            </Field>
            <Field label="Scope" help={role ? "Cannot be changed." : undefined}>
              {(id) => (
                <Select
                  id={id}
                  value={scope}
                  disabled={!!role}
                  onChange={(e) => {
                    setScope(e.target.value as RoleScope);
                    setSelected(new Set());
                  }}
                >
                  <option value="workspace">Workspace</option>
                  <option value="instance">Instance</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Description">
            {(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} className="min-h-16" placeholder="Optional" />}
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">{scope === "instance" ? "Instance permissions" : "Workspace permissions"}</legend>
            <div className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
              {rows.map((p) => (
                <label key={p.key} className={cn("flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40")}>
                  <Checkbox className="mt-0.5" checked={selected.has(p.key)} onChange={() => toggle(p.key)} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{p.label}</span>
                    <span className="block text-xs text-zinc-500">{p.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            {role ? "Save role" : "Create role"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
