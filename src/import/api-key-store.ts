// The rider's own Anthropic API key, entered once in Settings and stored in
// the device Keychain (iOS) / Keystore (Android) via expo-secure-store —
// never in SQLite, never in the app bundle, never checked into the repo.

import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'anthropic_api_key';

export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEY);
}

export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    return;
  }
  await SecureStore.setItemAsync(STORAGE_KEY, trimmed);
}
