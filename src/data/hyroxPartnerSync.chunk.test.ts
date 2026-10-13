// @vitest-environment jsdom
/**
 * HYROX Doubles partner, Wipe everything on the web while offline: the
 * partner module (hyroxPartner.ts) is a lazy chunk the device cannot fetch,
 * so its import rejects. The pending flag must already be written, from the
 * owner stamp, so the next launch still ends the link.
 */
import { it, expect, vi } from 'vitest';

vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  getUserId: async () => { throw new Error('SESSION_EXPIRED'); },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
}));
vi.mock('./hyroxPartner', () => { throw new TypeError('Failed to fetch dynamically imported module'); });

import { cleanUpHyroxPartnerOnReset, HYROX_PARTNER_PENDING_KEY } from './hyroxPartnerSync';
import { setLocalStateOwner } from './planSettingsSync';

it('wipe with the partner chunk unavailable still records the pending flag', async () => {
  localStorage.clear();
  setLocalStateOwner('user-a');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await cleanUpHyroxPartnerOnReset('wipe');
  expect(JSON.parse(localStorage.getItem(HYROX_PARTNER_PENDING_KEY) ?? 'null')).toEqual([{ userId: 'user-a', action: 'wipe' }]);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
