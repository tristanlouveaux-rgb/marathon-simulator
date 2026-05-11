/**
 * Triathlon end-of-week debrief modal.
 *
 * 3-step flow mirroring running's week-debrief.ts:
 *   Step 1: Summary — week metrics + per-discipline breakdown
 *   Step 2: Analysis animation — ring + checklist (same timing as running)
 *   Step 3: Next week tri plan — stored triWorkouts with effort-multiplier
 *           notes; "Accept" records the debrief and navigates to plan view.
 *
 * Overlay is vertically centred (UX_PATTERNS → Overlays and Modals).
 */

import type { SimulatorState } from '@/types/state';
import type { Workout } from '@/types/state';
import { getState, getMutableState, saveState } from '@/state';
import { triEffortMultiplier } from '@/calculations/effort-multiplier.triathlon';
import { getRaceOutcomeRetro } from '@/calculations/tri-race-outcome';
import { computeTriAdaptationRatios } from '@/calculations/tri-adaptation-ratio';
import { classifyActivity } from '@/calculations/tri-benchmarks-from-history';
import { computeWeekRawTSS } from '@/calculations/fitness-model';
import { readTriFitness } from '@/calculations/fitness-model.triathlon';
import { isCyclingOnlyMode } from '@/calculations/cycling-mode';

const OVERLAY_ID = 'tri-week-debrief-modal';

// ─── Animation constants (mirrors running's week-debrief.ts) ─────────────────

const ANALYSIS_STEPS = [
  'Analysing swim, bike, and run data',
  'Checking power and pace adherence',
  'Reviewing heart rate signals',
  'Evaluating cross-discipline load',
  'Checking recovery and readiness',
  'Building next week',
];
const STEP_DELAY_MS = 500;
const RING_RADIUS = 56;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const TOTAL_ANIMATION_MS = ANALYSIS_STEPS.length * STEP_DELAY_MS + 600;

// ─── Public API ───────────────────────────────────────────────────────────────

export function fireTriDebriefIfReady(): void {
  const s = getState() as { w?: number; eventType?: string; lastDebriefWeek?: number };
  if (s.eventType !== 'triathlon') return;
  if (document.getElementById(OVERLAY_ID)) return;
  const completedWeek = (s.w ?? 1) - 1;
  if (completedWeek < 1) return;
  if ((s.lastDebriefWeek ?? 0) >= completedWeek) return;
  showTriWeekDebrief(completedWeek);
}

export function showTriWeekDebrief(weekNum: number): void {
  if (document.getElementById(OVERLAY_ID)) return;
  const state = getState();
  if (!state.triConfig) return;
  const wk = state.wks?.[weekNum - 1];
  if (!wk) return;

  const summary = buildWeekSummary(state, weekNum);
  document.body.insertAdjacentHTML('beforeend', renderStep1HTML(weekNum, summary, state));

  document.getElementById(OVERLAY_ID)?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === OVERLAY_ID) _closeAndRecord(weekNum);
  });
  _wireStep1Handlers(weekNum);
}

// ─── Data layer ────────────────────────────────────────────────────────────

interface DisciplineSummary {
  discipline: 'swim' | 'bike' | 'run';
  plannedSessions: number;
  completedSessions: number;
  totalHours: number;
  effortLabel: string;
  effortColor: string;
  effortMultiplier: number;
}

interface WeekMetrics {
  totalHours: number;
  actualTSS: number;
  plannedHours: number;
  combinedCtl: number;
}

interface WeekSummary {
  disciplines: DisciplineSummary[];
  metrics: WeekMetrics;
  raceOutcome: ReturnType<typeof getRaceOutcomeRetro>;
  adaptationShifts: Array<{ discipline: 'swim' | 'bike' | 'run'; ratio: number }>;
}

function parseDurationMin(w: Workout): number {
  const segs = (w as any).brickSegments as Array<{ durationMin?: number }> | undefined;
  if (segs) return segs.reduce((acc, s) => acc + (s.durationMin ?? 0), 0);
  const d = w.d ?? '';
  const hm = d.match(/(\d+)\s*h\s*(\d+)\s*min/i);
  if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  const ms = Array.from(d.matchAll(/(\d+)\s*min/g)) as RegExpMatchArray[];
  if (!ms.length) return 0;
  return ms.reduce((acc, m) => Math.max(acc, parseInt(m[1], 10)), 0);
}

