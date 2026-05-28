/**
 * Marathon forecast fingerprint. The page hero.
 *
 * One glassy hero card with the predicted finish time + delta vs goal, then
 * five glass chips beneath showing the factor clusters that feed the
 * prediction (You / Capacity / Response / Training / Venue). Tap a chip in
 * Phase B will expand to the "why" detail; Phase A renders them static.
 *
 * Visual spec: low-opacity white gradient + heavy backdrop-blur + saturate,
 * inset edge highlight, outer drop shadow. A coloured radial-wash blob
 * layer sits behind the card content so the glass refracts something
 * visible (Mosaic cool palette + a warm cream blob).
 */

import type { SimulatorState } from '@/types/state';
import { ft } from '@/utils/format';
import { applyRunningCourseFactors } from '@/calculations/course-factors-running';
import { MARATHON_COURSE_PROFILES } from '@/data/marathon-course-profiles';

// ── Cluster data shape ───────────────────────────────────────────────────────

type ClusterKey = 'you' | 'capacity' | 'response' | 'training' | 'venue' | 'durability' | 'heat' | 'calibration';

interface Cluster {
  key: ClusterKey;
  label: string;
  headline: string;
  detail: string;
  present: boolean;
  addCta?: string;
}

// ── Cluster derivation ───────────────────────────────────────────────────────

function buildYou(s: SimulatorState): Cluster {
  const typ = s.typ ?? 'Balanced';
  const tier = s.athleteTier;
  const pbs = s.pbs ?? {};
  const hasPbs = Object.values(pbs).some(v => typeof v === 'number' && v > 0);
  const raceCount = s.runRaceLog?.length ?? 0;
  if (!tier && !hasPbs && raceCount === 0) {
    return { key: 'you', label: 'You', headline: typ, detail: 'Profile thin', present: false, addCta: 'Add PBs' };
  }
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1).replace('_', '-') : null;
  const parts: string[] = [];
  if (tierLabel) parts.push(tierLabel);
  if (raceCount > 0) parts.push(`${raceCount} race${raceCount === 1 ? '' : 's'}`);
  else if (hasPbs) parts.push('PBs on file');
  return { key: 'you', label: 'You', headline: typ, detail: parts.join(' · ') || 'Runner', present: true };
}

function buildCapacity(s: SimulatorState): Cluster {
  const vdot = s.blendedEffectiveVdot ?? s.v;
  const lt = s.lt;
  if (!vdot || vdot <= 0) {
    return { key: 'capacity', label: 'Capacity', headline: 'No data', detail: '', present: false, addCta: 'Sync runs' };
  }
  const ltLabel = lt && lt > 0 ? `LT ${Math.floor(lt / 60)}:${String(Math.round(lt % 60)).padStart(2, '0')}/km` : 'From PBs';
  return { key: 'capacity', label: 'Capacity', headline: `VDOT ${vdot.toFixed(1)}`, detail: ltLabel, present: true };
}

/** Minimum vdotHistory entries before we trust a trajectory label.
 *  Below this, the chip surfaces 'Building signal' rather than a fake trend. *  A single onboarding entry vs a single rollover entry is not a trend. */
const RESPONSE_MIN_HISTORY = 4;

