import * as SQLite from 'expo-sqlite';

// Native: expo-sqlite is ready immediately; nothing to prepare or seed.
export async function prepareDb(): Promise<void> {}

export function openDb(): SQLite.SQLiteDatabase {
  return SQLite.openDatabaseSync('enduro.db');
}

export function seedPreviewData(): void {}
