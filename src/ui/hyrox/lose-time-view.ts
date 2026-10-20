/**
 * HYROX "Where you lost time": the Forecast tab card and its drill-down.
 *
 * The card sits directly above "Where to gain" so the two read as one story:
 * the past race (where the time went against athletes who finished in the
 * same time) and training (where time can come back; Where to gain also
 * names the station that lost the most). Numbers come from
 * analyzeHyroxLoseTime (hyrox-lose-time.ts). With no past result the card is
 * one line that opens the existing "Log a previous HYROX" paste modal; a
 * first-timer (no result, band total_beginner) gets no card.
 *
 * Pattern: the card shell is the Forecast tab's glass card ("Where to gain",
 * forecast-view.ts renderWhereToGainCard) without its capital label; the
 * drill-down is renderHyroxChipDetail's skeleton (forecast-chip-detail-view.ts).
 * Neutrals only.
 *
 * Side: tracking.
 */

import { getState } from '@/state/store';
import type { SimulatorState } from '@/types/state';
import { renderTabBar, wireTabBarHandlers, type TabId } from '@/ui/tab-bar';
import { atmosphereGradient, buildSunGlint, buildRingBackground } from '@/ui/page-flair';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { topWeakestLinks } from '@/calculations/hyrox-weakest-link';
import { analyzeHyroxLoseTime, hyroxLoseTimeKeyLeg, hyroxPeerNoun, type HyroxLoseTime, type HyroxLoseTimeSegment } from '@/calculations/hyrox-lose-time';
import { hyroxPlacementWho, hyroxResultsCaption } from '@/calculations/hyrox-results';
import { ftRounded } from '@/utils/format';

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const GLASS = 'background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)';
const CARD = 'background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:16px';
const LINK = 'font:inherit;font-size:12px;color:var(--c-muted);background:none;border:none;padding:0;cursor:pointer';

/** "+1:12" / "−0:20": seconds lost (plus) or gained (minus). */
export function fmtLostSigned(lostSec: number): string {
  const t = Math.round(Math.abs(lostSec));
  const body = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  return `${lostSec >= 0 ? '+' : '−'}${body}`;
}

/** The one-line invitation when there is nothing to compare yet. */
export function loseTimeInviteLine(lt: Pick<HyroxLoseTime, 'status' | 'totalSec'>): string {
  if (lt.status === 'no_splits' && lt.totalSec) {
    return `Add the splits from your ${ftRounded(lt.totalSec)} to compare each segment with athletes who finished in the same time.`;
  }
  return 'Paste a past result to compare each segment with athletes who finished in the same time.';
}

/**
 * The drill-down caption: "41:20 against 38:24", from the finish when
 * implied; Running adds the leg with the most lost (or gained), or how many
 * legs it covers.
 */
export function loseTimeSegmentCaption(seg: HyroxLoseTimeSegment): string {
  const scope = seg.partialLegs ? `${seg.partialLegs} of 8 runs: ` : '';
  let text = `${scope}${ftRounded(seg.athleteSec)} against ${ftRounded(seg.peerSec)}${seg.implied ? ', from your finish' : ''}`;
  const leg = hyroxLoseTimeKeyLeg(seg);
  if (leg) text += `. Most on Run ${leg.leg}, ${fmtLostSigned(leg.lostSec)}`;
  return text;
}

function segmentRow(seg: HyroxLoseTimeSegment, first: boolean, withCaption: boolean): string {
  const caption = withCaption
    ? `<span style="display:block;font-size:11px;color:var(--c-faint);margin-top:2px;font-variant-numeric:tabular-nums">${loseTimeSegmentCaption(seg)}</span>`
    : '';
  return `
    <div data-lt-seg="${seg.key}" style="display:flex;justify-content:space-between;align-items:${withCaption ? 'flex-start' : 'center'};gap:12px;padding:9px 0;border-top:${first ? 'none' : '1px solid rgba(0,0,0,0.05)'};font-size:13px">
      <span style="min-width:0;color:${TEXT_M}">${seg.label}${caption}</span>
      <span style="flex-shrink:0;color:${seg.lostSec >= 0 ? TEXT_M : 'var(--c-faint)'};font-variant-numeric:tabular-nums">${fmtLostSigned(seg.lostSec)}</span>
    </div>
  `;
}