function buildResponse(s: SimulatorState): Cluster {
  const adaptation = s.adaptationRatio;
  const vdotHistory = (s.vdotHistory ?? []).filter(h => h.vdot && h.vdot > 0);

  // Thin signal. Fewer than 4 datapoints. Don't fabricate a trajectory.
  if (vdotHistory.length < RESPONSE_MIN_HISTORY) {
    if (adaptation == null) {
      return {
        key: 'response', label: 'Response',
        headline: 'Building signal',
        detail: vdotHistory.length === 0 ? 'Connect a watch' : `${vdotHistory.length} of ${RESPONSE_MIN_HISTORY} samples`,
        present: false,
        addCta: vdotHistory.length === 0 ? 'Sync runs' : undefined,
      };
    }
    // We have an adaptation ratio but not enough VDOT history. Still informative.
    const headline = adaptation >= 1.05 ? 'Ahead' : adaptation <= 0.95 ? 'Behind' : 'On track';
    return { key: 'response', label: 'Response', headline, detail: 'Vs expected', present: true };
  }

  // Real window: span between first and last VDOT-history entries we kept.
  // Entries log a `date` field but it is optional on the type. Fall back to
  // the week delta (×7 days) when either timestamp is missing.
  const first = vdotHistory[0];
  const last = vdotHistory[vdotHistory.length - 1];
  const tFirst = first.date ? Date.parse(first.date) : NaN;
  const tLast = last.date ? Date.parse(last.date) : NaN;
  const windowDays = Number.isFinite(tFirst) && Number.isFinite(tLast)
    ? Math.max(1, Math.round((tLast - tFirst) / 86_400_000))
    : Math.max(1, (last.week - first.week)) * 7;
  const windowLabel =
    windowDays < 14 ? `Last ${windowDays} days` :
    windowDays < 60 ? `Last ${Math.round(windowDays / 7)} weeks` :
    `Last ${Math.round(windowDays / 30)} months`;

  const delta = last.vdot - first.vdot;
  const trajectory: 'up' | 'down' | 'flat' =
    delta > 0.4 ? 'up' : delta < -0.4 ? 'down' : 'flat';
  const trajectoryLabel =
    trajectory === 'up' ? 'Trending up' : trajectory === 'down' ? 'Trending down' : 'Steady';

  if (adaptation == null) {
    return { key: 'response', label: 'Response', headline: trajectoryLabel, detail: windowLabel, present: true };
  }
  const headline = adaptation >= 1.05 ? 'Ahead' : adaptation <= 0.95 ? 'Behind' : 'On track';
  return { key: 'response', label: 'Response', headline, detail: trajectoryLabel, present: true };
}

function buildTraining(s: SimulatorState): Cluster {
  const wks = s.wks ?? [];
  const phase = wks[(s.w ?? 1) - 1]?.ph;
  const phaseLabel = phase ? phase.charAt(0).toUpperCase() + phase.slice(1) : '';
  const currentWeek = Math.max(1, Math.min(wks.length || 1, s.w ?? 1));

  // Mirror forecast-chip-detail-view.ts pageTraining() headline policy so the
  // chip and its drill-down agree (two numbers for the same metric must come
  // from the same source). The chip used to show the build-phase projection
  // (e.g. 79 km/wk for a 6-session marathon plan) while the drill-down showed
  // recent actuals (e.g. 18 km/wk): confusing in week 1 of a plan.
  let planActualKm = 0;
  let planBarsWithData = 0;
  for (let i = 0; i < currentWeek; i++) {
    const wk = wks[i];
    if (!wk) continue;
    const seen = new Set<string>();
    let km = 0;
    for (const a of Object.values(wk.garminActuals ?? {})) {
      if (a.garminId && seen.has(a.garminId)) continue;
      if (a.garminId) seen.add(a.garminId);
      if (typeof a.distanceKm === 'number' && a.distanceKm > 0) km += a.distanceKm;
    }
    if (km > 0) {
      planActualKm += km;
      planBarsWithData += 1;
    }
  }
  const inPlanAvgKm = planBarsWithData > 0 ? planActualKm / planBarsWithData : 0;
  const historicKm = s.historicWeeklyKm ?? [];
  const baselineFromHistory = historicKm.length > 0
    ? historicKm.reduce((a, b) => a + b, 0) / historicKm.length
    : 0;
  const trueBaseline = (s.detectedWeeklyKm ?? 0) > 0
    ? (s.detectedWeeklyKm as number)
    : baselineFromHistory;

  const useInPlanHeadline = planBarsWithData >= 2;
  const headlineKm = useInPlanHeadline ? inPlanAvgKm : trueBaseline;

  if (headlineKm > 0) {
    const detailParts = useInPlanHeadline
      ? [`${planBarsWithData}w in plan`, phaseLabel]
      : ['Recent · pre-plan', phaseLabel];
    return {
      key: 'training', label: 'Training',
      headline: `${Math.round(headlineKm)} km/wk`,
      detail: detailParts.filter(Boolean).join(' · '),
      present: true,
    };
  }

  if (!phaseLabel) {
    return { key: 'training', label: 'Training', headline: 'Not started', detail: '', present: false, addCta: 'Generate plan' };
  }
  return {
    key: 'training', label: 'Training',
    headline: '—', detail: phaseLabel,
    present: false, addCta: 'Sync runs',
  };
}

