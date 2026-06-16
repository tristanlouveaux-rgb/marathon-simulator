/**
 * Strength progress surface. A marquee card in Stats (PR count + strongest
 * trend) that drills into a full sub-page celebrating strength work:
 *   1. New bests this block (est-1RM PRs)
 *   2. Strength is making you faster (the forecast economy contribution, §BC)
 *   3. Lifts — per-lift est-1RM + trend, tapping into the lift-detail chart
 *   4. Consistency + total tonnage
 *
 * Pure builders + derivations; the page chrome (header, back, tab bar) and the
 * navigation/tap wiring live in stats-view.ts, which owns those shared helpers.
 * All data comes from `s.strengthLog` (per-lift est-1RM + PB-staircase history)
 * and completed gym `garminActuals` (loggedLifts) — no new state.
 *
 * Visual system: amber (#F59E0B) is the single strength accent; everything else
 * neutral. No tinted cards, no decorative icons, no gradients (UX_PATTERNS).
 */

import type { SimulatorState, RaceDistance } from '@/types';
import { calculateLiveForecast } from '@/calculations/predictions';
import { getPlanPrescribedMeanWeeklyKm } from '@/calculations/training-horizon';
import { isGymSessionActual } from '@/cross-training/activities';
import { STRENGTH_PR_THRESHOLD_KG } from '@/constants/strength-constants';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from './page-flair';
import { openStrengthLiftDetail } from './strength-lift-detail';
import { seedManualLift } from '@/guided/strength-log-persist';
import { estimate1RM } from '@/calculations/strength-progression';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';

const ACCENT = '#F59E0B';
/** How recent a PB must be to read as a "this block" PR / "trending up". */
const RECENT_WEEKS = 8;
const TRENDING_WEEKS = 6;

// ─── formatting helpers ──────────────────────────────────────────────────────

function esc(str: string): string {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtKg(kg: number): string {
  return `${Math.round(kg * 10) / 10}kg`;
}
function fmtTonnage(kg: number): string {
  if (kg >= 1000) return `${(Math.round(kg / 100) / 10).toLocaleString()} t`;
  return `${Math.round(kg).toLocaleString()} kg`;
}
function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const sc = Math.round(sec % 60);
  if (m > 0) return sc > 0 ? `${m} min ${sc} s` : `${m} min`;
  return `${sc} s`;
}
function fmtShortDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function daysAgo(iso?: string): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso + 'T12:00:00').getTime()) / 86400000;
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

const DIST_LABEL: Record<RaceDistance, string> = {
  '5k': '5K', '10k': '10K', 'half': 'half marathon', 'marathon': 'marathon',
};

// ─── derivations ─────────────────────────────────────────────────────────────

interface TrackedLift {
  key: string; displayName: string; est1rmKg: number;
  trendSinceFirst: number; firstDate?: string; trendingUp: boolean;
}

function trackedLifts(s: SimulatorState): TrackedLift[] {
  const lifts = Object.values(s.strengthLog?.lifts ?? {})
    .filter(e => e.est1rmKg != null && e.est1rmKg > 0);
  return lifts.map(e => {
    const hist = e.est1rmHistory ?? [];
    const first = hist[0];
    const latest = hist[hist.length - 1];
    const trendSinceFirst = first && latest ? latest.value - first.value : 0;
    const lastPbDate = latest?.date ?? e.est1rmUpdatedAt ?? e.lastDate;
    return {
      key: e.key,
      displayName: e.displayName,
      est1rmKg: e.est1rmKg!,
      trendSinceFirst,
      firstDate: first?.date,
      trendingUp: hist.length >= 2 && daysAgo(lastPbDate) <= TRENDING_WEEKS * 7,
    };
  }).sort((a, b) => b.est1rmKg - a.est1rmKg);
}

interface Pr { displayName: string; from: number; to: number; date: string }

function recentPrs(s: SimulatorState): Pr[] {
  const cutoff = s.planStartDate ?? isoDaysAgo(RECENT_WEEKS * 7);
  const prs: Pr[] = [];
  for (const e of Object.values(s.strengthLog?.lifts ?? {})) {
    const hist = e.est1rmHistory ?? [];
    if (hist.length < 2) continue;
    const latest = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    if (latest.date >= cutoff && latest.value - prev.value >= STRENGTH_PR_THRESHOLD_KG) {
      prs.push({ displayName: e.displayName, from: prev.value, to: latest.value, date: latest.date });
    }
  }
  return prs.sort((a, b) => b.date.localeCompare(a.date));
}

