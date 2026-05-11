/**
 * Race forecast card (§18.8).
 *
 * Headline = projected race-day time (assumes plan execution). Sub-line shows
 * "if you raced today" plus the gap the plan delivers. Confidence range
 * narrows with weeks remaining + years of training.
 *
 * Below the headline:
 *   - Proportional discipline bar (swim / bike / run composition)
 *   - Per-leg breakdown with deltas vs today
 *   - T1 / T2
 *   - Projected fitness markers
 *   - Course factors panel (climate, altitude, elevation, wind, swim type)
 *   - Sprint/Olympic side-effects
 */

import type { SimulatorState } from '@/types/state';
import type { CourseFactorEntry, LimitingFactor, TriRacePrediction } from '@/types/triathlon';
import type { CourseProfile } from '@/types/onboarding';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { predictCyclingEvent } from '@/calculations/race-prediction.cycling';
import { validateAgainstDistribution, type DistributionTable } from '@/validation/distribution';
import splitDistJson from '@/constants/empirical-split-distributions.json';
import { DISCIPLINE_COLOURS } from './colours';
import { isCyclingOnlyMode, getCyclingEventLabel } from '@/calculations/cycling-mode';
import { gp } from '@/calculations/paces';
import { getTriathlonById } from '@/data/triathlons';
import { COURSE_PROFILES } from '@/data/triathlon-course-profiles';
import { CYCLING_EVENTS } from '@/data/cycling-events';

const SPLIT_DIST_TABLES = splitDistJson as unknown as Record<string, DistributionTable>;

/**
 * Single source of truth for whether a course-factor array came from the
 * empirical (calibrated) model vs the physical fallback. Empirical entries
 * carry a `value` like "high, n=6480"; physical entries carry descriptive
 * values like "Cool (~12°C)" or "+200 m gain". The panel renderer and the
 * calibration caption both need this signal — if the empirical-output value
 * format ever changes, only this helper needs updating.
 */
function isEmpiricalFactors(factors: CourseFactorEntry[]): boolean {
  return factors.length > 0 && /n=\d+/.test(factors[0].value);
}

