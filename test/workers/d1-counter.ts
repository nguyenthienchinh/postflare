/**
 * Counts D1 calls made through a database binding: the Workers Free plan allows 50 queries per invocation.
 * `queries` = first/all/run/raw calls, `batches` = db.batch calls, `batchStatements` = statements inside them.
 */
export interface D1Count {
  queries: number;
  batches: number;
  batchStatements: number;
  sql: string[];
  reset(): void;
  /** Round trips: queries + batches. */
  readonly calls: number;
}

export function countingD1(db: D1Database): { db: D1Database; count: D1Count } {
  const count: D1Count = {
    queries: 0,
    batches: 0,
    batchStatements: 0,
    sql: [],
    reset() {
      this.queries = 0;
      this.batches = 0;
      this.batchStatements = 0;
      this.sql = [];
    },
    get calls() {
      return this.queries + this.batches;
    },
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => {
            count.queries++;
            count.sql.push(sql);
            return (target as any)[prop](...args);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          count.batches++;
          count.batchStatements += stmts.length;
          count.sql.push(`[batch of ${stmts.length}]`);
          return target.batch(stmts.map((s) => real.get(s) ?? s));
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy, count };
}
