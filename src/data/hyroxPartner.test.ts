/**
 * HYROX Doubles partner data layer against a mocked Supabase client: what
 * each call sends (the user filter on every read, only owner_id on invite
 * insert, only whitelisted columns on the snapshot), and how server, network
 * and session failures map to the one-line error codes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Op = [name: string, args: unknown[]];
interface Call { table: string | null; rpc?: { fn: string; args: unknown }; ops: Op[] }
type Responder = (call: Call) => { data?: unknown; error?: unknown } | Promise<{ data?: unknown; error?: unknown }>;

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  responder: (() => ({ data: null, error: null })) as Responder,
  userId: 'user-a' as string | null,
  userError: null as Error | null,
}));

vi.mock('./supabaseClient', () => {
  function builder(table: string): unknown {
    const call: Call = { table, ops: [] };
    h.calls.push(call);
    const run = () => Promise.resolve(h.responder(call)).then(r => ({ data: r.data ?? null, error: r.error ?? null }));
    const b: Record<string, unknown> = {};
    for (const name of ['select', 'insert', 'upsert', 'delete', 'update', 'eq', 'is', 'gt', 'order', 'limit']) {
      b[name] = (...args: unknown[]) => { call.ops.push([name, args]); return b; };
    }
    b.single = () => { call.ops.push(['single', []]); return run(); };
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return run(); };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej);
    return b;
  }
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: (fn: string, args: unknown) => {
        const call: Call = { table: null, rpc: { fn, args }, ops: [] };
        h.calls.push(call);
        return Promise.resolve(h.responder(call)).then(r => ({ data: r.data ?? null, error: r.error ?? null }));
      },
    },
    getUserId: async () => {
      if (h.userError) throw h.userError;
      if (!h.userId) throw new Error('SESSION_EXPIRED');
      return h.userId;
    },
  };
});

import {
  createInvite,
  getLink,
  getOpenInvite,
  getPartnerSnapshot,
  isWellFormedHyroxPartnerCode,
  mapRedeemStatus,
  normaliseHyroxPartnerCode,
  formatHyroxPartnerCode,
  redeemInvite,
  removeMyHyroxPartnerData,
  rowToSnapshot,
  snapshotToRow,
  SNAPSHOT_COLUMNS,
  unlink,
  upsertMySnapshot,
  type HyroxPartnerSnapshotRow,
} from './hyroxPartner';
import type { HyroxPartnerSnapshot } from '@/calculations/hyrox-partner-snapshot';
import { HYROX_PARTNER_SNAPSHOT_KEYS } from '@/calculations/hyrox-partner-snapshot';

const opArgs = (c: Call, name: string) => c.ops.filter(o => o[0] === name).map(o => o[1]);

const SNAP: HyroxPartnerSnapshot = {
  format: 'open_doubles',
  division: 'mixed',
  raceTier: 'M-Open',
  initials: 'TL',
  stationSec: { ski_erg: 270, sled_push: 200 },
  stationTier: { ski_erg: 'M-Open', sled_push: 'M-Open' },
  teamStations: ['wall_balls'],
  forecastStationSec: {
    ski_erg: 275, sled_push: 205, sled_pull: 265, burpee_broad_jumps: 305,
    row_erg: 295, farmer_carry: 115, sandbag_lunges: 285, wall_balls: 435,
  },
  runPaceSecKm: 300,
  roxzoneSec: 420,
};

beforeEach(() => {
  h.calls.length = 0;
  h.responder = () => ({ data: null, error: null });
  h.userId = 'user-a';
  h.userError = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('code helpers', () => {
  it('normalise what a user types and check the server shape', () => {
    expect(normaliseHyroxPartnerCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(isWellFormedHyroxPartnerCode('ABCDEFGH')).toBe(true);
    // No look-alikes in the alphabet (I, L, O, 0, 1).
    expect(isWellFormedHyroxPartnerCode('ABCDEFGI')).toBe(false);
    expect(isWellFormedHyroxPartnerCode('ABCDEF0H')).toBe(false);
    expect(isWellFormedHyroxPartnerCode('ABCDEFG')).toBe(false);
    expect(formatHyroxPartnerCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('createInvite', () => {
  it('drops the caller\'s unused codes, inserts only owner_id, returns the server code', async () => {
    h.responder = (c) => (opArgs(c, 'insert').length ? { data: { code: 'ABCDEFGH', expires_at: '2026-10-14T12:00:00Z' } } : {});
    const r = await createInvite();
    expect(r).toEqual({ ok: true, value: { code: 'ABCDEFGH', expiresAt: '2026-10-14T12:00:00Z' } });
    const del = h.calls[0];
    expect(del.table).toBe('hyrox_partner_invites');
    expect(opArgs(del, 'delete')).toHaveLength(1);
    expect(opArgs(del, 'eq')).toEqual([['owner_id', 'user-a']]);
    expect(opArgs(del, 'is')).toEqual([['used_at', null]]);
    const ins = h.calls[1];
    expect(opArgs(ins, 'insert')).toEqual([[{ owner_id: 'user-a' }]]);
  });

  it('retries once on a generated-code collision', async () => {
    let inserts = 0;
    h.responder = (c) => {
      if (!opArgs(c, 'insert').length) return {};
      inserts++;
      return inserts === 1 ? { error: { code: '23505', message: 'duplicate key' } } : { data: { code: 'QRSTUVWX', expires_at: 'x' } };
    };
    const r = await createInvite();
    expect(r.ok && r.value.code).toBe('QRSTUVWX');
    expect(inserts).toBe(2);
  });

  it('no session and offline map to their codes without a request', async () => {
    h.userId = null;
    expect(await createInvite()).toEqual({ ok: false, error: 'no_session' });
    h.userId = 'user-a';
    vi.stubGlobal('navigator', { onLine: false });
    expect(await createInvite()).toEqual({ ok: false, error: 'offline' });
    expect(h.calls).toHaveLength(0);
  });

  it('a network failure maps to offline, a server error to unknown', async () => {
    h.responder = (c) => (opArgs(c, 'insert').length ? { error: { message: 'TypeError: Failed to fetch' } } : {});
    expect(await createInvite()).toEqual({ ok: false, error: 'offline' });
    h.responder = (c) => (opArgs(c, 'insert').length ? { error: { code: '42501', message: 'permission denied' } } : {});
    expect(await createInvite()).toEqual({ ok: false, error: 'unknown' });
  });
});

describe('getOpenInvite', () => {
  it('reads only the caller\'s unused, unexpired code', async () => {
    h.responder = () => ({ data: { code: 'ABCDEFGH', expires_at: 'x' } });
    const r = await getOpenInvite();
    expect(r).toEqual({ ok: true, value: { code: 'ABCDEFGH', expiresAt: 'x' } });
    const c = h.calls[0];
    expect(opArgs(c, 'eq')).toEqual([['owner_id', 'user-a']]);
    expect(opArgs(c, 'is')).toEqual([['used_at', null]]);
    expect(opArgs(c, 'gt')[0][0]).toBe('expires_at');
  });
});

describe('redeemInvite', () => {
  it('a malformed code is rejected without a request', async () => {
    expect(await redeemInvite('nope')).toEqual({ ok: false, error: 'invalid_code' });
    expect(h.calls).toHaveLength(0);
  });

  it('sends the normalised code to the definer function', async () => {
    h.responder = () => ({ data: 'linked' });
    expect(await redeemInvite('abcd-efgh')).toEqual({ ok: true, value: undefined });
    expect(h.calls[0].rpc).toEqual({ fn: 'redeem_hyrox_partner_invite', args: { code: 'ABCDEFGH' } });
  });

  it('maps every status word', async () => {
    const cases: Array<[string, string]> = [
      ['invalid_code', 'invalid_code'], ['expired', 'expired'], ['used', 'used'], ['own_code', 'own_code'],
      ['already_linked', 'already_linked'], ['partner_linked', 'partner_linked'], ['not_authenticated', 'no_session'],
      ['something_else', 'unknown'],
    ];
    for (const [status, error] of cases) {
      h.responder = () => ({ data: status });
      expect(await redeemInvite('ABCDEFGH')).toEqual({ ok: false, error });
    }
    expect(mapRedeemStatus('linked')).toEqual({ ok: true, value: undefined });
  });
});

describe('link and unlink', () => {
  it('getLink filters by the session user', async () => {
    h.responder = () => ({ data: { partner_id: 'user-b', created_at: 't' } });
    expect(await getLink()).toEqual({ ok: true, value: { partnerId: 'user-b', createdAt: 't' } });
    expect(h.calls[0].table).toBe('hyrox_partner_links');
    expect(opArgs(h.calls[0], 'eq')).toEqual([['user_id', 'user-a']]);
  });

  it('getLink with no row is unlinked', async () => {
    expect(await getLink()).toEqual({ ok: true, value: null });
  });

  it('unlink deletes only the caller\'s row', async () => {
    expect(await unlink()).toEqual({ ok: true, value: undefined });
    expect(opArgs(h.calls[0], 'delete')).toHaveLength(1);
    expect(opArgs(h.calls[0], 'eq')).toEqual([['user_id', 'user-a']]);
  });
});

describe('snapshots', () => {
  it('upsert sends the whitelisted columns only, under the session user', async () => {
    const withExtra = { ...SNAP, restingHR: 41, vdot: 55, name: 'Tristan' } as unknown as HyroxPartnerSnapshot;
    expect(await upsertMySnapshot(withExtra)).toEqual({ ok: true, value: undefined });
    const [[row, opts]] = opArgs(h.calls[0], 'upsert') as [[HyroxPartnerSnapshotRow, unknown]];
    expect(Object.keys(row).sort()).toEqual(SNAPSHOT_COLUMNS.split(',').filter(c => c !== 'updated_at').sort());
    expect(row.user_id).toBe('user-a');
    expect(row.station_sec).toEqual([270, 200, null, null, null, null, null, null]);
    expect(row.station_tier).toEqual(['M-Open', 'M-Open', null, null, null, null, null, null]);
    expect(row.station_team).toEqual([false, false, false, false, false, false, false, true]);
    expect(opts).toEqual({ onConflict: 'user_id' });
    expect(JSON.stringify(row)).not.toContain('Tristan');
  });

  it('upsert refuses when the session user is not the local state\'s owner', async () => {
    expect(await upsertMySnapshot(SNAP, { expectUserId: 'user-z' })).toEqual({ ok: false, error: 'no_session' });
    expect(h.calls).toHaveLength(0);
  });

  it('row and snapshot round-trip; the row mapping covers every snapshot key', () => {
    expect(rowToSnapshot({ ...snapshotToRow('user-a', SNAP), updated_at: 't' })).toEqual(SNAP);
    expect(HYROX_PARTNER_SNAPSHOT_KEYS.length).toBe(Object.keys(SNAP).length);
  });

  it('a partner row with bad fields: optional ones read as absent, required ones as no snapshot', () => {
    const row = snapshotToRow('user-b', SNAP);
    const tampered = rowToSnapshot({ ...row, initials: '<img src=x>', division: 'nope' as never, race_tier: 'X' as never, station_tier: ['heart_rate', ...row.station_tier.slice(1)] as never });
    expect(tampered!.initials).toBeNull();
    expect(tampered!.division).toBeNull();
    expect(tampered!.raceTier).toBeNull();
    expect(tampered!.stationTier.ski_erg).toBeUndefined();
    expect(rowToSnapshot({ ...row, station_sec: [1, 2, 3] })).toBeNull();
    expect(rowToSnapshot({ ...row, run_pace_sec_km: -1 })).toBeNull();
    expect(rowToSnapshot({ ...row, format: 'relay' as never })).toBeNull();
    expect(rowToSnapshot(null)).toBeNull();
  });

  it('getPartnerSnapshot reads the partner id from the caller\'s own link row', async () => {
    h.responder = (c) => {
      if (c.table === 'hyrox_partner_links') return { data: { partner_id: 'user-b' } };
      return { data: { ...snapshotToRow('user-b', { ...SNAP, initials: 'MK' }), updated_at: '2026-10-12T08:00:00Z' } };
    };
    const r = await getPartnerSnapshot();
    expect(r.ok && r.value?.snapshot.initials).toBe('MK');
    expect(r.ok && r.value?.updatedAt).toBe('2026-10-12T08:00:00Z');
    expect(opArgs(h.calls[0], 'eq')).toEqual([['user_id', 'user-a']]);
    expect(h.calls[1].table).toBe('hyrox_partner_snapshots');
    expect(opArgs(h.calls[1], 'select')).toEqual([[SNAPSHOT_COLUMNS]]);
    expect(opArgs(h.calls[1], 'eq')).toEqual([['user_id', 'user-b']]);
  });

  it('unlinked, or a partner who has not synced: null', async () => {
    expect(await getPartnerSnapshot()).toEqual({ ok: true, value: null });
    h.responder = (c) => (c.table === 'hyrox_partner_links' ? { data: { partner_id: 'user-b' } } : { data: null });
    expect(await getPartnerSnapshot()).toEqual({ ok: true, value: null });
  });
});

describe('account deletion cleanup', () => {
  it('deletes the caller\'s link, snapshot and invites', async () => {
    expect(await removeMyHyroxPartnerData()).toBe(true);
    const byTable = Object.fromEntries(h.calls.map(c => [c.table, c]));
    expect(opArgs(byTable.hyrox_partner_links, 'eq')).toEqual([['user_id', 'user-a']]);
    expect(opArgs(byTable.hyrox_partner_snapshots, 'eq')).toEqual([['user_id', 'user-a']]);
    expect(opArgs(byTable.hyrox_partner_invites, 'eq')).toEqual([['owner_id', 'user-a']]);
    for (const c of h.calls) expect(opArgs(c, 'delete')).toHaveLength(1);
  });

  it('never throws; reports failure', async () => {
    h.responder = () => ({ error: { message: 'boom' } });
    expect(await removeMyHyroxPartnerData()).toBe(false);
    h.userId = null;
    expect(await removeMyHyroxPartnerData()).toBe(false);
  });
});
