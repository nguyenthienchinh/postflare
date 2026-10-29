import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { ImagePlus, MessageSquarePlus, Trash2 } from "lucide-react";
import { ProviderLogo } from "../../components/ProviderLogo";
import { MediaStrip } from "../../components/media/MediaStrip";
import { useToast } from "../../components/ui/Toast";
import { cn, textLength } from "../../lib/format";
import { useSession } from "../../lib/session";
import type { Provider, ThreadItem } from "../../lib/types";
import { useUploader } from "../../lib/useUploader";
import type { Item } from "./model";

function compact(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** "Thread replies" → "thread reply", "Comments" → "comment" (button label). */
const singular = (label: string) => label.toLowerCase().replace(/ies$/, "y").replace(/s$/, "");

export function CharCounters({ text, providers }: { text: string; providers: Provider[] }) {
  const len = textLength(text);
  if (!providers.length) return <span className="text-xs tabular-nums text-zinc-400">{len}</span>;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {providers.map((p) => {
        const max = p.capabilities.maxLength;
        const over = max > 0 && len > max;
        const near = max > 0 && len > max * 0.9;
        return (
          <span
            key={p.id}
            title={`${p.name}: ${len} of ${max} characters`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] font-medium tabular-nums ring-1",
              over
                ? "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900"
                : near
                  ? "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900"
                  : "text-zinc-500 ring-zinc-200 dark:text-zinc-400 dark:ring-zinc-700",
            )}
          >
            <ProviderLogo provider={p} size="xs" className="!rounded-full" />
            {over ? `-${len - max}` : `${len}/${compact(max)}`}
          </span>
        );
      })}
    </div>
  );
}

/** Drop-zone + paste handling shared by the main editor and follow-ups. */
function useFileDrop(addFiles: (f: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  // Without media.write, dropped/pasted files are left alone (the upload would be refused).
  const canUpload = useSession().can("media.write");
  const hasFiles = (e: DragEvent) => canUpload && Array.from(e.dataTransfer.types).includes("Files");
  return {
    over,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (hasFiles(e)) e.preventDefault();
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        addFiles(Array.from(e.dataTransfer.files));
      },
    },
    onPaste: (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files);
      if (files.length && canUpload) {
        e.preventDefault();
        addFiles(files);
      }
    },
  };
}

/** What attached media is used for, per selected platform (e.g. YouTube: the image becomes the custom thumbnail). */
export function MediaNotes({ providers }: { providers: Provider[] }) {
  const notes = providers.filter((p) => p.capabilities.mediaNote);
  if (!notes.length) return null;
  return (
    <div className="space-y-1">
      {notes.map((p) => (
        <p key={p.id} className="flex items-start gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <ProviderLogo provider={p} size="xs" className="mt-px shrink-0 !rounded-full" />
          <span>{p.capabilities.mediaNote}</span>
        </p>
      ))}
    </div>
  );
}

