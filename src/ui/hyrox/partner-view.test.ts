// @vitest-environment jsdom
/**
 * HYROX Doubles Partner page, every state, against a mocked data source (no
 * network): unlinked (create, copy, enter), linked (station leads, run pace,
 * pair forecast, unlink with an in-page confirm), errors, and the Stats entry
 * row that appears only in doubles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/data/supabaseClient', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
    from: () => { throw new Error('network blocked in test'); },
    rpc: () => { throw new Error('network blocked in test'); },
  },
  getUserId: async () => { throw new Error('SESSION_EXPIRED'); },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getDefaultState, setState } from '@/state/store';
import { setLocalStateOwner } from '@/data/planSettingsSync';
import { HYROX_HOURS_RANGE, HYROX_MTL_CAP, HYROX_WEEKLY_SESSIONS } from '@/constants/hyrox-constants';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { buildHyroxPartnerSnapshot, type HyroxPartnerSnapshot } from '@/calculations/hyrox-partner-snapshot';
import { renderHyroxPartnerView, stationStatusText, fmtLead, PARTNER_ERROR_COPY, withheldForecastText } from './partner-view';
import { partnerRowLabel, renderHyroxStatsView } from './stats-view';
import { _resetHyroxPartnerSyncForTests, getHyroxPartnerCache, refreshHyroxPartnerOnForeground, setHyroxPartnerCache } from '@/data/hyroxPartnerSync';
import type { HyroxPartnerSource, PartnerErrorCode, PartnerResult, PartnerInvite, PartnerLink, StoredPartnerSnapshot } from '@/data/hyroxPartner';
import type { HyroxConfig, HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import type { SimulatorState } from '@/types/state';

const MY_TIMES: Partial<Record<HyroxStation, number>> = {
  ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300,
  row_erg: 290, farmer_carry: 110, sandbag_lunges: 280, wall_balls: 430,
};

function seed(hx: Partial<HyroxConfig> = {}, over: Partial<SimulatorState> = {}): void {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.v = 50;
  s.biologicalSex = 'male';
  s.onboarding = { name: 'Tristan Louveaux' } as SimulatorState['onboarding'];
  s.hyroxConfig = {
    format: 'open_doubles', division: 'mixed', athleteBand: band, hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0, mtlCap: HYROX_MTL_CAP[band], mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    stationBenchmarksSingles: { ...MY_TIMES },
    ...hx,
  };
  Object.assign(s, over);
  setState(s);
}

const ok = <T>(value: T): PartnerResult<T> => ({ ok: true, value });
const fail = <T>(error: PartnerErrorCode): PartnerResult<T> => ({ ok: false, error });

/** A partner built from the viewer's own snapshot with set differences. */
function partnerFrom(me: HyroxPartnerSnapshot, over: Partial<HyroxPartnerSnapshot> = {}): HyroxPartnerSnapshot {
  return {
    ...me,
    initials: 'MK',
    stationSec: { ...me.stationSec, ski_erg: (me.stationSec.ski_erg ?? 0) + 12, sled_push: (me.stationSec.sled_push ?? 0) - 8 },
    runPaceSecKm: me.runPaceSecKm + 15,
    ...over,
  };
}

interface MockState {
  link: PartnerLink | null;
  invite: PartnerInvite | null;
  partner: StoredPartnerSnapshot | null;
  linkError?: 'offline';
  redeem?: PartnerResult<void>;
}

type MockFns = Record<keyof HyroxPartnerSource, ReturnType<typeof vi.fn>>;

