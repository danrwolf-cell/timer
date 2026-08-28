import * as SQLite from 'expo-sqlite';

let db: SQLite.SQLiteDatabase;

export function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync('enduro.db');
  }
  return db;
}

interface PragmaColumn { name: string }

function migrateAddColumn(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  type: string
): void {
  const cols = db.getAllSync(`PRAGMA table_info(${table})`) as PragmaColumn[];
  if (!cols.some(c => c.name === column)) {
    db.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
    );`);

  // Additive migrations — safe to run on every launch.
  // PRAGMA table_info guards prevent errors on fresh installs where the
  // column was added in the CREATE TABLE above on a future schema version.
  migrateAddColumn(database, 'route_segments', 'check_type', 'TEXT');
  migrateAddColumn(database, 'routes', 'has_secret_checks', 'INTEGER');
  migrateAddColumn(database, 'routes', 'ft_miles_after_check', 'REAL');
  migrateAddColumn(database, 'routes', 'ft_miles_before_gas', 'REAL');
  migrateAddColumn(database, 'routes', 'ft_miles_after_gas', 'REAL');
  migrateAddColumn(database, 'routes', 'ft_calibration_mile', 'REAL');
  // Event start config: official key time (absolute, second-precision) and the
  // rider's row. Held on the phone so it can be entered well ahead of the
  // start and pushed to the device whenever it is connected.
  migrateAddColumn(database, 'routes', 'key_time_epoch_ms', 'INTEGER');
  migrateAddColumn(database, 'routes', 'rider_row', 'INTEGER');
  // Signed ms the timekeeper's clock reads ahead of this phone's clock.
  // Key times are quoted in event time, so this is what makes them absolute.
  migrateAddColumn(database, 'routes', 'clock_offset_ms', 'INTEGER');

  database.execSync(`

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

    -- Free-territory zones taken verbatim from a route sheet (mile ranges the
    -- organizer marked no-check), in course-cumulative miles. See
    -- src/engine/free-territory.ts: explicit zones override the FtRules
    -- formula, which real sheets routinely don't follow exactly.
    CREATE TABLE IF NOT EXISTS route_free_zones (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id   INTEGER NOT NULL,
      start_mile REAL NOT NULL,
      end_mile   REAL NOT NULL,
      reason     TEXT,
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );
  `);
}
