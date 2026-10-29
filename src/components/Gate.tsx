import { useState, type FormEvent, type ReactNode } from "react";
import { Building2, Lock, Plus } from "lucide-react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import type { InstancePermission, WorkspacePermission } from "../lib/types";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field, Input } from "./ui/Form";
import { Card, EmptyState } from "./ui/Misc";
import { useToast } from "./ui/Toast";

/** Renders a workspace page only when there is a current workspace and the role grants `permission`. */
export function Gate({ permission, children }: { permission?: WorkspacePermission; children: ReactNode }) {
  const { workspace, can } = useSession();
  if (!workspace) return <NoWorkspace />;
  if (permission && !can(permission)) return <NoAccess />;
  return <>{children}</>;
}

/** Renders an admin page only with the instance permission. */
export function InstanceGate({ permission, children }: { permission: InstancePermission; children: ReactNode }) {
  const { canInstance } = useSession();
  if (!canInstance(permission)) return <NoAccess />;
  return <>{children}</>;
}

export function NoAccess() {
  return (
    <Card>
      <EmptyState
        icon={<Lock />}
        title="You don't have access to this page"
        description="Your role does not include it. Ask an admin of this workspace if you need it."
      />
    </Card>
  );
}

export function NoWorkspace() {
  const { canInstance } = useSession();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <EmptyState
        icon={<Building2 />}
        title="You are not in any workspace"
        description={
          canInstance("instance.workspaces.create")
            ? "Create a workspace to connect accounts and schedule posts, or ask someone for an invitation."
            : "Ask an admin for an invitation link to a workspace."
        }
        action={
          canInstance("instance.workspaces.create") && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
              Create workspace
            </Button>
          )
        }
      />
      <CreateWorkspaceDialog open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

export function CreateWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh, switchWorkspace } = useSession();
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const ws = await api.workspaces.create(name.trim());
      await refresh();
      switchWorkspace(ws.id);
      toast.success(`Workspace “${ws.name}” created`);
      setName("");
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Create workspace" description="You become its owner. Accounts, posts and media are separate per workspace.">
      <form onSubmit={submit}>
        <div className="p-5">
          <Field label="Name">
            {(id) => <Input id={id} data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme marketing" maxLength={100} />}
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
