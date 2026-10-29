import { fieldErrors } from "../../components/SettingsForm";
import { textLength } from "../../lib/format";
import type { AccountDTO, MediaDTO, Provider, ThreadItem } from "../../lib/types";

export interface Item {
  content: string;
  media: string[];
  thread: ThreadItem[];
}

export interface ComposerState {
  selected: string[];
  base: Item;
  /** Per-account customized content; absent = uses `base`. */
  overrides: Record<string, Item>;
  settings: Record<string, Record<string, unknown>>;
}

export const emptyItem = (): Item => ({ content: "", media: [], thread: [] });

export function effectiveItem(s: ComposerState, accountId: string, provider: Provider | undefined): Item {
  const item = s.overrides[accountId] ?? s.base;
  return provider?.capabilities.thread ? item : { ...item, thread: [] };
}

export interface Issue {
  level: "error" | "warning";
  message: string;
}

/** Client-side mirror of the server's validatePost, for live feedback. */
export function checkAccount(
  account: AccountDTO,
  provider: Provider | undefined,
  item: Item,
  settings: Record<string, unknown>,
  lookup: (id: string) => MediaDTO | undefined,
): Issue[] {
  const issues: Issue[] = [];
  if (!provider) return [{ level: "error", message: "Unknown platform" }];
  const err = (message: string) => issues.push({ level: "error", message });
  const cap = provider.capabilities;
  if (account.status === "disabled") err("Account is disabled");
  if (account.status === "reconnect") issues.push({ level: "warning", message: "Account needs to be reconnected, publishing will fail" });

  const checkMedia = (label: string, ids: string[], main: boolean) => {
    const kinds = ids.map((id) => lookup(id)?.kind);
    const images = kinds.filter((k) => k === "image").length;
    const videos = kinds.filter((k) => k === "video").length;
    if (images > cap.media.images) err(cap.media.images ? `${label}: at most ${cap.media.images} image${cap.media.images > 1 ? "s" : ""}` : `${label}: images are not supported`);
    if (videos > cap.media.videos) err(cap.media.videos ? `${label}: at most ${cap.media.videos} video${cap.media.videos > 1 ? "s" : ""}` : `${label}: videos are not supported`);
    if (images && videos && !cap.media.mixed) err(`${label}: images and videos cannot be mixed`);
    if (main && cap.media.required && !ids.length) err(`${label}: add at least one image or video`);
  };

  const len = textLength(item.content);
  if (cap.maxLength && len > cap.maxLength) err(`Text is ${len - cap.maxLength} characters too long (${len}/${cap.maxLength})`);
  if (cap.text === "required" && !item.content.trim()) err("Text is required");
  if (cap.text === "none" && item.content.trim()) issues.push({ level: "warning", message: "This platform ignores the text" });
  checkMedia("Post", item.media, true);
  const label = cap.threadLabel ?? "Follow-up";
  item.thread.forEach((t, i) => {
    const l = textLength(t.content);
    if (cap.maxLength && l > cap.maxLength) err(`${label} ${i + 1}: ${l}/${cap.maxLength} characters`);
    if (!t.content.trim() && !t.media.length) err(`${label} ${i + 1} is empty`);
    checkMedia(`${label} ${i + 1}`, t.media, false);
  });
  for (const message of Object.values(fieldErrors(provider.settingsFields, settings))) err(message);
  return issues;
}

/** Server errors are prefixed with the account name: attribute them back to accounts. */
export function attributeErrors(errors: string[], accounts: AccountDTO[]): { byAccount: Record<string, string[]>; general: string[] } {
  const byAccount: Record<string, string[]> = {};
  const general: string[] = [];
  const sorted = [...accounts].sort((a, b) => b.name.length - a.name.length);
  for (const e of errors) {
    const a = sorted.find((x) => e.startsWith(`${x.name}: `));
    if (a) (byAccount[a.id] ??= []).push(e.slice(a.name.length + 2));
    else general.push(e);
  }
  return { byAccount, general };
}
