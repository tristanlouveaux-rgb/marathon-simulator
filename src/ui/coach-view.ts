/**
 * Coach sub-page — rules-based coaching surface.
 * ==============================================
 * Opens from the Coach button on home-view / plan-view. Shows today's stance,
 * a single primary coaching sentence, a short "why" explanation, and stacked
 * signal cards (Recovery / Fitness / This week / Status).
 *
 * Rewritten from the previous brain-view on 2026-04-24:
 *   - No LLM fetch. The `primaryMessage` from daily-coach.ts is the hero copy.
 *     The edge-function scaffolding (supabase/functions/coach-narrative) stays
 *     in place as dormant future work; see docs/BRAIN.md for the deferral.
 *   - No accordion. Signal cards render inline, matching sleep-view.ts design
 *     language: stance-coloured sky header, cream body, stacked white cards.
 *
 * Visual rules (CLAUDE.md):
 *   - Max 2 non-neutral accents. Green only for 'push' stance. Red for active
 *     blockers. Amber for caution.
 *   - No tinted card backgrounds, no gradients, no decorative icons.
 *   - No emoji. No em dashes. No var(--c-accent) on nav links.
 */

import { getState } from '@/state';
import {
  computeDailyCoach,
  type CoachState,
  type CoachSignals,
  type CoachBlocker,
} from '@/calculations/daily-coach';
import { fmtSleepDebt } from '@/calculations/sleep-insights';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { openCheckinOverlay } from './checkin-overlay';
import { renderFeelingPromptHTML, wireFeelingPromptHandlers } from './feeling-prompt';
import { buildSkyBackground, skyAnimationCSS, type SkyPaletteName } from './sky-background';

// ─── Design tokens ────────────────────────────────────────────────────────────

const CREAM   = '#FAF9F6';
const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';
const BORDER  = '#F1F5F9';
const WARN    = '#DC2626';
const CAUTION = '#B45309';
const GREEN_D = '#16A34A';

const CARD_SHADOW = '0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)';

// Stance → readiness-page vocabulary (see docs/BRAIN.md stance vocabulary).
const STANCE_LABEL: Record<CoachState['stance'], string> = {
  push: 'Ready to Push',
  normal: 'On Track',
  reduce: 'Manage Load',
  rest: 'Ease Back',
};

// Stance → sky palette. One palette per stance so page colour signals state
// at a glance, mirroring how sleep-view.ts tints its ring by score.
const STANCE_PALETTE: Record<CoachState['stance'], SkyPaletteName> = {
  push: 'mint',
  normal: 'deepBlue',
  reduce: 'amber',
  rest: 'rose',
};

function stanceColor(stance: CoachState['stance']): string {
  if (stance === 'push') return GREEN_D;
  if (stance === 'normal') return TEXT_M;
  if (stance === 'reduce') return CAUTION;
  return WARN;
}

// ─── Small components ────────────────────────────────────────────────────────

function stancePill(stance: CoachState['stance']): string {
  const col = stanceColor(stance);
  return `
    <span style="
      display:inline-flex;align-items:center;padding:5px 12px;border-radius:100px;
      border:1px solid rgba(15,23,42,0.1);background:rgba(255,255,255,0.75);
      backdrop-filter:blur(8px);
      font-size:11px;font-weight:600;letter-spacing:0.04em;color:${col};
      text-transform:uppercase;
    ">${STANCE_LABEL[stance]}</span>
  `;
}

function pill(label: string, tone: 'neutral' | 'caution' | 'warn' | 'good'): string {
  const col = tone === 'warn' ? WARN
    : tone === 'caution' ? CAUTION
    : tone === 'good' ? GREEN_D
    : TEXT_M;
  return `<span style="
    display:inline-flex;align-items:center;padding:6px 12px;border-radius:100px;
    border:1px solid ${BORDER};background:white;
    font-size:12px;font-weight:500;color:${col};
  ">${label}</span>`;
}

function row(label: string, value: string, sub: string | null, valueColor: string = TEXT_M, isLast = false): string {
  return `
    <div style="
      display:flex;align-items:flex-start;padding:12px 0;
      ${isLast ? '' : `border-bottom:1px solid ${BORDER};`}
    ">
      <div style="flex:1;font-size:13px;color:${TEXT_S}">${label}</div>
      <div style="text-align:right">
        <div style="font-size:14px;font-weight:600;color:${valueColor};line-height:1.3">${value}</div>
        ${sub ? `<div style="font-size:11px;color:${TEXT_L};margin-top:2px">${sub}</div>` : ''}
      </div>
    </div>
  `;
}

