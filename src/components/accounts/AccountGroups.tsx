import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, FolderMinus, FolderPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "../ui/Button";
import { useConfirm } from "../ui/Confirm";
import { Dialog } from "../ui/Dialog";
import { Field, Input } from "../ui/Form";
import { MenuItem, MenuLabel, MenuSeparator } from "../ui/Menu";
import { EmptyState } from "../ui/Misc";
import { useToast } from "../ui/Toast";
import { api } from "../../lib/api";
import { GROUP_COLORS, groupColor, stepPosition } from "../../lib/accountGroups";
import { useApp } from "../../lib/app";
import { cn } from "../../lib/format";
import type { AccountGroupDTO } from "../../lib/types";
import { invalidate } from "../../lib/useFetch";

export function GroupDot({ color, className }: { color: string | undefined; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", groupColor(color).dot, className)} />;
}

/** Small pill with the group's color and name. */
export function GroupBadge({ group, className }: { group: AccountGroupDTO; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2 py-0.5 text-[11px] font-medium", groupColor(group.color).soft, className)} title={`Group: ${group.name}`}>
      <GroupDot color={group.color} className="size-1.5" />
      <span className="truncate">{group.name}</span>
    </span>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
      {GROUP_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          onClick={() => onChange(c)}
          className={cn(
            "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-white transition dark:ring-offset-zinc-900",
            value === c ? cn("ring-2", groupColor(c).ring) : "hover:scale-110",
          )}
        >
          <span className={cn("size-5 rounded-full", groupColor(c).dot)} />
        </button>
      ))}
    </div>
  );
}

/** Create (no `group`) or rename/recolor a group. `onSaved` gets the saved group (e.g. to assign accounts to it). */
export function GroupDialog({ open, onClose, group, onSaved }: { open: boolean; onClose: () => void; group?: AccountGroupDTO; onSaved?: (g: AccountGroupDTO) => void | Promise<void> }) {
  const { groups } = useApp();
  const toast = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("violet");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    // New groups: the next color in the palette (like the server's default).
    setColor(group?.color ?? GROUP_COLORS[1 + (groups.length % (GROUP_COLORS.length - 1))]);
    setError(null);
  }, [open, group, groups.length]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the group a name");
    setBusy(true);
    setError(null);
    try {
      const saved = group ? await api.accountGroups.update(group.id, { name, color }) : await api.accountGroups.create({ name, color });
      await onSaved?.(saved);
      invalidate("accounts");
      if (!onSaved) toast.success(group ? "Group saved" : `${saved.name} created`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} size="sm" title={group ? "Edit group" : "New group"} description={group ? undefined : "A brand or project, e.g. one app with its Instagram, TikTok and YouTube."}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-5">
          <Field label="Name" error={error}>
            {(id) => <Input id={id} data-autofocus value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="Party Games" invalid={!!error} />}
          </Field>
          <div>
            <p className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">Color</p>
            <ColorPicker value={color} onChange={setColor} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {group ? "Save" : "Create group"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Move accounts to a group (null = ungroup) in one request, with a toast. */
export function useMoveToGroup() {
  const toast = useToast();
  const { groupMap } = useApp();
  return async (accountIds: string[], groupId: string | null, label?: string): Promise<boolean> => {
    if (!accountIds.length) return false;
    try {
      if (accountIds.length === 1) await api.accounts.setGroup(accountIds[0], groupId);
      else await api.accounts.moveToGroup(accountIds, groupId);
      const what = label ?? `${accountIds.length} account${accountIds.length === 1 ? "" : "s"}`;
      const g = groupId ? groupMap.get(groupId) : null;
      toast.success(groupId ? `Moved ${what} to ${g?.name ?? "the group"}` : `Removed ${what} from ${accountIds.length === 1 ? "its group" : "their groups"}`);
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      invalidate("accounts");
    }
  };
}

/** Items of a "Move to group" menu: every group, "No group" and "New group…". */
export function MoveToGroupItems({ current, onPick, onNew, close }: { current?: string | null; onPick: (groupId: string | null) => void; onNew: () => void; close: () => void }) {
  const { groups } = useApp();
  const pick = (id: string | null) => {
    close();
    onPick(id);
  };
  return (
    <>
      <MenuLabel>Move to group</MenuLabel>
      {groups.map((g) => (
        <MenuItem key={g.id} icon={<GroupDot color={g.color} />} checked={current === undefined ? undefined : current === g.id} onClick={() => pick(g.id)}>
          {g.name}
        </MenuItem>
      ))}
      {!groups.length && <p className="px-2 py-1 text-xs text-zinc-500">No groups yet.</p>}
      <MenuSeparator />
      <MenuItem icon={<FolderMinus />} disabled={current === null} onClick={() => pick(null)}>
        No group
      </MenuItem>
      <MenuItem
        icon={<FolderPlus />}
        onClick={() => {
          close();
          onNew();
        }}
      >
        New group…
      </MenuItem>
    </>
  );
}

/** List of the workspace's groups: rename, recolor, reorder (up/down), delete, create. */
export function ManageGroupsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { groups } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AccountGroupDTO | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const move = async (g: AccountGroupDTO, dir: -1 | 1) => {
    const position = stepPosition(groups, g.id, dir);
    if (position === null) return;
    setBusy(g.id);
    try {
      await api.accountGroups.update(g.id, { position });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      invalidate("accounts");
    }
  };

  const remove = async (g: AccountGroupDTO) => {
    const ok = await confirm({
      title: `Delete ${g.name}?`,
      message: g.accountCount ? `Its ${g.accountCount} account${g.accountCount === 1 ? "" : "s"} become ungrouped. Nothing else changes.` : "The group is empty.",
      confirmLabel: "Delete group",
      danger: true,
    });
    if (!ok) return;
    setBusy(g.id);
    try {
      await api.accountGroups.remove(g.id);
      toast.success(`${g.name} deleted`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      invalidate("accounts");
    }
  };

  return (
    <>
      <Dialog
        open={open && !editing}
        onClose={onClose}
        title="Account groups"
        description="Group accounts by brand or project. An account is in at most one group."
        footer={
          <>
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              New group
            </Button>
            <div className="flex-1" />
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        {!groups.length ? (
          <EmptyState icon={<FolderPlus />} title="No groups yet" description="Create one per app or brand, then move accounts into it from their card or with Select." />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {groups.map((g, i) => (
              <li key={g.id} className="flex items-center gap-3 px-5 py-3">
                <GroupDot color={g.color} className="size-3" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{g.name}</p>
                  <p className="text-xs text-zinc-500">
                    {g.accountCount} account{g.accountCount === 1 ? "" : "s"}
                  </p>
                </div>
                <GroupAction label="Move up" disabled={i === 0 || !!busy} onClick={() => move(g, -1)}>
                  <ArrowUp className="size-4" />
                </GroupAction>
                <GroupAction label="Move down" disabled={i === groups.length - 1 || !!busy} onClick={() => move(g, 1)}>
                  <ArrowDown className="size-4" />
                </GroupAction>
                <GroupAction label="Rename or recolor" disabled={!!busy} onClick={() => setEditing(g)}>
                  <Pencil className="size-4" />
                </GroupAction>
                <IconButton label="Delete" size="sm" variant="danger" disabled={!!busy} onClick={() => remove(g)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <GroupDialog open={!!editing} onClose={() => setEditing(null)} group={editing && editing !== "new" ? editing : undefined} />
    </>
  );
}

function GroupAction({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton label={label} size="sm" disabled={disabled} onClick={onClick}>
      {children}
    </IconButton>
  );
}
