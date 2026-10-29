import { useEffect, useMemo, useState } from "react";
import { Check, ImagePlus, Upload } from "lucide-react";
import { api } from "../../lib/api";
import { cn } from "../../lib/format";
import { rememberMedia } from "../../lib/mediaCache";
import { ACCEPTED_MEDIA } from "../../lib/upload";
import type { MediaDTO } from "../../lib/types";
import { useFetch } from "../../lib/useFetch";
import { MediaThumb } from "../posts/MediaThumb";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { EmptyState, Skeleton, Tabs } from "../ui/Misc";

export function MediaLibraryPicker({
  open,
  onClose,
  onPick,
  onUpload,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (items: MediaDTO[]) => void;
  onUpload?: (files: FileList) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const lib = useFetch(open ? "media-picker" : null, () => api.media.list(200), ["media"]);
  useEffect(() => {
    if (open) setSelected([]);
  }, [open]);
  useEffect(() => {
    if (lib.data) rememberMedia(...lib.data);
  }, [lib.data]);
  const items = useMemo(() => (lib.data ?? []).filter((m) => filter === "all" || m.kind === filter), [lib.data, filter]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="Media library"
      description="Select files to attach. The order of selection is kept."
      footer={
        <>
          {onUpload && (
            <label className="mr-auto inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800">
              <Upload className="size-4" />
              Upload new
              <input
                type="file"
                multiple
                accept={ACCEPTED_MEDIA}
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    onUpload(e.target.files);
                    onClose();
                  }
                }}
              />
            </label>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!selected.length}
            onClick={() => {
              const byId = new Map((lib.data ?? []).map((m) => [m.id, m]));
              onPick(selected.map((id) => byId.get(id)!).filter(Boolean));
              onClose();
            }}
          >
            Attach{selected.length ? ` (${selected.length})` : ""}
          </Button>
        </>
      }
    >
      <div className="p-5">
        <Tabs
          className="mb-4"
          value={filter}
          onChange={setFilter}
          tabs={[
            { value: "all", label: "All" },
            { value: "image", label: "Images" },
            { value: "video", label: "Videos" },
          ]}
        />
        {!lib.data ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        ) : !items.length ? (
          <EmptyState icon={<ImagePlus />} title="No media yet" description="Upload images or videos to reuse them across posts." />
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {items.map((m) => {
              const idx = selected.indexOf(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggle(m.id)}
                  className={cn(
                    "group relative aspect-square overflow-hidden rounded-lg ring-2 transition",
                    idx >= 0 ? "ring-brand-500" : "ring-transparent hover:ring-zinc-300 dark:hover:ring-zinc-600",
                  )}
                  aria-pressed={idx >= 0}
                  title={m.filename}
                >
                  <MediaThumb media={m} className="size-full" />
                  <span
                    className={cn(
                      "absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full text-xs font-semibold ring-2 ring-white transition",
                      idx >= 0 ? "bg-brand-500 text-white" : "bg-black/30 text-transparent group-hover:bg-black/50",
                    )}
                  >
                    {idx >= 0 ? idx + 1 : <Check className="size-3.5" />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
