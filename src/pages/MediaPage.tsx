import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Download, ImagePlus, Link2, Loader2, Trash2, Type, Upload, X } from "lucide-react";
import { AltTextDialog } from "../components/media/AltTextDialog";
import { StorageUsage } from "../components/media/StorageUsage";
import { MediaThumb } from "../components/posts/MediaThumb";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input } from "../components/ui/Form";
import { Card, CopyButton, EmptyState, PageHeader, Skeleton, Tabs } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api, isPlanLimit } from "../lib/api";
import { useApp } from "../lib/app";
import { cn, copyText, formatBytes, formatDuration } from "../lib/format";
import { forgetMedia, rememberMedia } from "../lib/mediaCache";
import { useSession } from "../lib/session";
import { formatDateTime } from "../lib/time";
import { ACCEPTED_MEDIA } from "../lib/upload";
import type { MediaDTO } from "../lib/types";
import { invalidate, useFetch } from "../lib/useFetch";
import { useUploader } from "../lib/useUploader";

const PAGE = 60;

export function MediaPage() {
  const toast = useToast();
  const canWrite = useSession().can("media.write");
  const confirm = useConfirm();
  const [items, setItems] = useState<MediaDTO[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [detail, setDetail] = useState<MediaDTO | null>(null);
  const [altFor, setAltFor] = useState<MediaDTO | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const depth = useRef(0);
  const usage = useFetch("media-usage", api.media.usage, ["media"]);

  const load = async () => {
    try {
      const list = await api.media.list(PAGE);
      rememberMedia(...list);
      setItems(list);
      setHasMore(list.length === PAGE);
    } catch (err) {
      toast.error(err);
      setItems([]);
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const uploader = useUploader(
    (m) => {
      setItems((list) => [m, ...(list ?? [])]);
      void usage.refetch();
    },
    (msg) => toast.error(msg),
  );

  async function loadMore() {
    if (!items?.length) return;
    setLoadingMore(true);
    try {
      const list = await api.media.list(PAGE, items[items.length - 1].createdAt);
      rememberMedia(...list);
      setItems([...items, ...list]);
      setHasMore(list.length === PAGE);
    } catch (err) {
      toast.error(err);
    } finally {
      setLoadingMore(false);
    }
  }

  async function remove(m: MediaDTO) {
    if (!(await confirm({ title: "Delete this file?", message: "This cannot be undone. Files used by drafts or scheduled posts can't be deleted.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.media.remove(m.id);
      forgetMedia(m.id);
      setItems((list) => list?.filter((x) => x.id !== m.id) ?? null);
      setDetail(null);
      invalidate("media");
      toast.success("File deleted");
    } catch (err) {
      toast.error(err);
    }
  }

  const onSaved = (m: MediaDTO) => setItems((list) => list?.map((x) => (x.id === m.id ? m : x)) ?? null);

  const shown = useMemo(() => (items ?? []).filter((m) => filter === "all" || m.kind === filter), [items, filter]);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div
      onDragEnter={(e) => {
        if (!canWrite || !hasFiles(e)) return;
        depth.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => canWrite && hasFiles(e) && e.preventDefault()}
      onDragLeave={(e) => {
        if (!canWrite || !hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!canWrite || !hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragOver(false);
        uploader.addFiles(e.dataTransfer.files);
      }}
      className="relative"
    >
      <PageHeader
        title="Media"
        description="Images and videos you can attach to any post. Files are stored in your R2 bucket."
        actions={
          canWrite && (
          <>
            <Button icon={<Link2 className="size-4" />} onClick={() => setImportOpen(true)}>
              Import URL
            </Button>
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 dark:bg-brand-500 dark:hover:bg-brand-600">
              <Upload className="size-4" />
              Upload
              <input
                type="file"
                multiple
                accept={ACCEPTED_MEDIA}
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.length) uploader.addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </>
          )
        }
      />

      {usage.data && (
        <Card className="mb-4 px-4 py-3.5">
          <StorageUsage usage={usage.data} />
        </Card>
      )}

      <div className="mb-4 flex items-center justify-between gap-3">
        <Tabs
          value={filter}
          onChange={setFilter}
          tabs={[
            { value: "all", label: "All", count: items?.length },
            { value: "image", label: "Images", count: items?.filter((m) => m.kind === "image").length },
            { value: "video", label: "Videos", count: items?.filter((m) => m.kind === "video").length },
          ]}
        />
        {canWrite && <p className="hidden text-xs text-zinc-400 sm:block">Drop files anywhere on this page to upload. Files over 90 MB upload in parts.</p>}
      </div>

      {uploader.pending.length > 0 && (
        <Card className="mb-4 divide-y divide-zinc-100 dark:divide-zinc-800">
          {uploader.pending.map((p) => (
            <div key={p.key} className="flex items-center gap-3 px-4 py-2.5">
              <Loader2 className="size-4 animate-spin text-brand-500" />
              <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${p.progress * 100}%` }} />
              </div>
              <span className="w-10 text-right text-xs tabular-nums text-zinc-500">{Math.round(p.progress * 100)}%</span>
              <IconButton label="Cancel upload" size="sm" onClick={p.cancel}>
                <X className="size-4" />
              </IconButton>
            </div>
          ))}
        </Card>
      )}

      {!items ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : !shown.length ? (
        <Card>
          <EmptyState
            icon={<ImagePlus />}
            title={items.length ? "Nothing in this filter" : "Your media library is empty"}
            description={canWrite ? "Upload images and videos, or drop them here. They can be reused across posts." : "Images and videos uploaded to this workspace appear here."}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {shown.map((m) => (
              <div key={m.id} className="group relative overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
                <button type="button" onClick={() => setDetail(m)} className="block aspect-square w-full" aria-label={`Open ${m.filename}`}>
                  <MediaThumb media={m} className="size-full" />
                </button>
                <div className="px-2.5 py-2">
                  <p className="truncate text-xs font-medium" title={m.filename}>
                    {m.filename}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {formatBytes(m.size)}
                    {m.width && m.height ? ` · ${m.width}×${m.height}` : ""}
                  </p>
                </div>
                {m.alt && <span className="absolute left-2 top-2 rounded bg-white/90 px-1 text-[9px] font-bold text-zinc-900">ALT</span>}
                <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
                  {canWrite && (
                    <TileAction label="Alt text" onClick={() => setAltFor(m)}>
                      <Type className="size-3.5" />
                    </TileAction>
                  )}
                  <TileAction
                    label="Copy public URL"
                    onClick={async () => {
                      await copyText(m.url);
                      toast.success("Public URL copied");
                    }}
                  >
                    <Link2 className="size-3.5" />
                  </TileAction>
                  {canWrite && (
                    <TileAction label="Delete" onClick={() => remove(m)} danger>
                      <Trash2 className="size-3.5" />
                    </TileAction>
                  )}
                </div>
              </div>
            ))}
          </div>
          {hasMore && (
            <div className="mt-6 flex justify-center">
              <Button loading={loadingMore} onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-brand-500/10 backdrop-blur-[1px] lg:left-64">
          <div className="rounded-2xl border-2 border-dashed border-brand-400 bg-white px-10 py-8 text-center shadow-xl dark:bg-zinc-900">
            <Upload className="mx-auto size-8 text-brand-500" />
            <p className="mt-2 text-sm font-medium">Drop to upload</p>
          </div>
        </div>
      )}

      <MediaDetail media={detail} onClose={() => setDetail(null)} onDelete={remove} onAlt={(m) => setAltFor(m)} />
      <AltTextDialog
        media={altFor}
        onClose={() => setAltFor(null)}
        onSaved={(m) => {
          onSaved(m);
          setDetail((d) => (d?.id === m.id ? m : d));
        }}
      />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(m) => {
          rememberMedia(m);
          setItems((list) => [m, ...(list ?? [])]);
        }}
      />
    </div>
  );
}

function TileAction({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn("flex size-7 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur transition hover:bg-black/80", danger && "hover:bg-red-600")}
    >
      {children}
    </button>
  );
}

function MediaDetail({
  media: m,
  onClose,
  onDelete,
  onAlt,
}: {
  media: MediaDTO | null;
  onClose: () => void;
  onDelete: (m: MediaDTO) => void;
  onAlt: (m: MediaDTO) => void;
}) {
  const { tz } = useApp();
  const canWrite = useSession().can("media.write");
  return (
    <Dialog open={!!m} onClose={onClose} size="xl" title={m?.filename}>
      {m && (
        <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex items-center justify-center bg-zinc-100 p-4 dark:bg-black">
            {m.kind === "video" ? (
              <video src={m.url} controls className="max-h-[60vh] w-full rounded-lg" />
            ) : (
              <img src={m.url} alt={m.alt ?? ""} className="max-h-[60vh] rounded-lg object-contain" />
            )}
          </div>
          <div className="space-y-4 p-5 text-sm">
            <dl className="space-y-2">
              {[
                ["Type", m.mime],
                ["Size", formatBytes(m.size)],
                ["Dimensions", m.width && m.height ? `${m.width} × ${m.height}` : "—"],
                ...(m.kind === "video" ? [["Duration", m.duration ? formatDuration(m.duration) : "—"]] : []),
                ["Uploaded", formatDateTime(m.createdAt, tz, { year: "numeric" })],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd className="truncate text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="mb-1 text-zinc-500">Alt text</p>
              <p className={cn("text-sm", !m.alt && "italic text-zinc-400")}>{m.alt || "None"}</p>
              {canWrite && (
                <button type="button" onClick={() => onAlt(m)} className="mt-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                  {m.alt ? "Edit alt text" : "Add alt text"}
                </button>
              )}
            </div>
            <div>
              <p className="mb-1 text-zinc-500">Public URL</p>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-zinc-100 px-2 py-1.5 font-mono text-[11px] dark:bg-zinc-800">{m.url}</code>
                <CopyButton text={m.url} />
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <a
                href={m.url}
                download={m.filename}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium ring-1 ring-zinc-200 hover:bg-zinc-50 dark:ring-zinc-700 dark:hover:bg-zinc-800"
              >
                <Download className="size-4" /> Download
              </a>
              {canWrite && (
                <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => onDelete(m)}>
                  Delete
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (m: MediaDTO) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (open) {
      setUrl("");
      setError(null);
    }
  }, [open]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const m = await api.media.fromUrl(url.trim());
      onImported(m);
      invalidate("media");
      toast.success("File imported", m.filename);
      onClose();
    } catch (err) {
      if (!isPlanLimit(err)) setError((err as Error).message); // plan limits: PlanLimitDialog
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Import from URL" description="Postflare downloads the file into your library.">
      <form onSubmit={submit}>
        <div className="p-5">
          <Field label="File URL" error={error} help="A direct link to a JPEG, PNG, GIF, WebP, MP4, MOV or WebM file.">
            {(id) => <Input id={id} type="url" required data-autofocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/photo.jpg" invalid={!!error} />}
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!url.trim()}>
            Import
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