export function renderRaceForecastCard(state: SimulatorState): string {
  const tri = state.triConfig;
  if (!tri) return '';

  // Cycling-only mode: the multi-leg forecast doesn't apply.
  if (isCyclingOnlyMode(state)) return '';

  const p: TriRacePrediction | null = tri.prediction ?? predictTriathlonRace(state);
  if (!p) return `
    <div style="margin-bottom:28px">
      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:16px;padding:24px 22px 20px">
        <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Race forecast</div>
        <div style="font-size:15px;font-weight:500;color:#0F172A;margin-bottom:6px">Forecast not yet available</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5">A bike FTP and swim CSS are needed to compute your race time. Use the benchmark tests at the top of your plan to set them.</div>
      </div>
    </div>
  `;

  const distLabel = tri.distance === 'ironman' ? 'Ironman' : '70.3';

  const halfBandSec = Math.round((p.totalRangeSec[1] - p.totalRangeSec[0]) / 4);
  const halfBandMin = Math.max(1, Math.round(halfBandSec / 60));
  const weeksRemaining = p.projection?.weeksRemaining ?? 0;
  const willNarrow = weeksRemaining > 4;

  const todayLine = p.currentTotalSec != null
    ? `<span style="color:var(--c-muted)">Today ${fmtDuration(p.currentTotalSec)}</span><span style="color:var(--c-faint)"> · </span>`
    : '';

  return `
    <div style="margin-bottom:28px">
      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:16px;padding:24px 22px 20px">

        <!-- Label -->
        <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">${distLabel} race-day target</div>

        <!-- Hero time -->
        <div style="font-size:54px;font-weight:200;color:var(--c-black);font-variant-numeric:tabular-nums;letter-spacing:-0.025em;line-height:1">${fmtDuration(p.totalSec)}</div>

        <!-- Gap callout: the plan's headline value -->
        ${renderGapCallout(p)}

        <!-- Today + tolerance as secondary -->
        <div style="font-size:12px;margin-top:10px;line-height:1.5">
          ${todayLine}<span style="color:var(--c-faint)">±${halfBandMin} min${willNarrow ? ' · narrows to race day' : ''}</span>
        </div>

        <!-- Per-leg breakdown -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:24px">
          ${legCell('Swim', p.swimSec, DISCIPLINE_COLOURS.swim.accent, p.currentSwimSec, swimLowConfidenceFlag(state))}
          ${legCell('Bike', p.bikeSec, DISCIPLINE_COLOURS.bike.accent, p.currentBikeSec, bikeLowConfidenceFlag(state))}
          ${legCell('Run',  p.runSec,  DISCIPLINE_COLOURS.run.accent,  p.currentRunSec)}
        </div>

        <!-- Transitions: tap to open the override overlay (also surfaces the
             empirical lookup provenance — average at this race × your level). -->
        <button id="tri-fc-transitions-btn" type="button" style="display:flex;align-items:center;gap:14px;width:100%;background:transparent;border:none;padding:8px 0;margin-top:8px;cursor:pointer;text-align:left;font-family:var(--f);-webkit-tap-highlight-color:transparent">
          <span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">T1: ${fmtShort(p.t1Sec)}</span>
          <span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">T2: ${fmtShort(p.t2Sec)}</span>
          <span style="font-size:11px;color:var(--c-muted);margin-left:auto">Adjust →</span>
        </button>

        ${renderProjectedMarkers(p, state)}
        ${renderDistributionBanner(p, tri.distance)}
        ${renderCourseFactorsPanel(
          p.courseFactors ?? [],
          getTriathlonById(state.onboarding?.selectedTriathlonId ?? '')?.name ?? null,
          COURSE_PROFILES[state.onboarding?.selectedTriathlonId ?? ''] ?? null,
        )}

        <!-- Calibration caption — honest about which source generated this prediction's course factors -->
        ${(() => {
          const isEmpirical = isEmpiricalFactors(p.courseFactors ?? []);
          const caption = isEmpirical
            ? `Calibrated against <span style="color:var(--c-black);font-weight:500">1.3 million</span> historical Ironman and 70.3 race finishes (CoachCox, Kaggle, 2002 to 2024). Course factors for this race are derived from real splits, controlled for athlete quality.`
            : `Course factors for this race use the physical model (climate, altitude, elevation, wind, swim type). The dataset of 1.3 million historical Ironman and 70.3 finishes (CoachCox, Kaggle) doesn't yet cover this venue or has too few finishers for a reliable empirical fit.`;
          return `<div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.06);font-size:10px;color:var(--c-faint);line-height:1.5">${caption}</div>`;
        })()}

        ${p.sprintTotalSec || p.olympicTotalSec ? `
          <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(0,0,0,0.06);font-size:12px;color:var(--c-muted);line-height:1.6">
            ${p.sprintTotalSec ? `Sprint: <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(p.sprintTotalSec)}</span>` : ''}
            ${p.sprintTotalSec && p.olympicTotalSec ? ' · ' : ''}
            ${p.olympicTotalSec ? `Olympic: <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(p.olympicTotalSec)}</span>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Cycling-only finish-time card
// ───────────────────────────────────────────────────────────────────────────

