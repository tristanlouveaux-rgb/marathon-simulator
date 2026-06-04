/**
 * Cross-Training Suggestion Modal
 *
 * Shows a popup with 3 global choices for adjusting runs:
 * - REPLACE: Apply full recommendation (includes replacements)
 * - REDUCE: Apply only downgrades/reductions (no replacements)
 * - KEEP: No changes, warn about overtraining risk
 *
 * Visual system: glass overlay (modelled on goal-time-overlay.ts) with a single
 * muted severity accent on the alert header. Option cards are neutral; the
 * recommended one carries dark-border emphasis rather than its own colour, so the
 * whole modal stays within the 2-colour budget (see UX_PATTERNS Visual Constraints).
 */

import type { SuggestionPopup, GlobalChoice, Adjustment } from '@/cross-training/suggester';
import { classifyWorkoutType } from '@/cross-training/universalLoad';
import { getState } from '@/state'; // used for intensityThresholds in cross-training header
import { SPORT_LABELS } from '@/constants/sports';
import { formatKm } from '@/utils/format';
import { showSimpleToast } from '@/ui/toast';

export interface SuggestionDecision {
  choice: GlobalChoice;
  adjustments: Adjustment[];
}

/** Optional cross-training activity context for the Phase B v3 modal header */
export interface CrossTrainingModalContext {
  sport: string;
  durationMin: number;
  iTrimp?: number | null;
  hrZones?: { z1: number; z2: number; z3: number; z4: number; z5?: number };
  /** Planned run this activity is matched to (if any) */
  matchedRunName?: string;
  matchedRunKm?: number;
}

/** Optional ACWR context injected into the top of the suggestion modal */
export interface ACWRModalContext {
  ratio: number;
  status: 'caution' | 'high';
  safeUpper: number;
  intensityPct?: number;           // % of week's planned load that is threshold+intensity
  kmSpiked?: boolean;              // actual running km > planned km × 1.3 (mechanical risk)
  crossTrainingCause?: string;     // sport name if cross-training drove the spike (Rule 3)
  consecutiveIntensityWeeks?: number; // # consecutive past weeks >40% intensity (Rule 4)
}

