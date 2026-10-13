/**
 * HYROX Doubles partner: Supabase data layer.
 *
 * Tables and the redeem function: supabase/migrations/20261013000001_hyrox_partner.sql
 * (RLS on all three tables; the partner snapshot policy reads the link table,
 * so unlink revokes access at once). RLS is the isolation control; every read
 * here also filters by the signed-in user (defence in depth,
 * docs/DATA_ISOLATION_AUDIT.md). The user id comes from getUserId() (the
 * verified session), never from a caller argument.
 *
 * Every call returns a result object and never throws: offline, no session
 * and server errors map to a short error code the UI turns into one line.
 */

import { supabase, getUserId } from './supabaseClient';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { HyroxDivision, HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import { isValidHyroxPartnerInitials, type HyroxPartnerFormat, type HyroxPartnerSnapshot } from '@/calculations/hyrox-partner-snapshot';

const INVITES = 'hyrox_partner_invites';
const LINKS = 'hyrox_partner_links';
const SNAPSHOTS = 'hyrox_partner_snapshots';

/** Invite code alphabet and length, mirrored from the migration's CHECK. */
export const HYROX_PARTNER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const HYROX_PARTNER_CODE_LENGTH = 8;

export type PartnerErrorCode =
  | 'offline'
  | 'no_session'
  | 'invalid_code'
  /** No live code: unknown, expired or already redeemed. The server answers
   *  all three with one word so it never says whether a code existed. */
  | 'unavailable'
  | 'own_code'
  | 'already_linked'
  | 'partner_linked'
  | 'unknown';

export type PartnerResult<T> = { ok: true; value: T } | { ok: false; error: PartnerErrorCode };

export interface PartnerInvite {
  code: string;
  expiresAt: string;
}

export interface PartnerLink {
  partnerId: string;
  createdAt: string;
}

/** A partner's snapshot as read back, with the server's update time. */
export interface StoredPartnerSnapshot {
  snapshot: HyroxPartnerSnapshot;
  updatedAt: string;
}

export interface UpsertSnapshotOptions {
  /** Refuse the write unless the session user is this id: the local state's
   *  owner stamp, so a previous account's in-memory state is never written
   *  under a new session. */
  expectUserId?: string;
}

/** The calls the Partner page and the sync use. An interface so the page and
 *  the QA harness can run against a mock with no network. */
export interface HyroxPartnerSource {
  createInvite(): Promise<PartnerResult<PartnerInvite>>;
  getOpenInvite(): Promise<PartnerResult<PartnerInvite | null>>;
  redeemInvite(code: string): Promise<PartnerResult<void>>;
  getLink(): Promise<PartnerResult<PartnerLink | null>>;
  unlink(): Promise<PartnerResult<void>>;
  upsertMySnapshot(snapshot: HyroxPartnerSnapshot, opts?: UpsertSnapshotOptions): Promise<PartnerResult<void>>;
  /** Delete the caller's own snapshot (the athlete left doubles mode). */
  removeMySnapshot(opts?: UpsertSnapshotOptions): Promise<PartnerResult<void>>;
  getPartnerSnapshot(): Promise<PartnerResult<StoredPartnerSnapshot | null>>;
}

// ── Code helpers ─────────────────────────────────────────────────────────────

/** Normalise what a user typed: drop spaces and dashes, upper-case. */
export function normaliseHyroxPartnerCode(input: string): string {
  return (input ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** True when a normalised code has the server's shape. */
export function isWellFormedHyroxPartnerCode(code: string): boolean {
  if (code.length !== HYROX_PARTNER_CODE_LENGTH) return false;
  for (const ch of code) if (!HYROX_PARTNER_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** "ABCDEFGH" → "ABCD-EFGH" for display. */
export function formatHyroxPartnerCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

// ── Row mapping (whitelist on the wire) ──────────────────────────────────────

export interface HyroxPartnerSnapshotRow {
  user_id: string;
  format: HyroxPartnerFormat;
  division: HyroxDivision | null;
  race_tier: HyroxLoadTier | null;
  initials: string | null;
  station_sec: Array<number | null>;
  station_tier: Array<HyroxLoadTier | null>;
  station_team: boolean[];
  forecast_station_sec: number[];
  run_pace_sec_km: number;
  roxzone_sec: number;
  updated_at?: string;
}

/** Every column of hyrox_partner_snapshots, the whitelist on the wire. */
export const SNAPSHOT_COLUMNS =
  'user_id,updated_at,format,division,race_tier,initials,station_sec,station_tier,station_team,forecast_station_sec,run_pace_sec_km,roxzone_sec';

const FORMATS: ReadonlyArray<HyroxPartnerFormat> = ['open_singles', 'pro_singles', 'open_doubles', 'pro_doubles'];
const DIVISIONS: ReadonlyArray<HyroxDivision> = ['women', 'men', 'mixed'];
const TIERS: ReadonlyArray<HyroxLoadTier> = ['W-Open', 'M-Open', 'M-Pro'];
const isPositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const tierOrNull = (t: unknown): HyroxLoadTier | null => (TIERS as ReadonlyArray<unknown>).includes(t) ? t as HyroxLoadTier : null;

/** Snapshot → row. Builds each column explicitly, so a field added to the
 *  snapshot object by mistake never reaches the server. */
export function snapshotToRow(userId: string, s: HyroxPartnerSnapshot): HyroxPartnerSnapshotRow {
  return {
    user_id: userId,
    format: s.format,
    division: s.division,
    race_tier: s.raceTier,
    initials: s.initials,
    station_sec: HYROX_STATION_ORDER.map(st => s.stationSec[st] ?? null),
    station_tier: HYROX_STATION_ORDER.map(st => s.stationTier[st] ?? null),
    station_team: HYROX_STATION_ORDER.map(st => s.teamStations.includes(st)),
    forecast_station_sec: HYROX_STATION_ORDER.map(st => s.forecastStationSec[st]),
    run_pace_sec_km: s.runPaceSecKm,
    roxzone_sec: s.roxzoneSec,
  };
}

/** Row → snapshot. The partner's row is another user's data: every field is
 *  checked against the column's shape, an invalid optional field reads as
 *  absent, and a row missing a required field reads as no snapshot. */
export function rowToSnapshot(row: Partial<HyroxPartnerSnapshotRow> | null | undefined): HyroxPartnerSnapshot | null {
  if (!row) return null;
  const n = HYROX_STATION_ORDER.length;
  const sec = row.station_sec;
  const tier = row.station_tier;
  const team = row.station_team;
  const fc = row.forecast_station_sec;
  if (!Array.isArray(sec) || !Array.isArray(tier) || !Array.isArray(team) || !Array.isArray(fc)) return null;
  if (sec.length !== n || tier.length !== n || team.length !== n || fc.length !== n) return null;
  if (!FORMATS.includes(row.format as HyroxPartnerFormat)) return null;
  if (!isPositive(row.run_pace_sec_km) || !isPositive(row.roxzone_sec)) return null;
  if (!fc.every(isPositive)) return null;
  const stationSec: Partial<Record<HyroxStation, number>> = {};
  const stationTier: Partial<Record<HyroxStation, HyroxLoadTier>> = {};
  const teamStations: HyroxStation[] = [];
  const forecastStationSec = {} as Record<HyroxStation, number>;
  HYROX_STATION_ORDER.forEach((st, i) => {
    if (isPositive(sec[i])) stationSec[st] = sec[i] as number;
    const t = tierOrNull(tier[i]);
    if (t) stationTier[st] = t;
    if (team[i] === true) teamStations.push(st);
    forecastStationSec[st] = fc[i];
  });
  return {
    format: row.format as HyroxPartnerFormat,
    division: DIVISIONS.includes(row.division as HyroxDivision) ? row.division as HyroxDivision : null,
    raceTier: tierOrNull(row.race_tier),
    initials: isValidHyroxPartnerInitials(row.initials) ? row.initials : null,
    stationSec,
    stationTier,
    teamStations,
    forecastStationSec,
    runPaceSecKm: row.run_pace_sec_km,
    roxzoneSec: row.roxzone_sec,
  };
}

// ── Error mapping ────────────────────────────────────────────────────────────

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** A supabase-js / fetch error that means the network, not the server. */
function isNetworkError(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '');
  return /Failed to fetch|NetworkError|Load failed|network|fetch failed/i.test(msg);
}

function fail<T>(error: PartnerErrorCode): PartnerResult<T> {
  return { ok: false, error };
}

/** The redeem function's status words → result. 'retry' (a concurrent
 *  redeem won a lock race, nothing was written) is handled by redeemInvite
 *  and reads as unknown here. */
export function mapRedeemStatus(status: unknown): PartnerResult<void> {
  switch (status) {
    case 'linked': return { ok: true, value: undefined };
    case 'invalid_code': return fail('invalid_code');
    case 'unavailable': return fail('unavailable');
    case 'own_code': return fail('own_code');
    case 'already_linked': return fail('already_linked');
    case 'partner_linked': return fail('partner_linked');
    case 'not_authenticated': return fail('no_session');
    default: return fail('unknown');
  }
}

/** Session user id, or the error to return. */
async function sessionUser(): Promise<{ id: string } | { error: PartnerErrorCode }> {
  if (isOffline()) return { error: 'offline' };
  try {
    return { id: await getUserId() };
  } catch (e) {
    return { error: isNetworkError(e) ? 'offline' : 'no_session' };
  }
}

function serverError<T>(error: unknown): PartnerResult<T> {
  if (isOffline() || isNetworkError(error)) return fail('offline');
  console.warn('[hyroxPartner] request failed:', (error as { message?: string })?.message ?? error);
  return fail('unknown');
}

// ── Calls ────────────────────────────────────────────────────────────────────

/** New invite code. The server sets the code and expiry and deletes the
 *  caller's earlier code in the same statement (one code per user). */
export async function createInvite(): Promise<PartnerResult<PartnerInvite>> {
  const u = await sessionUser();
  if ('error' in u) return fail(u.error);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = await supabase
        .from(INVITES)
        .insert({ owner_id: u.id })
        .select('code,expires_at')
        .single();
      if (!error && data) return { ok: true, value: { code: data.code, expiresAt: data.expires_at } };
      // 23505 = a generated code collided with an existing one: retry once.
      if ((error as { code?: string } | null)?.code !== '23505') return serverError(error);
    }
    return fail('unknown');
  } catch (e) {
    return serverError(e);
  }
}

/** The caller's live invite, if any (to show it again on return). A
 *  redeemed code no longer exists, so any row here is unused. */
export async function getOpenInvite(): Promise<PartnerResult<PartnerInvite | null>> {
  const u = await sessionUser();
  if ('error' in u) return fail(u.error);
  try {
    const { data, error } = await supabase
      .from(INVITES)
      .select('code,expires_at')
      .eq('owner_id', u.id)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) return serverError(error);
    return { ok: true, value: data ? { code: data.code, expiresAt: data.expires_at } : null };
  } catch (e) {
    return serverError(e);
  }
}

/** Redeem a partner's code (redeem_hyrox_partner_invite, SECURITY DEFINER).
 *  'retry' means a concurrent redeem won a lock race and nothing was written:
 *  call once more, which then reads the settled state. */
export async function redeemInvite(input: string): Promise<PartnerResult<void>> {
  const code = normaliseHyroxPartnerCode(input);
  if (!isWellFormedHyroxPartnerCode(code)) return fail('invalid_code');
  const u = await sessionUser();
  if ('error' in u) return fail(u.error);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = await supabase.rpc('redeem_hyrox_partner_invite', { code });
      if (error) return serverError(error);
      if (data !== 'retry') return mapRedeemStatus(data);
    }
    return fail('unknown');
  } catch (e) {
    return serverError(e);
  }
}

