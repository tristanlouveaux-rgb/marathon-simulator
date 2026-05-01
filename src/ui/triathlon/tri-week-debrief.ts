/**
 * Triathlon end-of-week debrief modal.
 *
 * Mirrors running's `week-debrief.ts` shape but with per-discipline data and
 * tri-specific adaptation summary. Fires from the same `fireDebriefIfReady`
 * path on launch when the calendar week has rolled.
 *
 * Surfaces (per CLAUDE.md → Adaptation transparency):
 *   1. Per-discipline summary — sessions completed, hours, RPE-vs-expected
 *   2. Plan adjustments for NEXT week — effort-multiplier scaling per discipline
 *   3. Adaptation ratio shifts (if crossed ±5%)
 *   4. Race outcome retro (if a target race fell within the week, positive only)
 *
 * Centered overlay (UX_PATTERNS.md → Overlays and Modals). Single "Continue"
 * action; backdrop click also dismisses. Follows the mirror rule with running's
 * shape so adaptations to one apply to both.
 */

import type { SimulatorState } from '@/types/state';
import { getState, getMutableState, saveState } from '@/state';
import { triEffortMultiplier, triTrailingEffortScore } from '@/calculations/effort-multiplier.triathlon';
import { getRaceOutcomeRetro } from '@/calculations/tri-race-outcome';
import { computeTriAdaptationRatios } from '@/calculations/tri-adaptation-ratio';
import { classifyActivity } from '@/calculations/tri-benchmarks-from-history';

const OVERLAY_ID = 'tri-week-debrief-modal';

/**
 * Fires the tri-week-debrief if the calendar week has rolled and we haven't
 * shown it yet. Mirror of running's `shouldAutoDebrief` + `showWeekDebrief`
 * dispatch — same `lastDebriefWeek` guard so we don't double-fire.
 */
export function fireTriDebriefIfReady(): void {
  const s = getState() as { w?: number; eventType?: string; lastDebriefWeek?: number };
  if (s.eventType !== 'triathlon') return;
  if (document.getElementById(OVERLAY_ID)) return;
  const completedWeek = (s.w ?? 1) - 1;
  if (completedWeek < 1) return;
  if ((s.lastDebriefWeek ?? 0) >= completedWeek) return;
  showTriWeekDebrief(completedWeek);
}

/** Manually show the debrief for a specific week (used in admin / debug). */
export function showTriWeekDebrief(weekNum: number): void {
  if (document.getElementById(OVERLAY_ID)) return;
  const state = getState();
  const tri = state.triConfig;
  if (!tri) return;
  const wk = state.wks?.[weekNum - 1];
  if (!wk) return;

  const summary = buildWeekSummary(state, weekNum);
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-[1000] flex items-center justify-center p-4';
  overlay.style.background = 'rgba(15,23,42,0.55)';
  overlay.innerHTML = renderHTML(weekNum, summary);
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    // Mark this week as debriefed so we don't show it again on next launch.
    const ms = getMutableState() as { lastDebriefWeek?: number };
    ms.lastDebriefWeek = Math.max(ms.lastDebriefWeek ?? 0, weekNum);
    saveState();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.getElementById('tri-debrief-continue')?.addEventListener('click', close);
}

// ─── Data layer ────────────────────────────────────────────────────────────

interface DisciplineSummary {
  discipline: 'swim' | 'bike' | 'run';
  plannedSessions: number;
  completedSessions: number;
  totalHours: number;
  rpeDelta: number | null;        // mean(actual - expected); negative = easier than planned
  effortMultiplier: number;        // applied to next week's durations
}

interface WeekSummary {
  disciplines: DisciplineSummary[];
  raceOutcome: ReturnType<typeof getRaceOutcomeRetro>;
  adaptationShifts: Array<{ discipline: 'swim' | 'bike' | 'run'; ratio: number }>;
}