function buildEffortSignal(
  discipline: 'swim' | 'bike' | 'run',
  actuals: Array<Record<string, unknown>>,
): { effortLabel: string; effortColor: string } {
  const scores = actuals.map(a => {
    if (discipline === 'bike') return (a.powerAdherence ?? a.hrEffortScore ?? null) as number | null;
    if (discipline === 'swim') return (a.paceAdherence ?? null) as number | null;
    return (a.hrEffortScore ?? null) as number | null;
  }).filter((x): x is number => x != null);

  if (!scores.length) return { effortLabel: 'No data', effortColor: '#94A3B8' };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (avg < 0.9) return { effortLabel: 'Easier than planned', effortColor: '#5a8050' };
  if (avg > 1.1) return { effortLabel: 'Harder than planned', effortColor: '#a89060' };
  return { effortLabel: 'On target', effortColor: '#0F172A' };
}

function buildWeekSummary(state: SimulatorState, weekNum: number): WeekSummary {
  const wk = state.wks?.[weekNum - 1];
  const allActuals = Object.values(wk?.garminActuals ?? {}) as unknown as Array<Record<string, unknown>>;

  const disciplineList = (isCyclingOnlyMode(state) ? ['bike'] : ['swim', 'bike', 'run']) as ('swim' | 'bike' | 'run')[];
  const disciplines: DisciplineSummary[] = disciplineList.map(d => {
    const planned = wk?.triWorkouts?.filter(w => (w.discipline ?? 'run') === d) ?? [];
    const plannedSessions = planned.length;

    const statusCount = planned.filter(w => w.status === 'completed').length;
    const disciplineActuals = allActuals.filter(a => classifyActivity(a.activityType as string) === d);
    const completedSessions = Math.min(
      plannedSessions,
      Math.max(statusCount, disciplineActuals.length),
    );

    const totalSec = disciplineActuals.reduce((acc, a) => acc + ((a.durationSec as number) ?? 0), 0);
    const totalHours = Math.round((totalSec / 3600) * 10) / 10;

    const { effortLabel, effortColor } = buildEffortSignal(d, disciplineActuals);
    const effortMultiplier = triEffortMultiplier(state, d);

    return { discipline: d, plannedSessions, completedSessions, totalHours, effortLabel, effortColor, effortMultiplier };
  });

  const totalSec = allActuals.reduce((acc, a) => acc + ((a.durationSec as number) ?? 0), 0);
  const totalHours = Math.round((totalSec / 3600) * 10) / 10;
  const actualTSS = Math.round(computeWeekRawTSS(
    wk as Parameters<typeof computeWeekRawTSS>[0],
    (wk?.rated ?? {}) as Record<string, number>,
    state.planStartDate,
  ));
  const plannedHours = Math.round(
    (wk?.triWorkouts ?? []).reduce((acc, w) => acc + parseDurationMin(w) / 60, 0) * 10,
  ) / 10;
  const combinedCtl = Math.round((readTriFitness(state).combinedCtl / 7) * 10) / 10;
  const metrics: WeekMetrics = { totalHours, actualTSS, plannedHours, combinedCtl };

  const raceOutcome = getRaceOutcomeRetro(state);

  const adapt = computeTriAdaptationRatios(state);
  const adaptationShifts = disciplineList
    .filter(d => Math.abs(adapt[d] - 1) >= 0.05)
    .map(d => ({ discipline: d, ratio: adapt[d] }));

  return { disciplines, metrics, raceOutcome, adaptationShifts };
}

// ─── Step 1 Render ────────────────────────────────────────────────────────────

const DISC_LABEL: Record<'swim' | 'bike' | 'run', string> = { swim: 'Swim', bike: 'Bike', run: 'Run' };

// These mirror running's week-debrief.ts constants exactly.
const ROW = 'display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--c-border)';
const LABEL_STYLE = 'font-size:14px;color:var(--c-muted);font-weight:500';
const VALUE_STYLE = 'font-size:15px;font-weight:700;letter-spacing:-0.02em';
const SIGNAL_VALUE = 'font-size:14px;font-weight:600;color:var(--c-black)';

