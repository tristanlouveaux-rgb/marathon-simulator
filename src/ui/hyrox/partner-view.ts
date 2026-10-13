/**
 * HYROX Doubles partner page (drill-down from the Stats "Partner" row).
 *
 * Unlinked: create a code (shown large, copyable) or enter the partner's.
 * Linked: partner initials and update date, one row per station saying who
 * leads and by how much (hyrox-partner-compare.ts), the pair's run pace and
 * pair forecast, and Unlink with an in-page confirm.
 *
 * Scaffold mirrors critical-pace-detail-view.ts (atmosphere + whisper rings +
 * sun glint, back button, centred title, white cards, tab bar on Stats). The
 * data source is injectable so tests and the QA harness run with no network.
 * Everything that came from the partner's row is escaped before it reaches
 * innerHTML: it is another user's data.
 */

import { getState } from '@/state/store';
import { renderTabBar, wireTabBarHandlers, type TabId } from '@/ui/tab-bar';
import { atmosphereGradient, buildSunGlint, buildRingBackground } from '@/ui/page-flair';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { buildHyroxPartnerSnapshot, type HyroxPartnerSnapshot } from '@/calculations/hyrox-partner-snapshot';
import { hyroxDivisionLabel } from '@/calculations/hyrox-division';
import {
  compareHyroxPartners,
  type HyroxPartnerComparison,
  type PartnerNotComparableReason,
  type PartnerStationComparison,
} from '@/calculations/hyrox-partner-compare';
import type { HyroxLoadTier } from '@/types/triathlon';
import {
  formatHyroxPartnerCode,
  hyroxPartnerSource,
  type HyroxPartnerSource,
  type PartnerErrorCode,
  type PartnerInvite,
  type PartnerLink,
  type StoredPartnerSnapshot,
} from '@/data/hyroxPartner';
import { flushHyroxPartnerSnapshot, setHyroxPartnerCache } from '@/data/hyroxPartnerSync';
import { fpModel, ftRounded } from '@/utils/format';

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const TEXT_L = '#94A3B8';
const CARD = 'background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:16px 18px';
const ROW = 'display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid rgba(0,0,0,0.04)';

/** How often the code screen re-checks whether the partner has redeemed.
 *  Polling runs only while a code is on screen; elsewhere the app re-reads
 *  the link on foreground (refreshHyroxPartnerOnForeground). */
const LINK_POLL_MS = 5000;

export interface HyroxPartnerViewOptions {
  source?: HyroxPartnerSource;
  onBack?: () => void;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'load_error'; error: PartnerErrorCode }
  | { kind: 'unlinked'; invite: PartnerInvite | null; message: string | null; busy: boolean; copied: '' | 'copied' | 'selected' }
  | { kind: 'linked'; partner: StoredPartnerSnapshot | null; confirmUnlink: boolean; message: string | null; busy: boolean };

/** One-line messages, consultant tone, no em dashes. */
export const PARTNER_ERROR_COPY: Record<PartnerErrorCode, string> = {
  offline: 'Offline. Connect and try again.',
  no_session: 'Sign in to link a partner.',
  invalid_code: 'Check the code. It has 8 characters.',
  unavailable: 'This code has expired or been used. Check the 8 characters.',
  own_code: 'This is your own code. Your partner enters it on their phone.',
  already_linked: 'You already have a partner. Unlink first.',
  partner_linked: 'That athlete already has a partner.',
  unknown: 'Something went wrong. Try again.',
};

export const PARTNER_REASON_COPY: Record<PartnerNotComparableReason, string> = {
  missing_both: 'No benchmark from either of you',
  missing_you: 'No benchmark from you',
  missing_partner: 'No benchmark from your partner',
  team_time: 'Pair time from a doubles race',
  tier: 'Not at the race loads',
  tier_unknown: 'Load not known',
  setup: 'Race setups differ',
};

/** Rulebook names of the load tiers, as the setup screen words them. */
const TIER_NAME: Record<HyroxLoadTier, string> = { 'W-Open': 'Women Open', 'M-Open': 'Men Open', 'M-Pro': 'Men Pro' };

/** The Pair forecast caption when the forecast is withheld: what is missing,
 *  and from whom. */