interface StrengthVolume { sessions: number; streakWeeks: number; tonnageKg: number }

function strengthVolume(s: SimulatorState): StrengthVolume {
  let sessions = 0;
  let tonnageKg = 0;
  const weekHas: boolean[] = [];
  (s.wks ?? []).forEach((wk, i) => {
    let has = false;
    for (const a of Object.values((wk as any).garminActuals ?? {}) as any[]) {
      // Session count uses the matcher's "gym" definition (weight training OR
      // HIIT / tagged-strength) so it agrees with how the plan counts gym work —
      // including watch-matched sessions never started in-app. Tonnage stays
      // weight-based below (a HIIT carries no loggedLifts → adds 0).
      if (!isGymSessionActual(a)) continue;
      sessions++; has = true;
      for (const lift of (a.loggedLifts ?? [])) {
        if (!lift.weightKg) continue;
        const reps = parseInt(String(lift.reps), 10) || 0;
        const sets = lift.sets ?? 1;
        tonnageKg += lift.weightKg * reps * sets;
      }
    }
    weekHas[i] = has;
  });
  let streakWeeks = 0;
  for (let i = Math.min((s.w ?? 1) - 1, weekHas.length - 1); i >= 0; i--) {
    if (weekHas[i]) streakWeeks++; else break;
  }
  return { sessions, streakWeeks, tonnageKg: Math.round(tonnageKg) };
}

/** Seconds the planned strength work is worth off the race forecast (§BC), or
 *  null when there's no targeted race / no strength / no usable forecast. Robust
 *  by construction: the two forecasts share every input bar the strength count,
 *  so the diff isolates the strength term even if the absolute forecast shifts. */
function strengthSecondsSaved(s: SimulatorState): number | null {
  // The strength→economy forecast contribution (§BC) is a RUNNING-race term.
  // In triathlon / cycling / HYROX the projected finish isn't a running race, so
  // this section is hidden there (the other sections are mode-agnostic).
  const mode = (s as any).eventType;
  if (mode === 'triathlon' || mode === 'hyrox' || (s as any).trainingMode === 'hyrox') return null;
  if (!s.gs || s.gs <= 0 || s.continuousMode || !s.rd || !(s.v && s.v > 0)) return null;
  const blended = s.blendedRaceTimeSec ?? s.initialBaseline ?? undefined;
  if (!blended || blended <= 0) return null;
  const weeksRemaining = Math.max(1, (s.tw ?? 16) - ((s.w ?? 1) - 1));
  const sessions = s.epw || s.rw || 4;
  const planMeanKm = getPlanPrescribedMeanWeeklyKm(sessions, s.rd) ?? s.wkm;
  const base = {
    currentVdot: s.v,
    targetDistance: s.rd,
    weeksRemaining,
    sessionsPerWeek: sessions,
    runnerType: s.typ as any,
    experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
    crossTrained: s.onboarding?.crossTrainedBackground === true,
    weeklyVolumeKm: planMeanKm ?? undefined,
    hmPbSeconds: s.pbs?.h || undefined,
    ltPaceSecPerKm: s.lt || undefined,
    adaptationRatio: s.adaptationRatio,
    blendedAnchorSec: blended,
  };
  const withStrength = calculateLiveForecast({ ...base, strengthSessionsPerWeek: s.gs }).forecastTime;
  const without = calculateLiveForecast({ ...base, strengthSessionsPerWeek: 0 }).forecastTime;
  const saved = without - withStrength;
  return saved > 5 ? saved : null;
}

export function hasStrengthData(s: SimulatorState): boolean {
  return trackedLifts(s).length > 0 || strengthVolume(s).sessions > 0;
}

// ─── card (Stats opening screen) ─────────────────────────────────────────────

/** Marquee card for the Stats opening screen. Shows for anyone who does OR plans
 *  strength (so it's discoverable before the first session); hidden only when
 *  strength is irrelevant to them — no logged sessions AND none in the plan. */
