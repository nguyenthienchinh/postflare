import type { FieldDef, ThreadItem } from "../../shared/types";
import type { MediaRow } from "./media";
import type { Provider } from "../providers/types";

export function visibleFields(fields: FieldDef[], values: Record<string, unknown>): FieldDef[] {
  return fields.filter((f) => !f.showIf || values[f.showIf.key] === f.showIf.equals || String(values[f.showIf.key]) === String(f.showIf.equals));
}

export function textLength(text: string): number {
  return Array.from(text).length;
}

/** Validate one post against a provider's capabilities and settings fields. Returns error messages. */
export function validatePost(
  provider: Provider,
  input: { content: string; media: MediaRow[]; settings: Record<string, unknown>; thread: Array<ThreadItem & { mediaRows: MediaRow[] }> },
): string[] {
  const errors: string[] = [];
  const cap = provider.capabilities;
  const checkItem = (label: string, content: string, media: MediaRow[], main: boolean) => {
    const len = textLength(content);
    if (cap.maxLength && len > cap.maxLength) errors.push(`${label}: ${len}/${cap.maxLength} characters`);
    if (main && cap.text === "required" && !content.trim()) errors.push(`${label}: text is required`);
    const images = media.filter((m) => m.kind === "image").length;
    const videos = media.filter((m) => m.kind === "video").length;
    if (images > cap.media.images) errors.push(cap.media.images ? `${label}: at most ${cap.media.images} images` : `${label}: images are not supported`);
    if (videos > cap.media.videos) errors.push(cap.media.videos ? `${label}: at most ${cap.media.videos} videos` : `${label}: videos are not supported`);
    if (images && videos && !cap.media.mixed) errors.push(`${label}: images and videos cannot be mixed`);
    if (main && cap.media.required && !media.length) errors.push(`${label}: at least one image or video is required`);
    if (!main && !content.trim() && !media.length) errors.push(`${label}: empty`);
  };
  checkItem(provider.name, input.content, input.media, true);
  if (input.thread.length && !cap.thread) errors.push(`${provider.name} does not support follow-ups`);
  input.thread.forEach((t, i) => checkItem(`${provider.name} ${cap.threadLabel ?? "follow-up"} ${i + 1}`, t.content, t.mediaRows, false));
  for (const field of visibleFields(provider.settingsFields, input.settings)) {
    const v = input.settings[field.key];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (field.required && empty) errors.push(`${provider.name}: "${field.label}" is required`);
    if (!empty && field.maxLength && typeof v === "string" && textLength(v) > field.maxLength)
      errors.push(`${provider.name}: "${field.label}" is longer than ${field.maxLength} characters`);
  }
  if (provider.validate) {
    errors.push(
      ...provider.validate({
        id: "",
        content: input.content,
        settings: input.settings,
        media: input.media.map((m) => ({
          id: m.id,
          kind: m.kind,
          mime: m.mime,
          filename: m.filename,
          size: m.size,
          width: m.width,
          height: m.height,
          duration: m.duration,
          alt: m.alt,
          url: "",
        })),
      }),
    );
  }
  return errors;
}