export function withheldForecastText(cmp: Pick<HyroxPartnerComparison, 'forecastWithheld' | 'withheldFor' | 'pairTier'>): string {
  if (cmp.forecastWithheld === 'loads' && cmp.pairTier) {
    const from = cmp.withheldFor === 'you' ? 'you' : cmp.withheldFor === 'both' ? 'both of you' : 'your partner';
    return `Needs times at ${TIER_NAME[cmp.pairTier]} loads from ${from}.`;
  }
  if (cmp.forecastWithheld === 'loads_unknown') {
    const whose = cmp.withheldFor === 'you' ? 'you' : cmp.withheldFor === 'both' ? 'either of you' : 'your partner';
    return `Station loads not known for ${whose}.`;
  }
  return 'Needs matching race setups.';
}

/** The race a snapshot describes, for the setups-differ line. */
function setupLabel(snap: Pick<HyroxPartnerSnapshot, 'format' | 'division'>): string {
  return hyroxDivisionLabel(snap.format, undefined, snap.division ?? undefined) ?? 'an unknown division';
}

function esc(t: string): string {
  return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** "12 s" under a minute, "1:05" from a minute. */
export function fmtLead(sec: number): string {
  const s = Math.round(sec);
  return s < 60 ? `${s} s` : ftRounded(s);
}

export function stationStatusText(c: PartnerStationComparison): string {
  if (c.status === 'you') return `You lead by ${fmtLead(c.leadSec ?? 0)}`;
  if (c.status === 'partner') return `Partner leads by ${fmtLead(c.leadSec ?? 0)}`;
  if (c.status === 'level') return 'Level';
  return 'Not comparable';
}

function fmtUpdated(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return `Updated ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

function hoursLeft(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 3600000)) : 0;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
function stopPoll(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function renderHyroxPartnerView(opts: HyroxPartnerViewOptions = {}): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  if (!s.hyroxConfig) return;
  const source = opts.source ?? hyroxPartnerSource;
  stopPoll();

  const myInitials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      @keyframes hxpFloatUp { from { opacity:0; } to { opacity:1; } }
      .hxp-fade { opacity:0; animation:hxpFloatUp 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>
    <div id="hxp-view" class="safe-top-bleed" style="position:relative;min-height:100vh;background:${atmosphereGradient('sky')};font-family:var(--f);overflow-x:hidden">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxp', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">
        <div class="hxp-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="hxp-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          <button id="hxp-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${esc(myInitials) || 'Me'}</button>
        </div>
        <div id="hxp-hero" class="hxp-fade" style="animation-delay:0.06s;text-align:center;padding:20px 20px 16px"></div>
        <div id="hxp-body" class="hxp-fade" style="animation-delay:0.10s;padding:0 16px"></div>
      </div>
      ${renderTabBar('stats')}
    </div>
  `;

  document.getElementById('hxp-back-btn')?.addEventListener('click', () => {
    stopPoll();
    if (opts.onBack) { opts.onBack(); return; }
    import('./stats-view').then(({ renderHyroxStatsView }) => renderHyroxStatsView());
  });
  document.getElementById('hxp-account-btn')?.addEventListener('click', () => {
    stopPoll();
    import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  });
  wireTabBarHandlers((tab) => { stopPoll(); navigateTab(tab); });

  let vs: ViewState = { kind: 'loading' };
  const alive = () => !!document.getElementById('hxp-view');

  const paint = (next: ViewState) => {
    vs = next;
    if (!alive()) { stopPoll(); return; }
    const hero = document.getElementById('hxp-hero')!;
    const body = document.getElementById('hxp-body')!;
    hero.innerHTML = renderHero(vs);
    body.innerHTML = renderBody(vs);
    wire();
    managePoll();
  };

  // The session cache records an open code's expiry, so the foreground hook
  // knows to re-read the link while the code is out.
  const loadUnlinked = async (message: string | null = null) => {
    const inv = await source.getOpenInvite();
    const invite = inv.ok ? inv.value : null;
    setHyroxPartnerCache({ linked: false, inviteExpiresAt: invite?.expiresAt ?? null });
    paint({ kind: 'unlinked', invite, message, busy: false, copied: '' });
  };

  const loadLinked = async (link?: PartnerLink) => {
    void flushHyroxPartnerSnapshot({ source, force: true });
    const p = await source.getPartnerSnapshot();
    if (!p.ok) { paint({ kind: 'load_error', error: p.error }); return; }
    setHyroxPartnerCache({ linked: true, since: link?.createdAt ?? null, initials: p.value?.snapshot.initials ?? null });
    paint({ kind: 'linked', partner: p.value, confirmUnlink: false, message: null, busy: false });
  };

  const load = async () => {
    paint({ kind: 'loading' });
    const link = await source.getLink();
    if (!link.ok) { paint({ kind: 'load_error', error: link.error }); return; }
    if (link.value) await loadLinked(link.value);
    else await loadUnlinked();
  };

  const managePoll = () => {
    const waiting = vs.kind === 'unlinked' && !!vs.invite;
    if (!waiting) { stopPoll(); return; }
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!alive() || vs.kind !== 'unlinked' || !vs.invite) { stopPoll(); return; }
      const link = await source.getLink();
      if (link.ok && link.value && alive() && vs.kind === 'unlinked') {
        stopPoll();
        await loadLinked(link.value);
      }
    }, LINK_POLL_MS);
  };

  const wire = () => {
    document.getElementById('hxp-retry')?.addEventListener('click', () => { void load(); });

    document.getElementById('hxp-create')?.addEventListener('click', async () => {
      if (vs.kind !== 'unlinked' || vs.busy) return;
      paint({ ...vs, busy: true, message: null });
      const r = await source.createInvite();
      if (vs.kind !== 'unlinked') return;
      if (r.ok) setHyroxPartnerCache({ linked: false, inviteExpiresAt: r.value.expiresAt });
      paint(r.ok
        ? { ...vs, invite: r.value, busy: false, copied: '' }
        : { ...vs, busy: false, message: PARTNER_ERROR_COPY[r.error] });
    });

    document.getElementById('hxp-copy')?.addEventListener('click', async () => {
      if (vs.kind !== 'unlinked' || !vs.invite) return;
      const text = formatHyroxPartnerCode(vs.invite.code);
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
      } catch { copied = false; }
      paint({ ...vs, copied: copied ? 'copied' : 'selected' });
      // After the repaint, so the selection lands on the rendered code.
      if (!copied) selectCodeText();
    });

    const input = document.getElementById('hxp-code-input') as HTMLInputElement | null;
    const redeem = async () => {
      if (vs.kind !== 'unlinked' || vs.busy || !input) return;
      const value = input.value;
      paint({ ...vs, busy: true, message: null });
      const r = await source.redeemInvite(value);
      if (vs.kind !== 'unlinked') return;
      if (r.ok) {
        setHyroxPartnerCache({ linked: true });
        await loadLinked();
      } else {
        paint({ ...vs, busy: false, message: PARTNER_ERROR_COPY[r.error] });
        const again = document.getElementById('hxp-code-input') as HTMLInputElement | null;
        if (again) again.value = value;
      }
    };
    document.getElementById('hxp-redeem')?.addEventListener('click', () => { void redeem(); });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') void redeem(); });

    document.getElementById('hxp-unlink')?.addEventListener('click', () => {
      if (vs.kind !== 'linked') return;
      paint({ ...vs, confirmUnlink: true, message: null });
    });
    document.getElementById('hxp-unlink-cancel')?.addEventListener('click', () => {
      if (vs.kind !== 'linked') return;
      paint({ ...vs, confirmUnlink: false });
    });
    document.getElementById('hxp-unlink-confirm')?.addEventListener('click', async () => {
      if (vs.kind !== 'linked' || vs.busy) return;
      paint({ ...vs, busy: true });
      const r = await source.unlink();
      if (vs.kind !== 'linked') return;
      if (r.ok) {
        await loadUnlinked();
      } else {
        paint({ ...vs, busy: false, message: PARTNER_ERROR_COPY[r.error] });
      }
    });
  };

  void load();
}