export function ItemEditor({
  item,
  onChange,
  providers,
  threadLabel,
  placeholder = "What do you want to share?",
  header,
  textareaRef,
}: {
  item: Item;
  onChange: (fn: (item: Item) => Item) => void;
  providers: Provider[];
  /** Label for follow-ups, or null when no selected provider supports them. */
  threadLabel: string | null;
  placeholder?: string;
  header?: ReactNode;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const toast = useToast();
  const uploader = useUploader(
    (m) => onChange((it) => ({ ...it, media: [...it.media, m.id] })),
    (msg) => toast.error(msg),
  );
  const drop = useFileDrop(uploader.addFiles);

  const setThread = (fn: (t: ThreadItem[]) => ThreadItem[]) => onChange((it) => ({ ...it, thread: fn(it.thread) }));

  return (
    <div className="space-y-3">
      <div
        {...drop.handlers}
        className={cn(
          "relative rounded-xl bg-white ring-1 ring-zinc-200 transition focus-within:ring-2 focus-within:ring-brand-500 dark:bg-zinc-900 dark:ring-zinc-700",
          drop.over && "ring-2 ring-brand-500",
        )}
      >
        {header}
        <textarea
          ref={textareaRef}
          value={item.content}
          onChange={(e) => {
            const v = e.target.value;
            onChange((it) => ({ ...it, content: v }));
          }}
          onPaste={drop.onPaste}
          placeholder={placeholder}
          rows={7}
          className="block min-h-40 w-full resize-y rounded-xl bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-zinc-400"
        />
        <div className="flex flex-wrap items-end justify-between gap-3 px-3 pb-3 pt-1">
          <MediaStrip ids={item.media} onChange={(fn) => onChange((it) => ({ ...it, media: fn(it.media) }))} pending={uploader.pending} onAddFiles={uploader.addFiles} />
          <CharCounters text={item.content} providers={providers} />
        </div>
        {drop.over && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-brand-50/90 text-sm font-medium text-brand-700 dark:bg-brand-950/80 dark:text-brand-200">
            <ImagePlus className="mr-2 size-5" /> Drop to attach
          </div>
        )}
      </div>
      <MediaNotes providers={providers} />

      {threadLabel && (
        <div className="space-y-3">
          {item.thread.map((t, i) => (
            <ThreadItemEditor
              key={i}
              index={i}
              label={threadLabel}
              item={t}
              providers={providers}
              onChange={(fn) => setThread((list) => list.map((x, j) => (j === i ? fn(x) : x)))}
              onRemove={() => setThread((list) => list.filter((_, j) => j !== i))}
            />
          ))}
          <button
            type="button"
            onClick={() => setThread((list) => [...list, { content: "", media: [] }])}
            className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <MessageSquarePlus className="size-4" />
            Add {singular(threadLabel)}
          </button>
        </div>
      )}
    </div>
  );
}

function ThreadItemEditor({
  index,
  label,
  item,
  providers,
  onChange,
  onRemove,
}: {
  index: number;
  label: string;
  item: ThreadItem;
  providers: Provider[];
  onChange: (fn: (t: ThreadItem) => ThreadItem) => void;
  onRemove: () => void;
}) {
  const toast = useToast();
  const uploader = useUploader(
    (m) => onChange((t) => ({ ...t, media: [...t.media, m.id] })),
    (msg) => toast.error(msg),
  );
  const drop = useFileDrop(uploader.addFiles);
  return (
    <div className="relative flex gap-3 pl-4">
      <div className="absolute bottom-0 left-[7px] top-0 w-0.5 rounded bg-zinc-200 dark:bg-zinc-700" />
      <div
        {...drop.handlers}
        className={cn(
          "relative flex-1 rounded-xl bg-white ring-1 ring-zinc-200 focus-within:ring-2 focus-within:ring-brand-500 dark:bg-zinc-900 dark:ring-zinc-700",
          drop.over && "ring-2 ring-brand-500",
        )}
      >
        <div className="flex items-center justify-between px-4 pt-2.5">
          <span className="text-xs font-medium text-zinc-500">
            {label.replace(/s$/, "")} {index + 1}
          </span>
          <button type="button" onClick={onRemove} className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40" aria-label="Remove">
            <Trash2 className="size-3.5" />
          </button>
        </div>
        <textarea
          value={item.content}
          onChange={(e) => {
            const v = e.target.value;
            onChange((t) => ({ ...t, content: v }));
          }}
          onPaste={drop.onPaste}
          rows={3}
          placeholder="Write a follow-up…"
          className="block w-full resize-y bg-transparent px-4 py-1.5 text-sm leading-relaxed outline-none placeholder:text-zinc-400"
        />
        <div className="flex flex-wrap items-end justify-between gap-3 px-3 pb-3">
          <MediaStrip compact ids={item.media} onChange={(fn) => onChange((t) => ({ ...t, media: fn(t.media) }))} pending={uploader.pending} onAddFiles={uploader.addFiles} />
          <CharCounters text={item.content} providers={providers} />
        </div>
      </div>
    </div>
  );
}