function buildWeekSummary(state: SimulatorState, weekNum: number): WeekSummary {
  const wk = state.wks?.[weekNum - 1];
  const disciplines: DisciplineSummary[] = (['swim', 'bike', 'run'] as const).map(d => {
    const planned = wk?.triWorkouts?.filter(w => (w.discipline ?? 'run') === d) ?? [];
    const plannedSessions = planned.length;
    const completedSessions = planned.filter(w => w.status === 'completed').length;

    // Hours from this week's actuals matching the discipline.
    let totalSec = 0;
    for (const a of Object.values(wk?.garminActuals ?? {})) {
      if (classifyActivity(a?.activityType) === d) totalSec += a?.durationSec ?? 0;
    }
    const totalHours = Math.round((totalSec / 3600) * 10) / 10;

    // RPE delta — mean(actual - expected) over rated workouts of this discipline.
    let rpeDelta: number | null = null;
    if (wk?.rated && plannedSessions > 0) {
      const deltas: number[] = [];
      for (const w of planned) {
        if (!w.id) continue;
        const expected = (w as { rpe?: number }).rpe ?? w.r;
        if (expected == null) continue;
        const rated = wk.rated[w.id];
        if (typeof rated !== 'number') continue;
        deltas.push(rated - expected);
      }
      if (deltas.length > 0) {
        rpeDelta = Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10;
      }
    }

    // Effort multiplier the plan engine WILL apply next week.
    const effortMultiplier = triEffortMultiplier(state, d);

    return { discipline: d, plannedSessions, completedSessions, totalHours, rpeDelta, effortMultiplier };
  });

  const raceOutcome = getRaceOutcomeRetro(state);

  // Adaptation ratio shifts (only show those crossing ±5% from neutral).
  const adapt = computeTriAdaptationRatios(state);
  const adaptationShifts = (['swim', 'bike', 'run'] as const)
    .filter(d => Math.abs(adapt[d] - 1) >= 0.05)
    .map(d => ({ discipline: d, ratio: adapt[d] }));

  void triTrailingEffortScore;  // imported for future use; silence unused-import lint
  return { disciplines, raceOutcome, adaptationShifts };
}

// ─── Render ────────────────────────────────────────────────────────────────

const DISCIPLINE_LABEL: Record<'swim' | 'bike' | 'run', string> = {
  swim: 'Swim',
  bike: 'Bike',
  run: 'Run',
};

function renderHTML(weekNum: number, summary: WeekSummary): string {
  const adaptiveSection = renderAdaptiveSection(summary);
  const raceSection = renderRaceSection(summary);
  return `
    <div class="w-full max-w-lg rounded-2xl p-5"
         style="background:#fff;max-height:90vh;overflow-y:auto;
                box-shadow:0 4px 12px rgba(0,0,0,0.10),0 16px 40px rgba(0,0,0,0.14)">
      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94A3B8">Week ${weekNum} recap</div>
        <div style="font-size:18px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;line-height:1.3;margin-top:4px">Here's what changed this week</div>
        <div style="font-size:12px;color:#64748B;line-height:1.5;margin-top:6px">A short summary of what you completed and what's adjusted for next week.</div>
      </div>

      ${raceSection}

      <!-- Per-discipline summary -->
      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94A3B8;margin-bottom:10px">By discipline</div>
        ${summary.disciplines.map(renderDisciplineRow).join('')}
      </div>

      ${adaptiveSection}

      <button id="tri-debrief-continue" style="
        width:100%;padding:12px;border-radius:10px;
        border:none;background:#0F172A;
        font-size:13px;font-weight:500;color:#fff;cursor:pointer;
      ">Continue</button>
    </div>
  `;
}