/**
 * The Forecast tab card: the headline, then any other material losses (the
 * headline's segment is not repeated). Empty for a first-timer with no
 * result (band total_beginner): there is no past race to paste.
 */
export function buildLoseTimeCard(state: Pick<SimulatorState, 'hyroxConfig' | 'biologicalSex'>): string {
  if (!state.hyroxConfig) return '';
  const lt = analyzeHyroxLoseTime(state);
  if (lt.status === 'no_result' && state.hyroxConfig.athleteBand === 'total_beginner') return '';
  const title = `<div style="font-size:13px;font-weight:600;color:var(--c-black)">Where you lost time</div>`;
  if (lt.status !== 'ok') {
    return `
      <div id="hx-lose-time" data-lt-status="${lt.status}" style="${GLASS};padding:16px 20px;margin-bottom:14px">
        ${title}
        <button id="hx-lose-time-paste" type="button" style="${LINK};display:flex;width:100%;align-items:center;gap:12px;text-align:left;margin-top:4px;line-height:1.45">
          <span style="flex:1;min-width:0">${loseTimeInviteLine(lt)}</span>
          <span style="color:var(--c-faint);font-size:16px;line-height:1;flex-shrink:0">›</span>
        </button>
      </div>
    `;
  }
  const more = lt.losses.slice(1, 3);
  const rows = more.map((seg, i) => segmentRow(seg, i === 0, false)).join('');
  return `
    <div id="hx-lose-time" data-lt-status="ok" style="${GLASS};padding:16px 20px;margin-bottom:14px">
      ${title}
      <div data-lt-headline style="font-size:12px;color:var(--c-muted);line-height:1.45;margin:4px 0 ${rows ? 6 : 8}px">${lt.headline}.</div>
      ${rows}
      <div style="margin-top:${rows ? 8 : 0}px">
        <button id="hx-lose-time-all" type="button" style="${LINK}">All segments ›</button>
      </div>
    </div>
  `;
}

/** The drill-down body: time lost, time gained, provenance. */
export function renderLoseTimeBody(lt: HyroxLoseTime, hasWhereToGain: boolean): string {
  if (lt.status !== 'ok' || !lt.cohort || !lt.totalSec || !lt.format) {
    return `
      <div style="${CARD};margin-bottom:14px">
        <button id="lt-paste" type="button" style="${LINK};display:flex;width:100%;align-items:center;gap:12px;text-align:left;line-height:1.45">
          <span style="flex:1;min-width:0">${loseTimeInviteLine(lt)}</span>
          <span style="color:var(--c-faint);font-size:16px;line-height:1;flex-shrink:0">›</span>
        </button>
      </div>
    `;
  }
  const lost = lt.losses.map((seg, i) => segmentRow(seg, i === 0, true)).join('');
  const gained = lt.gains.map((seg, i) => segmentRow(seg, i === 0, true)).join('');
  const section = (heading: string, rows: string) => rows ? `
    <div style="${CARD};margin-bottom:14px">
      <div style="font-size:13px;font-weight:600;color:${TEXT_M};margin-bottom:4px">${heading}</div>
      ${rows}
    </div>
  ` : '';
  // Segments inside the materiality band: one muted line, so all compared
  // segments are accounted for.
  const levelLine = lt.level.length > 0
    ? `<div data-lt-level style="font-size:12px;color:${TEXT_S};line-height:1.5;margin:0 4px 14px">Level with your peers: ${lt.level.map(seg => seg.label).join(', ')}.</div>`
    : '';
  const divisionNote = lt.divisionAssumed ? ' Compared in your current division.' : '';
  return `
    ${section('Time lost', lost)}
    ${section('Time gained', gained)}
    ${levelLine}
    <div style="font-size:11px;color:var(--c-faint);line-height:1.5;margin:0 4px 14px">Median splits of ${hyroxPlacementWho({ cohort: lt.cohort, ageGroup: null })} who finished near your time.${divisionNote} ${hyroxResultsCaption(lt.cohort)} Venues differ, so a sled lane or run course can move a segment.</div>
    <div style="display:flex;justify-content:space-between;gap:12px;margin:0 4px">
      <button id="lt-update" type="button" style="${LINK}">Update result ›</button>
      ${hasWhereToGain ? `<button id="lt-gain" type="button" style="${LINK}">Where training can gain ›</button>` : ''}
    </div>
  `;
}