const PHASE_NAMES: Record<string, string> = {
  base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper',
};

function renderStep1HTML(weekNum: number, summary: WeekSummary, state: SimulatorState): string {
  const { metrics } = summary;
  const wk = state.wks?.[weekNum - 1];
  const phase = wk?.ph ?? 'base';
  const phaseLabel = PHASE_NAMES[phase] ?? phase;

  // Hours vs plan delta (coloured arrow, same pattern as running's TSS arrow).
  const hoursPct = metrics.plannedHours > 0
    ? Math.round((metrics.totalHours / metrics.plannedHours) * 100) - 100
    : null;
  const hoursArrowColor = hoursPct == null ? 'var(--c-muted)'
    : Math.abs(hoursPct) > 20 ? 'var(--c-warn)'
    : Math.abs(hoursPct) > 10 ? 'var(--c-caution)'
    : 'var(--c-ok)';
  const hoursSuffix = hoursPct == null ? '' : `
    <span style="font-size:12px;font-weight:500;margin-left:4px">
      <span style="color:${hoursArrowColor}">${hoursPct > 0 ? '↑' : '↓'}</span>
      <span style="color:var(--c-muted)"> ${hoursPct > 0 ? '+' : ''}${hoursPct}% vs plan</span>
    </span>`;

  // Discipline rows rendered as signal-style rows inside the unified table.
  const disciplineRowsHtml = summary.disciplines.map((d, i) => {
    const isLast = i === summary.disciplines.length - 1;
    const pct = d.plannedSessions > 0
      ? Math.round((d.completedSessions / d.plannedSessions) * 100) : 0;
    const sessionsTxt = d.plannedSessions === 0
      ? 'No sessions planned'
      : `${d.completedSessions}/${d.plannedSessions} (${pct}%) · ${d.totalHours}h`;
    const arrowColor = d.effortLabel === 'On target' ? 'var(--c-ok)'
      : d.effortLabel === 'Harder than planned' ? 'var(--c-caution)'
      : d.effortLabel === 'No data' ? '' : 'var(--c-ok)';
    const arrow = arrowColor ? `<span style="color:${arrowColor};margin-right:4px">↑</span>` : '';
    return `
      <div style="${ROW}${isLast ? ';border-bottom:none' : ''}">
        <span style="${LABEL_STYLE}">
          ${DISC_LABEL[d.discipline]}
          <span style="font-size:12px;color:var(--c-muted);font-weight:400;margin-left:6px">${sessionsTxt}</span>
        </span>
        <span style="${SIGNAL_VALUE}">${arrow}${d.effortLabel}</span>
      </div>`;
  }).join('');

  const raceHtml = summary.raceOutcome.display ? `
    <div style="margin-top:16px;padding:14px;background:rgba(90,128,80,0.08);border-radius:10px;border:1px solid rgba(90,128,80,0.2)">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#5a8050;margin-bottom:4px">Race result</div>
      <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:4px">${summary.raceOutcome.headline ?? ''}</div>
      <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${summary.raceOutcome.body ?? ''}</div>
    </div>` : '';

  return `
    <div id="${OVERLAY_ID}"
      style="position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.45);
             display:flex;align-items:center;justify-content:center;padding:20px">
      <div id="debrief-card"
           style="width:100%;max-width:400px;background:var(--c-surface);border-radius:20px;
                  padding:24px 20px 20px;box-shadow:0 8px 40px rgba(0,0,0,0.18);
                  max-height:85vh;overflow-y:auto">

        <!-- Header — mirrors running's debrief header exactly -->
        <div style="position:relative;text-align:center;margin-bottom:18px">
          <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">
            ${phaseLabel} Phase — Week ${weekNum}
          </span>
          <button id="tri-debrief-cancel"
            style="position:absolute;right:0;top:50%;transform:translateY(-50%);
                   width:28px;height:28px;border-radius:50%;border:1px solid var(--c-border);
                   background:none;cursor:pointer;font-size:14px;color:var(--c-muted);
                   display:flex;align-items:center;justify-content:center">✕</button>
        </div>

        <!-- Unified metrics + discipline table -->
        <div style="border-top:1px solid var(--c-border)">
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Total training</span>
            <span style="${VALUE_STYLE}">${metrics.totalHours}h${hoursSuffix}</span>
          </div>
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Training load</span>
            <span style="${VALUE_STYLE}">${metrics.actualTSS}</span>
          </div>
          <div style="${ROW}">
            <span style="${LABEL_STYLE}">Tri fitness</span>
            <span style="${VALUE_STYLE}">${metrics.combinedCtl}</span>
          </div>
          ${disciplineRowsHtml}
        </div>

        ${raceHtml}

        <div style="margin-top:20px">
          <button id="tri-debrief-continue"
            style="width:100%;padding:14px;border-radius:12px;border:none;
                   background:var(--c-black);color:#fff;font-size:15px;font-weight:600;
                   cursor:pointer;font-family:var(--f);letter-spacing:-0.01em">View next week →</button>
        </div>
      </div>
    </div>
  `;
}

