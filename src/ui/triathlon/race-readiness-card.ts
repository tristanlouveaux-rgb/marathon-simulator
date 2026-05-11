/**
 * Race-readiness summary card for the triathlon Forecast page.
 *
 * Shows three per-discipline bars (swim/bike/run) with 0-100 readiness score
 * and label. Tap-through opens the detail view (`race-readiness-detail.ts`)
 * for the actionable breakdown ("you need 2 more weeks of long rides").
 *
 * Data source: `state.triConfig.prediction.raceReadiness` — populated by
 * `predictTriathlonRace` whenever the prediction is computed. If absent
 * (no prediction yet, race distance not set), this card returns ''.
 *
 * Visual pattern: mirrors the discipline-readiness bars in
 * `src/ui/readiness-view.ts:479-512` (daily readiness) for consistency.
 */

import type { SimulatorState } from '@/types/state';
import type { RaceReadinessResult } from '@/calculations/race-readiness';

const TEXT_M = '#374151';
const TEXT_S = '#6B7280';

/**
 * Map readiness tone → bar colour. Mirrors `readinessColor()` from the daily
 * readiness module so the colour palette stays consistent across surfaces.
 */
function readinessBarColor(tone: 'ok' | 'caution' | 'warn'): string {
  if (tone === 'ok') return 'var(--c-ok, #16A34A)';
  if (tone === 'caution') return 'var(--c-caution, #D97706)';
  return 'var(--c-warn, #DC2626)';
}

function makeBar(
  discName: string,
  result: { score: number; label: string; tone: 'ok' | 'caution' | 'warn' },
  isLast: boolean,
): string {
  const col = readinessBarColor(result.tone);
  return `
    <div style="${isLast ? '' : 'margin-bottom:14px'}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
        <div style="font-size:12px;font-weight:600;color:${TEXT_M}">${discName}</div>
        <div style="display:flex;align-items:baseline;gap:6px">
          <div style="font-size:14px;font-weight:600;color:${col}">${result.score}</div>
          <div style="font-size:11px;color:${TEXT_S}">${result.label}</div>
        </div>
      </div>
      <div style="position:relative;height:8px;border-radius:4px;background:rgba(0,0,0,0.07);overflow:hidden">
        <div style="position:absolute;left:0;top:0;height:100%;width:${result.score}%;background:${col};border-radius:4px;transition:width 0.8s cubic-bezier(0.2,0.8,0.2,1)"></div>
      </div>
    </div>`;
}

/**
 * Render the race-readiness summary card. Returns '' when no readiness data
 * is available (no prediction yet). When rendered, includes a click handler
 * id (`race-readiness-detail-trigger`) that the parent view wires to open
 * the detail page.
 */
export function renderRaceReadinessCard(state: SimulatorState): string {
  const readiness: RaceReadinessResult | undefined =
    state.triConfig?.prediction?.raceReadiness;
  if (!readiness) return '';

  const swim = makeBar('Swim', readiness.swim, false);
  const bike = makeBar('Bike', readiness.bike, false);
  const run  = makeBar('Run',  readiness.run,  true);

  // Only show the panel if any discipline is below "race ready" — when the
  // athlete is fully prepared across all three, the panel adds no value
  // and clutters the forecast page.
  const showSummary = readiness.overallScore < 90;
  if (!showSummary) return '';

  return `
    <div style="margin-bottom:18px">
      <button
        id="race-readiness-detail-trigger"
        style="
          width:100%;
          background:rgba(255,255,255,0.92);
          border:1px solid rgba(0,0,0,0.05);
          border-radius:16px;
          padding:18px 20px;
          text-align:left;
          cursor:pointer;
          -webkit-tap-highlight-color:transparent;
        "
      >
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
          <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">Race readiness</div>
          <div style="font-size:11px;color:${TEXT_S}">${readiness.overallLabel} · tap for detail ›</div>
        </div>
        ${swim}
        ${bike}
        ${run}
      </button>
    </div>
  `;
}