/** The caller's link, or null when unlinked. */
export async function getLink(): Promise<PartnerResult<PartnerLink | null>> {
  const u = await sessionUser();
  if ('error' in u) return fail(u.error);
  try {
    const { data, error } = await supabase
      .from(LINKS)
      .select('partner_id,created_at')
      .eq('user_id', u.id)
      .maybeSingle();
    if (error) return serverError(error);
    return { ok: true, value: data ? { partnerId: data.partner_id, createdAt: data.created_at } : null };
  } catch (e) {
    return serverError(e);
  }
}

/** Unlink: delete the caller's link row; the partner's mirror row cascades
 *  and the database deletes both snapshots (hyrox_partner_link_after_delete). */
export async function unlink(): Promise<PartnerResult<void>> {
  const u = await sessionUser();
  if ('error' in u) return fail(u.error);
  try {
    const { error } = await supabase.from(LINKS).delete().eq('user_id', u.id);
    if (error) return serverError(error);
    return { ok: true, value: undefined };
  } catch (e) {
    return serverError(e);
  }
}

/** Write the caller's snapshot (insert or replace their own row). */
export async function upsertMySnapshot(
  snapshot: HyroxPartnerSnapshot,
  opts: UpsertSnapshotOptions = {},
): Promise<PartnerResult<void>> {
  const u = await sessionUser();
  if ('error' in u) return fail(u.error);
  if (opts.expectUserId && opts.expectUserId !== u.id) return fail('no_session');
  try {
    const { error } = await supabase
      .from(SNAPSHOTS)
      .upsert(snapshotToRow(u.id, snapshot), { onConflict: 'user_id' });
    if (error) return serverError(error);
    return { ok: true, value: undefined };
  } catch (e) {
    return serverError(e);
  }
}