// ─── Step 1 Handlers ─────────────────────────────────────────────────────────

function _wireStep1Handlers(weekNum: number): void {
  document.getElementById('tri-debrief-cancel')?.addEventListener('click', () => {
    document.getElementById(OVERLAY_ID)?.remove();
  });
  document.getElementById('tri-debrief-continue')?.addEventListener('click', () => {
    _showAnalysisAnimation(weekNum);
  });
}

// ─── Step 2: Analysis animation ──────────────────────────────────────────────

function _showAnalysisAnimation(weekNum: number): void {
  const card = document.getElementById('debrief-card');
  if (!card) return;

  const stepsHtml = ANALYSIS_STEPS.map((label, i) => `
    <div id="tri-step-${i}"
         style="display:flex;align-items:center;gap:12px;padding:7px 0;
                opacity:0;transform:translateY(4px);transition:opacity 0.3s ease,transform 0.3s ease">
      <div id="tri-check-${i}"
           style="width:22px;height:22px;border-radius:50%;border:1.5px solid var(--c-border);background:transparent;
                  display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.25s ease">
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style="opacity:0;transition:opacity 0.15s ease">
          <path d="M1 4L3.5 6.5L9 1" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span style="font-size:14px;color:var(--c-black);font-weight:500">${label}</span>
    </div>
  `).join('');

  const ringSize = RING_RADIUS * 2 + 16;
  card.innerHTML = `
    <div style="position:relative;text-align:center;margin-bottom:24px">
      <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">Analysing week ${weekNum}</span>
      <button id="tri-debrief-cancel"
        style="position:absolute;right:0;top:50%;transform:translateY(-50%);width:28px;height:28px;
               border-radius:50%;border:1px solid var(--c-border);background:none;cursor:pointer;
               font-size:14px;color:var(--c-muted);display:flex;align-items:center;justify-content:center">✕</button>
    </div>
    <div style="display:flex;justify-content:center;margin-bottom:28px">
      <div style="position:relative;width:${ringSize}px;height:${ringSize}px">
        <svg width="${ringSize}" height="${ringSize}" viewBox="0 0 ${ringSize} ${ringSize}"
             style="transform:rotate(-90deg)">
          <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${RING_RADIUS}"
                  stroke="var(--c-border)" stroke-width="6" fill="none"/>
          <circle id="tri-ring" cx="${ringSize / 2}" cy="${ringSize / 2}" r="${RING_RADIUS}"
                  stroke="var(--c-black)" stroke-width="6" fill="none"
                  stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}"
                  stroke-linecap="round"
                  style="transition:stroke-dashoffset ${TOTAL_ANIMATION_MS}ms cubic-bezier(0.4,0,0.2,1)"/>
        </svg>
        <div id="tri-pct"
             style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
                    font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em">0%</div>
      </div>
    </div>
    <div style="padding:0 4px">${stepsHtml}</div>
  `;

  document.getElementById('tri-debrief-cancel')?.addEventListener('click', () => {
    document.getElementById(OVERLAY_ID)?.remove();
  });
  _runAnalysisAnimation(weekNum);
}

