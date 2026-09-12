/**
 * Test helper: wraps a `D1Database` so every `prepare(sql)` call pushes its SQL
 * string into `log`. Lets a test assert *how many* and *which* statements a flow
 * issues — used to characterize and then pin the D1 round-trip budget of the
 * listener JOIN hot path.
 *
 * Mirrors the `Proxy`-over-`prepare` pattern already used in
 * `listener-realtime.test.ts` (`disconnectBeforeSessionPersistenceDb`), but
 * read-only: it observes the SQL without mutating behavior.
 */
export function countingDb(db: D1Database, log: string[]): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (sql: string) => {
        log.push(sql);
        return target.prepare(sql);
      };
    }
  }) as D1Database;
}

/** True when the SQL statement is a SELECT (ignoring leading whitespace). */
export function isSelect(sql: string): boolean {
  return /^\s*SELECT/i.test(sql);
}

/** True when the SQL statement is an UPDATE (ignoring leading whitespace). */
export function isUpdate(sql: string): boolean {
  return /^\s*UPDATE/i.test(sql);
}

/** True when the SQL statement is an INSERT (ignoring leading whitespace). */
export function isInsert(sql: string): boolean {
  return /^\s*INSERT/i.test(sql);
}

/** True when the SQL statement targets the given table name. */
export function targetsTable(sql: string, table: string): boolean {
  return new RegExp(`\\b${table}\\b`, "i").test(sql);
}