function buildDurability(s: SimulatorState): Cluster {
  // Long-run cap status. Always-on for running. Reads `s.runDurability`
  // which is refreshed by `refreshBlendedFitness` on every recalc.
  const d = s.runDurability;
  if (!d) {
    return { key: 'durability', label: 'Durability', headline: 'Pending', detail: 'Needs synced runs', present: false };
  }
  const metPct = Math.round(d.metFraction * 100);
  const capped = d.limitingFactor === 'long_run_shortfall';
  const headline = capped ? 'Capped' : metPct >= 100 ? 'Met' : 'Building';
  const longestMin = Math.round(d.longestRunSec / 60);
  const thresholdMin = Math.round(d.thresholdSec / 60);
  return {
    key: 'durability', label: 'Durability',
    headline,
    detail: `${longestMin} / ${thresholdMin} min longest run`,
    present: d.longestRunSec > 0,
    addCta: d.longestRunSec === 0 ? 'Log a long run' : undefined,
  };
}

function buildHeat(s: SimulatorState): Cluster | null {
  // Conditional chip. Only renders when the race climate is warm/hot/hot-humid
  // (the only conditions where heat acclimatisation can move the prediction).
  const climate = s.selectedMarathon?.profile?.climate
    ?? (s.selectedMarathon?.id && MARATHON_COURSE_PROFILES[s.selectedMarathon.id]?.climate)
    ?? null;
  if (climate !== 'warm' && climate !== 'hot' && climate !== 'hot-humid') return null;

  // Find the heat-acclim factor in `s.forecastCourseFactors` (engine writes it
  // when training-temp data exists).
  const factors = s.forecastCourseFactors ?? [];
  const heat = factors.find(f => f.kind === 'heat-acclim');
  if (!heat) {
    return {
      key: 'heat', label: 'Heat',
      headline: 'No training data',
      detail: 'Sync outdoor runs',
      present: false,
      addCta: 'Need recent runs',
    };
  }
  // Negative deltaSec = saved time. Show as "saves X min" or "Acclimated".
  const savedMin = Math.round(-heat.deltaSec / 60);
  const headline = savedMin >= 1 ? 'Acclimated' : 'Partial';
  return {
    key: 'heat', label: 'Heat',
    headline,
    detail: savedMin >= 1 ? `Saves ~${savedMin} min` : 'Light discount',
    present: true,
  };
}

function buildCalibration(s: SimulatorState): Cluster | null {
  // Conditional. Only renders when tier ≥ 1 (≥ 2 races at same distance).
  const cal = s.runCalibration;
  if (!cal || cal.tier < 1) return null;
  const distBias = cal.perDistanceBiasSec?.[s.rd ?? 'marathon'];
  if (distBias == null) return null;
  const sign = distBias >= 0 ? '+' : '−';
  const absSec = Math.abs(distBias);
  const fmt = absSec >= 60
    ? `${sign}${Math.round(absSec / 60)} min`
    : `${sign}${absSec}s`;
  return {
    key: 'calibration', label: 'Calibration',
    headline: `Tier ${cal.tier}`,
    detail: `${cal.basedOnRaceCount} race${cal.basedOnRaceCount === 1 ? '' : 's'} · ${fmt}`,
    present: true,
  };
}

function buildVenue(s: SimulatorState): Cluster {
  const factors = s.forecastCourseFactors ?? [];
  const venueName = s.selectedMarathon?.name;
  if (factors.length === 0) {
    return {
      key: 'venue', label: 'Venue',
      headline: venueName ? shortVenueName(venueName) : 'No race',
      detail: venueName ? 'Factors pending' : '',
      present: !!venueName,
      addCta: venueName ? undefined : 'Pick a race',
    };
  }
  const compoundedMult = factors.reduce((acc, f) => acc * f.multiplier, 1);
  const pct = (compoundedMult - 1) * 100;
  const sign = pct >= 0 ? '+' : '−';
  return {
    key: 'venue', label: 'Venue',
    headline: shortVenueName(venueName ?? 'Course'),
    detail: `${sign}${Math.abs(pct).toFixed(1)}% vs flat`,
    present: true,
  };
}