function _runAnalysisAnimation(weekNum: number): void {
  const ring = document.getElementById('tri-ring');
  const pctEl = document.getElementById('tri-pct');

  requestAnimationFrame(() => {
    ring?.setAttribute('stroke-dashoffset', '0');
  });

  const animStart = performance.now();
  const tick = () => {
    const elapsed = performance.now() - animStart;
    const pct = Math.min(100, Math.round((elapsed / TOTAL_ANIMATION_MS) * 100));
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (pct < 100) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  for (let i = 0; i < ANALYSIS_STEPS.length; i++) {
    setTimeout(() => {
      const el = document.getElementById(`tri-step-${i}`);
      if (el) { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }
    }, i * STEP_DELAY_MS);
    setTimeout(() => {
      const check = document.getElementById(`tri-check-${i}`);
      if (check) {
        check.style.borderColor = 'var(--c-black)';
        check.style.background = 'var(--c-black)';
        const svg = check.querySelector('svg');
        if (svg) (svg as unknown as HTMLElement).style.opacity = '1';
      }
    }, i * STEP_DELAY_MS + STEP_DELAY_MS * 0.7);
  }

  setTimeout(() => _showTriPlanPreview(weekNum), TOTAL_ANIMATION_MS + 200);
}

// ─── Step 3: Plan preview ─────────────────────────────────────────────────────

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DISC_BG: Record<'swim' | 'bike' | 'run', string> = {
  swim: 'rgba(59,130,246,0.12)',
  bike: 'rgba(249,115,22,0.12)',
  run:  'rgba(34,197,94,0.12)',
};
const DISC_TEXT_COLOR: Record<'swim' | 'bike' | 'run', string> = {
  swim: '#2563EB',
  bike: '#EA580C',
  run:  '#16A34A',
};
const PHASE_LABEL: Record<string, string> = {
  base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper',
};

function _showTriPlanPreview(weekNum: number): void {
  const card = document.getElementById('debrief-card');
  if (!card) return;
  const state = getState();

  // Next week is at index weekNum (0-based), since weekNum is 1-based completed week.
  const nextWk = state.wks?.[weekNum];
  const nextWorkouts = (nextWk?.triWorkouts ?? [])
    .slice()
    .sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0));
  const nextPhase = nextWk?.ph ?? state.wks?.[weekNum - 1]?.ph ?? 'base';

  // Effort-multiplier adjustment notes (≥3% shift from neutral).
  const adjustNotes: string[] = [];
  for (const d of ['swim', 'bike', 'run'] as const) {
    const m = triEffortMultiplier(state, d);
    if (Math.abs(m - 1) >= 0.03) {
      const pct = Math.round((m - 1) * 100);
      adjustNotes.push(
        `${DISC_LABEL[d]} sessions ${Math.abs(pct)}% ${pct > 0 ? 'longer' : 'shorter'} based on recent effort`,
      );
    }
  }

  // First-time calibration tier-up note. Surface once when tier advances.
  const calTier = state.triConfig?.calibration?.tier ?? 0;
  const notifiedTier = state.triConfig?.notifiedMarkers?.calibrationTier ?? 0;
  const tierUpNote = calTier > notifiedTier && calTier >= 1
    ? `Predictions now calibrated from ${state.triConfig!.calibration!.basedOnRaceCount} logged races.`
    : null;
  if (tierUpNote) adjustNotes.push(tierUpNote);

  const changesHtml = adjustNotes.length > 0 ? `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:#64748B;margin-bottom:6px;letter-spacing:0.02em">Adjustments</div>
      ${adjustNotes.map(n => `<div style="font-size:13px;color:#0F172A;line-height:1.5;padding:1px 0">${n}</div>`).join('')}
    </div>
  ` : `
    <div style="margin-bottom:16px">
      <p style="font-size:13px;color:#64748B;line-height:1.5;margin:0">
        No adjustments needed. Recent effort and load are tracking to plan.
      </p>
    </div>
  `;

  const workoutsHtml = nextWorkouts.length === 0
    ? '<p style="font-size:13px;color:#64748B;text-align:center;padding:16px 0">No sessions scheduled</p>'
    : nextWorkouts.map(w => {
        const d = (w.discipline ?? 'run') as 'swim' | 'bike' | 'run';
        const dayLabel = w.dayOfWeek != null ? DAY_SHORT[w.dayOfWeek] ?? '' : '';
        const dMin = parseDurationMin(w);
        const hrs = Math.floor(dMin / 60);
        const rem = dMin % 60;
        const durationTxt = dMin > 0
          ? hrs > 0 ? `${hrs}h${rem > 0 ? ` ${rem}m` : ''}` : `${dMin}m`
          : '';
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--c-border)">
            <span style="font-size:10px;font-weight:600;width:28px;color:var(--c-muted);flex-shrink:0">${dayLabel}</span>
            <span style="font-size:11px;font-weight:600;padding:3px 8px;border-radius:8px;
                         background:${DISC_BG[d]};color:${DISC_TEXT_COLOR[d]};
                         white-space:nowrap;min-width:40px;text-align:center">${DISC_LABEL[d]}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:600;color:var(--c-black);
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${w.n ?? ''}</div>
              ${w.d ? `<div style="font-size:12px;color:var(--c-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${w.d}</div>` : ''}
            </div>
            ${durationTxt ? `<span style="font-size:12px;color:var(--c-muted);flex-shrink:0">${durationTxt}</span>` : ''}
          </div>
        `;
      }).join('');

  card.innerHTML = `
    <div style="position:relative;text-align:center;margin-bottom:18px">
      <span style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">
        ${PHASE_LABEL[nextPhase] ?? nextPhase} — Week ${weekNum + 1}
      </span>
      <button id="tri-debrief-cancel"
        style="position:absolute;right:0;top:50%;transform:translateY(-50%);width:28px;height:28px;
               border-radius:50%;border:1px solid var(--c-border);background:none;cursor:pointer;
               font-size:14px;color:var(--c-muted);display:flex;align-items:center;justify-content:center">✕</button>
    </div>
    ${changesHtml}
    <div>${workoutsHtml}</div>
    <div style="margin-top:20px">
      <button id="tri-debrief-accept"
        style="width:100%;padding:14px;border-radius:12px;border:none;
               background:var(--c-black);color:#fff;font-size:15px;font-weight:600;
               cursor:pointer;font-family:var(--f);letter-spacing:-0.01em">Accept plan</button>
    </div>
  `;

  document.getElementById('tri-debrief-cancel')?.addEventListener('click', () => {
    document.getElementById(OVERLAY_ID)?.remove();
  });
  document.getElementById('tri-debrief-accept')?.addEventListener('click', () => {
    _closeAndRecord(weekNum);
  });
}

// ─── Close & record ──────────────────────────────────────────────────────────

function _closeAndRecord(weekNum: number): void {
  const ms = getMutableState() as { lastDebriefWeek?: number };
  ms.lastDebriefWeek = Math.max(ms.lastDebriefWeek ?? 0, weekNum);
  // Mark calibration tier as seen so the tier-up note doesn't re-appear.
  const tri = (ms as SimulatorState).triConfig;
  const calTier = tri?.calibration?.tier ?? 0;
  if (tri && calTier > (tri.notifiedMarkers?.calibrationTier ?? 0)) {
    tri.notifiedMarkers = { ...(tri.notifiedMarkers ?? {}), calibrationTier: calTier };
  }
  saveState();
  document.getElementById(OVERLAY_ID)?.remove();
  import('@/ui/triathlon/plan-view').then(({ renderTriathlonPlanView }) => renderTriathlonPlanView());
}

// ─── Dev helper ────────────────────────────────────────────────────────────
// In the browser console:
//   __showTriDebrief()     → show debrief for the last completed week
//   __showTriDebrief(1)    → show debrief for week 1 specifically
if (typeof window !== 'undefined') {
  (window as any).__showTriDebrief = (week?: number) => {
    const s = JSON.parse(localStorage.getItem('marathonSimulatorState') ?? 'null');
    const w = week ?? Math.max(1, ((s?.w ?? 2) - 1));
    document.getElementById(OVERLAY_ID)?.remove();
    showTriWeekDebrief(w);
  };
}
