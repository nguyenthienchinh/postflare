import { Film, ImageOff } from "lucide-react";
import { useState } from "react";
import type { MediaDTO } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { cn } from "../../lib/format";

/**
 * Square thumbnail for an image or video (first frame via preload=metadata). Images use the small `thumbUrl` (falling
 * back to the file when there is none or it fails to load); `full` shows the file itself (previews).
 */
export function MediaThumb({
  media,
  className,
  controls,
  full,
  badge = true,
}: {
  media: MediaDTO | undefined;
  className?: string;
  controls?: boolean;
  full?: boolean;
  /** Video duration badge (when there are no controls). */
  badge?: boolean;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  if (!media)
    return (
      <div className={cn("flex items-center justify-center bg-zinc-100 text-zinc-400 dark:bg-zinc-800", className)}>
        <ImageOff className="size-5" />
      </div>
    );
  if (media.kind === "video")
    return (
      <div className={cn("relative overflow-hidden bg-black", className)}>
        <video src={`${media.url}#t=0.1`} preload="metadata" muted playsInline controls={controls} className="size-full object-cover" />
        {!controls && badge && (
          <span className="pointer-events-none absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-black/70 px-1 py-0.5 text-[10px] font-medium text-white">
            <Film className="size-3" />
            {media.duration ? formatDuration(media.duration) : "Video"}
          </span>
        )}
      </div>
    );
  const thumb = !full && !thumbFailed ? media.thumbUrl : null;
  return (
    <img
      src={thumb ?? media.url}
      onError={thumb ? () => setThumbFailed(true) : undefined}
      alt={media.alt ?? ""}
      loading="lazy"
      className={cn("bg-zinc-100 object-cover dark:bg-zinc-800", className)}
    />
  );
}
