import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Eye, EyeOff, RefreshCw, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../lib/app";
import { cn } from "../lib/format";
import { fromLocalInput, toLocalInput } from "../lib/time";
import type { FieldDef, FieldOption } from "../lib/types";
import { useDebounced } from "../lib/useFetch";
import { Field, Input, Select, Switch, Textarea, inputClass } from "./ui/Form";

/**
 * A field as the form shows it: platform panels (e.g. TikTok's creator_info rules) can disable a field or some of its
 * options and say why.
 */
export type UiFieldDef = FieldDef & {
  disabled?: boolean;
  /** Shown under the field (why it is disabled, what it does now). */
  note?: string;
  /** select: option value → why it cannot be picked (shown on hover). */
  disabledOptions?: Record<string, string>;
};

export function isVisible(field: FieldDef, values: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  const v = values[field.showIf.key];
  if (v === undefined && field.showIf.equals === false) return true;
  return v === field.showIf.equals || String(v ?? "") === String(field.showIf.equals);
}

export function visibleFields<F extends FieldDef>(fields: F[], values: Record<string, unknown>): F[] {
  return fields.filter((f) => isVisible(f, values));
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Initial values from field defaults. */
export function defaultValues(fields: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

/** Errors for required / too-long visible fields. */
export function fieldErrors(fields: FieldDef[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of visibleFields(fields, values)) {
    const v = values[f.key];
    if (f.required && isEmpty(v) && f.type !== "checkbox") errors[f.key] = `${f.label} is required`;
    else if (f.maxLength && typeof v === "string" && Array.from(v).length > f.maxLength)
      errors[f.key] = `${f.label} is longer than ${f.maxLength} characters`;
  }
  return errors;
}

export function SettingsForm({
  fields,
  values,
  onChange,
  accountId,
  errors = {},
  showErrors = true,
  className,
}: {
  fields: UiFieldDef[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  accountId?: string;
  errors?: Record<string, string>;
  showErrors?: boolean;
  className?: string;
}) {
  const shown = visibleFields(fields, values);
  if (!shown.length) return null;
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2", className)}>
      {shown.map((f) => {
        const wide = f.type === "textarea" || f.type === "tags" || f.type === "checkbox" || (f.help?.length ?? 0) > 60;
        if (f.type === "checkbox")
          return (
            <label key={f.key} className={cn("flex items-start gap-3 sm:col-span-2", f.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")} title={f.disabled ? f.note : undefined}>
              <Switch checked={!!values[f.key]} onChange={(v) => onChange(f.key, v)} label={f.label} disabled={f.disabled} />
              <span className="-mt-0.5">
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{f.label}</span>
                {f.help && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{f.help}</span>}
                {f.note && <span className="block text-xs text-amber-700 dark:text-amber-400">{f.note}</span>}
              </span>
            </label>
          );
        return (
          <Field
            key={f.key}
            label={f.label}
            required={f.required}
            help={f.note ? `${f.help ? `${f.help} ` : ""}${f.note}` : f.help}
            error={showErrors ? errors[f.key] : undefined}
            className={wide ? "sm:col-span-2" : undefined}
          >
            {(id) => (
              <FieldInput id={id} field={f} value={values[f.key]} values={values} onChange={(v) => onChange(f.key, v)} accountId={accountId} invalid={showErrors && !!errors[f.key]} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

function FieldInput({
  id,
  field: f,
  value,
  values,
  onChange,
  accountId,
  invalid,
}: {
  id: string;
  field: UiFieldDef;
  value: unknown;
  values: Record<string, unknown>;
  onChange: (v: unknown) => void;
  accountId?: string;
  invalid?: boolean;
}) {
  const { tz } = useApp();
  const str = value === undefined || value === null ? "" : String(value);
  switch (f.type) {
    case "textarea": {
      const len = Array.from(str).length;
      return (
        <div className="relative">
          <Textarea id={id} value={str} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} invalid={invalid} rows={3} />
          {f.maxLength && (
            <span className={cn("absolute bottom-2 right-3 text-[11px] tabular-nums", len > f.maxLength ? "text-red-500" : "text-zinc-400")}>
              {len}/{f.maxLength}
            </span>
          )}
        </div>
      );
    }
    case "password":
      return <PasswordInput id={id} value={str} placeholder={f.placeholder} onChange={onChange} invalid={invalid} />;
    case "number":
      return (
        <Input
          id={id}
          type="number"
          value={str}
          placeholder={f.placeholder}
          invalid={invalid}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "select":
      if (f.dynamicOptions && accountId)
        return <DynamicSelect id={id} field={f} value={value} values={values} accountId={accountId} onChange={onChange} mode="select" />;
      return <StaticSelect id={id} field={f} value={str} options={f.options ?? []} onChange={onChange} />;
    case "tags":
      if (f.dynamicOptions && accountId)
        return <DynamicSelect id={id} field={f} value={value} values={values} accountId={accountId} onChange={onChange} mode="tags" />;
      return <TagsInput id={id} value={Array.isArray(value) ? (value as string[]) : str ? str.split(",") : []} onChange={onChange} placeholder={f.placeholder} />;
    case "datetime":
      return (
        <Input
          id={id}
          type="datetime-local"
          invalid={invalid}
          value={str && !Number.isNaN(Date.parse(str)) ? toLocalInput(Date.parse(str), tz) : ""}
          onChange={(e) => {
            const ts = fromLocalInput(e.target.value, tz);
            onChange(ts === null ? undefined : new Date(ts).toISOString());
          }}
        />
      );
    case "url":
      return <Input id={id} type="url" value={str} placeholder={f.placeholder ?? "https://"} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
    default:
      if (f.dynamicOptions && accountId)
        return <DynamicSelect id={id} field={f} value={value} values={values} accountId={accountId} onChange={onChange} mode="text" />;
      return <Input id={id} type="text" value={str} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
  }
}

function PasswordInput({ id, value, placeholder, onChange, invalid }: { id: string; value: string; placeholder?: string; onChange: (v: string) => void; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => value.startsWith("••••") && e.target.select()}
        invalid={invalid}
        className="pr-9"
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        aria-label={show ? "Hide" : "Show"}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function StaticSelect({ id, field, value, options, onChange }: { id: string; field: UiFieldDef; value: string; options: FieldOption[]; onChange: (v: unknown) => void }) {
  const all = value && !options.some((o) => o.value === value) ? [{ value, label: value }, ...options] : options;
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value || undefined)} disabled={field.disabled}>
      {(!field.required || !value) && <option value="">{field.placeholder ?? "Select…"}</option>}
      {all.map((o) => (
        <option key={o.value} value={o.value} disabled={!!field.disabledOptions?.[o.value]} title={field.disabledOptions?.[o.value]}>
          {o.label}
          {field.disabledOptions?.[o.value] ? ` (${field.disabledOptions[o.value]})` : ""}
        </option>
      ))}
    </Select>
  );
}

const optionCache = new Map<string, Promise<FieldOption[]>>();

function DynamicSelect({
  id,
  field,
  value,
  values,
  accountId,
  onChange,
  mode,
}: {
  id: string;
  field: UiFieldDef;
  value: unknown;
  values: Record<string, unknown>;
  accountId: string;
  onChange: (v: unknown) => void;
  /** select: pick one; text: free text with suggestions; tags: multiple values with suggestions (option labels). */
  mode: "select" | "text" | "tags";
}) {
  const str = value === undefined || value === null || Array.isArray(value) ? "" : String(value);
  // Reload when any other short field changes (e.g. Reddit flair depends on subreddit).
  const deps = useMemo(() => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (k !== field.key && (typeof v !== "string" || v.length < 200)) o[k] = v;
    return JSON.stringify(o);
  }, [values, field.key]);
  const debounced = useDebounced(deps, 600);
  const [state, setState] = useState<{ options: FieldOption[]; loading: boolean; error: string | null }>({ options: [], loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const key = `${accountId}:${field.key}:${debounced}`;
    if (nonce) optionCache.delete(key);
    let p = optionCache.get(key);
    if (!p) {
      p = api.accounts.options(accountId, field.key, JSON.parse(debounced) as Record<string, unknown>);
      optionCache.set(key, p);
      p.catch(() => optionCache.delete(key));
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    p.then(
      (options) => alive && setState({ options: Array.isArray(options) ? options : [], loading: false, error: null }),
      (err) => alive && setState({ options: [], loading: false, error: errorMessage(err) }),
    );
    return () => {
      alive = false;
    };
  }, [accountId, field.key, debounced, nonce]);

  const refresh = (
    <button
      type="button"
      onClick={() => setNonce((n) => n + 1)}
      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 ring-1 ring-zinc-300 hover:bg-zinc-50 dark:ring-zinc-700 dark:hover:bg-zinc-800"
      aria-label={`Reload ${field.label} options`}
      title="Reload options"
    >
      <RefreshCw className={cn("size-4", state.loading && "animate-spin")} />
    </button>
  );

  if (mode !== "select") {
    const listId = `${id}-suggestions`;
    const suggestions = (
      <datalist id={listId}>
        {state.options.map((o) => (
          <option key={o.value} value={mode === "tags" ? o.label : o.value}>
            {o.label}
          </option>
        ))}
      </datalist>
    );
    return (
      <div>
        <div className="flex gap-2">
          {mode === "tags" ? (
            <TagsInput
              id={id}
              list={listId}
              value={Array.isArray(value) ? (value as string[]) : str ? str.split(",") : []}
              onChange={onChange}
              placeholder={field.placeholder}
            />
          ) : (
            <Input id={id} list={listId} value={str} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
          )}
          {refresh}
        </div>
        {suggestions}
        {state.error && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Could not load suggestions: {state.error}</p>}
      </div>
    );
  }

  if (state.error)
    return (
      <div>
        <div className="flex gap-2">
          <Input id={id} value={str} placeholder={field.placeholder ?? "Enter a value"} onChange={(e) => onChange(e.target.value)} />
          {refresh}
        </div>
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Could not load options: {state.error}</p>
      </div>
    );

  return (
    <div className="flex gap-2">
      <StaticSelect
        id={id}
        field={{ ...field, placeholder: state.loading ? "Loading…" : state.options.length ? field.placeholder : "No options available" }}
        value={str}
        options={state.options}
        onChange={onChange}
      />
      {refresh}
    </div>
  );
}

function TagsInput({
  id,
  value,
  onChange,
  placeholder,
  list,
}: {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  list?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim().replace(/^#/, ""))
      .filter((s) => s && !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className={cn(inputClass, "ring-zinc-300 dark:ring-zinc-700 flex min-h-9 flex-wrap items-center gap-1.5 py-1.5 focus-within:ring-2 focus-within:ring-brand-500")}>
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 py-0.5 pl-2 pr-1 text-xs font-medium dark:bg-zinc-800">
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="rounded text-zinc-400 hover:text-zinc-700" aria-label={`Remove ${t}`}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        list={list}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft && add(draft)}
        placeholder={value.length ? "" : (placeholder ?? "Type and press Enter")}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
      />
    </div>
  );
}