/** Subhead: "Your 1:24:31 against athletes who finished in the same time". */
export function loseTimeSubhead(lt: HyroxLoseTime): string {
  if (lt.status !== 'ok' || !lt.totalSec || !lt.format) return 'Against athletes who finished in the same time';
  return `Your ${ftRounded(lt.totalSec)} against ${hyroxPeerNoun(lt.format)} who finished in the same time`;
}

/** Scroll the Forecast tab to "Where to gain". */
export function scrollToWhereToGain(): void {
  document.getElementById('hx-where-to-gain')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hasWhereToGainFor(state: SimulatorState): boolean {
  return topWeakestLinks(predictHyroxRace(state), 2).length > 0;
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('@/ui/home-view').then(({ renderHomeView }) => renderHomeView());
  else if (tab === 'plan') import('@/ui/hyrox/plan-view').then(({ renderHyroxPlanView }) => renderHyroxPlanView());
  else if (tab === 'stats') import('@/ui/hyrox/stats-view').then(({ renderHyroxStatsView }) => renderHyroxStatsView());
  else if (tab === 'account') import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  else if (tab === 'forecast') import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
}

function openPasteModal(onSaved: () => void): void {
  import('./log-prev-time-modal').then(({ openHyroxLogPrevTimeModal }) => openHyroxLogPrevTimeModal(onSaved));
}

/** Render the drill-down into #app-root. */
export function renderHyroxLoseTimeView(): void {
  const root = document.getElementById('app-root');
  if (!root) return;
  const s = getState();
  const lt = analyzeHyroxLoseTime(s);
  const gainLink = hasWhereToGainFor(s);
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  root.innerHTML = `
    <div id="lt-view" class="safe-top-bleed" style="position:relative;min-height:100vh;background:${atmosphereGradient('sky')};font-family:var(--f);overflow-x:hidden">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxlt', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="lt-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          <button id="lt-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>
        <div style="text-align:center;padding:20px 20px 16px">
          <div style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1">Where you lost time</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">${loseTimeSubhead(lt)}</div>
        </div>
        <div style="padding:0 16px">
          ${renderLoseTimeBody(lt, gainLink)}
        </div>
      </div>
      ${renderTabBar('forecast')}
    </div>
  `;

  const toForecast = (then?: () => void) =>
    import('./forecast-view').then(({ renderHyroxForecastView }) => {
      renderHyroxForecastView();
      if (then) setTimeout(then, 50);
    });
  document.getElementById('lt-back-btn')?.addEventListener('click', () => { void toForecast(); });
  document.getElementById('lt-account-btn')?.addEventListener('click', () => {
    import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  });
  document.getElementById('lt-gain')?.addEventListener('click', () => { void toForecast(scrollToWhereToGain); });
  document.getElementById('lt-update')?.addEventListener('click', () => openPasteModal(() => renderHyroxLoseTimeView()));
  document.getElementById('lt-paste')?.addEventListener('click', () => openPasteModal(() => renderHyroxLoseTimeView()));
  wireTabBarHandlers(navigateTab);
}

/** Wire the Forecast tab card (called by renderHyroxForecastView). */
export function wireLoseTimeCard(onPasted: () => void): void {
  document.getElementById('hx-lose-time-paste')?.addEventListener('click', () => openPasteModal(onPasted));
  document.getElementById('hx-lose-time-all')?.addEventListener('click', () => renderHyroxLoseTimeView());
}