function shortVenueName(name: string): string {
  return name.replace(/\s+(Half\s+)?Marathon$/i, '').trim() || name;
}

// ── Util ─────────────────────────────────────────────────────────────────────

function escapeText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Coloured wash (refraction backdrop) ─────────────────────────────────────

const COLOUR_WASH = `
  <div style="position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:24px;z-index:0">
    <div style="position:absolute;left:14%;top:14%;width:280px;height:280px;border-radius:50%;
      background:radial-gradient(circle,rgba(70,130,200,0.40) 0%,transparent 65%);filter:blur(44px);"></div>
    <div style="position:absolute;right:10%;bottom:12%;width:300px;height:300px;border-radius:50%;
      background:radial-gradient(circle,rgba(110,180,200,0.34) 0%,transparent 65%);filter:blur(48px);"></div>
    <div style="position:absolute;left:50%;top:55%;transform:translate(-50%,-50%);width:240px;height:240px;border-radius:50%;
      background:radial-gradient(circle,rgba(225,180,130,0.28) 0%,transparent 60%);filter:blur(40px);"></div>
  </div>
`;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Glass hero card. Predicted finish time + delta vs goal, with five
 * factor-cluster chips beneath. Returns '' when there is no predicted time
 * (defensive. Caller already gates on race mode + initialBaseline).
 */