export function renderCyclingFinishCard(state: SimulatorState): string {
  const eventLabel = getCyclingEventLabel(state) ?? 'Cycling';
  const p = predictCyclingEvent(state);

  if (!p) return `
    <div style="margin-bottom:28px">
      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:16px;padding:24px 22px 20px">
        <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Event target</div>
        <div style="font-size:15px;font-weight:500;color:#0F172A;margin-bottom:6px">Forecast not yet available</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5">Set your FTP with the benchmark test in your plan to get a finish-time prediction.</div>
      </div>
    </div>
  `;

  const halfBandSec = (p.totalRangeSec[1] - p.totalRangeSec[0]) / 2;
  const halfBandMin = Math.max(1, Math.round(halfBandSec / 60));

  const course = state.triConfig?.bike?.courseProfile ?? 'flat';
  const courseLabel = course === 'flat' ? 'flat' : course;

  const factorsPanel = renderCyclingCourseFactorsPanel(p);
  const inputsPanel = renderCyclingCourseInputsPanel(state);

  return `
    <div style="margin-bottom:28px">
      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:16px;padding:24px 22px 20px">

        <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">${eventLabel} event target</div>

        <div style="font-size:54px;font-weight:200;color:var(--c-black);font-variant-numeric:tabular-nums;letter-spacing:-0.025em;line-height:1">${fmtDuration(p.totalSec)}</div>

        <div style="font-size:13px;color:var(--c-muted);margin-top:10px;line-height:1.5">
          ${p.avgKph} kph · ±${halfBandMin} min
        </div>

        ${factorsPanel}

        ${inputsPanel}

        <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(0,0,0,0.06);display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--c-muted)">
          <span>${p.avgWatts}W</span>
          <span>IF ${p.intensityFactor.toFixed(2)}</span>
          <span>${courseLabel}</span>
          <span style="flex:1"></span>
          <button id="tri-bike-setup-btn" style="background:transparent;border:none;padding:0;font-size:11px;color:var(--c-muted);cursor:pointer">Bike &amp; aero →</button>
        </div>
      </div>
    </div>
  `;
}

function renderCyclingCourseInputsPanel(state: SimulatorState): string {
  const eventId = state.onboarding?.cyclingEventId ?? '';
  const climate = state.onboarding?.cyclingClimate ?? '';
  const altitudeM = state.onboarding?.cyclingAltitudeM ?? '';

  const eventOptions = CYCLING_EVENTS
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => `<option value="${e.id}" ${eventId === e.id ? 'selected' : ''}>${e.name}</option>`)
    .join('');

  const climateOptions = (['cool', 'temperate', 'warm', 'hot', 'hot-humid'] as const)
    .map(c => `<option value="${c}" ${climate === c ? 'selected' : ''}>${climateLabel(c)}</option>`)
    .join('');

  const inputStyle = `padding:7px 10px;border-radius:9px;border:1px solid var(--c-border);background:var(--c-bg);color:var(--c-black);font-size:12px;font-family:var(--f);outline:none`;

  return `
    <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(0,0,0,0.06)">
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Course inputs</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <select id="cyc-event" style="${inputStyle};grid-column:1/-1">
          <option value="">Custom event</option>
          ${eventOptions}
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <select id="cyc-climate" style="${inputStyle}">
          <option value="">Climate (auto)</option>
          ${climateOptions}
        </select>
        <input id="cyc-altitude" type="number" min="0" max="4500" step="50" placeholder="Altitude m" value="${altitudeM}" style="${inputStyle}" />
      </div>
      <p style="font-size:11px;color:var(--c-faint);margin:8px 0 0;line-height:1.5">Pick a known event to auto-fill, or set climate and altitude manually for a custom course.</p>
    </div>
  `;
}

function climateLabel(c: 'cool' | 'temperate' | 'warm' | 'hot' | 'hot-humid'): string {
  switch (c) {
    case 'cool':       return 'Cool';
    case 'temperate':  return 'Temperate';
    case 'warm':       return 'Warm';
    case 'hot':        return 'Hot';
    case 'hot-humid':  return 'Hot and humid';
  }
}