/** Delete the caller's own snapshot (the athlete left doubles mode). Refused
 *  unless the session user is `expectUserId` when given, as for the upsert. */
export async function removeMySnapshot(opts: UpsertSnapshotOptions = {}): Promise<PartnerResult<void>> {
  const u = await sessionUser();
  if ('error' in u) return fail(u.error);
  if (opts.expectUserId && opts.expectUserId !== u.id) return fail('no_session');
  try {
    const { error } = await supabase.from(SNAPSHOTS).delete().eq('user_id', u.id);
    if (error) return serverError(error);
    return { ok: true, value: undefined };
  } catch (e) {
    return serverError(e);
  }
}

/** The linked partner's snapshot, or null when unlinked or the partner has
 *  not synced. The partner id is read from the caller's own link row
 *  (filtered by the session user), never taken from an argument; RLS would
 *  return nothing for anyone else in any case. */
export async function getPartnerSnapshot(): Promise<PartnerResult<StoredPartnerSnapshot | null>> {
  const u = await sessionUser();
  if ('error' in u) return fail(u.error);
  try {
    const link = await supabase
      .from(LINKS)
      .select('partner_id')
      .eq('user_id', u.id)
      .maybeSingle();
    if (link.error) return serverError(link.error);
    const partnerId = (link.data as { partner_id?: string } | null)?.partner_id;
    if (!partnerId || partnerId === u.id) return { ok: true, value: null };
    const { data, error } = await supabase
      .from(SNAPSHOTS)
      .select(SNAPSHOT_COLUMNS)
      .eq('user_id', partnerId)
      .maybeSingle();
    if (error) return serverError(error);
    const row = data as unknown as HyroxPartnerSnapshotRow | null;
    const snapshot = rowToSnapshot(row);
    if (!snapshot || !row) return { ok: true, value: null };
    return { ok: true, value: { snapshot, updatedAt: row.updated_at ?? '' } };
  } catch (e) {
    return serverError(e);
  }
}

/**
 * Account deletion: end the link and delete this user's snapshot and invites
 * at once, so a partner stops reading the numbers immediately rather than
 * after the 30-day purge (auth.users delete cascades the rest; the
 * delete-account edge function does the same server-side once deployed).
 * The link goes first: its delete trigger also removes both snapshots, so the
 * snapshot delete after it usually finds nothing. One call at a time, so the
 * three deletes never wait on each other. Best effort: never throws, returns
 * false on any failure.
 */
export async function removeMyHyroxPartnerData(): Promise<boolean> {
  const u = await sessionUser();
  if ('error' in u) return false;
  try {
    let ok = true;
    ok = !(await supabase.from(LINKS).delete().eq('user_id', u.id)).error && ok;
    ok = !(await supabase.from(SNAPSHOTS).delete().eq('user_id', u.id)).error && ok;
    ok = !(await supabase.from(INVITES).delete().eq('owner_id', u.id)).error && ok;
    return ok;
  } catch {
    return false;
  }
}

/** The live data source. */
export const hyroxPartnerSource: HyroxPartnerSource = {
  createInvite,
  getOpenInvite,
  redeemInvite,
  getLink,
  unlink,
  upsertMySnapshot,
  removeMySnapshot,
  getPartnerSnapshot,
};