export function renderForecastFingerprint(s: SimulatorState): string {
  const predictedSec = s.forecastTimeAdjusted ?? s.forecastTime ?? s.blendedRaceTimeSec ?? 0;
  if (!predictedSec || predictedSec <= 0) return '';

  // Delta vs "if you ran today". Both sides describe the SAME venue so the
  // subtraction is pure training gain. We take today's blended prediction
  // (s.blendedRaceTimeSec) and apply the same course factors the forecast
  // already carries. Course penalty is owned by the Venue chip below.
  const todayRawSec = s.blendedRaceTimeSec ?? 0;
  let todayAtVenueSec = 0;
  if (todayRawSec > 0) {
    const distKm = s.rd === '5k' ? 5
      : s.rd === '10k' ? 10
      : s.rd === 'half' ? 21.0975
      : 42.195;
    let profile = s.selectedMarathon?.profile;
    if (!profile && s.selectedMarathon?.id && MARATHON_COURSE_PROFILES[s.selectedMarathon.id]) {
      profile = MARATHON_COURSE_PROFILES[s.selectedMarathon.id];
    }
    todayAtVenueSec = profile
      ? applyRunningCourseFactors(todayRawSec, profile, distKm).adjustedSec
      : todayRawSec;
  }
  const delta = todayAtVenueSec > 0 ? predictedSec - todayAtVenueSec : 0;
  const deltaTxt = todayAtVenueSec === 0 ? ''
    : Math.abs(delta) < 60 ? 'On pace vs today'
    : delta > 0 ? `+${Math.round(delta / 60)} min vs today`
    : `−${Math.round(-delta / 60)} min vs today`;
  const deltaColor = todayAtVenueSec === 0 ? 'var(--c-muted)'
    : Math.abs(delta) < 60 ? 'var(--c-muted)'
    : delta > 0 ? '#9A6A20' : '#1F7A3D';

  // Always-on chips (every chip always feeds the math, even when the value is
  // a default). Conditional chips render only when their factor is actively
  // contributing. Heat only when race climate ≥ warm; calibration only when
  // ≥ 2 races at the current distance are logged.
  const alwaysOn: Cluster[] = [
    buildYou(s),
    buildCapacity(s),
    buildResponse(s),
    buildTraining(s),
    buildDurability(s),
    buildVenue(s),
  ];
  const conditional: Cluster[] = [
    buildHeat(s),
    buildCalibration(s),
  ].filter((c): c is Cluster => c !== null);
  const clusters: Cluster[] = [...alwaysOn, ...conditional];

  const chips = clusters.map(c => `
    <div class="rfc-chip" data-cluster="${c.key}" role="button" tabindex="0" style="position:relative;min-width:0;
      background:linear-gradient(135deg,rgba(255,255,255,0.62) 0%,rgba(255,255,255,0.22) 100%);
      backdrop-filter:blur(20px) saturate(170%);-webkit-backdrop-filter:blur(20px) saturate(170%);
      border:1px solid rgba(255,255,255,${c.present ? 0.55 : 0.30});
      box-shadow:0 4px 12px rgba(0,0,0,0.08),inset 0 1px 0 rgba(255,255,255,0.6);
      border-radius:14px;padding:12px 8px;text-align:center;min-height:86px;
      display:flex;flex-direction:column;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <div style="position:absolute;top:8px;right:8px;pointer-events:none"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--c-muted)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></div>
      <div style="font-size:9px;color:var(--c-muted);font-weight:500;line-height:1;margin-bottom:6px">${c.label}</div>
      <div style="font-size:12px;color:${c.present ? 'var(--c-black)' : 'var(--c-muted)'};font-weight:600;line-height:1.15;letter-spacing:-0.005em">${escapeText(c.headline)}</div>
      ${c.detail ? `<div style="font-size:9px;color:var(--c-faint);line-height:1.2;margin-top:4px">${escapeText(c.detail)}</div>` : ''}
      ${!c.present && c.addCta ? `<div style="font-size:8px;color:var(--c-faint);margin-top:5px;line-height:1.15;font-style:italic">${c.addCta}</div>` : ''}
    </div>
  `).join('');

  const missing = clusters.filter(c => !c.present).map(c => c.label);
  const missingLine = missing.length > 0
    ? `<div style="font-size:11px;color:var(--c-faint);margin-top:10px;line-height:1.4;text-align:center">Missing: ${missing.join(', ')}. fewer factors means lower confidence.</div>`
    : '';

  return `
    <style>
      @keyframes rfcChipFadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
      .rfc-chip { opacity:0; animation:rfcChipFadeIn 0.45s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .rfc-chip:nth-child(1) { animation-delay:0.20s; }
      .rfc-chip:nth-child(2) { animation-delay:0.26s; }
      .rfc-chip:nth-child(3) { animation-delay:0.32s; }
      .rfc-chip:nth-child(4) { animation-delay:0.38s; }
      .rfc-chip:nth-child(5) { animation-delay:0.44s; }
      .rfc-chip:nth-child(6) { animation-delay:0.50s; }
      .rfc-chip:nth-child(7) { animation-delay:0.56s; }
      .rfc-chip:nth-child(8) { animation-delay:0.62s; }
    </style>
    <div class="rfc-fade" style="animation-delay:0.10s;padding:0 16px;margin-bottom:14px">
      <div style="position:relative;background:rgba(255,255,255,0.50);backdrop-filter:blur(24px) saturate(170%);-webkit-backdrop-filter:blur(24px) saturate(170%);border-radius:24px;padding:22px 22px 20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 18px 48px rgba(0,0,0,0.10);border:1px solid rgba(255,255,255,0.55);overflow:hidden">
        ${COLOUR_WASH}
        <div style="position:relative;z-index:1">
          <div style="text-align:center;padding:10px 6px 14px">
            <div style="font-size:11px;font-weight:500;color:var(--c-muted)">Forecast</div>
            <div style="font-size:56px;font-weight:300;color:var(--c-black);letter-spacing:-0.03em;line-height:1;margin-top:10px;font-variant-numeric:tabular-nums">${ft(predictedSec)}</div>
            ${deltaTxt ? `<div style="font-size:13px;color:${deltaColor};margin-top:8px;font-weight:500">${deltaTxt}</div>` : ''}
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:4px">${chips}</div>
          ${missingLine}
        </div>
      </div>
    </div>
  `;
}