function renderDisciplineRow(d: DisciplineSummary): string {
  const completionPct = d.plannedSessions > 0
    ? Math.round((d.completedSessions / d.plannedSessions) * 100)
    : 0;
  const completionTxt = d.plannedSessions === 0
    ? 'No sessions planned'
    : `${d.completedSessions} of ${d.plannedSessions} sessions`;
  const rpeTxt = d.rpeDelta == null
    ? 'No RPE rated'
    : d.rpeDelta < -0.5 ? `Felt easier than planned`
    : d.rpeDelta > 0.5  ? `Felt harder than planned`
    : `On target`;
  const rpeColor = d.rpeDelta == null ? '#94A3B8'
    : d.rpeDelta < -0.5 ? '#5a8050'
    : d.rpeDelta > 0.5  ? '#a89060'
    : '#0F172A';
  return `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 12px;border-radius:8px;border:1px solid #F1F5F9;margin-bottom:6px">
      <div>
        <div style="font-size:13px;font-weight:600;color:#0F172A">${DISCIPLINE_LABEL[d.discipline]}</div>
        <div style="font-size:11px;color:#64748B;margin-top:2px">${completionTxt} ${d.plannedSessions > 0 ? `(${completionPct}%)` : ''} &middot; ${d.totalHours}h</div>
      </div>
      <div style="font-size:11px;color:${rpeColor};text-align:right">${rpeTxt}</div>
    </div>
  `;
}

function renderRaceSection(summary: WeekSummary): string {
  if (!summary.raceOutcome.display) return '';
  return `
    <div style="margin-bottom:18px;padding:12px 14px;border-radius:10px;background:#E8F2E5;border:1px solid #B8D6AE">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#5a8050;margin-bottom:4px">Race result</div>
      <div style="font-size:14px;font-weight:600;color:#0F172A;margin-bottom:4px">${summary.raceOutcome.headline ?? ''}</div>
      <div style="font-size:12px;color:#64748B;line-height:1.5">${summary.raceOutcome.body ?? ''}</div>
    </div>
  `;
}

function renderAdaptiveSection(summary: WeekSummary): string {
  // Effort multiplier changes — show those moving by ≥3% from neutral so we
  // don't bother the user with sub-3% noise.
  const mults = summary.disciplines
    .filter(d => Math.abs(d.effortMultiplier - 1) >= 0.03)
    .map(d => {
      const pct = Math.round((d.effortMultiplier - 1) * 100);
      const direction = pct > 0 ? 'longer' : 'shorter';
      return `${DISCIPLINE_LABEL[d.discipline]} sessions ${Math.abs(pct)}% ${direction}`;
    });
  const adaptShifts = summary.adaptationShifts.map(s => {
    const pct = Math.round((s.ratio - 1) * 100);
    const direction = pct > 0 ? 'faster' : 'slower';
    return `${DISCIPLINE_LABEL[s.discipline]} fitness responding ${Math.abs(pct)}% ${direction} than expected`;
  });

  if (mults.length === 0 && adaptShifts.length === 0) {
    return `
      <div style="margin-bottom:18px;padding:12px 14px;border-radius:10px;border:1px solid #F1F5F9">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94A3B8;margin-bottom:4px">Next week</div>
        <div style="font-size:12px;color:#64748B;line-height:1.5">No adjustments needed. Plan continues as scheduled.</div>
      </div>
    `;
  }
  return `
    <div style="margin-bottom:18px;padding:12px 14px;border-radius:10px;background:#FAF9F6;border:1px solid #E5E5E5">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#94A3B8;margin-bottom:6px">Plan adjusted for next week</div>
      ${mults.map(line => `<div style="font-size:12px;color:#0F172A;line-height:1.5;margin-bottom:2px">${line}</div>`).join('')}
      ${adaptShifts.map(line => `<div style="font-size:12px;color:#0F172A;line-height:1.5;margin-bottom:2px">${line}</div>`).join('')}
      ${mults.length > 0 ? '<div style="font-size:11px;color:#64748B;line-height:1.5;margin-top:6px">Based on how you rated sessions over the last 2 weeks.</div>' : ''}
    </div>
  `;
}