// ── Glass-modal palette (slate, self-contained — matches goal-time-overlay) ───
const INK = '#0F172A';        // headings / primary text
const BODY = '#334155';       // body copy in tinted alert
const MUTED = '#64748B';      // secondary text
const FAINT = '#94A3B8';      // tertiary / captions
const HAIR = 'rgba(15,23,42,0.08)'; // neutral border
// Frosted inner card: white 0.66 + the m-btn-glass--inset two-layer shadow
// (styles.css). No backdrop-filter on inner cards — stacking glass is the
// documented perf cliff (UX_PATTERNS → Rendering performance).
const FROST = 'background:rgba(255,255,255,0.66);box-shadow:0 1px 2px rgba(0,0,0,0.04),0 2px 6px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,0.8)';

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Only one suggestion modal may exist at a time. Triggers can race (auto-fire on
// sync + a readiness tap, or two processed activities) and stacked instances
// compound the dim/blur backdrop into a near-opaque navy sheet, with the upper
// overlay's backdrop blur smearing the lower card into a white halo. The stale
// instance is dismissed exactly like a backdrop tap (onComplete(null)), so its
// load still routes to the excess-load card at the call site. The tri modal has
// the same guard (tri-suggestion-modal.ts).
let dismissActiveModal: (() => void) | null = null;

/**
 * Show the suggestion popup modal with 3 global choices.
 * When acwrContext is provided, an ACWR explanation header is rendered at the top.
 * When crossTrainingCtx is provided, a sport/effort header is rendered below ACWR context.
 * When onPushToNextWeek is provided, a "Push to next week" button is shown between Reduce and Keep Plan.
 */
export function showSuggestionModal(
  popup: SuggestionPopup,
  sportName: string,
  onComplete: (decision: SuggestionDecision | null) => void,
  acwrContext?: ACWRModalContext,
  crossTrainingCtx?: CrossTrainingModalContext,
  onPushToNextWeek?: () => void,
): void {
  // Dismiss any already-open instance before building a new one (see
  // dismissActiveModal above). Belt-and-braces removal covers an orphaned
  // element whose closure was lost (e.g. across a hot reload).
  dismissActiveModal?.();
  document.getElementById('suggestion-modal')?.remove();

  const unitPref = getState().unitPref ?? 'km';

  // Build adjustment details for expandable sections — neutral rows, no per-action colour
  const buildAdjustmentList = (adjustments: Adjustment[]): string => {
    if (adjustments.length === 0) {
      return `<div style="color:${FAINT};font-size:13px;padding:6px 0">No changes to your running plan.</div>`;
    }

    return adjustments.map(adj => {
      let actionLabel = '';
      let detail = '';

      const origKm = Math.round(adj.originalDistanceKm * 10) / 10;
      const newKm = Math.round(adj.newDistanceKm * 10) / 10;

      if (adj.action === 'replace') {
        if (newKm > 0) {
          actionLabel = 'Convert';
          detail = `${adj.originalType} → ${formatKm(newKm, unitPref)} easy shakeout`;
        } else {
          actionLabel = 'Replace';
          detail = 'Replaced by cross-training';
        }
      } else if (adj.action === 'downgrade') {
        actionLabel = 'Downgrade';
        const paceLabel = adj.newType === 'easy' ? 'easy effort'
                        : adj.newType === 'marathon_pace' && adj.originalType === 'threshold' ? 'steady pace'
                        : adj.newType === 'marathon_pace' ? 'marathon pace'
                        : adj.newType === 'threshold' ? 'threshold pace'
                        : 'lower intensity';
        detail = origKm > 0
          ? `Keep ${formatKm(origKm, unitPref)}, drop to ${paceLabel}`
          : `Drop to ${paceLabel}`;
      } else {
        actionLabel = 'Reduce';
        detail = origKm > 0
          ? `${formatKm(origKm, unitPref)} → ${formatKm(newKm, unitPref)}`
          : `Reduce intensity`;
      }

      const day = DAY_SHORT[adj.dayIndex] ?? '';
      return `
        <div class="sm-adj" style="padding:9px 0;border-bottom:1px solid rgba(15,23,42,0.06)">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">
            <span style="color:${INK};font-weight:500;font-size:13px">${day ? `${day} · ` : ''}${adj.workoutId}</span>
            <span style="color:${INK};font-weight:600;font-size:12px;flex-shrink:0">${actionLabel}</span>
          </div>
          <div style="color:${MUTED};font-size:12px;margin-top:2px">${detail}</div>
        </div>
      `;
    }).join('');
  };

  const hasReplacements = popup.replaceOutcome.adjustments.some(a => a.action === 'replace');
  const hasReductions = popup.reduceOutcome.adjustments.length > 0;
  const noTrimPossible = !hasReductions && !hasReplacements && !popup.noMatchingRun && !popup.alreadyCompletedMatch;

  // Single recommended option (priority order) — only one gets dark emphasis
  const recommended: GlobalChoice | 'push' =
      hasReplacements ? 'replace'
    : hasReductions ? 'reduce'
    : (onPushToNextWeek && noTrimPossible) ? 'push'
    : 'keep';

  // Equivalent easy km display
  const equivKm = popup.equivalentEasyKm > 0
    ? `≈ ${formatKm(popup.equivalentEasyKm, unitPref)} easy running equivalent`
    : '';

  // Per-option absorption, in the same easy-km currency as the header strip.
  // loadReduction and runReplacementCredit share the suggester's load units, and
  // the header's equivalentEasyKm is derived from that credit — so a pure
  // proportion converts each option's total into comparable km. Clamped to the
  // header value (effectiveRRC can slightly exceed the raw credit via the
  // recovery multiplier). Answers "do these cover the same load?" at a glance.
  const loadToKm = (load: number): number =>
    Math.min(popup.equivalentEasyKm, (load / popup.runReplacementCredit) * popup.equivalentEasyKm);
  const optionEasyKm = (adjs: Adjustment[]): number | null => {
    if (adjs.length === 0 || popup.runReplacementCredit <= 0 || popup.equivalentEasyKm <= 0) return null;
    const total = adjs.reduce((sum, a) => sum + (a.loadReduction || 0), 0);
    if (total <= 0) return null;
    return Math.round(loadToKm(total) * 10) / 10;
  };
  const replaceCutKm = optionEasyKm(popup.replaceOutcome.adjustments) ?? 0;
  const reduceCutKm = optionEasyKm(popup.reduceOutcome.adjustments) ?? 0;
  // The user-facing ask is what the recommended option actually delivers. The
  // full physiological excess can exceed what the plan can safely cut (run
  // minimums, preserve fraction); headlining an unreachable number reads as
  // failure, so the header states the achievable trim and the full accounting
  // lives in See details.
  const askKm = Math.max(replaceCutKm, reduceCutKm);
  // Reduce exists to spread an equivalent cut across runs without replacing one.
  // When the floors stop it reaching ≈ the same total as Replace & Reduce it is
  // not a real alternative — hide it (Tristan, 2026-06-03).
  const showReduce = hasReductions && (!hasReplacements || reduceCutKm >= replaceCutKm * 0.9);
  // Direction-explicit wording: the excess is work already done, so the options
  // cut upcoming planned runs to make room for it. The header owns the ask;
  // each card states only what it delivers.
  // "Equivalent of easy running" because cuts mix two levers: a downgrade keeps
  // the distance and drops intensity, a reduce keeps intensity and drops distance.
  // Both land in one load currency; easy-run-equivalent is its display unit.
  // (TSS display blocked until the internal load scales are reconciled — ISSUE-263.)
  const absorbLine = (adjs: Adjustment[]): string | undefined => {
    const km = optionEasyKm(adjs);
    if (km == null) return undefined;
    return `Cuts the equivalent of ≈ ${formatKm(km, unitPref)} of easy running.`;
  };

  // Data tier label (neutral chip — provenance, not a status colour)
  const tierLabelMap: Record<string, string> = { itrimp: 'HR Stream', garmin: 'Garmin', hr: 'HR Zones', rpe: 'Estimated' };
  const tierLabel = tierLabelMap[popup.tier] ?? 'Estimated';

  // Leg impact — meaning carried by the word, rendered as neutral text (no colour spent)
  const impactText = popup.impactLoad <= 0 ? 'No leg impact'
    : popup.impactLoad < 4   ? 'Low leg impact'
    : popup.impactLoad < 10  ? 'Moderate leg impact'
    :                          'High leg impact';

  // Tappable impact label → one-line explainer ("leg impact" means ground-strike
  // stress, not muscular work — a hard ride is correctly "No leg impact").
  const impactBtn = `<button id="impact-info-btn" style="background:none;border:none;cursor:pointer;padding:0;font:inherit;font-size:12px;color:${MUTED};border-bottom:1px dotted rgba(15,23,42,0.3)">${impactText}</button>`;
  const impactExplainer = `<div id="impact-info" style="display:none;font-size:12px;color:${FAINT};line-height:1.55;width:100%">Leg impact is the ground-strike stress on bones and tendons, separate from aerobic effort. A hard ride or swim can carry zero impact. The easy-running equivalent is aerobic load only.</div>`;

  // Tappable excess label → what the excess actually is and where it goes if
  // nothing is cut (the mental model: work already done, paid for now or later).
  const equivBtn = equivKm
    ? `<button id="equiv-info-btn" style="background:none;border:none;cursor:pointer;padding:0;font:inherit;font-size:12px;color:${FAINT};border-bottom:1px dotted rgba(15,23,42,0.3)">${equivKm}</button>`
    : '';
  const equivExplainer = `<div id="equiv-info" style="display:none;font-size:12px;color:${FAINT};line-height:1.55;width:100%">This excess is training stress already done, not upcoming distance, expressed as easy running. Reducing trades planned sessions for it. Keeping the plan carries it as fatigue: readiness stays lower, and a week that ends over target starts the next one with a smaller training budget.</div>`;

  // Warning text based on severity. Only shown when ACWR is actually elevated.
  // A heavy session alone doesn't mean fatigue risk is high (e.g. high-volume athlete with
  // high CTL baseline can absorb a big session without ACWR spiking).
  const keepWarning = acwrContext
    ? (popup.severity === 'extreme'
        ? 'Your load this week is above your usual base. Consider reducing intensity or duration of remaining sessions.'
        : popup.severity === 'heavy'
        ? 'Fatigue has built this week. Monitor how you feel.'
        : '')
    : '';

  // ── Option-card renderer ────────────────────────────────────────────────────
  // Cards are div[role=button], not <button>: the "View changes" <details> inside
  // is interactive content, which is invalid inside a real <button> and breaks
  // keyboard tab focus. Enter/Space activation is wired below.
  const optionCard = (opts: {
    id: string;
    title: string;
    desc: string;
    recommended?: boolean;
    /** "Absorbs ≈ X of the Y excess." comparison line, shown under the description */
    loadLine?: string;
    expander?: { count: number; body: string; open?: boolean };
    warning?: string;
  }): string => {
    const border = opts.recommended
      ? 'border:1.5px solid rgba(15,23,42,0.82)'
      : `border:1px solid ${HAIR}`;
    const chip = opts.recommended
      ? `<span style="font-size:11px;font-weight:600;color:${MUTED};background:rgba(15,23,42,0.05);border:1px solid rgba(15,23,42,0.10);padding:2px 9px;border-radius:999px;flex-shrink:0">Recommended</span>`
      : '';
    return `
      <div id="${opts.id}" class="sm-choice" role="button" tabindex="0" aria-pressed="${opts.recommended ? 'true' : 'false'}" style="width:100%;text-align:left;padding:14px 16px;border-radius:14px;${border};${FROST};cursor:pointer;display:block">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px">
          <span style="font-weight:600;color:${INK};font-size:15px;letter-spacing:-0.01em">${opts.title}</span>
          ${chip}
        </div>
        <p style="color:${MUTED};font-size:13px;line-height:1.5;margin:0">${opts.desc}</p>
        ${opts.loadLine ? `<p style="color:${INK};font-size:12px;font-weight:500;line-height:1.5;margin:6px 0 0">${opts.loadLine}</p>` : ''}
        ${opts.expander ? `
          <details style="font-size:12px;margin-top:10px" ${opts.expander.open ? 'open' : ''}>
            <summary style="color:${FAINT};cursor:pointer;list-style:none"><span class="sm-caret">▸</span> View changes (${opts.expander.count})</summary>
            <div style="margin-top:6px;border-top:1px solid rgba(15,23,42,0.06)">
              ${opts.expander.body}
            </div>
          </details>` : ''}
        ${opts.warning ? `<p style="color:${MUTED};font-size:12px;line-height:1.5;margin:8px 0 0">${opts.warning}</p>` : ''}
      </div>`;
  };

  // ── ACWR context header (the "Heavy training week" alert) ────────────────────
  const acwrHeader = (() => {
    if (!acwrContext) return '';
    const { ratio, status, safeUpper, intensityPct } = acwrContext;
    const pctAboveCeiling = Math.round((ratio / safeUpper - 1) * 100);
    const pctAboveBaseline = Math.round((ratio - 1) * 100);
    // §8. 5-rule plain language reduction advice
    const { kmSpiked, crossTrainingCause, consecutiveIntensityWeeks } = acwrContext;
    const iHeavy = (intensityPct ?? 0) > 50;
    let zoneAdvice: string;
    if (consecutiveIntensityWeeks != null && consecutiveIntensityWeeks >= 3) {
      // Rule 4. Consecutive intensity-heavy weeks
      zoneAdvice = `Your last ${consecutiveIntensityWeeks} weeks have been intensity-heavy. Pulling back on intervals protects your aerobic base.`;
    } else if (crossTrainingCause) {
      // Rule 3. Cross-training drove the spike
      const sportLabel = crossTrainingCause === 'generic_sport'
        ? 'cross-training'
        : (SPORT_LABELS[crossTrainingCause as keyof typeof SPORT_LABELS]
            ?? crossTrainingCause.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).toLowerCase();
      zoneAdvice = `A ${sportLabel} session added load on top of your planned running. The adjustments below bring the week back in line. Quality sessions are preserved where possible.`;
    } else if (kmSpiked) {
      // Rule 2. Running km spiked (mechanical risk)
      zoneAdvice = 'Your running km spiked this week. Heart rate load is fine. The risk here is mechanical (tendons, bones), so volume should come down before intensity.';
    } else if (iHeavy) {
      // Rule 1. ACWR elevated + intensity-heavy
      zoneAdvice = `Your load is ${pctAboveBaseline}% above your usual weekly volume and most of it was high-intensity work. Intensity is the biggest fatigue driver, so it should come down before volume.`;
    } else {
      // Rule 5. Trailing zone mix / general
      zoneAdvice = `Your load has built quickly. The safest cuts are to your highest-volume runs. Quality sessions stay intact where possible.`;
    }
    // Human-consequence headline carries the ask: the achievable trim, in
    // Tristan's framing ("you've been training harder than normal, so we need
    // to reduce by X"). The unreachable full excess lives in See details.
    const humanConsequence = status === 'high'
      ? (askKm > 0
          ? `You've been training harder than normal. This week is ${pctAboveBaseline}% above your usual load, so the remaining runs come down by the equivalent of ≈ ${formatKm(askKm, unitPref)} of easy running.`
          : `You've been training harder than normal. This week is ${pctAboveBaseline}% above your usual load. Extra recovery is needed before the next hard effort.`)
      : pctAboveCeiling <= 5
      ? `Your load is just above the safe ceiling (${ratio.toFixed(2)}× vs ${safeUpper.toFixed(1)}×). A small adjustment is enough.`
      : (askKm > 0
          ? `This week is ${pctAboveBaseline}% above your usual load, so the remaining runs come down by the equivalent of ≈ ${formatKm(askKm, unitPref)} of easy running.`
          : `This week is ${pctAboveBaseline}% above your usual load. Recovery between sessions matters more than usual.`);
    // Full-excess accounting, shown on demand. States plainly why the trim can
    // be smaller than the excess and where the remainder goes (fatigue decay +
    // next-week carry, week-rollover carriedTSS in events.ts).
    const excessDetail = popup.equivalentEasyKm > 0
      ? `<p style="font-size:12px;color:${MUTED};line-height:1.55;margin:0 0 4px">The full excess is ≈ ${formatKm(popup.equivalentEasyKm, unitPref)} of easy running equivalent, training stress already done. The plan only trims what it can without dropping runs below their minimums. What isn't cut clears through recovery, and a week that ends over target starts the next one with a smaller budget.</p>`
      : '';
    // Plain header on the glass card — no tinted sub-box, no severity colour
    // (UX_PATTERNS → "No tinted card backgrounds"). Severity is carried by the
    // title and the copy. The impact label and details toggle share one quiet
    // meta row; the advice + full-excess accounting live in the expander.
    return `
      <div style="padding:22px 20px 0">
        <h3 style="color:${INK};font-weight:700;font-size:18px;letter-spacing:-0.01em;margin:0 0 6px;padding-right:28px">${status === 'high' ? 'Heavy training week' : 'Load building up'}</h3>
        <p style="font-size:13px;color:${MUTED};line-height:1.55;margin:0 0 9px">${humanConsequence}</p>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          ${impactBtn}
          <button id="acwr-details-toggle" style="font:inherit;font-size:12px;color:${FAINT};display:inline-flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:0">
            <span id="acwr-details-caret">▸</span> See details
          </button>
          ${impactExplainer}
        </div>
        <div id="acwr-details-body" style="display:none;margin-top:10px;flex-direction:column;gap:6px">
          <p style="font-size:12px;color:${MUTED};line-height:1.55;margin:0 0 4px">${zoneAdvice}</p>
          ${excessDetail}
          <div style="display:flex;justify-content:space-between;font-size:12px;color:${FAINT}"><span>ATL (acute fatigue)</span><span style="color:${INK}">${Math.round(acwrContext.ratio * (safeUpper * 50))}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:${FAINT}"><span>Safe upper (your tier)</span><span style="color:${INK}">${safeUpper.toFixed(1)}×</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:${FAINT}">Current ratio</span><span style="color:${INK};font-weight:600">${ratio.toFixed(2)}×</span></div>
          ${intensityPct != null ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:${FAINT}"><span>Week intensity</span><span style="color:${INK}">${intensityPct}% at threshold or above</span></div>` : ''}
        </div>
      </div>
    `;
  })();

  // ── Cross-training activity header (Phase B v3) — neutral, no decorative emoji ─
  const ctxHeader = (() => {
    if (!crossTrainingCtx) return '';

    const { sport, durationMin, iTrimp, hrZones, matchedRunName, matchedRunKm } = crossTrainingCtx;

    const state2 = getState();
    const classification = classifyWorkoutType({
      sport,
      durationMin,
      iTrimp: iTrimp ?? undefined,
      hrZones: hrZones ? {
        zone1Minutes: hrZones.z1 / 60,
        zone2Minutes: hrZones.z2 / 60,
        zone3Minutes: hrZones.z3 / 60,
        zone4Minutes: hrZones.z4 / 60,
        zone5Minutes: hrZones.z5 ? hrZones.z5 / 60 : 0,
      } : undefined,
      thresholds: state2.intensityThresholds,
    });

    const effortLabel = classification.type === 'vo2' ? 'Interval'
      : classification.type === 'threshold' ? 'Tempo'
      : 'Easy';

    const totalLoad2 = Math.round(popup.aerobicLoad + popup.anaerobicLoad);

    const cardioCoveredPct = matchedRunKm && matchedRunKm > 0
      ? Math.min(100, Math.round((popup.aerobicLoad / (matchedRunKm * 4.5)) * 100))
      : null;
    const kmGap = matchedRunKm ? -matchedRunKm : null;

    const sportLabel = sport.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const hasHR = iTrimp != null || hrZones != null;

    return `
      <div style="padding:14px 20px 0">
        <div style="border:1px solid ${HAIR};border-radius:14px;padding:13px 15px;${FROST}">
          <div style="color:${INK};font-weight:600;font-size:13px;margin-bottom:4px">${sportLabel} · ${Math.round(durationMin)} min</div>
          <div style="color:${MUTED};font-size:12px">
            ${hasHR ? `HR-based load: ${totalLoad2} · ` : `Estimated load: ${totalLoad2} · `}Effort type: ${effortLabel}
          </div>
          ${matchedRunName || matchedRunKm ? `
          <div style="border-top:1px solid rgba(15,23,42,0.06);margin-top:11px;padding-top:11px">
            ${matchedRunName ? `<div style="color:${MUTED};font-size:12px;margin-bottom:6px">Matched to: <span style="color:${INK}">${matchedRunName}${matchedRunKm ? ` (${formatKm(matchedRunKm, unitPref)})` : ''}</span></div>` : ''}
            <div style="display:flex;gap:14px;font-size:12px">
              ${cardioCoveredPct !== null ? `
                <button class="ctx-info-btn" data-ctx-info="cardio" style="background:none;border:none;cursor:pointer;color:${MUTED};padding:0;font:inherit">
                  Cardio covered: <span style="color:${INK};font-weight:600">${cardioCoveredPct}%</span>
                </button>` : ''}
              ${kmGap !== null ? `
                <button class="ctx-info-btn" data-ctx-info="km" style="background:none;border:none;cursor:pointer;color:${MUTED};padding:0;font:inherit">
                  Running km gap: <span style="color:${INK};font-weight:600">${formatKm(kmGap as number, unitPref)}</span>
                </button>` : ''}
            </div>
            <div id="ctx-info-cardio" style="display:none;margin-top:8px;font-size:12px;color:${FAINT};line-height:1.55">Cardio covered compares the aerobic load of this activity to your planned run. Above 80% means your heart and lungs get a similar stimulus without the running stress.</div>
            <div id="ctx-info-km" style="display:none;margin-top:8px;font-size:12px;color:${FAINT};line-height:1.55">Running km gap shows how many km of road running this session doesn't replace. Cross-training builds aerobic fitness but misses the bone, tendon, and neuromuscular adaptations of running.</div>
          </div>
          ` : ''}
        </div>
      </div>`;
  })();

  // When ACWR context is present, the header above already carries the impact
  // label, easy-km equivalent, and details toggle — nothing more to render here.
  const sevWord = popup.severity === 'extreme' ? 'Very high' : popup.severity === 'heavy' ? 'High' : 'Moderate';
  const mainHeader = acwrContext
    ? ''
    : `<div style="padding:22px 20px 0">
        <h3 style="color:${INK};font-weight:700;font-size:18px;letter-spacing:-0.01em;margin:0 0 6px;padding-right:28px">${popup.headline}</h3>
        <p style="color:${MUTED};font-size:13px;line-height:1.55;margin:0 0 12px">${popup.summary}</p>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="display:inline-flex;align-items:center;padding:4px 11px;border-radius:999px;background:rgba(15,23,42,0.05);border:1px solid ${HAIR};color:${INK};font-size:12px;font-weight:500">
            ${popup.durationMin} min ${popup.sportName} · ${sevWord} load
          </span>
          ${equivBtn}
          ${popup.warnings.length > 0 ? `<span style="font-size:12px;color:${MUTED}">${popup.warnings[0]}</span>` : ''}
          ${equivExplainer}
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px">
          <span style="display:inline-flex;align-items:center;padding:2px 9px;border-radius:6px;font-weight:500;background:rgba(15,23,42,0.05);border:1px solid ${HAIR};color:${MUTED}">${tierLabel}</span>
          ${impactBtn}
          ${impactExplainer}
        </div>
      </div>`;

  // ── Assemble option cards ───────────────────────────────────────────────────
  const optionsHtml = [
    noTrimPossible ? `
      <div style="padding:13px 15px;border-radius:14px;${FROST};border:1px solid ${HAIR};font-size:13px;color:${MUTED};line-height:1.5">
        Your remaining runs are already at minimum intensity and distance. The extra load can't be absorbed by trimming this week's plan. Push it to next week or keep the plan and accept the added stimulus.
      </div>` : '',
    hasReplacements ? optionCard({
      id: 'choice-replace',
      title: 'Replace & Reduce',
      desc: 'Replace runs where possible, downgrade the rest. Best for heavy cross-training.',
      recommended: recommended === 'replace',
      loadLine: absorbLine(popup.replaceOutcome.adjustments),
      expander: { count: popup.replaceOutcome.adjustments.length, body: buildAdjustmentList(popup.replaceOutcome.adjustments), open: recommended === 'replace' },
    }) : '',
    showReduce ? optionCard({
      id: 'choice-reduce',
      title: 'Reduce',
      desc: 'Trims intensity or distance across your runs. Keeps every run in the plan.',
      recommended: recommended === 'reduce',
      loadLine: absorbLine(popup.reduceOutcome.adjustments),
      expander: { count: popup.reduceOutcome.adjustments.length, body: buildAdjustmentList(popup.reduceOutcome.adjustments), open: recommended === 'reduce' },
    }) : '',
    onPushToNextWeek ? optionCard({
      id: 'choice-push-next-week',
      title: 'Push to next week',
      desc: 'Keep this week unchanged. The excess load carries to next week.',
      recommended: recommended === 'push',
    }) : '',
    optionCard({
      id: 'choice-keep',
      title: 'Keep plan',
      desc: 'Keep your running plan unchanged.',
      recommended: recommended === 'keep',
      loadLine: askKm > 0
        ? 'Cuts nothing. The excess stays as fatigue.'
        : undefined,
      // The cut line already says the fatigue stays; only the extreme-severity
      // warning adds actionable advice beyond it.
      warning: keepWarning && (popup.severity === 'extreme' || askKm <= 0) ? keepWarning : undefined,
    }),
  ].filter(Boolean).join('');

  const overlay = document.createElement('div');
  overlay.id = 'suggestion-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,0.42);backdrop-filter:blur(12px) saturate(1.1);-webkit-backdrop-filter:blur(12px) saturate(1.1);overflow-y:auto';

  overlay.innerHTML = `
    <div style="position:relative;background:rgba(255,255,255,0.78);backdrop-filter:blur(24px) saturate(1.4);-webkit-backdrop-filter:blur(24px) saturate(1.4);border:1px solid rgba(255,255,255,0.6);border-radius:24px;max-width:440px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(15,23,42,0.18),0 0 0 1px rgba(15,23,42,0.04)">
      <button id="close-modal-top" aria-label="Close" style="font:inherit;position:absolute;top:14px;right:14px;background:none;border:none;cursor:pointer;color:${FAINT};font-size:22px;line-height:1;padding:4px;z-index:2">×</button>

      ${acwrHeader}
      ${ctxHeader}
      ${mainHeader}

      <!-- §6.5 edge case: already completed run or no matching run -->
      ${popup.alreadyCompletedMatch ? `
      <div style="padding:16px 20px 0">
        <div style="${FROST};border:1px solid ${HAIR};border-radius:14px;padding:14px 16px">
          <div style="font-size:13px;color:${INK};font-weight:600;margin-bottom:6px">
            Matched to: ${popup.alreadyCompletedMatch.runName}. But you already completed it
          </div>
          <p style="font-size:12px;color:${MUTED};line-height:1.55;margin-bottom:12px">
            Your session contributes to your weekly load (ACWR updated). Apply the load credit to next week's ${popup.alreadyCompletedMatch.runType.replace(/_/g,' ')} run instead?
          </p>
          <div style="display:flex;gap:8px">
            <button id="choice-apply-next-week" style="font:inherit;flex:1;padding:11px 12px;border-radius:999px;border:none;background:${INK};cursor:pointer;font-size:13px;font-weight:600;color:#fff">Apply to next week</button>
            <button id="choice-log-load-only" style="font:inherit;flex:1;padding:11px 12px;border-radius:999px;border:1px solid ${HAIR};background:rgba(255,255,255,0.7);cursor:pointer;font-size:13px;font-weight:500;color:${MUTED}">Log load only</button>
          </div>
        </div>
      </div>` : ''}
      ${popup.noMatchingRun ? `
      <div style="padding:16px 20px 0">
        <div style="${FROST};border:1px solid ${HAIR};border-radius:14px;padding:14px 16px">
          <div style="font-size:13px;color:${INK};font-weight:600;margin-bottom:6px">No matching planned run this week</div>
          <p style="font-size:12px;color:${MUTED};line-height:1.55;margin-bottom:12px">
            Your session's load is counted in your weekly TSS. Apply the credit toward next week's plan?
          </p>
          <div style="display:flex;gap:8px">
            <button id="choice-apply-next-week" style="font:inherit;flex:1;padding:11px 12px;border-radius:999px;border:none;background:${INK};cursor:pointer;font-size:13px;font-weight:600;color:#fff">Match to next week</button>
            <button id="choice-log-load-only" style="font:inherit;flex:1;padding:11px 12px;border-radius:999px;border:1px solid ${HAIR};background:rgba(255,255,255,0.7);cursor:pointer;font-size:13px;font-weight:500;color:${MUTED}">Log as load only</button>
          </div>
        </div>
      </div>` : ''}

      <!-- Global choices -->
      <div style="padding:16px 20px;display:flex;flex-direction:column;gap:10px">
        ${optionsHtml}
      </div>

      <!-- Footer: tap selects an option above, Confirm applies it -->
      <div style="padding:0 20px 18px">
        <button id="confirm-choice" style="font:inherit;width:100%;padding:14px;border:none;border-radius:999px;background:${INK};color:#fff;font-size:15px;font-weight:600;cursor:pointer">
          Confirm
        </button>
        <button id="close-modal" style="font:inherit;width:100%;padding:12px 0 0;background:none;border:none;color:${FAINT};font-size:13px;cursor:pointer">
          Dismiss
        </button>
      </div>
    </div>

    <style id="suggestion-modal-style">
      #suggestion-modal details > summary::-webkit-details-marker { display:none; }
      #suggestion-modal .sm-choice:focus-visible { outline:2px solid rgba(15,23,42,0.8); outline-offset:2px; }
      #suggestion-modal details > summary:focus-visible { outline:1px solid rgba(15,23,42,0.4); outline-offset:2px; border-radius:4px; }
      #suggestion-modal .sm-caret { display:inline-block; transition:transform 0.15s ease; }
      #suggestion-modal details[open] > summary .sm-caret { transform:rotate(90deg); }
      #suggestion-modal .sm-adj:last-child { border-bottom:none; padding-bottom:2px; }
    </style>
  `;

  document.body.appendChild(overlay);

  // Wire cross-training context info buttons
  overlay.querySelectorAll<HTMLButtonElement>('.ctx-info-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.ctxInfo!;
      const box = overlay.querySelector(`#ctx-info-${id}`) as HTMLElement | null;
      if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
    });
  });

  // Keyboard activation for the option cards (div[role=button]). Only when focus
  // is on the card itself — the <summary> inside handles its own Enter/Space.
  overlay.querySelectorAll<HTMLElement>('.sm-choice').forEach(card => {
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    });
  });

  // Wire impact-label + excess-label explainer toggles
  overlay.querySelector('#impact-info-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const box = overlay.querySelector('#impact-info') as HTMLElement | null;
    if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
  });
  overlay.querySelector('#equiv-info-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const box = overlay.querySelector('#equiv-info') as HTMLElement | null;
    if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
  });

  // Wire ACWR details toggle if present
  overlay.querySelector('#acwr-details-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const body = overlay.querySelector('#acwr-details-body') as HTMLElement | null;
    const caret = overlay.querySelector('#acwr-details-caret') as HTMLElement | null;
    if (body) {
      const isHidden = body.style.display === 'none' || body.style.display === '';
      body.style.display = isHidden ? 'flex' : 'none';
      if (caret) caret.textContent = isHidden ? '▾' : '▸';
    }
  });

  const close = (choice: GlobalChoice | null, adjustments: Adjustment[]) => {
    if (dismissActiveModal === ownDismiss) dismissActiveModal = null;
    overlay.remove();
    if (choice) {
      onComplete({ choice, adjustments });
    } else {
      onComplete(null);
    }
  };
  const ownDismiss = () => close(null, []);
  dismissActiveModal = ownDismiss;

  // Event handlers
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(null, []);
  });

  // Prevent the <summary> toggle click from bubbling to the parent choice button.
  // Only block the summary toggle itself. Clicks on expanded content should
  // still reach the button so the user can select the option by clicking anywhere on the card.
  overlay.querySelectorAll('details summary').forEach(summary => {
    summary.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  // §6.5 edge case buttons. Fire 'keep' with empty adjustments (load already counted in ACWR)
  overlay.querySelector('#choice-apply-next-week')?.addEventListener('click', () => {
    close('keep', []);
  });
  overlay.querySelector('#choice-log-load-only')?.addEventListener('click', () => {
    close('keep', []);
  });

  // Transient confirmation after a plan-mutating choice (CLAUDE.md → adaptation
  // transparency: small meaningful change gets a small toast). Fired after close()
  // so onComplete has already applied the adjustments at the call site.
  const summariseAdjustments = (adjs: Adjustment[]): string => {
    const counts: Record<string, number> = {};
    for (const a of adjs) {
      const key = a.action === 'replace'
        ? (a.newDistanceKm > 0 ? 'converted to easy' : 'replaced')
        : a.action === 'downgrade' ? 'downgraded' : 'reduced';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const parts = Object.entries(counts).map(([k, n]) => `${n} ${n === 1 ? 'run' : 'runs'} ${k}`);
    return `Plan updated: ${parts.join(', ')}.`;
  };

  // Tap selects, Confirm applies. Guards against accidental application from a
  // stray tap on a large card (the cards also host the "View changes" expanders).
  const CHOICE_IDS = ['choice-replace', 'choice-reduce', 'choice-push-next-week', 'choice-keep'] as const;
  let selectedId: string =
      recommended === 'replace' ? 'choice-replace'
    : recommended === 'reduce' ? 'choice-reduce'
    : recommended === 'push' ? 'choice-push-next-week'
    : 'choice-keep';

  const refreshSelection = (): void => {
    for (const id of CHOICE_IDS) {
      const card = overlay.querySelector<HTMLElement>(`#${id}`);
      if (!card) continue;
      const isSel = id === selectedId;
      card.style.border = isSel ? '1.5px solid rgba(15,23,42,0.82)' : `1px solid ${HAIR}`;
      card.setAttribute('aria-pressed', String(isSel));
    }
  };

  CHOICE_IDS.forEach(id => {
    overlay.querySelector(`#${id}`)?.addEventListener('click', () => {
      selectedId = id;
      refreshSelection();
    });
  });

  overlay.querySelector('#confirm-choice')?.addEventListener('click', () => {
    if (selectedId === 'choice-replace') {
      close('replace', popup.replaceOutcome.adjustments);
      if (popup.replaceOutcome.adjustments.length > 0) showSimpleToast(summariseAdjustments(popup.replaceOutcome.adjustments));
    } else if (selectedId === 'choice-reduce') {
      close('reduce', popup.reduceOutcome.adjustments);
      if (popup.reduceOutcome.adjustments.length > 0) showSimpleToast(summariseAdjustments(popup.reduceOutcome.adjustments));
    } else if (selectedId === 'choice-push-next-week') {
      close(null, []);
      onPushToNextWeek?.();
    } else {
      close('keep', []);
    }
  });

  overlay.querySelector('#close-modal')?.addEventListener('click', () => {
    close(null, []);
  });
  overlay.querySelector('#close-modal-top')?.addEventListener('click', () => {
    close(null, []);
  });
}

// Legacy export for backwards compatibility
export type { SuggestionDecision as SuggestionDecisionLegacy };
