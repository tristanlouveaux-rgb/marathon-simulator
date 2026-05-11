/**
 * api-key-store.ts
 * ================
 * Secure storage for the user's Anthropic API key.
 *
 * On iOS (Capacitor native): @capacitor/preferences → iOS Keychain.
 * On web (dev): localStorage (not encrypted — acceptable for dev only, disclosed in UI).
 *
 * The key itself never touches SimulatorState. State only carries a boolean flag
 * `anthropicApiKeyStored` so the coach view knows whether to show AI mode without
 * reading the key on every render.
 */

import { Capacitor } from '@capacitor/core';

const STORAGE_KEY = 'mosaic_anthropic_api_key';

async function getPreferences() {
  const { Preferences } = await import('@capacitor/preferences');
  return Preferences;
}

export async function storeApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key cannot be empty');

  if (Capacitor.isNativePlatform()) {
    const Preferences = await getPreferences();
    await Preferences.set({ key: STORAGE_KEY, value: trimmed });
  } else {
    localStorage.setItem(STORAGE_KEY, trimmed);
  }
}

export async function getApiKey(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    const Preferences = await getPreferences();
    const { value } = await Preferences.get({ key: STORAGE_KEY });
    return value ?? null;
  }
  return localStorage.getItem(STORAGE_KEY);
}

export async function clearApiKey(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const Preferences = await getPreferences();
    await Preferences.remove({ key: STORAGE_KEY });
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export async function hasApiKey(): Promise<boolean> {
  const key = await getApiKey();
  return key !== null && key.length > 0;
}
