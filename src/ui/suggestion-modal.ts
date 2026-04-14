/**
 * Cross-Training Suggestion Modal
 *
 * Shows a popup with 3 global choices for adjusting runs:
 * - REPLACE: Apply full recommendation (includes replacements)
 * - REDUCE: Apply only downgrades/reductions (no replacements)
 * - KEEP: No changes, warn about overtraining risk
 */

import type { SuggestionPopup, GlobalChoice, Adjustment } from '@/cross-training/suggester';
import { classifyWorkoutType } from '@/cross-training/universalLoad';
import { getState } from '@/state'; // used for intensityThresholds in cross-training header
import { SPORT_LABELS } from '@/constants/sports';
import { formatKm } from '@/utils/format';

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
  const unitPref = getState().unitPref ?? 'km';
  const severityStyles = {
    light: {
      bg: 'background:rgba(37,99,235,0.06)',
      border: 'border:1px solid rgba(37,99,235,0.3)',
      textColor: 'color:#2563EB',
      iconColor: 'color:#2563EB',
      badgeStyle: 'background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.3);color:#2563EB',
    },
    heavy: {
      bg: 'background:rgba(245,158,11,0.06)',
      border: 'border:1px solid rgba(245,158,11,0.3)',
      textColor: 'color:var(--c-caution)',
      iconColor: 'color:var(--c-caution)',
      badgeStyle: 'background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);color:var(--c-caution)',
    },
    extreme: {
      bg: 'background:rgba(239,68,68,0.06)',
      border: 'border:1px solid rgba(239,68,68,0.3)',
      textColor: 'color:var(--c-warn)',
      iconColor: 'color:var(--c-warn)',
      badgeStyle: 'background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);color:var(--c-warn)',
    },
  };
  const sv = severityStyles[popup.severity];

  // Build adjustment details for expandable sections
  const buildAdjustmentList = (adjustments: Adjustment[]): string => {
    if (adjustments.length === 0) {
      return '<div style="color:var(--c-faint);font-size:13px;padding:8px 0">No changes to your running plan.</div>';
    }

    return adjustments.map(adj => {
      let actionLabel = '';
      let actionStyle = '';
      let detail = '';

      const origKm = Math.round(adj.originalDistanceKm * 10) / 10;
      const newKm = Math.round(adj.newDistanceKm * 10) / 10;

      if (adj.action === 'replace') {
        if (newKm > 0) {
          actionLabel = 'Convert';
          actionStyle = 'color:#2563EB';
          detail = `${adj.originalType} → ${formatKm(newKm, unitPref)} easy shakeout`;
        } else {
          actionLabel = 'Replace';
          actionStyle = 'color:var(--c-warn)';
          detail = 'Replaced by cross-training';
        }
      } else if (adj.action === 'downgrade') {
        actionLabel = 'Downgrade';
        actionStyle = 'color:var(--c-caution)';
        const paceLabel = adj.newType === 'easy' ? 'easy effort'
                        : adj.newType === 'marathon_pace' && adj.originalType === 'threshold' ? 'steady pace (MP–easy midpoint)'
                        : adj.newType === 'marathon_pace' ? 'marathon pace'
                        : adj.newType === 'threshold' ? 'threshold pace'
                        : 'lower intensity';
        detail = origKm > 0
          ? `Keep ${formatKm(origKm, unitPref)} — drop to ${paceLabel}`
          : `Drop to ${paceLabel}`;
      } else {
        actionLabel = 'Reduce';
        actionStyle = 'color:var(--c-caution)';
        detail = origKm > 0
          ? `${formatKm(origKm, unitPref)} → ${formatKm(newKm, unitPref)}`
          : `Reduce intensity`;
      }

      return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--c-border)">
          <div>
            <span style="color:var(--c-black);font-weight:500">${adj.workoutId}</span>
            <span style="color:var(--c-faint);font-size:12px;margin-left:8px">${adj.originalType}</span>
          </div>
          <div style="text-align:right">
            <span style="${actionStyle};font-weight:500">${actionLabel}</span>
            <div style="color:var(--c-muted);font-size:11px">${detail}</div>
          </div>
        </div>
      `;
    }).join('');
  };

  const hasReplacements = popup.replaceOutcome.adjustments.some(a => a.action === 'replace');
  const hasReductions = popup.reduceOutcome.adjustments.length > 0;

  // Equivalent easy km display
  const equivKm = popup.equivalentEasyKm > 0
    ? `≈ ${formatKm(popup.equivalentEasyKm, unitPref)} easy running equivalent`
    : '';

  // Data tier badge
  const tierStyles: Record<string, string> = {
    itrimp: 'color:#16a34a;background:rgba(22,163,74,0.08);border:1px solid rgba(22,163,74,0.3)',
    garmin: 'color:#2563EB;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.3)',
    hr:     'color:#0891B2;background:rgba(8,145,178,0.08);border:1px solid rgba(8,145,178,0.3)',
    rpe:    'color:var(--c-muted);background:rgba(0,0,0,0.05);border:1px solid var(--c-border-strong)',
  };
  const tierLabelMap: Record<string, string> = { itrimp: 'HR Stream', garmin: 'Garmin', hr: 'HR Zones', rpe: 'Estimated' };
  const tierStyle = tierStyles[popup.tier] ?? tierStyles.rpe;
  const tierLabel = tierLabelMap[popup.tier] ?? 'Estimated';

  // Impact load label
  const impactStyle = popup.impactLoad <= 0 ? { text: 'No leg impact', color: '#16a34a' }
    : popup.impactLoad < 4   ? { text: 'Low leg impact',      color: '#16a34a' }
    : popup.impactLoad < 10  ? { text: 'Moderate leg impact', color: 'var(--c-caution)' }
    :                          { text: 'High leg impact',      color: 'var(--c-warn)' };

  // Warning text based on severity — only shown when ACWR is actually elevated.
  // A heavy session alone doesn't mean fatigue risk is high (e.g. high-volume athlete with
  // high CTL baseline can absorb a big session without ACWR spiking).
  const keepWarning = acwrContext
    ? (popup.severity === 'extreme'
        ? 'Warning: Your load this week is above your usual base. Consider reducing intensity or duration of remaining sessions.'
        : popup.severity === 'heavy'
        ? 'Note: Fatigue has built this week. Monitor how you feel.'
        : '')
    : '';

  // Build optional ACWR context header
  const acwrHeader = (() => {
    if (!acwrContext) return '';
    const { ratio, status, safeUpper, intensityPct } = acwrContext;
    const pctAboveCeiling = Math.round((ratio / safeUpper - 1) * 100);
    const pctAboveBaseline = Math.round((ratio - 1) * 100);
    const statusBg = status === 'high'
      ? 'background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.25)'
      : 'background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.25)';
    const statusTextColor = status === 'high' ? 'color:var(--c-warn)' : 'color:var(--c-caution)';
    // §8 — 5-rule plain language reduction advice
    const { kmSpiked, crossTrainingCause, consecutiveIntensityWeeks } = acwrContext;
    const iHeavy = (intensityPct ?? 0) > 50;
    let zoneAdvice: string;
    if (consecutiveIntensityWeeks != null && consecutiveIntensityWeeks >= 3) {
      // Rule 4 — consecutive intensity-heavy weeks
      zoneAdvice = `Your last ${consecutiveIntensityWeeks} weeks have been intensity-heavy. Pulling back on intervals protects your aerobic base.`;
    } else if (crossTrainingCause) {
      // Rule 3 — cross-training drove the spike
      const sportLabel = crossTrainingCause === 'generic_sport'
        ? 'cross-training'
        : (SPORT_LABELS[crossTrainingCause as keyof typeof SPORT_LABELS]
            ?? crossTrainingCause.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).toLowerCase();
      zoneAdvice = `A ${sportLabel} session added load on top of your planned running. The adjustments below bring the week back in line. Quality sessions are preserved where possible.`;
    } else if (kmSpiked) {
      // Rule 2 — running km spiked (mechanical risk)
      zoneAdvice = 'Your running km spiked this week. Heart rate load is fine. The risk here is mechanical (tendons, bones), so volume should come down before intensity.';
    } else if (iHeavy) {
      // Rule 1 — ACWR elevated + intensity-heavy
      zoneAdvice = `Your load is ${pctAboveBaseline}% above your usual weekly volume and most of it was high-intensity work. Intensity is the biggest fatigue driver, so it should come down before volume.`;
    } else {
      // Rule 5 — trailing zone mix / general
      zoneAdvice = `Your load has built quickly. The safest cuts are to your highest-volume runs. Quality sessions stay intact where possible.`;
    }
    // Human-consequence headline: reference actual load vs baseline (not vs safety ceiling)
    const humanConsequence = status === 'high'
      ? `This week is ${pctAboveBaseline}% above your usual weekly load. Extra recovery is needed before the next hard effort.`
      : pctAboveCeiling <= 5
      ? `Your load is just above the safe ceiling (${ratio.toFixed(2)}× vs ${safeUpper.toFixed(1)}×). A small adjustment is enough.`
      : `This week is ${pctAboveBaseline}% above your usual load. Recovery between sessions matters more than usual.`;
    return `
      <div style="padding:16px 20px 0">
        <div style="${statusBg};border-radius:10px;padding:14px 16px;margin-bottom:4px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <svg style="width:14px;height:14px;${statusTextColor};flex-shrink:0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z"/>
            </svg>
            <span style="font-weight:600;${statusTextColor};font-size:14px">${status === 'high' ? 'Heavy training week' : 'Load building up'}</span>
          </div>
          <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin-bottom:8px">${humanConsequence}</p>
          <p style="font-size:12px;color:var(--c-faint)">${zoneAdvice}</p>
          <button id="acwr-details-toggle" style="margin-top:10px;font-size:11px;color:var(--c-faint);display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;padding:0">
            <span id="acwr-details-caret">▸</span> See details
          </button>
          <div id="acwr-details-body" style="display:none;margin-top:10px;flex-direction:column;gap:4px">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-faint)"><span>ATL (acute fatigue)</span><span style="color:var(--c-black)">${Math.round(acwrContext.ratio * (safeUpper * 50))}</span></div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-faint)"><span>Safe upper (your tier)</span><span style="color:var(--c-black)">${safeUpper.toFixed(1)}×</span></div>
            <div style="display:flex;justify-content:space-between;font-size:11px"><span style="color:var(--c-faint)">Current ratio</span><span style="${statusTextColor};font-weight:500">${ratio.toFixed(2)}×</span></div>
            ${intensityPct != null ? `<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-faint)"><span>Week intensity %</span><span style="color:var(--c-black)">${intensityPct}% threshold+hi</span></div>` : ''}
          </div>
        </div>
      </div>
    `;
  })();

  // Build optional cross-training activity header (Phase B v3)
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

    const sportEmoji: Record<string, string> = {
      football: '⚽', soccer: '⚽', cycling: '🚴', bike: '🚴', swim: '🏊', swimming: '🏊',
      yoga: '🧘', gym: '💪', strength: '💪', tennis: '🎾', rowing: '🚣', hiking: '🥾',
      basketball: '🏀', rugby: '🏉', running: '🏃',
    };
    const sportKey = sport.toLowerCase();
    const emoji = Object.entries(sportEmoji).find(([k]) => sportKey.includes(k))?.[1] ?? '🏅';
    const sportLabel = sport.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const hasHR = iTrimp != null || hrZones != null;

    return `
      <div style="padding:12px 20px 0">
        <div style="border:1px solid var(--c-border);border-radius:10px;padding:12px 14px;background:var(--c-bg);margin-bottom:4px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="color:var(--c-black);font-weight:500;font-size:14px">${emoji} ${sportLabel} · ${Math.round(durationMin)} min</span>
          </div>
          <div style="color:var(--c-muted);font-size:12px">
            ${hasHR ? `HR-based load: ${totalLoad2} · ` : `Estimated load: ${totalLoad2} · `}Effort type: ${effortLabel}
          </div>
          ${matchedRunName || matchedRunKm ? `
          <div style="border-top:1px solid var(--c-border);margin-top:10px;padding-top:10px">
            ${matchedRunName ? `<div style="color:var(--c-muted);font-size:12px;margin-bottom:4px">Matched to: <span style="color:var(--c-black)">${matchedRunName}${matchedRunKm ? ` (${formatKm(matchedRunKm, unitPref)})` : ''}</span></div>` : ''}
            <div style="display:flex;gap:12px;font-size:12px">
              ${cardioCoveredPct !== null ? `
                <button class="ctx-info-btn" data-ctx-info="cardio" style="background:none;border:none;cursor:pointer;color:var(--c-muted);padding:0">
                  Cardio covered: <span style="color:var(--c-black);font-weight:500">${cardioCoveredPct}%</span>
                </button>` : ''}
              ${kmGap !== null ? `
                <button class="ctx-info-btn" data-ctx-info="km" style="background:none;border:none;cursor:pointer;color:var(--c-muted);padding:0">
                  Running km gap: <span style="color:var(--c-black);font-weight:500">${formatKm(kmGap as number, unitPref)}</span>
                </button>` : ''}
            </div>
            <div id="ctx-info-cardio" style="display:none;margin-top:8px;font-size:12px;color:var(--c-faint);line-height:1.6">Cardio covered compares the aerobic load of this activity to your planned run. Above 80% means your heart and lungs get a similar stimulus without the running stress.</div>
            <div id="ctx-info-km" style="display:none;margin-top:8px;font-size:12px;color:var(--c-faint);line-height:1.6">Running km gap shows how many km of road running this session doesn't replace. Cross-training builds aerobic fitness but misses the bone, tendon, and neuromuscular adaptations of running.</div>
          </div>
          ` : ''}
        </div>
      </div>`;
  })();

  // When ACWR context is present, the amber box above already explains what happened.
  // Show a compact strip (just data provenance + impact) rather than duplicating the session details.
  const mainHeader = acwrContext
    ? `<div style="padding:8px 20px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:11px;color:${impactStyle.color}">${impactStyle.text}</span>
        ${equivKm ? `<span style="font-size:11px;color:var(--c-faint)">${equivKm}</span>` : ''}
      </div>`
    : `<div style="padding:20px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:flex-start;gap:16px">
          <div style="width:44px;height:44px;border-radius:50%;${sv.bg};${sv.border};display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg style="width:20px;height:20px;${sv.iconColor}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
          </div>
          <div style="flex:1">
            <h3 style="color:var(--c-black);font-weight:700;font-size:17px;margin-bottom:4px">${popup.headline}</h3>
            <p style="color:var(--c-muted);font-size:13px;line-height:1.6">${popup.summary}</p>
          </div>
        </div>
        <div style="margin-top:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="display:inline-flex;align-items:center;padding:6px 12px;border-radius:20px;${sv.badgeStyle};font-size:13px;font-weight:500">
            ${popup.durationMin} min ${popup.sportName} — ${popup.severity === 'extreme' ? 'Very high' : popup.severity === 'heavy' ? 'High' : 'Moderate'} load
          </span>
          ${equivKm ? `<span style="font-size:12px;color:var(--c-faint)">${equivKm}</span>` : ''}
          ${popup.warnings.length > 0 ? `<span style="font-size:12px;color:var(--c-caution)">${popup.warnings[0]}</span>` : ''}
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px">
          <span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-weight:500;${tierStyle}">${tierLabel}</span>
          <span style="color:${impactStyle.color}">${impactStyle.text}</span>
        </div>
      </div>`;

  const overlay = document.createElement('div');
  overlay.id = 'suggestion-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px;overflow-y:auto';

  overlay.innerHTML = `
    <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:16px;max-width:440px;width:100%;max-height:90vh;overflow-y:auto">
      ${acwrHeader}
      ${ctxHeader}
      ${mainHeader}

      <!-- §6.5 edge case: already completed run or no matching run -->
      ${popup.alreadyCompletedMatch ? `
      <div style="padding:16px 20px 0">
        <div style="background:rgba(37,99,235,0.05);border:1px solid rgba(37,99,235,0.2);border-radius:10px;padding:14px 16px">
          <div style="font-size:13px;color:var(--c-black);font-weight:500;margin-bottom:6px">
            Matched to: ${popup.alreadyCompletedMatch.runName} — but you already completed it
          </div>
          <p style="font-size:12px;color:var(--c-muted);line-height:1.6;margin-bottom:10px">
            Your session contributes to your weekly load (ACWR updated). Apply the load credit to next week's ${popup.alreadyCompletedMatch.runType.replace(/_/g,' ')} run instead?
          </p>
          <div style="display:flex;gap:8px">
            <button id="choice-apply-next-week" style="flex:1;padding:10px 12px;border-radius:8px;border:1.5px solid rgba(37,99,235,0.4);background:rgba(37,99,235,0.06);cursor:pointer;font-size:12px;font-weight:500;color:var(--c-accent);font-family:var(--f)">Apply to next week</button>
            <button id="choice-log-load-only" style="flex:1;padding:10px 12px;border-radius:8px;border:1.5px solid var(--c-border);background:transparent;cursor:pointer;font-size:12px;font-weight:500;color:var(--c-muted);font-family:var(--f)">Log load only</button>
          </div>
        </div>
      </div>` : ''}
      ${popup.noMatchingRun ? `
      <div style="padding:16px 20px 0">
        <div style="background:rgba(0,0,0,0.03);border:1px solid var(--c-border);border-radius:10px;padding:14px 16px">
          <div style="font-size:13px;color:var(--c-black);font-weight:500;margin-bottom:6px">No matching planned run this week</div>
          <p style="font-size:12px;color:var(--c-muted);line-height:1.6;margin-bottom:10px">
            Your session's load is counted in your weekly TSS. Apply the credit toward next week's plan?
          </p>
          <div style="display:flex;gap:8px">
            <button id="choice-apply-next-week" style="flex:1;padding:10px 12px;border-radius:8px;border:1.5px solid rgba(37,99,235,0.4);background:rgba(37,99,235,0.06);cursor:pointer;font-size:12px;font-weight:500;color:var(--c-accent);font-family:var(--f)">Match to next week</button>
            <button id="choice-log-load-only" style="flex:1;padding:10px 12px;border-radius:8px;border:1.5px solid var(--c-border);background:transparent;cursor:pointer;font-size:12px;font-weight:500;color:var(--c-muted);font-family:var(--f)">Log as load only</button>
          </div>
        </div>
      </div>` : ''}

      <!-- 3 Global Choices -->
      <div style="padding:16px 20px;display:flex;flex-direction:column;gap:10px">

        ${!hasReductions && !hasReplacements ? `
        <div style="padding:12px 14px;border-radius:10px;background:var(--c-surface);border:1px solid var(--c-border);font-size:13px;color:var(--c-muted);line-height:1.5">
          Your remaining runs are already at minimum intensity and distance. The extra load can't be absorbed by trimming this week's plan. Push it to next week or keep the plan and accept the added stimulus.
        </div>
        ` : ''}

        <!-- REPLACE option (only show if there are replacements) -->
        ${hasReplacements ? `
        <button id="choice-replace" style="width:100%;text-align:left;padding:14px 16px;border-radius:12px;border:1.5px solid var(--c-border-strong);background:var(--c-bg);cursor:pointer">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-weight:700;color:var(--c-warn);font-size:16px">Replace & Reduce</span>
            <span style="font-size:11px;color:var(--c-faint)">Recommended for heavy loads</span>
          </div>
          <p style="color:var(--c-muted);font-size:13px;margin-bottom:10px">Replace runs where possible, downgrade the rest. Best for heavy cross-training.</p>
          <details style="font-size:12px">
            <summary style="color:var(--c-faint);cursor:pointer">View changes (${popup.replaceOutcome.adjustments.length})</summary>
            <div style="margin-top:8px;background:var(--c-surface);border-radius:8px;padding:10px">
              ${buildAdjustmentList(popup.replaceOutcome.adjustments)}
            </div>
          </details>
        </button>
        ` : ''}

        <!-- REDUCE option -->
        ${hasReductions ? `
        <button id="choice-reduce" style="width:100%;text-align:left;padding:14px 16px;border-radius:12px;${!hasReplacements ? 'border:2px solid var(--c-caution);background:rgba(245,158,11,0.04)' : 'border:1.5px solid var(--c-border-strong);background:var(--c-bg)'};cursor:pointer">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-weight:700;color:var(--c-caution);font-size:16px">Reduce</span>
            ${!hasReplacements ? '<span style="font-size:11px;background:rgba(245,158,11,0.15);color:var(--c-caution);padding:2px 8px;border-radius:4px">Recommended</span>' : ''}
          </div>
          <p style="color:var(--c-muted);font-size:13px;margin-bottom:10px">Downgrade intensity and/or reduce distance. Keeps all runs in your plan.</p>
          <details style="font-size:12px" ${!hasReplacements ? 'open' : ''}>
            <summary style="color:var(--c-faint);cursor:pointer">View changes (${popup.reduceOutcome.adjustments.length})</summary>
            <div style="margin-top:8px;background:var(--c-surface);border-radius:8px;padding:10px">
              ${buildAdjustmentList(popup.reduceOutcome.adjustments)}
            </div>
          </details>
        </button>
        ` : ''}

        <!-- PUSH TO NEXT WEEK option (only shown when callback provided) -->
        ${onPushToNextWeek ? `
        <button id="choice-push-next-week" style="width:100%;text-align:left;padding:14px 16px;border-radius:12px;${!hasReductions && !hasReplacements ? 'border:2px solid var(--c-ok);background:rgba(34,197,94,0.04)' : 'border:1.5px solid var(--c-border-strong);background:var(--c-bg)'};cursor:pointer">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-weight:700;color:${!hasReductions && !hasReplacements ? 'var(--c-ok)' : 'var(--c-black)'};font-size:16px">Push to next week</span>
            ${!hasReductions && !hasReplacements ? '<span style="font-size:11px;background:rgba(34,197,94,0.15);color:var(--c-ok);padding:2px 8px;border-radius:4px">Recommended</span>' : ''}
          </div>
          <p style="color:var(--c-muted);font-size:13px">Keep this week unchanged. The excess load carries to next week.</p>
        </button>
        ` : ''}

        <!-- KEEP option -->
        <button id="choice-keep" style="width:100%;text-align:left;padding:14px 16px;border-radius:12px;${!hasReductions && !onPushToNextWeek ? 'border:2px solid var(--c-ok);background:rgba(34,197,94,0.04)' : 'border:1.5px solid var(--c-border-strong);background:var(--c-bg)'};cursor:pointer">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-weight:700;color:${!hasReductions && !onPushToNextWeek ? 'var(--c-ok)' : 'var(--c-black)'};font-size:16px">Keep Plan</span>
            ${!hasReductions && !onPushToNextWeek ? '<span style="font-size:11px;background:rgba(34,197,94,0.15);color:var(--c-ok);padding:2px 8px;border-radius:4px">Recommended</span>' : ''}
          </div>
          <p style="color:var(--c-muted);font-size:13px">Keep your running plan unchanged.</p>
          ${keepWarning ? `<p style="color:var(--c-caution);font-size:12px;margin-top:6px">${keepWarning}</p>` : ''}
        </button>

      </div>

      <!-- Footer -->
      <div style="padding:0 20px 20px">
        <button id="close-modal" style="width:100%;padding:10px;background:none;border:none;color:var(--c-faint);font-size:13px;cursor:pointer">
          Dismiss
        </button>
      </div>
    </div>
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
    overlay.remove();
    if (choice) {
      onComplete({ choice, adjustments });
    } else {
      onComplete(null);
    }
  };

  // Event handlers
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(null, []);
  });

  // Prevent the <summary> toggle click from bubbling to the parent choice button.
  // Only block the summary toggle itself — clicks on expanded content should
  // still reach the button so the user can select the option by clicking anywhere on the card.
  overlay.querySelectorAll('details summary').forEach(summary => {
    summary.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  // §6.5 edge case buttons — fire 'keep' with empty adjustments (load already counted in ACWR)
  overlay.querySelector('#choice-apply-next-week')?.addEventListener('click', () => {
    close('keep', []);
  });
  overlay.querySelector('#choice-log-load-only')?.addEventListener('click', () => {
    close('keep', []);
  });

  overlay.querySelector('#choice-push-next-week')?.addEventListener('click', () => {
    close(null, []);
    onPushToNextWeek?.();
  });

  overlay.querySelector('#choice-replace')?.addEventListener('click', () => {
    close('replace', popup.replaceOutcome.adjustments);
  });

  overlay.querySelector('#choice-reduce')?.addEventListener('click', () => {
    close('reduce', popup.reduceOutcome.adjustments);
  });

  overlay.querySelector('#choice-keep')?.addEventListener('click', () => {
    close('keep', []);
  });

  overlay.querySelector('#close-modal')?.addEventListener('click', () => {
    close(null, []);
  });
}

// Legacy export for backwards compatibility
export type { SuggestionDecision as SuggestionDecisionLegacy };
