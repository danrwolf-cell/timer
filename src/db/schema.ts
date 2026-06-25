import * as SQLite from 'expo-sqlite';

let db: SQLite.SQLiteDatabase;

export function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync('enduro.db');
  }
  return db;
}

export function initSchema(): void {
  const database = getDb();
  database.execSync(`
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      event_date TEXT,
      notes TEXT,
      published_id TEXT
    );

    CREATE TABLE IF NOT EXISTS route_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      distance REAL NOT NULL,
      speed REAL,
      is_reset INTEGER NOT NULL DEFAULT 0,
      is_free INTEGER NOT NULL DEFAULT 0,
      label TEXT,
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      wheel_circumference_mm INTEGER NOT NULL DEFAULT 2183,
      sensor_id TEXT,
      FOREIGN KEY (route_id) REFERENCES routes(id)
    );

    CREATE TABLE IF NOT EXISTS ride_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ride_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      cumulative_distance REAL NOT NULL,
      deviation_seconds REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'live',
      FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS raw_csc_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ride_id          INTEGER NOT NULL,
      wall_clock_ms    INTEGER NOT NULL,
      cumulative_revs  INTEGER NOT NULL,
      wheel_event_time INTEGER NOT NULL,
      FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE
    );
  `);
}