export function buildStrengthProgressCard(s: SimulatorState): string {
  const has = hasStrengthData(s);
  if (!has && !((s.gs ?? 0) > 0)) return '';
  const prs = recentPrs(s);
  const lifts = trackedLifts(s);
  const topTrend = lifts.find(l => l.trendingUp) ?? lifts[0];

  const headline = !has
    ? 'Track your strength progress'
    : prs.length
      ? `${prs.length} new ${prs.length === 1 ? 'best' : 'bests'} this block`
      : lifts.length
        ? `${lifts.length} ${lifts.length === 1 ? 'lift' : 'lifts'} tracked`
        : 'Strength logged';
  const sub = !has
    ? 'Log a session and your PRs build here'
    : topTrend
      ? `${esc(topTrend.displayName)} ${topTrend.trendingUp ? 'trending up' : 'holding'}`
      : 'Tap for your strength progress';

  return `
    <div id="stats-strength-card" class="m-card" style="padding:16px;cursor:pointer;margin-top:18px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div style="min-width:0">
          <div style="font-size:11px;font-weight:600;color:var(--c-faint);margin-bottom:4px">Strength</div>
          <div style="font-size:15px;font-weight:600;color:var(--c-black)">${headline}</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>
        </div>
        <span style="color:var(--c-faint);font-size:18px;flex-shrink:0">&rsaquo;</span>
      </div>
    </div>`;
}

// ─── detail page body (chrome added by stats-view) ───────────────────────────

function card(title: string, sub: string, content: string): string {
  return `
    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="margin-bottom:12px">
        <div style="font-size:12px;font-weight:600;color:var(--c-black)">${title}</div>
        ${sub ? `<div style="font-size:10px;color:var(--c-faint);margin-top:1px">${sub}</div>` : ''}
      </div>
      ${content}
    </div>`;
}

function prsSection(s: SimulatorState): string {
  const prs = recentPrs(s);
  if (!prs.length) return '';
  const rows = prs.map(p => `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--c-border)">
      <span style="font-size:13px;color:var(--c-black)">${esc(p.displayName)}</span>
      <span style="font-size:13px;color:var(--c-muted);font-variant-numeric:tabular-nums">${fmtKg(p.from)} &rarr; <strong style="color:${ACCENT};font-weight:600">${fmtKg(p.to)}</strong></span>
    </div>`).join('');
  return card('New bests this block', `${prs.length} estimated-1RM ${prs.length === 1 ? 'PR' : 'PRs'}`, rows);
}

function forecastLinkSection(s: SimulatorState): string {
  const saved = strengthSecondsSaved(s);
  if (saved == null) return '';
  const gs = s.gs ?? 0;
  const dist = DIST_LABEL[s.rd] ?? 'race';
  const body = `<p style="font-size:13px;color:var(--c-black);line-height:1.55;margin:0">Your ${gs} strength ${gs === 1 ? 'session' : 'sessions'} a week ${gs === 1 ? 'is' : 'are'} worth about <strong style="color:${ACCENT};font-weight:600">${fmtDuration(saved)}</strong> off your projected ${dist}. Resistance work raises running economy, so you hold pace at a lower cost.</p>`;
  return card('Strength is making you faster', 'Beattie &amp; Blagrove 2018', body);
}

function liftsSection(s: SimulatorState): string {
  const lifts = trackedLifts(s);
  if (!lifts.length) return '';
  const rows = lifts.map(l => {
    const deltaTxt = l.trendSinceFirst > 0 && l.firstDate
      ? `+${fmtKg(l.trendSinceFirst)} since ${fmtShortDate(l.firstDate)}`
      : '';
    const trendTxt = l.trendingUp ? 'trending up' : 'holding';
    const sub = deltaTxt ? `${trendTxt} &middot; ${deltaTxt}` : trendTxt;
    return `
      <div class="strength-lift-row" data-lift-key="${esc(l.key)}" data-lift-name="${esc(l.displayName)}"
           style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--c-border);cursor:pointer">
        <div style="min-width:0">
          <div style="font-size:13px;color:var(--c-black)">${esc(l.displayName)}</div>
          <div style="font-size:11px;color:var(--c-faint);margin-top:1px">${sub}</div>
        </div>
        <span style="font-size:14px;color:var(--c-black);font-variant-numeric:tabular-nums;flex-shrink:0">${fmtKg(l.est1rmKg)}<span style="color:var(--c-faint);margin-left:8px">&rsaquo;</span></span>
      </div>`;
  }).join('');
  return card('Lifts', 'Estimated 1RM &middot; tap for the trend', rows);
}

