// Applies migrations/*.sql on first use so a fresh deploy (e.g. the Deploy to Cloudflare button) needs no
// manual `wrangler d1 migrations apply`. Uses wrangler's own d1_migrations table, so both stay in sync.

const files = import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

const ready = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = migrate(db).catch((err) => {
      ready.delete(db);
      throw err;
    });
    ready.set(db, p);
  }
  return p;
}

export function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n']*$/gm, "")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Applies pending migrations (only those whose name passes `only`, for tests). */
export async function migrate(db: D1Database, only: (name: string) => boolean = () => true) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    )
    .run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));
  for (const m of migrations) {
    if (applied.has(m.name) || !only(m.name)) continue;
    await db.batch([
      ...splitStatements(m.sql).map((s) => db.prepare(s)),
      db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(m.name),
    ]);
  }
}
