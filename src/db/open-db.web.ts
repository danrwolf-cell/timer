import type * as SQLite from 'expo-sqlite';
// sql.js ships no types in this repo; the adapter below is the typed surface.
// @ts-ignore
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { listRoutes } from './queries';
import { importRouteSheet } from '../import/import-route';
import { BEEHIVE_2026_AB, BEEHIVE_2026_ALL_OTHERS } from '../import/beehive-2026';

// Web build, for design preview only. expo-sqlite's web backend runs SQLite in
// a worker and fakes the sync API with a bounded busy-wait that times out on
// writes and truncates results, so the web preview uses sql.js instead: wasm
// SQLite that is genuinely synchronous. The database is in memory and re-seeded
// with the sample route sheets on every load. The wasm is served by
// scripts/web-preview-proxy.js.
//
// Implements only the slice of SQLiteDatabase the app calls.

let SQL: any = null;

export async function prepareDb(): Promise<void> {
  SQL = await initSqlJs({ locateFile: () => '/__sqljs/sql-wasm.wasm' });
}

type Params = unknown[];

// expo-sqlite accepts either spread params or a single array.
function flatten(params: Params): any[] {
  const list = params.length === 1 && Array.isArray(params[0]) ? (params[0] as Params) : params;
  return list.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

export function openDb(): SQLite.SQLiteDatabase {
  const db = new SQL.Database();

  const run = (sql: string, params: Params) => {
    db.run(sql, flatten(params));
    const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
    return { lastInsertRowId: id, changes: db.getRowsModified() as number };
  };

  const getAll = (sql: string, params: Params) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(flatten(params));
      const rows: unknown[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  };

  const adapter = {
    execSync: (sql: string) => void db.exec(sql),
    runSync: (sql: string, ...params: Params) => run(sql, params),
    getAllSync: (sql: string, ...params: Params) => getAll(sql, params),
    getFirstSync: (sql: string, ...params: Params) => getAll(sql, params)[0] ?? null,
    prepareSync: (sql: string) => ({
      executeSync: (...params: Params) => run(sql, params),
      finalizeSync: () => {},
    }),
    withTransactionSync: (fn: () => void) => {
      db.exec('BEGIN');
      try {
        fn();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    closeSync: () => {},
  };
  return adapter as unknown as SQLite.SQLiteDatabase;
}

// Called once the schema exists.
export function seedPreviewData(): void {
  if (listRoutes().length > 0) return;
  importRouteSheet(BEEHIVE_2026_AB);
  importRouteSheet(BEEHIVE_2026_ALL_OTHERS);
}
