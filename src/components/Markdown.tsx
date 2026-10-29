import { Fragment, type ReactNode } from "react";

/**
 * Tiny, safe markdown renderer (no HTML passthrough): headings, paragraphs, ordered/unordered lists, task items
 * (`- [ ]`), blockquotes, fenced code, inline code, bold, italic and http(s)/mailto links.
 * `doc`: long documents (playbooks): bigger section headings, wrapped code blocks.
 */
export function Markdown({ source, vars = {}, doc = false }: { source: string; vars?: Record<string, string>; doc?: boolean }) {
  const text = source.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
  return <div className="space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{blocks(text, doc)}</div>;
}

function blocks(text: string, doc = false): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*```/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++} className={`rounded-lg bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900 ${doc ? "whitespace-pre-wrap break-words" : "overflow-x-auto"}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls =
        doc && level === 2
          ? "!mt-7 border-t border-zinc-100 pt-5 text-base font-semibold text-zinc-900 first:!mt-0 first:border-0 first:pt-0 dark:border-zinc-800 dark:text-zinc-100"
          : level === 1
          ? "text-base font-semibold text-zinc-900 dark:text-zinc-100"
          : level === 2
            ? "text-sm font-semibold text-zinc-900 dark:text-zinc-100"
            : "text-sm font-medium text-zinc-900 dark:text-zinc-100";
      out.push(
        <p key={key++} role="heading" aria-level={level + 2} className={cls}>
          {inline(h[2])}
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={key++} className="border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          {inline(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }
    const listRe = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && (listRe.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(listRe);
        if (m) items.push(m[2]);
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      if (!ordered && items.every((it) => /^\[[ xX]\]\s/.test(it))) {
        out.push(
          <ul key={key++} className="space-y-1.5">
            {items.map((it, j) => (
              <li key={j} className="flex gap-2">
                <span aria-hidden className="mt-[3px] size-3.5 shrink-0 rounded border border-zinc-300 dark:border-zinc-600" />
                <span>{inline(it.slice(4))}</span>
              </li>
            ))}
          </ul>,
        );
        continue;
      }
      out.push(
        <Tag key={key++} className={`${ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5 marker:text-zinc-400`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !listRe.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^\s*>/.test(lines[i]))
      para.push(lines[i++].trim());
    out.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|((?<!\w)\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_\s][^_]*_(?!\w))|(https?:\/\/[^\s<)]+)/g;

function safeHref(href: string): string | null {
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

function inline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const t = m[0];
    if (m[1]) {
      nodes.push(
        <code key={k++} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
          {t.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      nodes.push(
        <strong key={k++} className="font-semibold text-zinc-900 dark:text-zinc-100">
          {inline(t.slice(2, -2))}
        </strong>,
      );
    } else if (m[3]) {
      const lm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const href = safeHref(lm[2]);
      nodes.push(
        href ? (
          <a key={k++} href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-brand-600 underline-offset-2 hover:underline dark:text-brand-400">
            {inline(lm[1])}
          </a>
        ) : (
          <Fragment key={k++}>{lm[1]}</Fragment>
        ),
      );
    } else if (m[4]) {
      nodes.push(<em key={k++}>{inline(t.slice(1, -1))}</em>);
    } else if (m[5]) {
      nodes.push(
        <a key={k++} href={t} target="_blank" rel="noreferrer noopener" className="break-all font-medium text-brand-600 underline-offset-2 hover:underline dark:text-brand-400">
          {t}
        </a>,
      );
    }
    last = idx + t.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length === 1 ? nodes[0] : <>{nodes}</>;
}