function consistencySection(s: SimulatorState): string {
  const { sessions, streakWeeks, tonnageKg } = strengthVolume(s);
  if (sessions === 0) return '';
  const cols = [
    { v: String(sessions), l: `session${sessions === 1 ? '' : 's'} logged` },
    streakWeeks >= 2 ? { v: String(streakWeeks), l: 'week streak' } : null,
    tonnageKg > 0 ? { v: fmtTonnage(tonnageKg), l: 'total moved' } : null,
  ].filter(Boolean) as Array<{ v: string; l: string }>;
  const colHtml = cols.map((c, i) => `
    <div style="flex:1;${i > 0 ? 'border-left:1px solid var(--c-border);padding-left:14px' : ''}">
      <div style="font-size:18px;font-weight:400;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${c.v}</div>
      <div style="font-size:11px;color:var(--c-faint);margin-top:2px">${c.l}</div>
    </div>`).join('');
  return card('Consistency', 'Logged strength work', `<div style="display:flex;gap:14px">${colHtml}</div>`);
}

/** Curated headline lifts offered in the manual-entry picker. Every key exists
 *  in `strength-exercise-key.ts` KEY_RULES, so a manual entry joins the same
 *  est-1RM trend a logged session would write. */
const MANUAL_LIFTS: Array<{ key: string; name: string }> = [
  { key: 'back-squat', name: 'Back Squat' },
  { key: 'front-squat', name: 'Front Squat' },
  { key: 'deadlift', name: 'Deadlift' },
  { key: 'rdl', name: 'Romanian Deadlift' },
  { key: 'hip-thrust', name: 'Hip Thrust' },
  { key: 'bench-press', name: 'Bench Press' },
  { key: 'overhead-press', name: 'Overhead Press' },
  { key: 'row', name: 'Barbell Row' },
  { key: 'lat-pulldown', name: 'Lat Pulldown' },
];

/** The picker's options: the curated headline lifts, plus any already-tracked
 *  lift not in that list (so the athlete can correct a goblet-squat, etc.). */
function manualLiftOptions(s: SimulatorState): Array<{ key: string; name: string }> {
  const out = [...MANUAL_LIFTS];
  const seen = new Set(out.map(o => o.key));
  for (const e of Object.values(s.strengthLog?.lifts ?? {})) {
    if (e.key && !seen.has(e.key)) { out.push({ key: e.key, name: e.displayName || e.key }); seen.add(e.key); }
  }
  return out;
}

/** Bordered "Add a lift" action row (transparent, no accent — an in-page action,
 *  not a form-submit CTA). Always shown so lifts can be seeded or corrected. */
function manualEntryButton(hasData: boolean): string {
  return `
    <button id="strength-add-lift" style="width:100%;padding:11px;border-radius:10px;background:transparent;border:1px solid var(--c-border);font-size:13px;font-weight:500;color:var(--c-black);cursor:pointer;font-family:var(--f);margin-bottom:10px">
      ${hasData ? 'Add or update a lift' : 'Add your lifts'}
    </button>`;
}

/** Inner sections of the drill-down page. stats-view wraps this with the header,
 *  page background, and tab bar, and wires the lift-row taps + add-lift button. */
export function buildStrengthProgressBody(s: SimulatorState): string {
  const sections = [
    prsSection(s),
    forecastLinkSection(s),
    liftsSection(s),
    consistencySection(s),
  ].filter(Boolean);
  if (!sections.length) {
    return `<div class="m-card" style="padding:20px;margin-bottom:10px;font-size:13px;color:var(--c-muted);line-height:1.55">Log a gym session and your strength progress builds here: personal bests, per-lift trends, and how your strength work is shaping your race time. Or enter your current numbers below.</div>${manualEntryButton(false)}`;
  }
  return sections.join('') + manualEntryButton(true);
}

/**
 * Modal: enter (or correct) a lift's 1RM on the Stats strength page. The athlete
 * supplies either a direct 1RM or a working weight x reps; we Epley-derive the
 * 1RM either way and live-preview it. Centered overlay (never a bottom sheet).
 * Calls `opts.onSaved()` after a successful save so the page re-renders.
 */