/** Select the code text so the user can copy it from the system menu (the
 *  clipboard API is unavailable or refused). */
function selectCodeText(): void {
  const el = document.getElementById('hxp-code');
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!el || !sel || typeof document.createRange !== 'function') return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderHero(vs: ViewState): string {
  let headline = 'Partner';
  let sub = '';
  if (vs.kind === 'unlinked') {
    headline = 'Not linked';
    sub = 'Link by code to compare stations.';
  } else if (vs.kind === 'linked') {
    headline = esc(vs.partner?.snapshot.initials ?? 'Linked');
    sub = vs.partner ? esc(fmtUpdated(vs.partner.updatedAt)) : '';
  } else if (vs.kind === 'load_error') {
    sub = PARTNER_ERROR_COPY[vs.error];
  }
  return `
    <div style="font-size:11px;color:${TEXT_S};font-weight:500">Doubles partner</div>
    <div id="hxp-headline" style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1;margin-top:6px">${headline}</div>
    ${sub ? `<div id="hxp-sub" style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">${sub}</div>` : ''}`;
}

function messageLine(message: string | null): string {
  return message
    ? `<div id="hxp-msg" role="alert" style="font-size:12px;color:var(--c-warn);margin-top:10px">${esc(message)}</div>`
    : '';
}

