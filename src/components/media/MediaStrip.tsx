import { useState } from "react";
import { ChevronLeft, ChevronRight, FolderOpen, Loader2, Upload, X } from "lucide-react";
import { cn } from "../../lib/format";
import { useMediaLookup } from "../../lib/mediaCache";
import { useSession } from "../../lib/session";
import { ACCEPTED_MEDIA } from "../../lib/upload";
import type { MediaDTO } from "../../lib/types";
import type { PendingUpload } from "../../lib/useUploader";
import { MediaThumb } from "../posts/MediaThumb";
import { AltTextDialog } from "./AltTextDialog";
import { MediaLibraryPicker } from "./MediaLibraryPicker";

/** Attached media with reorder (drag or arrow buttons), remove, alt text, plus upload/library buttons. */
export function MediaStrip({
  ids,
  onChange,
  pending,
  onAddFiles,
  compact,
}: {
  ids: string[];
  onChange: (fn: (ids: string[]) => string[]) => void;
  pending: PendingUpload[];
  onAddFiles: (files: FileList | File[]) => void;
  compact?: boolean;
}) {
  const lookup = useMediaLookup(ids);
  const { can } = useSession();
  const canUpload = can("media.write");
  const canBrowse = can("media.read");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [altFor, setAltFor] = useState<MediaDTO | null>(null);
  const [library, setLibrary] = useState(false);
  const tile = compact ? "size-16" : "size-20";

  const move = (from: number, to: number) =>
    onChange((list) => {
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x);
      return next;
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ids.map((id, i) => {
        const m = lookup(id);
        return (
          <div
            key={`${id}-${i}`}
            draggable
            onDragStart={(e) => {
              setDragIdx(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/x-postflare-media", String(i));
            }}
            onDragOver={(e) => {
              if (dragIdx === null) return;
              e.preventDefault();
              setOverIdx(i);
            }}
            onDragLeave={() => setOverIdx((o) => (o === i ? null : o))}
            onDrop={(e) => {
              if (dragIdx === null) return;
              e.preventDefault();
              e.stopPropagation();
              move(dragIdx, i);
              setDragIdx(null);
              setOverIdx(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setOverIdx(null);
            }}
            className={cn(
              "group relative cursor-grab overflow-hidden rounded-lg ring-1 ring-zinc-200 active:cursor-grabbing dark:ring-zinc-700",
              tile,
              dragIdx === i && "opacity-40",
              overIdx === i && dragIdx !== i && "ring-2 ring-brand-500",
            )}
          >
            <MediaThumb media={m} className="size-full" />
            <button
              type="button"
              onClick={() => onChange((list) => list.filter((_, j) => j !== i))}
              className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-black/80 focus:opacity-100 group-hover:opacity-100"
              aria-label="Remove media"
            >
              <X className="size-3" />
            </button>
            {m && (canUpload || m.alt) && (
              <button
                type="button"
                disabled={!canUpload}
                onClick={() => setAltFor(m)}
                className={cn(
                  "absolute bottom-1 right-1 rounded px-1 text-[9px] font-bold leading-4 transition",
                  m.alt ? "bg-white/90 text-zinc-900" : "bg-black/60 text-white opacity-0 focus:opacity-100 group-hover:opacity-100",
                )}
                aria-label="Edit alt text"
                title={m.alt ? `Alt: ${m.alt}` : "Add alt text"}
              >
                ALT
              </button>
            )}
            {ids.length > 1 && (
              <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-between px-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                  className="rounded-full bg-black/50 p-0.5 text-white disabled:invisible"
                  aria-label="Move left"
                >
                  <ChevronLeft className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={i === ids.length - 1}
                  onClick={() => move(i, i + 1)}
                  className="rounded-full bg-black/50 p-0.5 text-white disabled:invisible"
                  aria-label="Move right"
                >
                  <ChevronRight className="size-3" />
                </button>
              </div>
            )}
          </div>
        );
      })}
      {pending.map((p) => (
        <div key={p.key} className={cn("relative overflow-hidden rounded-lg bg-zinc-100 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700", tile)} title={p.name}>
          {p.kind === "image" ? (
            <img src={p.previewUrl} alt="" className="size-full object-cover opacity-50" />
          ) : (
            <video src={p.previewUrl} muted className="size-full object-cover opacity-50" />
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <Loader2 className="size-4 animate-spin text-zinc-700 dark:text-zinc-200" />
            <span className="text-[10px] font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">{Math.round(p.progress * 100)}%</span>
          </div>
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/10">
            <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${p.progress * 100}%` }} />
          </div>
          <button
            type="button"
            onClick={p.cancel}
            className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            aria-label="Cancel upload"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {canUpload && (
      <label
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 text-zinc-500 transition hover:border-brand-400 hover:bg-brand-50/50 hover:text-brand-700 focus-within:ring-2 focus-within:ring-brand-500 dark:border-zinc-700 dark:hover:bg-brand-950/20 dark:hover:text-brand-300",
          tile,
        )}
        title="Upload images or videos (or drop / paste them)"
      >
        <Upload className="size-4" />
        <span className="text-[10px] font-medium">Upload</span>
        <input
          type="file"
          multiple
          accept={ACCEPTED_MEDIA}
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) onAddFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      )}
      {canBrowse && (
      <button
        type="button"
        onClick={() => setLibrary(true)}
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 text-zinc-500 transition hover:border-brand-400 hover:bg-brand-50/50 hover:text-brand-700 dark:border-zinc-700 dark:hover:bg-brand-950/20 dark:hover:text-brand-300",
          tile,
        )}
        title="Choose from the media library"
      >
        <FolderOpen className="size-4" />
        <span className="text-[10px] font-medium">Library</span>
      </button>
      )}
      <AltTextDialog media={altFor} onClose={() => setAltFor(null)} />
      <MediaLibraryPicker
        open={library}
        onClose={() => setLibrary(false)}
        onPick={(items) => onChange((list) => [...list, ...items.map((m) => m.id).filter((id) => !list.includes(id))])}
        onUpload={canUpload ? onAddFiles : undefined}
      />
    </div>
  );
}
