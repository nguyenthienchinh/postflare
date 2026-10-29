import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { rememberMedia } from "../../lib/mediaCache";
import type { MediaDTO } from "../../lib/types";
import { invalidate } from "../../lib/useFetch";
import { MediaThumb } from "../posts/MediaThumb";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Textarea } from "../ui/Form";
import { useToast } from "../ui/Toast";

export function AltTextDialog({ media, onClose, onSaved }: { media: MediaDTO | null; onClose: () => void; onSaved?: (m: MediaDTO) => void }) {
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => setAlt(media?.alt ?? ""), [media]);
  async function save() {
    if (!media) return;
    setBusy(true);
    try {
      const m = await api.media.setAlt(media.id, alt.trim() || null);
      rememberMedia(m);
      onSaved?.(m);
      invalidate("media");
      toast.success("Alt text saved");
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={!!media}
      onClose={onClose}
      title="Alt text"
      description="Describe the media for people using screen readers. Sent to platforms that support it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {media && (
        <div className="flex flex-col gap-4 p-5 sm:flex-row">
          <MediaThumb media={media} className="aspect-square w-full rounded-lg sm:w-40" controls />
          <Field label="Description" className="flex-1" help={`${Array.from(alt).length}/1000`}>
            {(id) => (
              <Textarea
                id={id}
                data-autofocus
                rows={5}
                maxLength={1000}
                value={alt}
                onChange={(e) => setAlt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
                }}
                placeholder="A golden retriever catching a frisbee on the beach"
              />
            )}
          </Field>
        </div>
      )}
    </Dialog>
  );
}