function renderBody(vs: ViewState): string {
  if (vs.kind === 'loading') return '';
  if (vs.kind === 'load_error') {
    return `<div style="text-align:center"><button id="hxp-retry" class="m-btn-secondary">Try again</button></div>`;
  }
  if (vs.kind === 'unlinked') return renderUnlinked(vs);
  return renderLinked(vs);
}

function renderUnlinked(vs: Extract<ViewState, { kind: 'unlinked' }>): string {
  const codeRow = vs.invite
    ? `
      <div style="padding:2px 0 12px">
        <div style="font-size:13px;font-weight:600;color:${TEXT_M}">Your code</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px">
          <div id="hxp-code" style="font-size:28px;font-weight:600;color:${TEXT_M};font-variant-numeric:tabular-nums;letter-spacing:0.02em;user-select:all;-webkit-user-select:all">${esc(formatHyroxPartnerCode(vs.invite.code))}</div>
          <button id="hxp-copy" class="m-btn-secondary">${vs.copied === 'copied' ? 'Copied' : vs.copied === 'selected' ? 'Selected' : 'Copy'}</button>
        </div>
        <div style="font-size:11px;color:${TEXT_S};margin-top:4px">Single use. Expires in ${hoursLeft(vs.invite.expiresAt)} h.</div>
      </div>`
    : `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:2px 0 12px">
        <div>
          <div style="font-size:13px;font-weight:600;color:${TEXT_M}">Your code</div>
          <div style="font-size:11px;color:${TEXT_S};margin-top:2px">Your partner enters it on their phone.</div>
        </div>
        <button id="hxp-create" class="m-btn-secondary" ${vs.busy ? 'disabled style="opacity:0.55"' : ''}>Create code</button>
      </div>`;
  return `
    <div style="${CARD}">
      ${codeRow}
      <div style="border-top:1px solid rgba(0,0,0,0.04);padding-top:12px">
        <label for="hxp-code-input" style="display:block;font-size:13px;font-weight:600;color:${TEXT_M};margin-bottom:8px">Partner's code</label>
        <div style="display:flex;gap:10px;align-items:center">
          <input id="hxp-code-input" class="m-input" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="12" placeholder="ABCD-EFGH" style="flex:1;min-width:0;font-variant-numeric:tabular-nums">
          <button id="hxp-redeem" class="m-btn-primary" ${vs.busy ? 'disabled style="opacity:0.55"' : ''}>Link</button>
        </div>
        ${messageLine(vs.message)}
      </div>
    </div>`;
}