function card(inner: string, delay: string): string {
  return `
    <div class="cv-fade" style="
      animation-delay:${delay};margin:0 16px 12px;padding:16px 18px;
      background:white;border-radius:16px;box-shadow:${CARD_SHADOW};
    ">${inner}</div>
  `;
}

function cardTitle(label: string): string {
  return `<div style="font-size:11px;color:${TEXT_L};margin-bottom:10px;letter-spacing:0.02em;text-transform:uppercase;font-weight:600">${label}</div>`;
}

// ─── Explanation: why this stance ─────────────────────────────────────────────

/**
 * Translate the blockers + key signals that drove the stance into short bullets.
 * This is the "why" under the primary message — scannable evidence for the call.
 */
function buildWhyBullets(coach: CoachState): string[] {
  const bullets: string[] = [];
  const sig = coach.signals;

  // Blockers first — each blocker maps to one explicit bullet.
  const b = new Set<CoachBlocker>(coach.blockers);
  if (b.has('injury')) {
    bullets.push(`Injury active${sig.injuryLocation ? ` (${sig.injuryLocation})` : ''}. Pause loaded running until cleared.`);
  }
  if (b.has('illness')) {
    const sev = sig.illnessSeverity ?? 'active';
    bullets.push(`Illness ${sev}. Training under illness raises recovery cost and prolongs the infection.`);
  }
  if (b.has('overload')) {
    const acwr = sig.acwr.toFixed(2);
    bullets.push(`Load safety: ACWR ${acwr} is above the safe upper bound. Injury risk rises sharply above 1.5.`);
  }
  if (b.has('sleep')) {
    if (sig.sleepLastNight != null && sig.sleepLastNight < 55) {
      bullets.push(`Sleep last night ${sig.sleepLastNight}/100. Hard sessions on poor sleep blunt adaptation.`);
    } else if (sig.sleepDebtSec != null && sig.sleepDebtSec > 5 * 3600) {
      bullets.push(`Sleep debt ${fmtSleepDebt(sig.sleepDebtSec)} this week. Accumulated deficit suppresses training response.`);
    } else {
      bullets.push('Sleep signals suggest incomplete recovery.');
    }
  }

  // HRV as a secondary signal — only call out when there's a measurable drop.
  if (sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0) {
    const pct = ((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline) * 100;
    if (pct < -15 && !b.has('sleep')) {
      bullets.push(`HRV ${Math.round(pct)}% below baseline. Autonomic stress elevated.`);
    }
  }

  // Positive framing when nothing is flagging — explain why "push" or "normal".
  if (bullets.length === 0) {
    if (coach.stance === 'push') {
      bullets.push(`Recovery good, load safe (ACWR ${sig.acwr.toFixed(2)}), TSB ${sig.tsb >= 0 ? 'positive' : 'neutral'}. Full session on.`);
    } else {
      bullets.push(`No red flags. Readiness ${sig.readinessScore}/100. Proceed as planned.`);
    }
  }

  return bullets;
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function heroSection(coach: CoachState): string {
  const col = stanceColor(coach.stance);
  const alertBadge = coach.blockers.length > 0
    ? `<div style="font-size:11px;font-weight:600;color:${WARN};letter-spacing:0.02em;margin-bottom:12px;text-transform:uppercase">
         ${coach.blockers.map(b => {
           if (b === 'injury') return 'Injury';
           if (b === 'illness') return 'Illness';
           if (b === 'overload') return 'Load risk';
           return 'Sleep';
         }).join(' · ')}
       </div>`
    : '';

  return `
    <div class="cv-fade" style="animation-delay:0.06s;padding:8px 20px 22px;text-align:center">
      ${alertBadge}
      <div style="margin-bottom:14px">${stancePill(coach.stance)}</div>
      <div style="
        font-size:22px;line-height:1.35;font-weight:500;color:${TEXT_M};
        letter-spacing:-0.01em;max-width:440px;margin:0 auto;
      ">${coach.primaryMessage}</div>
      <div style="font-size:12px;color:${TEXT_S};margin-top:10px">
        Readiness ${coach.readiness.score}/100 · <span style="color:${col};font-weight:600">${coach.readiness.label}</span>
      </div>
    </div>
  `;
}

function whySection(coach: CoachState): string {
  const bullets = buildWhyBullets(coach);
  if (bullets.length === 0) return '';
  const items = bullets.map(b => `
    <li style="
      display:flex;gap:10px;padding:10px 0;border-bottom:1px solid ${BORDER};
      font-size:13px;line-height:1.5;color:${TEXT_M};
    ">
      <span style="color:${TEXT_L};flex-shrink:0;margin-top:2px">·</span>
      <span>${b}</span>
    </li>
  `).join('');

  return card(`
    ${cardTitle("Why this call")}
    <ul style="list-style:none;padding:0;margin:0">${items}</ul>
  `, '0.14s');
}

function recoverySection(coach: CoachState): string {
  const sig = coach.signals;

  const sleepValue = sig.sleepLastNight != null ? String(sig.sleepLastNight) : '—';
  const sleepSub   = sig.sleepAvg7d != null ? `7-day avg ${sig.sleepAvg7d}` : null;
  const sleepColor = sig.sleepLastNight == null ? TEXT_L
    : sig.sleepLastNight < 45 ? WARN
    : sig.sleepLastNight < 60 ? CAUTION
    : TEXT_M;

  let hrvValue = '—';
  let hrvSub: string | null = null;
  let hrvColor = TEXT_L;
  if (sig.hrv != null) {
    hrvValue = `${sig.hrv} ms`;
    hrvColor = TEXT_M;
    if (sig.hrvBaseline != null && sig.hrvBaseline > 0) {
      const delta = sig.hrv - sig.hrvBaseline;
      const sign = delta >= 0 ? '+' : '-';
      hrvSub = `${sign}${Math.abs(delta)} ms vs baseline`;
      const pct = (delta / sig.hrvBaseline) * 100;
      if (pct < -20) hrvColor = WARN;
      else if (pct < -10) hrvColor = CAUTION;
    }
  }

  let bankValue: string;
  let bankSub: string | null = null;
  let bankColor = TEXT_M;
  if (sig.sleepDebtSec != null && sig.sleepDebtSec > 0) {
    bankValue = `−${fmtSleepDebt(sig.sleepDebtSec)}`;
    bankSub = 'sleep debt';
    bankColor = sig.sleepDebtSec > 5 * 3600 ? WARN : sig.sleepDebtSec > 3 * 3600 ? CAUTION : TEXT_M;
  } else if (sig.sleepDebtSec != null) {
    bankValue = 'On track';
    bankSub = null;
  } else {
    bankValue = '—';
    bankColor = TEXT_L;
  }

  return card(`
    ${cardTitle("Recovery")}
    ${row('Sleep last night', sleepValue, sleepSub, sleepColor)}
    ${row('HRV', hrvValue, hrvSub, hrvColor)}
    ${row('Sleep debt', bankValue, bankSub, bankColor, true)}
  `, '0.18s');
}

function fitnessSection(sig: CoachSignals): string {
  const ctlTrendLabel = sig.ctlTrend === 'up' ? 'trending up'
    : sig.ctlTrend === 'down' ? 'trending down'
    : 'steady';
  const ctlColor = sig.ctlTrend === 'down' ? CAUTION : TEXT_M;

  const weeklyTss = sig.weekTSS != null ? `${sig.weekTSS} TSS` : '—';
  const weeklyPct = (sig.weekTSS != null && sig.plannedTSS != null && sig.plannedTSS > 0)
    ? `${Math.round((sig.weekTSS / sig.plannedTSS) * 100)}% of plan`
    : null;

  const fitnessTrendLabel = sig.fitnessTrend === 'up' ? 'Improving'
    : sig.fitnessTrend === 'down' ? 'Declining'
    : sig.fitnessTrend === 'flat' ? 'Steady'
    : '—';
  const fitnessTrendColor = sig.fitnessTrend === 'down' ? CAUTION
    : sig.fitnessTrend == null ? TEXT_L
    : TEXT_M;

  return card(`
    ${cardTitle("Fitness")}
    ${row('Running fitness (CTL)', String(sig.ctlNow), ctlTrendLabel, ctlColor)}
    ${row('This week', weeklyTss, weeklyPct, TEXT_M)}
    ${row('4-week trend', fitnessTrendLabel, null, fitnessTrendColor, true)}
  `, '0.22s');
}

function thisWeekSection(sig: CoachSignals): string {
  // Track-only mode with no activities yet: show a prompt instead of "0% of plan."
  if (sig.trackOnlyEmptyWeek) {
    return card(`
      ${cardTitle("This week")}
      <div style="font-size:13px;color:${TEXT_S};line-height:1.5">No activities logged yet. Record or sync a workout to see this week's load analysis.</div>
    `, '0.26s');
  }

  let effortText: string;
  let effortTone: 'neutral' | 'caution' | 'warn' | 'good';
  if (sig.weekRPE === 'hard') { effortText = 'Effort: Harder than expected'; effortTone = 'warn'; }
  else if (sig.weekRPE === 'easy') { effortText = 'Effort: Easier than expected'; effortTone = 'neutral'; }
  else if (sig.weekRPE === 'on-target') { effortText = 'Effort: As expected'; effortTone = 'good'; }
  else { effortText = 'Effort: No rating yet'; effortTone = 'neutral'; }

  let loadText: string;
  let loadTone: 'neutral' | 'caution' | 'warn' | 'good';
  if (sig.weekTSS != null && sig.plannedTSS != null && sig.plannedTSS > 0) {
    const pct = Math.round((sig.weekTSS / sig.plannedTSS) * 100);
    loadText = `Load: ${pct}% of plan`;
    loadTone = pct > 130 ? 'warn' : pct > 110 ? 'caution' : pct < 75 ? 'caution' : 'good';
  } else {
    loadText = 'Load: No data';
    loadTone = 'neutral';
  }

  return card(`
    ${cardTitle("This week")}
    <div style="display:flex;flex-wrap:wrap;gap:6px">${pill(effortText, effortTone)}${pill(loadText, loadTone)}</div>
  `, '0.26s');
}

function statusSection(sig: CoachSignals): string {
  const injuryText = sig.injuryActive
    ? `Injury: active${sig.injuryLocation ? ` (${sig.injuryLocation})` : ''}`
    : 'Injury: none';
  const injuryPill = pill(injuryText, sig.injuryActive ? 'warn' : 'neutral');

  let illnessPill: string;
  if (sig.illnessActive) {
    const sev = sig.illnessSeverity ?? 'active';
    illnessPill = pill(`Illness: ${sev}`, sev === 'resting' ? 'warn' : 'caution');
  } else {
    illnessPill = pill('Illness: none', 'neutral');
  }

  return card(`
    ${cardTitle("Status")}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
      ${injuryPill}
      ${illnessPill}
    </div>
    <button id="coach-checkin-btn" class="m-btn-glass" style="width:100%">Check-in</button>
  `, '0.30s');
}

function extraNarratives(coach: CoachState): string {
  const parts: string[] = [];
  if (coach.sessionNote) {
    parts.push(card(`
      ${cardTitle("Today's session")}
      <div style="font-size:13px;color:${TEXT_M};line-height:1.55">${coach.sessionNote}</div>
    `, '0.34s'));
  }
  if (coach.sleepInsight) {
    parts.push(card(`
      ${cardTitle("Sleep pattern")}
      <div style="font-size:13px;color:${TEXT_M};line-height:1.55">${coach.sleepInsight}</div>
    `, '0.38s'));
  }
  return parts.join('');
}

function feelingSection(): string {
  return card(`
    ${cardTitle("How do you feel today?")}
    ${renderFeelingPromptHTML('brain')}
  `, '0.42s');
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./plan-view').then(m => m.renderPlanView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

let coachOnBack: (() => void) | null = null;

function wireCoachHandlers(): void {
  wireTabBarHandlers(navigateTab);

  document.getElementById('coach-back-btn')?.addEventListener('click', () => {
    if (coachOnBack) { coachOnBack(); return; }
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  document.getElementById('coach-checkin-btn')?.addEventListener('click', () => openCheckinOverlay());

  wireFeelingPromptHandlers(document, () => renderCoachView(coachOnBack ?? undefined));
}

// ─── HTML shell ───────────────────────────────────────────────────────────────

function getCoachHTML(coach: CoachState): string {
  const palette = STANCE_PALETTE[coach.stance];

  return `
    <style>
      #coach-view { box-sizing:border-box; }
      #coach-view *, #coach-view *::before, #coach-view *::after { box-sizing:inherit; }
      @keyframes coachFloatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .cv-fade { opacity:0; animation:coachFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('cv')}
    </style>

    <div id="coach-view" style="
      position:relative;min-height:100vh;background:${CREAM};
      font-family:var(--f);overflow-x:hidden;
    ">

      ${buildSkyBackground('cv', palette)}

      <div style="position:relative;z-index:10;padding-bottom:96px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
        ">
          <button id="coach-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="font-size:20px;font-weight:700;color:${TEXT_M}">Coach</div>
          <div style="width:36px"></div>
        </div>

        ${heroSection(coach)}
        ${whySection(coach)}
        ${recoverySection(coach)}
        ${fitnessSection(coach.signals)}
        ${thisWeekSection(coach.signals)}
        ${statusSection(coach.signals)}
        ${extraNarratives(coach)}
        ${feelingSection()}

      </div>
    </div>

    ${renderTabBar('home')}
  `;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function renderCoachView(onBack?: () => void): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  coachOnBack = onBack ?? coachOnBack;

  const coach = computeDailyCoach(getState());
  container.innerHTML = getCoachHTML(coach);
  wireCoachHandlers();
}
