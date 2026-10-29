import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, isPlanLimit } from "./api";
import { rememberMedia } from "./mediaCache";
import { isMediaFile, mimeOf, uploadFile } from "./upload";
import type { MediaDTO } from "./types";
import { invalidate } from "./useFetch";

export interface PendingUpload {
  key: string;
  name: string;
  kind: "image" | "video";
  previewUrl: string;
  progress: number;
  error?: string;
  cancel: () => void;
}

let active = 0;
/** Number of uploads in progress anywhere in the app (the composer waits for them before saving). */
export function uploadsInFlight(): number {
  return active;
}

/** Upload queue with progress; `onDone` is called for each finished file, in completion order. */
export function useUploader(onDone: (m: MediaDTO) => void, onError?: (message: string) => void) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const errRef = useRef(onError);
  errRef.current = onError;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!isMediaFile(file)) {
        errRef.current?.(`${file.name}: only images and videos can be attached`);
        continue;
      }
      const key = `${Date.now()}-${Math.random()}`;
      const ctrl = new AbortController();
      const previewUrl = URL.createObjectURL(file);
      const update = (patch: Partial<PendingUpload>) =>
        alive.current && setPending((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));
      active++;
      const remove = () => {
        active--;
        URL.revokeObjectURL(previewUrl);
        if (alive.current) setPending((list) => list.filter((p) => p.key !== key));
      };
      setPending((list) => [
        ...list,
        { key, name: file.name, kind: mimeOf(file).startsWith("video/") ? "video" : "image", previewUrl, progress: 0, cancel: () => ctrl.abort() },
      ]);
      uploadFile(file, (progress) => update({ progress }), ctrl.signal)
        .then((m) => {
          rememberMedia(m);
          invalidate("media");
          remove();
          doneRef.current(m);
        })
        .catch((err) => {
          remove();
          // Plan limits (storage) open the upgrade dialog (PlanLimitDialog) instead.
          if (!ctrl.signal.aborted && !isPlanLimit(err)) errRef.current?.(`${file.name}: ${errorMessage(err)}`);
        });
    }
  }, []);

  return { pending, addFiles, busy: pending.length > 0 };
}