function mockSource(m: MockState): HyroxPartnerSource & MockFns {
  const src = {
    getLink: vi.fn(async () => (m.linkError ? fail<PartnerLink | null>(m.linkError) : ok(m.link))),
    getOpenInvite: vi.fn(async () => ok(m.invite)),
    createInvite: vi.fn(async () => {
      m.invite = { code: 'ABCDEFGH', expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() };
      return ok(m.invite);
    }),
    redeemInvite: vi.fn(async () => {
      const r = m.redeem ?? ok(undefined);
      if (r.ok) m.link = { partnerId: 'user-b', createdAt: 't' };
      return r;
    }),
    unlink: vi.fn(async () => { m.link = null; return ok(undefined); }),
    getPartnerSnapshot: vi.fn(async () => ok(m.link ? m.partner : null)),
    upsertMySnapshot: vi.fn(async () => ok(undefined)),
    removeMySnapshot: vi.fn(async () => ok(undefined)),
  };
  return src as unknown as HyroxPartnerSource & MockFns;
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

beforeEach(() => {
  document.body.innerHTML = '<div id="app-root"></div>';
  _resetHyroxPartnerSyncForTests();
  seed();
});

afterEach(() => {
  setLocalStateOwner(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('copy helpers', () => {
  it('leads read in seconds under a minute, m:ss from a minute', () => {
    expect(fmtLead(12)).toBe('12 s');
    expect(fmtLead(65)).toBe('1:05');
    expect(stationStatusText({ station: 'ski_erg', status: 'you', leadSec: 12 })).toBe('You lead by 12 s');
    expect(stationStatusText({ station: 'ski_erg', status: 'partner', leadSec: 8 })).toBe('Partner leads by 8 s');
    expect(stationStatusText({ station: 'ski_erg', status: 'level' })).toBe('Level');
    expect(stationStatusText({ station: 'ski_erg', status: 'not_comparable', reason: 'tier' })).toBe('Not comparable');
  });

  it('error lines are one sentence or two, no em dashes', () => {
    for (const line of Object.values(PARTNER_ERROR_COPY)) {
      expect(line).not.toContain('—');
      expect(line.length).toBeLessThan(80);
    }
  });

  it('a withheld pair forecast says what is missing and from whom', () => {
    expect(withheldForecastText({ forecastWithheld: 'setup', withheldFor: null, pairTier: null })).toBe('Needs matching race setups.');
    expect(withheldForecastText({ forecastWithheld: 'loads', withheldFor: 'partner', pairTier: 'M-Open' })).toBe('Needs times at Men Open loads from your partner.');
    expect(withheldForecastText({ forecastWithheld: 'loads', withheldFor: 'you', pairTier: 'M-Pro' })).toBe('Needs times at Men Pro loads from you.');
    expect(withheldForecastText({ forecastWithheld: 'loads', withheldFor: 'both', pairTier: 'W-Open' })).toBe('Needs times at Women Open loads from both of you.');
    expect(withheldForecastText({ forecastWithheld: 'loads_unknown', withheldFor: 'partner', pairTier: 'M-Open' })).toBe('Station loads not known for your partner.');
    expect(withheldForecastText({ forecastWithheld: 'loads_unknown', withheldFor: 'both', pairTier: 'M-Open' })).toBe('Station loads not known for either of you.');
  });
});

describe('unlinked', () => {
  it('offers Create code and a code entry, nothing else', async () => {
    const src = mockSource({ link: null, invite: null, partner: null });
    renderHyroxPartnerView({ source: src });
    await flush();
    expect(text('#hxp-headline')).toBe('Not linked');
    expect($('#hxp-create')).not.toBeNull();
    expect($('#hxp-code-input')).not.toBeNull();
    expect($('#hxp-redeem')?.textContent).toBe('Link');
    expect(document.querySelectorAll('.hxp-station')).toHaveLength(0);
    expect($('#hxp-unlink')).toBeNull();
  });

  it('Create code shows the code large with a Copy button', async () => {
    const src = mockSource({ link: null, invite: null, partner: null });
    renderHyroxPartnerView({ source: src });
    await flush();
    expect(getHyroxPartnerCache()).toEqual({ linked: false, inviteExpiresAt: null });
    $('#hxp-create')!.click();
    await flush();
    expect(src.createInvite).toHaveBeenCalledTimes(1);
    expect(text('#hxp-code')).toBe('ABCD-EFGH');
    expect($('#hxp-copy')?.textContent).toBe('Copy');
    expect(document.body.textContent).toContain('Single use. Expires in 24 h.');
    // The open code is recorded so the foreground hook re-reads the link.
    expect(getHyroxPartnerCache()?.inviteExpiresAt).toBeTruthy();
  });

  it('a code out, partner redeems while the app is in the background: the foreground re-read pushes the snapshot', async () => {
    setLocalStateOwner('user-a');
    const m: MockState = { link: null, invite: null, partner: null };
    const src = mockSource(m);
    renderHyroxPartnerView({ source: src });
    await flush();
    $('#hxp-create')!.click();
    await flush();
    m.link = { partnerId: 'user-b', createdAt: 't' };
    await refreshHyroxPartnerOnForeground(src);
    expect(getHyroxPartnerCache()?.linked).toBe(true);
    expect(src.upsertMySnapshot).toHaveBeenCalled();
  });

  it('Copy writes the code to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const src = mockSource({ link: null, invite: { code: 'ABCDEFGH', expiresAt: new Date(Date.now() + 3600e3).toISOString() }, partner: null });
    renderHyroxPartnerView({ source: src });
    await flush();
    $('#hxp-copy')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
    expect($('#hxp-copy')?.textContent).toBe('Copied');
  });

  it('without the clipboard API the code text is selected instead', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const src = mockSource({ link: null, invite: { code: 'ABCDEFGH', expiresAt: new Date(Date.now() + 3600e3).toISOString() }, partner: null });
    renderHyroxPartnerView({ source: src });
    await flush();
    $('#hxp-copy')!.click();
    await flush();
    expect($('#hxp-copy')?.textContent).toBe('Selected');
    expect(window.getSelection()?.toString().replace(/\s+/g, '')).toBe('ABCD-EFGH');
  });

  it('a dead code (expired, used or unknown) shows one plain line and keeps what was typed', async () => {
    const src = mockSource({ link: null, invite: null, partner: null, redeem: fail('unavailable') });
    renderHyroxPartnerView({ source: src });
    await flush();
    ($('#hxp-code-input') as HTMLInputElement).value = 'wxyz-2345';
    $('#hxp-redeem')!.click();
    await flush();
    expect(src.redeemInvite).toHaveBeenCalledWith('wxyz-2345');
    expect(text('#hxp-msg')).toBe('This code has expired or been used. Check the 8 characters.');
    expect(($('#hxp-code-input') as HTMLInputElement).value).toBe('wxyz-2345');
  });

  it.each([
    ['own_code' as const], ['already_linked' as const], ['partner_linked' as const], ['offline' as const], ['invalid_code' as const], ['unknown' as const],
  ])('redeem error %s maps to its line', async (err) => {
    const src = mockSource({ link: null, invite: null, partner: null, redeem: fail(err) });
    renderHyroxPartnerView({ source: src });
    await flush();
    ($('#hxp-code-input') as HTMLInputElement).value = 'ABCDEFGH';
    $('#hxp-redeem')!.click();
    await flush();
    expect(text('#hxp-msg')).toBe(PARTNER_ERROR_COPY[err]);
  });

  it('a valid code links and shows the linked page', async () => {
    const me = buildHyroxPartnerSnapshot((await import('@/state/store')).getState())!;
    const src = mockSource({ link: null, invite: null, partner: { snapshot: partnerFrom(me), updatedAt: '2026-10-12T08:00:00Z' } });
    renderHyroxPartnerView({ source: src });
    await flush();
    ($('#hxp-code-input') as HTMLInputElement).value = 'ABCDEFGH';
    $('#hxp-redeem')!.click();
    await flush();
    expect(text('#hxp-headline')).toBe('MK');
    expect(document.querySelectorAll('.hxp-station')).toHaveLength(8);
  });
});

describe('linked', () => {
  async function renderLinked(partnerOver: Partial<HyroxPartnerSnapshot> = {}) {
    const me = buildHyroxPartnerSnapshot((await import('@/state/store')).getState())!;
    const partner = partnerFrom(me, partnerOver);
    const src = mockSource({ link: { partnerId: 'user-b', createdAt: 't' }, invite: null, partner: { snapshot: partner, updatedAt: '2026-10-12T08:00:00Z' } });
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderHyroxPartnerView({ source: src });
    await flush();
    return { me, partner, src, confirmSpy };
  }

  it('shows the partner, one row per station, run pace and the pair forecast', async () => {
    await renderLinked();
    expect(text('#hxp-headline')).toBe('MK');
    expect(text('#hxp-sub')).toBe('Updated 12 Oct');
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.hxp-station'));
    expect(rows.map(r => r.dataset.station)).toEqual(HYROX_STATION_ORDER);
    const row = (st: string) => rows.find(r => r.dataset.station === st)!.textContent!.replace(/\s+/g, ' ');
    expect(row('ski_erg')).toContain('You lead by 12 s');
    expect(row('sled_push')).toContain('Partner leads by 8 s');
    expect(text('#hxp-run')).toContain("Your partner's solo pace, the slower of the two");
    expect(text('#hxp-forecast')).toMatch(/Pair forecast.*\d:\d\d:\d\d/);
    expect($('#hxp-setups')).toBeNull();
  });

  it('a woman\'s Women Open times in a Mixed pair: loaded stations not comparable, ergs compared, pair forecast withheld', async () => {
    const tiers = Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, 'W-Open'])) as Record<HyroxStation, HyroxLoadTier>;
    await renderLinked({ stationTier: tiers });
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.hxp-station'));
    const row = (st: string) => rows.find(r => r.dataset.station === st)!.textContent!.replace(/\s+/g, ' ');
    expect(row('sled_push')).toContain('Not comparable');
    expect(row('sled_push')).toContain('Not at the race loads');
    expect(row('ski_erg')).toContain('You lead by 12 s');
    // The pair number would read her Women Open times as Men Open: one short
    // line naming what is missing and from whom instead.
    expect(text('#hxp-forecast')).toContain('Needs times at Men Open loads from your partner.');
    expect(text('#hxp-forecast')).toContain('Not available');
    expect(text('#hxp-forecast')).not.toMatch(/\d:\d\d:\d\d/);
    expect(text('#hxp-run')).toContain('solo pace');
  });

  it('a partner time whose load is not known: that row says so and the forecast names whose loads are missing', async () => {
    const me = buildHyroxPartnerSnapshot((await import('@/state/store')).getState())!;
    const tiers = { ...me.stationTier };
    delete tiers.wall_balls;
    await renderLinked({ stationTier: tiers });
    const wall = Array.from(document.querySelectorAll<HTMLElement>('.hxp-station')).find(r => r.dataset.station === 'wall_balls')!;
    expect(wall.textContent!.replace(/\s+/g, ' ')).toContain('Load not known');
    expect(text('#hxp-forecast')).toContain('Station loads not known for your partner.');
    expect(text('#hxp-forecast')).toContain('Not available');
  });

  it('a Men Pro pair whose tests were at Open weights: rows compare and the pair forecast shows, as the solo forecast does', async () => {
    seed({ format: 'pro_doubles', division: 'men' });
    await renderLinked();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.hxp-station'));
    const row = (st: string) => rows.find(r => r.dataset.station === st)!.textContent!.replace(/\s+/g, ' ');
    expect(row('sled_push')).toContain('Partner leads by 8 s');
    expect(text('#hxp-forecast')).toMatch(/Pair forecast.*\d:\d\d:\d\d/);
    expect(text('#hxp-forecast')).not.toContain('Needs');
  });

  it('different race setups: one line naming both, no pair forecast', async () => {
    await renderLinked({ division: 'women', raceTier: 'W-Open' });
    expect(text('#hxp-setups')).toBe('Setups differ: you race Doubles Mixed, your partner Doubles Women.');
    const sled = Array.from(document.querySelectorAll<HTMLElement>('.hxp-station')).find(r => r.dataset.station === 'sled_push')!;
    expect(sled.textContent!.replace(/\s+/g, ' ')).toContain('Race setups differ');
    expect(text('#hxp-forecast')).toContain('Needs matching race setups.');
    expect(text('#hxp-forecast')).toContain('Not available');
  });

  it('the partner\'s initials are escaped (another user\'s data)', async () => {
    await renderLinked({ initials: '<img src=x onerror=alert(1)>' });
    expect(document.querySelector('img')).toBeNull();
    expect(text('#hxp-headline')).toBe('<img src=x onerror=alert(1)>');
  });

  it('Unlink asks inside the page, Cancel keeps the link', async () => {
    const { src, confirmSpy } = await renderLinked();
    $('#hxp-unlink')!.click();
    expect($('#hxp-unlink-confirm-box')).not.toBeNull();
    expect(text('#hxp-unlink-confirm-box')).toContain("Unlink from MK? Neither of you will see the other's numbers.");
    $('#hxp-unlink-cancel')!.click();
    expect($('#hxp-unlink-confirm-box')).toBeNull();
    expect(src.unlink).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('confirmed Unlink ends the link and returns to the unlinked page', async () => {
    const { src, confirmSpy } = await renderLinked();
    $('#hxp-unlink')!.click();
    $('#hxp-unlink-confirm')!.click();
    await flush();
    expect(src.unlink).toHaveBeenCalledTimes(1);
    expect(text('#hxp-headline')).toBe('Not linked');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('a partner who has not synced yet', async () => {
    const src = mockSource({ link: { partnerId: 'user-b', createdAt: 't' }, invite: null, partner: null });
    renderHyroxPartnerView({ source: src });
    await flush();
    expect(text('#hxp-headline')).toBe('Linked');
    expect(document.body.textContent).toContain('No numbers from your partner yet. They appear when your partner next opens Mosaic with a Doubles race set.');
    expect(document.querySelectorAll('.hxp-station')).toHaveLength(0);
    expect($('#hxp-unlink')).not.toBeNull();
  });
});

describe('load errors', () => {
  it('offline: one line and Try again', async () => {
    const m: MockState = { link: null, invite: null, partner: null, linkError: 'offline' };
    const src = mockSource(m);
    renderHyroxPartnerView({ source: src });
    await flush();
    expect(text('#hxp-sub')).toBe(PARTNER_ERROR_COPY.offline);
    delete m.linkError;
    $('#hxp-retry')!.click();
    await flush();
    expect(src.getLink).toHaveBeenCalledTimes(2);
    expect(text('#hxp-headline')).toBe('Not linked');
  });
});

describe('Stats entry row', () => {
  it('label: empty until checked, Link when unlinked, initials when linked', () => {
    expect(partnerRowLabel(undefined)).toBe('');
    expect(partnerRowLabel({ linked: false })).toBe('Link');
    expect(partnerRowLabel({ linked: true, initials: 'MK' })).toBe('MK');
    expect(partnerRowLabel({ linked: true, initials: null })).toBe('Linked');
  });

  it('appears in doubles only', () => {
    setHyroxPartnerCache({ linked: true, initials: 'MK' });
    renderHyroxStatsView();
    expect(text('#hx-stats-partner-row')).toBe('Partner MK ›');
    seed({ format: 'open_singles', division: undefined });
    renderHyroxStatsView();
    expect($('#hx-stats-partner-row')).toBeNull();
  });

  it('the label follows a later cache change while Stats is on screen (foreground re-read)', () => {
    setHyroxPartnerCache({ linked: true, initials: 'MK' });
    renderHyroxStatsView();
    expect(text('#hx-stats-partner-value')).toBe('MK ›');
    setHyroxPartnerCache({ linked: false, inviteExpiresAt: null });
    expect(text('#hx-stats-partner-value')).toBe('Link ›');
  });
});