function renderCyclingCourseFactorsPanel(p: ReturnType<typeof predictCyclingEvent>): string {
  if (!p || !p.courseFactors || p.courseFactors.length === 0) return '';
  const rows = p.courseFactors.map(f => {
    const pct = (f.multiplier - 1) * 100;
    const sign = pct > 0 ? '+' : '−';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12px">
        <span style="color:var(--c-muted)">${f.label}</span>
        <span style="display:flex;gap:14px;align-items:center">
          <span style="color:var(--c-black)">${f.value}</span>
          <span style="color:var(--c-faint);font-variant-numeric:tabular-nums">${sign}${Math.abs(pct).toFixed(1)}%</span>
        </span>
      </div>
    `;
  }).join('');
  const compoundedMult = p.courseFactors.reduce((acc, f) => acc * f.multiplier, 1);
  const totalPct = (compoundedMult - 1) * 100;
  const slowerOrFaster = totalPct >= 0 ? 'slower' : 'faster';
  const totalSign = totalPct >= 0 ? '+' : '−';
  return `
    <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(0,0,0,0.06)">
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Course factors</div>
      <div style="font-size:11px;color:var(--c-muted);margin-bottom:8px;line-height:1.5">Riders tend to go ${totalSign}${Math.abs(totalPct).toFixed(1)}% ${slowerOrFaster} here than on a flat, cool, sea-level course. Raw physics: ${fmtDuration(p.rawSec)}.</div>
      ${rows}
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-renders
// ───────────────────────────────────────────────────────────────────────────

function renderGapCallout(p: TriRacePrediction): string {
  if (p.currentTotalSec == null) return '';
  const gap = p.currentTotalSec - p.totalSec; // positive = plan delivers improvement
  if (Math.abs(gap) < 60) return '';

  const lines: string[] = [];

  if (gap > 0) {
    lines.push(`
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:14px">
        <span style="font-size:22px;font-weight:400;color:var(--c-ok);font-variant-numeric:tabular-nums">−${fmtShort(gap)}</span>
        <span style="font-size:13px;color:var(--c-muted)">faster by race day</span>
      </div>
    `);
  } else {
    lines.push(`<div style="font-size:14px;color:var(--c-muted);margin-top:12px">+${fmtShort(Math.abs(gap))} vs today</div>`);
  }

  if (p.adaptation) {
    const deltas = [
      { d: 'Run',  v: (p.adaptation.run  - 1) * 100 },
      { d: 'Bike', v: (p.adaptation.bike - 1) * 100 },
      { d: 'Swim', v: (p.adaptation.swim - 1) * 100 },
    ].filter(x => Math.abs(x.v) >= 5);
    if (deltas.length > 0) {
      const phrase = deltas
        .map(x => `${x.d.toLowerCase()} ${x.v > 0 ? '+' : ''}${x.v.toFixed(0)}%`)
        .join(', ');
      lines.push(
        `<div style="font-size:11px;color:var(--c-muted);margin-top:6px">Fitness responding ${phrase} vs expected — projection adjusted.</div>`,
      );
    }
  }

  return lines.join('');
}

function renderDisciplineBar(p: TriRacePrediction): string {
  const total = p.swimSec + p.bikeSec + p.runSec;
  if (total <= 0) return '';
  return `
    <div style="margin-top:22px;display:flex;height:4px;border-radius:2px;overflow:hidden;gap:2px">
      <div style="flex:${p.swimSec};background:${DISCIPLINE_COLOURS.swim.accent}"></div>
      <div style="flex:${p.bikeSec};background:${DISCIPLINE_COLOURS.bike.accent}"></div>
      <div style="flex:${p.runSec};background:${DISCIPLINE_COLOURS.run.accent}"></div>
    </div>
  `;
}

const OUT_OF_BAND_Z = 2.5;

function renderDistributionBanner(p: TriRacePrediction, distance: '70.3' | 'ironman'): string {
  const table = SPLIT_DIST_TABLES[distance];
  if (!table) return '';
  const result = validateAgainstDistribution(
    { swimSec: p.swimSec, bikeSec: p.bikeSec, runSec: p.runSec, finishSec: p.totalSec },
    table,
  );
  if (!result.swim || !result.bike || !result.run) return '';

  const legs: Array<{ name: string; v: typeof result.swim }> = [
    { name: 'swim', v: result.swim },
    { name: 'bike', v: result.bike },
    { name: 'run',  v: result.run  },
  ];
  const flagged = legs.filter(l => Math.abs(l.v.zScore) > OUT_OF_BAND_Z);
  if (flagged.length === 0) return '';

  const lines = flagged.map(({ name, v }) => {
    const actual  = Math.round(v.fraction * 1000) / 10;
    const lo      = Math.round((v.expectedMean - v.expectedSD) * 1000) / 10;
    const hi      = Math.round((v.expectedMean + v.expectedSD) * 1000) / 10;
    return `${name.charAt(0).toUpperCase() + name.slice(1)} split: ${actual}% of total time. Typical at this finish level: ${lo}–${hi}%.`;
  });

  return `
    <div style="margin-bottom:14px;padding:10px 12px;border-radius:10px;background:#F4F1E8;border:1px solid #DDD3B6;font-size:12px;color:#6B5B2E;line-height:1.55">
      ${lines.join('<br>')}
    </div>
  `;
}

function renderLimitingBanner(limitingFactor: LimitingFactor | undefined): string {
  if (!limitingFactor) return '';
  const msg = (() => {
    switch (limitingFactor) {
      case 'long_ride_volume':
        return 'Today\'s run leg would suffer from limited long-ride volume. The plan\'s long rides will close this gap.';
      case 'long_run_volume':
        return 'Today\'s run leg would suffer from limited long-run volume. The plan\'s long runs will close this gap.';
      case 'volume_durability':
        return 'Today\'s run leg would suffer from limited long-session volume in both disciplines. The plan\'s long sessions will close this gap.';
    }
  })();
  return `
    <div style="margin-bottom:14px;padding:10px 12px;border-radius:10px;background:#F4F1E8;border:1px solid #DDD3B6;font-size:12px;color:#6B5B2E;line-height:1.45">
      ${msg}
    </div>
  `;
}

function renderCourseFactorsPanel(
  factors: CourseFactorEntry[],
  raceName: string | null,
  profile: CourseProfile | null,
): string {
  // Both modes render one row per leg so calibrated and uncalibrated venues
  // share the same shape. Physical mode aggregates its per-dimension entries
  // (climate + altitude + elevation + wind + swim-type) into a single delta
  // per leg, with the contributing dimensions surfaced as a breakdown line.
  const isEmpirical = isEmpiricalFactors(factors);

  const legOrder: Array<'swim' | 'bike' | 'run'> = ['swim', 'bike', 'run'];
  const aggregated = legOrder
    .map(leg => {
      const legFactors = factors.filter(f => f.leg === leg);
      if (legFactors.length === 0) return null;
      const totalDelta = legFactors.reduce((sum, f) => sum + f.deltaSec, 0);
      const dimensionLabels = legFactors.map(f => f.label);
      return { leg, totalDelta, legFactors, dimensionLabels };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const rows = aggregated.map(({ leg, totalDelta, legFactors, dimensionLabels }) => {
    const faster = totalDelta < 0;
    const sign = totalDelta > 0 ? '+' : '−';
    const deltaColor = faster ? 'var(--c-ok)' : 'var(--c-black)';
    const deltaTxt = `${sign}${fmtShort(Math.abs(totalDelta))}`;
    const legLabel = leg.charAt(0).toUpperCase() + leg.slice(1);

    // Commentary line:
    //   - empirical: human-written description from the venue's physical
    //     attributes (legCommentary)
    //   - physical: list the dimensions that drove the delta (Climate, Run
    //     elevation, Wind ...) so the user can see *why* the leg slows or
    //     speeds rather than just "Run +26:54" with no cause.
    let commentary = '';
    if (isEmpirical) {
      commentary = legCommentary(leg, totalDelta, profile);
    } else if (legFactors.length === 1) {
      // Single-dimension hit — show the descriptive value directly
      // (e.g. "Hot-humid (~30°C)") so the user sees the actual reading.
      commentary = `${legFactors[0].label} · ${legFactors[0].value}`;
    } else {
      commentary = dimensionLabels.join(' · ');
    }

    return `
      <div style="padding:10px 0;font-size:12px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="color:var(--c-muted)">${legLabel}</span>
          <span style="color:${deltaColor};font-variant-numeric:tabular-nums">${deltaTxt}</span>
        </div>
        ${commentary ? `<div style="color:var(--c-faint);margin-top:4px;line-height:1.45">${commentary}</div>` : ''}
      </div>
    `;
  }).join('');

  // Venue sample size sits quietly at the bottom of the panel — confidence
  // and n are the same across all three legs (single empirical fit per
  // venue), so surface them once instead of repeating on every row.
  // Physical-mode entries have no n, so this footer is skipped naturally.
  const nMatch = isEmpirical ? factors[0]?.value.match(/n=(\d+)/) : null;
  const venueN = nMatch ? Number(nMatch[1]) : null;
  const venueFooter = venueN
    ? `<div style="margin-top:8px;font-size:11px;color:var(--c-faint)">${venueN.toLocaleString()} finishes from this venue.</div>`
    : '';

  // Altitude acclimatisation flag — empirical course factors are talent-
  // controlled but include altitude-acclimatised locals, so a sea-level
  // athlete racing at altitude may face a larger effective penalty than the
  // factor suggests. We don't know where the user trains, so we flag it
  // and let them weight it. Threshold 800m matches when altitude has a
  // measurable physiological effect (≈4-5% VO2max reduction at 1500m).
  const altitudeM = profile?.altitudeM ?? 0;
  const altitudeNote = altitudeM >= 800
    ? `<div style="margin-top:6px;font-size:11px;color:var(--c-faint);line-height:1.5">Race altitude is ${altitudeM} m. Penalty depends on your acclimatisation, which we don't track. Sea-level athletes may run slower than the factor suggests.</div>`
    : '';

  return `
    <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(0,0,0,0.06)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">Course factors</span>
          ${raceName ? `<span style="font-size:11px;color:var(--c-muted)">· ${raceName}</span>` : ''}
        </div>
        <button id="tri-bike-setup-btn" style="background:transparent;border:none;padding:0;font-size:11px;color:var(--c-muted);cursor:pointer">Bike &amp; aero →</button>
      </div>
      ${factors.length > 0 ? rows : `<div style="font-size:12px;color:var(--c-faint);padding:8px 0">Set climate, elevation, and wind on the race plan to refine the forecast.</div>`}
      ${venueFooter}
      ${altitudeNote}
    </div>
  `;
}

/**
 * Per-leg commentary derived from the venue's published physical attributes.
 *
 * Empirical course factors fuse physics, race-day weather, and field
 * composition into a single multiplier — we can't decompose them. So this
 * function describes the physical attributes that plausibly explain the
 * direction of the delta and is honest where physics alone doesn't (a flat
 * course that still runs slow points to weather and field, not terrain).
 *
 * Rule: only generate commentary when the physical attributes credibly
 * explain the direction we see. If a "tough" course (hilly, mountainous,
 * exposed) reads faster than reference, that's most likely a field-strength
 * signal we have no independent data on — we return empty rather than
 * speculate.
 */
function legCommentary(
  leg: 'swim' | 'bike' | 'run',
  deltaSec: number,
  profile: CourseProfile | null,
): string {
  if (!profile) return '';
  const slow = deltaSec > 0;

  if (leg === 'swim') {
    const exposed = profile.windExposure === 'exposed';
    switch (profile.swimType) {
      case 'ocean-current-assisted':
        return slow ? '' : 'Current-assisted swim shaves time vs still water.';
      case 'river':
        return slow ? '' : 'River swim with current assist.';
      case 'ocean':
        if (slow) return exposed ? 'Saltwater ocean swim with exposed wind. Chop and sighting slow it.' : 'Saltwater ocean swim, no current to draft.';
        return '';
      case 'wetsuit-lake':
      case 'non-wetsuit-lake':
        if (slow) return exposed ? 'Open lake swim with exposed wind. Chop and sighting slow this leg vs sheltered or current-assisted swims.' : 'Standing-water lake swim, no current to draft.';
        return 'Sheltered lake swim, no chop or current to fight.';
    }
    return '';
  }

  if (leg === 'bike') {
    const elev = profile.bikeElevationM;
    const hasElev = elev != null && elev > 0;
    const elevPhrase = hasElev ? ` ${elev.toLocaleString()}m` : '';
    const exposed = profile.windExposure === 'exposed';
    const lowAlt = (profile.altitudeM ?? 0) < 250;
    switch (profile.bikeProfile) {
      case 'mountainous':
      case 'hilly':
        // Faster than reference on a hilly course is most likely a field
        // signal we can't verify — stay quiet rather than speculate.
        return slow && hasElev ? `${elev.toLocaleString()}m of climbing on the bike.` : '';
      case 'rolling':
        if (slow) return exposed ? `Rolling${elevPhrase} bike with exposed crosswinds.` : `Rolling${elevPhrase} bike profile.`;
        return '';
      case 'flat':
        if (slow) return exposed ? 'Flat course but exposed crosswinds slow the leg.' : 'Flat course; conditions or field pace explain the gap.';
        return lowAlt ? `Pancake-flat${elevPhrase} course at low altitude.` : `Flat${elevPhrase} course.`;
    }
    return '';
  }

  // Run
  const elev = profile.runElevationM;
  const hasElev = elev != null && elev > 0;
  const elevPhrase = hasElev ? ` ${elev.toLocaleString()}m` : '';
  const climate = profile.climate;
  const hot = climate === 'hot' || climate === 'hot-humid';
  const warm = climate === 'warm';
  const exposed = profile.windExposure === 'exposed';
  switch (profile.runProfile) {
    case 'hilly':
      return slow && hasElev ? `Hilly run with ${elev!.toLocaleString()}m of gain on a fatigued body.` : '';
    case 'rolling':
      return slow ? `Rolling run${elevPhrase} on tired legs.` : '';
    case 'flat':
      if (slow) {
        if (hot) return 'Flat course but heat and humidity tax the run leg.';
        if (warm && exposed) return `Flat${elevPhrase} course; warm conditions and exposed wind weigh on the leg.`;
        if (warm) return `Flat${elevPhrase} course; warm race-day conditions slow the run.`;
        return `Flat${elevPhrase} course; slower than terrain alone suggests. Field and conditions explain the gap.`;
      }
      return `Flat${elevPhrase} course in cool to temperate conditions.`;
  }
  return '';
}

function legCell(label: string, sec: number, accent: string, currentSec?: number, lowConfidenceFlag?: string): string {
  const gap = currentSec != null ? currentSec - sec : null;
  const showGap = gap != null && Math.abs(gap) >= 30;
  return `
    <div style="border-left:2px solid ${accent};border-radius:10px;padding:14px 12px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${label}</span>
        ${lowConfidenceFlag ? `<span title="${lowConfidenceFlag}" style="font-size:9px;color:#a89060;background:#FAF3E2;padding:1px 5px;border-radius:6px">${lowConfidenceFlag}</span>` : ''}
      </div>
      <div style="font-size:17px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(sec)}</div>
      ${showGap ? `<div style="font-size:10px;color:${gap! > 0 ? 'var(--c-ok)' : 'var(--c-faint)'};font-variant-numeric:tabular-nums;margin-top:3px">${gap! > 0 ? '−' : '+'}${fmtShort(Math.abs(gap!))} vs today</div>` : ''}
    </div>
  `;
}

function renderProjectedMarkers(p: TriRacePrediction, state: SimulatorState): string {
  if (!p.projection) return '';
  const swim = p.projection.swimCss;
  const bike = p.projection.bikeFtp;
  const run  = p.projection.runVdot;
  const rows: string[] = [];

  // Render all four markers when we have data for them, even when projected ≈
  // current (race week, low-headroom athlete, etc.). When the projection
  // doesn't move, drop the arrow and just show today's value — surfacing all
  // four reassures the athlete that every benchmark is being tracked.
  const row = (label: string, body: string) => `
    <div style="display:flex;justify-content:space-between;padding:5px 0">
      <span style="color:var(--c-muted)">${label}</span>
      <span style="font-variant-numeric:tabular-nums;color:var(--c-black)">${body}</span>
    </div>
  `;

  if (swim.current != null) {
    const moved = swim.projected != null && Math.abs(swim.current - swim.projected) >= 1;
    rows.push(row('CSS', moved
      ? `${fmtCss(swim.current)} → ${fmtCss(swim.projected!)}`
      : fmtCss(swim.current)));
  }

  if (bike.current != null) {
    const moved = bike.projected != null && Math.abs(bike.current - bike.projected) >= 2;
    rows.push(row('FTP', moved
      ? `${Math.round(bike.current)}W → ${Math.round(bike.projected!)}W`
      : `${Math.round(bike.current)}W`));
  }

  if (run.current != null) {
    // LT pace projection: anchor current to the canonical s.lt (the measured
    // value users see on the LT card and onboarding "Lactate threshold pace"
    // row), then propagate the *delta* the VDOT projection predicts.
    // Computing both from VDOT was apples-to-apples internally but produced a
    // current value (4:23) that didn't match what the same user saw labelled
    // "Lactate threshold pace" elsewhere (4:08 from s.lt). Anchoring to s.lt
    // keeps both surfaces showing the same number for "today".
    const vdotCurrentLT = gp(run.current).t;
    const vdotProjectedLT = run.projected != null ? gp(run.projected).t : vdotCurrentLT;
    const ltDelta = vdotCurrentLT - vdotProjectedLT; // positive = getting faster
    const anchoredCurrentLT = state.lt ?? vdotCurrentLT;
    const anchoredProjectedLT = anchoredCurrentLT - ltDelta;
    const ltMoved = ltDelta >= 1;
    rows.push(row('LT pace', ltMoved
      ? `${fmtLtPace(anchoredCurrentLT, state.unitPref)} → ${fmtLtPace(anchoredProjectedLT, state.unitPref)}`
      : fmtLtPace(anchoredCurrentLT, state.unitPref)));

    const vdotMoved = run.projected != null && Math.abs(run.current - run.projected) >= 0.5;
    rows.push(row('VDOT', vdotMoved
      ? `${run.current.toFixed(1)} → ${run.projected!.toFixed(1)}`
      : run.current.toFixed(1)));
  }

  if (rows.length === 0) return '';
  return `
    <div style="margin-top:16px;padding:12px 14px;border-radius:10px;background:rgba(0,0,0,0.025);font-size:12px;line-height:1">
      <div style="font-size:11px;color:var(--c-faint);margin-bottom:8px">Projected fitness markers</div>
      ${rows.join('')}
    </div>
  `;
}

/**
 * Surface a small chip on the swim leg showing the source/quality of CSS.
 * Only "high"-confidence reads (paired-TT test or recent strong-data derived
 * estimate) get NO chip — everything else carries a hint so the user knows
 * the swim split rests on incomplete information.
 */
function swimLowConfidenceFlag(state: SimulatorState): string | undefined {
  const swim = state.triConfig?.swim;
  if (!swim?.cssSecPer100m) return 'no test';
  const conf = swim.cssConfidence;
  if (conf === 'high') return undefined;
  if (conf === 'low' || conf === 'none') return 'estimate';
  if (swim.cssSource === 'derived') return 'derived';
  return 'no test';
}

/** Same idea for bike — flag when FTP isn't paired-TT high-confidence. */
function bikeLowConfidenceFlag(state: SimulatorState): string | undefined {
  const bike = state.triConfig?.bike;
  if (!bike?.ftp) return 'no test';
  const conf = (bike as { ftpConfidence?: string }).ftpConfidence;
  if (conf === 'high') return undefined;
  if (conf === 'low' || conf === 'none') return 'estimate';
  if ((bike as { ftpSource?: string }).ftpSource === 'derived') return 'derived';
  return 'no test';
}

function fmtLtPace(secPerKm: number, unitPref?: string | null): string {
  const sec = unitPref === 'mi' ? secPerKm * 1.60934 : secPerKm;
  const unit = unitPref === 'mi' ? '/mi' : '/km';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}${unit}`;
}

function fmtCss(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')}/100m`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtShort(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