export function openManualLiftModal(s: SimulatorState, opts: { onSaved: () => void }): void {
  const options = manualLiftOptions(s);
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';

  let selectedKey = options[0]?.key ?? 'back-squat';
  let inputMode: '1rm' | 'reps' = 'reps';

  const segStyle = (active: boolean) =>
    `flex:1;padding:8px;border-radius:9px;border:1px solid ${active ? 'var(--c-black)' : 'var(--c-border)'};background:${active ? 'var(--c-black)' : '#fff'};color:${active ? 'var(--c-surface)' : 'var(--c-black)'};font-size:13px;cursor:pointer;font-family:var(--f)`;

  function readWeight(): number {
    const el = overlay.querySelector('#ml-weight') as HTMLInputElement | null;
    const v = el ? Number(el.value) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  function readReps(): number {
    if (inputMode === '1rm') return 1;
    const el = overlay.querySelector('#ml-reps') as HTMLInputElement | null;
    const v = el ? Number(el.value) : NaN;
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  }
  function refreshPreview(): void {
    const w = readWeight();
    const r = readReps();
    const node = overlay.querySelector('#ml-preview');
    const save = overlay.querySelector('#ml-save') as HTMLButtonElement | null;
    const valid = w > 0 && r > 0;
    // Match seedManualLift: a 1-rep entry is the 1RM (no Epley inflation).
    const est = valid ? Math.round((r === 1 ? w : estimate1RM(w, r)) * 10) / 10 : 0;
    if (node) {
      node.innerHTML = valid
        ? `Estimated 1RM <strong style="color:${ACCENT};font-weight:600">${fmtKg(est)}</strong>${inputMode === 'reps' ? ` from ${fmtKg(w)} x ${r}` : ''}`
        : 'Enter a weight to see the estimated 1RM.';
    }
    if (save) {
      save.disabled = !valid;
      save.style.background = valid ? 'var(--c-black)' : 'rgba(0,0,0,0.12)';
      save.style.color = valid ? 'var(--c-surface)' : 'var(--c-muted)';
      save.style.cursor = valid ? 'pointer' : 'default';
    }
  }

  function render(): void {
    const existing = s.strengthLog?.lifts?.[selectedKey];
    const prefillWeight = inputMode === '1rm'
      ? (existing?.est1rmKg ?? '')
      : (existing?.lastWeightKg ?? '');
    const prefillReps = inputMode === 'reps' ? (existing?.lastReps ?? '5') : '';
    overlay.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
        <div style="font-size:17px;font-weight:600;color:var(--c-black);margin-bottom:4px">Add a lift</div>
        <div style="font-size:12px;color:var(--c-muted);margin-bottom:16px;line-height:1.4">Enter a one-rep max, or a working weight and reps and we derive the 1RM. It seeds your trend and lets future workouts target a real load.</div>

        <label style="font-size:11px;color:var(--c-muted);display:block;margin-bottom:6px">Lift</label>
        <select id="ml-lift" style="width:100%;padding:10px;border:1px solid var(--c-border);border-radius:9px;background:#fff;color:var(--c-black);font-size:14px;font-family:var(--f);margin-bottom:14px">
          ${options.map(o => `<option value="${esc(o.key)}" ${o.key === selectedKey ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        </select>

        <div style="display:flex;gap:6px;margin-bottom:14px">
          <button id="ml-mode-reps" style="${segStyle(inputMode === 'reps')}">Weight &amp; reps</button>
          <button id="ml-mode-1rm" style="${segStyle(inputMode === '1rm')}">1RM</button>
        </div>

        <div style="display:flex;gap:10px;margin-bottom:14px">
          <div style="flex:1">
            <label style="font-size:11px;color:var(--c-muted);display:block;margin-bottom:4px">${inputMode === '1rm' ? 'One-rep max' : 'Weight'}</label>
            <div style="display:flex;align-items:center;gap:6px">
              <input id="ml-weight" type="number" inputmode="decimal" min="1" max="500" step="0.5" placeholder="—" value="${prefillWeight}" style="width:100%;padding:9px 10px;border:1px solid var(--c-border);border-radius:9px;background:#fff;color:var(--c-black);font-size:14px;font-variant-numeric:tabular-nums">
              <span style="font-size:13px;color:var(--c-muted)">kg</span>
            </div>
          </div>
          ${inputMode === 'reps' ? `
          <div style="width:84px">
            <label style="font-size:11px;color:var(--c-muted);display:block;margin-bottom:4px">Reps</label>
            <input id="ml-reps" type="number" inputmode="numeric" min="1" max="15" step="1" placeholder="5" value="${prefillReps}" style="width:100%;padding:9px 10px;border:1px solid var(--c-border);border-radius:9px;background:#fff;color:var(--c-black);font-size:14px;font-variant-numeric:tabular-nums">
          </div>` : ''}
        </div>

        <div id="ml-preview" style="font-size:12px;color:var(--c-muted);line-height:1.4;margin-bottom:16px"></div>

        <button id="ml-save" disabled style="width:100%;padding:12px;border-radius:12px;border:none;background:rgba(0,0,0,0.12);color:var(--c-muted);font-size:14px;font-weight:600;cursor:default;font-family:var(--f)">Save</button>
      </div>`;

    overlay.querySelector('#ml-lift')?.addEventListener('change', (e) => {
      selectedKey = (e.target as HTMLSelectElement).value;
      render();
    });
    overlay.querySelector('#ml-mode-reps')?.addEventListener('click', () => { inputMode = 'reps'; render(); });
    overlay.querySelector('#ml-mode-1rm')?.addEventListener('click', () => { inputMode = '1rm'; render(); });
    overlay.querySelector('#ml-weight')?.addEventListener('input', refreshPreview);
    overlay.querySelector('#ml-reps')?.addEventListener('input', refreshPreview);
    overlay.querySelector('#ml-save')?.addEventListener('click', () => {
      const w = readWeight();
      const r = readReps();
      if (!(w > 0) || !(r > 0)) return;
      const name = options.find(o => o.key === selectedKey)?.name ?? selectedKey;
      const ms = getMutableState();
      const ok = seedManualLift(ms, { key: selectedKey, displayName: name, weightKg: w, reps: r });
      if (ok) saveState();
      overlay.remove();
      opts.onSaved();
    });

    refreshPreview();
  }

  render();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ─── drill-down page (shared across modes) ───────────────────────────────────

function detailHeader(): string {
  return `
    <div style="padding:max(16px, env(safe-area-inset-top)) 18px 12px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--c-border)">
      <button id="strength-detail-back" style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;font-size:20px;color:var(--c-black);font-family:var(--f);flex-shrink:0;margin-left:-8px">&larr;</button>
      <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">Strength</div>
    </div>`;
}

export interface StrengthDetailOpts {
  /** Where the back button returns (the opener's stats view, per mode). */
  back: () => void;
  /** The mode's tab-bar navigation. */
  navigateTab: (tab: TabId) => void;
  /** Pre-rendered tab bar for this mode (running passes the simulator flag). */
  tabBar: string;
}

/** Render the full strength-progress drill-down. Mode-agnostic body + chrome;
 *  the caller supplies the back target + tab bar so the page returns to the
 *  correct (running / triathlon / HYROX) stats view. */
export function openStrengthProgressDetail(s: SimulatorState, opts: StrengthDetailOpts): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = `
    <div class="mosaic-page" style="background:${atmosphereGradient('mint')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('spd', { variant: 'centered', palette: 'mint', pulse: false })}
      </div>
      ${buildSunGlint('low')}
      <div style="position:relative;z-index:10">
        ${detailHeader()}
        <div style="max-width:600px;margin:0 auto;padding:12px 18px 100px">
          ${buildStrengthProgressBody(s)}
        </div>
      </div>
    </div>
    ${opts.tabBar}`;
  wireTabBarHandlers(opts.navigateTab);
  const back = document.getElementById('strength-detail-back');
  if (back) {
    back.addEventListener('click', opts.back);
    back.addEventListener('touchend', (e) => { e.preventDefault(); opts.back(); }, { passive: false });
  }
  container.querySelectorAll<HTMLElement>('.strength-lift-row').forEach(row => {
    const key = row.getAttribute('data-lift-key');
    const name = row.getAttribute('data-lift-name');
    if (!key || !name) return;
    const go = () => openStrengthLiftDetail(key, name);
    row.addEventListener('click', go);
    row.addEventListener('touchend', (e) => { e.preventDefault(); go(); }, { passive: false });
  });
  const addLift = document.getElementById('strength-add-lift');
  if (addLift) {
    const open = () => openManualLiftModal(getMutableState(), { onSaved: () => openStrengthProgressDetail(getMutableState(), opts) });
    addLift.addEventListener('click', open);
    addLift.addEventListener('touchend', (e) => { e.preventDefault(); open(); }, { passive: false });
  }
}