function renderLinked(vs: Extract<ViewState, { kind: 'linked' }>): string {
  const s = getState();
  const unitPref = s.unitPref ?? 'km';
  const mine = buildHyroxPartnerSnapshot(s);
  const partner = vs.partner?.snapshot ?? null;

  let stationsCard: string;
  let pairCard = '';
  if (!partner || !mine) {
    stationsCard = `
      <div style="${CARD}">
        <div style="font-size:13px;color:${TEXT_S};line-height:1.5">${partner
          ? 'Your numbers are not ready yet.'
          : 'No numbers from your partner yet. They appear when your partner next opens Mosaic with a Doubles race set.'}</div>
      </div>`;
  } else {
    const cmp = compareHyroxPartners(mine, partner);
    const setupsDiffer = cmp.pairTier == null
      ? `<div id="hxp-setups" style="font-size:11px;color:${TEXT_S};margin-bottom:4px;line-height:1.4">Setups differ: you race ${esc(setupLabel(mine))}, your partner ${esc(setupLabel(partner))}.</div>`
      : '';
    stationsCard = `
      <div style="${CARD}">
        <div style="font-size:13px;color:${TEXT_S};font-weight:500;margin-bottom:2px">Stations</div>
        ${setupsDiffer}
        ${cmp.stations.map(c => `
          <div class="hxp-station" data-station="${c.station}" style="${ROW}">
            <div>
              <div style="font-size:13px;font-weight:600;color:${TEXT_M}">${STATION_DISPLAY[c.station].name}</div>
              ${c.reason ? `<div style="font-size:11px;color:${TEXT_S};margin-top:1px">${PARTNER_REASON_COPY[c.reason]}</div>` : ''}
            </div>
            <div style="font-size:13px;color:${c.status === 'not_comparable' ? TEXT_L : TEXT_M};font-variant-numeric:tabular-nums;text-align:right;flex-shrink:0">${stationStatusText(c)}</div>
          </div>`).join('')}
      </div>`;
    // Solo pace (singles terms): the slower partner's own HYROX pace. It can
    // differ from the Stats HYROX pace, which carries the doubles run ratio.
    const runCaption = cmp.run.setBy === 'partner' ? "Your partner's solo pace, the slower of the two"
      : cmp.run.setBy === 'you' ? 'Your solo pace, the slower of the two'
      : 'Solo pace, the same for both';
    const venueNote = s.hyroxConfig?.venueId ? ' Before course factors.' : '';
    pairCard = `
      <div style="${CARD};margin-top:14px">
        <div id="hxp-run" style="${ROW};border-top:none;padding-top:2px">
          <div>
            <div style="font-size:13px;font-weight:600;color:${TEXT_M}">Run pace</div>
            <div style="font-size:11px;color:${TEXT_S};margin-top:1px">${runCaption}</div>
          </div>
          <div style="font-size:13px;color:${TEXT_M};font-variant-numeric:tabular-nums">${fpModel(cmp.run.paceSecKm, unitPref)}</div>
        </div>
        <div id="hxp-forecast" style="${ROW}">
          <div>
            <div style="font-size:13px;font-weight:600;color:${TEXT_M}">Pair forecast</div>
            <div style="font-size:11px;color:${TEXT_S};margin-top:1px">${cmp.forecast
              ? `Equal split of every station.${venueNote}`
              : withheldForecastText(cmp)}</div>
          </div>
          <div style="font-size:13px;color:${cmp.forecast ? TEXT_M : TEXT_L};font-variant-numeric:tabular-nums;text-align:right;flex-shrink:0">${cmp.forecast ? ftRounded(cmp.forecast.totalSec) : 'Not available'}</div>
        </div>
      </div>`;
  }

  const name = esc(partner?.initials ?? 'your partner');
  const unlinkBlock = vs.confirmUnlink
    ? `
      <div id="hxp-unlink-confirm-box" style="${CARD};margin-top:14px">
        <div style="font-size:13px;color:${TEXT_M};line-height:1.5">Unlink from ${name}? Neither of you will see the other's numbers.</div>
        <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:12px">
          <button id="hxp-unlink-cancel" style="padding:9px 14px;border:none;background:none;font-size:13px;color:${TEXT_S};cursor:pointer;font-family:var(--f)">Cancel</button>
          <button id="hxp-unlink-confirm" class="m-btn-danger" ${vs.busy ? 'disabled style="opacity:0.55"' : ''}>Unlink</button>
        </div>
        ${messageLine(vs.message)}
      </div>`
    : `
      <div style="text-align:center;margin-top:18px">
        <button id="hxp-unlink" style="background:none;border:none;font-size:13px;color:${TEXT_S};cursor:pointer;font-family:var(--f);padding:6px 10px">Unlink</button>
        ${messageLine(vs.message)}
      </div>`;

  return `${stationsCard}${pairCard}${unlinkBlock}`;
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('@/ui/home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('@/ui/hyrox/plan-view').then(m => m.renderHyroxPlanView());
  else if (tab === 'stats') import('@/ui/hyrox/stats-view').then(m => m.renderHyroxStatsView());
  else if (tab === 'forecast') import('@/ui/hyrox/forecast-view').then(m => m.renderHyroxForecastView());
  else if (tab === 'account') import('@/ui/account-view').then(m => m.renderAccountView());
}
