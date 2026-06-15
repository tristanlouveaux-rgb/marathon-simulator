import type { OnboardingState } from '@/types/onboarding';
import { getState } from '@/state/store';
import { nextStep } from '../controller';
import { renderBackButton } from '../renderer';
import { buildSunGlint, buildAtmosphereBase, buildRingBackground, ringAnimationCSS } from '@/ui/page-flair';
import { SPORT_LABELS, SPORT_ALIASES } from '@/constants/sports';
import type { SportKey } from '@/types';
import { getRunnerType } from '@/calculations';
import { derivePlanShape, planPhaseSegments, type PlanShape, type PhaseSegment } from '@/calculations/plan-shape';
import { computeUniversalLoad } from '@/cross-training/universalLoad';
import { fp } from '@/utils/format';
import { readinessColorStops, type ReadinessLabel } from '@/calculations/readiness';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { topWeakestLinks } from '@/calculations/hyrox-weakest-link';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';

/**
 * Coach contract — the post-plan "here's how your plan works" beat.
 *
 * One step, three modes; the last beat before entering the app, after the plan
 * exists:
 *   running    : plan-preview-v2 → coach-contract → workout-preview → main-view
 *   triathlon  : tri-plan-forecast → coach-contract → main-view
 *   HYROX      : initializing → coach-contract → main-view
 * (Cycling and just-track skip this step entirely — straight to main-view.)
 *
 * Design intent (2026-06-15 redesign): premium, not "AI slop". Two principles:
 *   1. ONE strong, data-derived visual per idea, restrained palette. Running
 *      gets an editorial single-accent load arc + per-phase session shift;
 *      triathlon gets a load ramp STACKED BY DISCIPLINE (swim/bike/run) plus a
 *      "three engines" benchmark card; HYROX gets a run-vs-stations load ramp
 *      plus a weakest-link card.
 *   2. SHOW the premium features, don't list them. The "Built to flex" section
 *      renders faithful mini-mockups of the real UI — a live readiness ring,
 *      a touchable Adjust slider (the real m-slider-glass), a swap, the weekly
 *      rebalance, and the injury "Recovery mode" banner — with mode-correct copy.
 *
 * Every plan-shape graphic is DERIVED FROM THE REAL GENERATED PLAN (running via
 * `derivePlanShape`; tri/HYROX via `deriveDisciplineLoad` over the stored
 * `triWorkouts`), never synthesised. The feature mocks are illustrative UI
 * snapshots, personalised where possible (the athlete's real easy pace).
 *
 * The background uses the full page-flair system (ring background + atmosphere
 * + sun glint) so it matches the other wizard pages.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  TWEAKING COPY: per-mode wording lives in `buildRunningView` / `buildTriView`
 *  / `buildHyroxView` and the section builders. The shared "Built to flex"
 *  showcase copy lives in `renderFeatureShowcase` + `showcaseDataForMode`.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function renderCoachContract(container: HTMLElement, state: OnboardingState): void {
  const s = getState();
  const name = (state.name || '').trim();
  const mode: PlanMode = !state.trainingMode || state.trainingMode === 'running'
    ? 'running'
    : state.trainingMode === 'triathlon' ? 'triathlon' : 'hyrox';

  const view = mode === 'running' ? buildRunningView(s, state)
    : mode === 'triathlon' ? buildTriView(s, state)
    : buildHyroxView(s, state);

  container.innerHTML = `
    <style>
      ${ringAnimationCSS('cc')}
      @keyframes ccRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .cc-rise { opacity:0; animation: ccRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .cc-card { background:rgba(255,255,255,0.78); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:18px 18px; }
      .cc-h { font-size:15px; font-weight:600; color:var(--c-black); margin:0 0 8px; letter-spacing:-0.01em; }
      .cc-p { font-size:13.5px; color:var(--c-muted); line-height:1.6; margin:0; }
      .cc-p + .cc-p { margin-top:10px; }
      .cc-p strong { color:var(--c-black); font-weight:600; }

      /* Load charts — area (running) and stacked-by-discipline (tri/HYROX). */
      .cc-arc { width:100%; height:128px; display:block; }
      .cc-axis { position:relative; height:15px; margin-top:7px; }
      .cc-axis > span { position:absolute; transform:translateX(-50%); font-size:10.5px; color:var(--c-faint); white-space:nowrap; }

      /* Two-snapshot / per-phase session shift. */
      .cc-shift-lbl { font-size:12px; color:var(--c-muted); margin-bottom:5px; }
      .cc-shift-bar { display:flex; height:22px; border-radius:7px; overflow:hidden; }
      .cc-shift-bar > div { display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:600; min-width:0; }
      .cc-legend { display:flex; flex-wrap:wrap; gap:14px; margin-top:12px; }
      .cc-legend span.k { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:var(--c-muted); }
      .cc-legend span.sw { width:9px; height:9px; border-radius:2px; flex:0 0 auto; }

      /* Tabular rows — cross-training, three engines, weakest link. */
      .cc-xrow { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:8px 0; border-top:1px solid rgba(0,0,0,0.06); }
      .cc-xrow:first-of-type { border-top:none; }
      .cc-xname { font-size:13px; color:var(--c-black); font-weight:500; }
      .cc-xval { font-size:12.5px; color:var(--c-muted); text-align:right; }
      .cc-xval strong { color:var(--c-black); font-weight:600; }
      .cc-ddot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; vertical-align:middle; }

      /* Feature showcase — faithful mini-mockups of the real UI. */
      .cc-feat + .cc-feat { margin-top:18px; }
      .cc-fl { font-size:13.5px; font-weight:600; color:var(--c-black); margin:0; letter-spacing:-0.01em; }
      .cc-fc { font-size:12.5px; color:var(--c-muted); line-height:1.5; margin:7px 0 0; }
      .cc-mock { background:rgba(255,255,255,0.55); border:1px solid rgba(0,0,0,0.07); border-radius:12px; padding:13px 14px; margin-top:9px; }
      .cc-mtag { font-size:11px; font-weight:600; color:var(--c-faint); }
      .cc-mlink { font-size:11px; color:var(--c-muted); }
      .cc-chip { flex:1; text-align:center; font-size:12px; color:var(--c-black); background:rgba(255,255,255,0.85); border:1px solid rgba(0,0,0,0.10); border-radius:10px; padding:9px 6px; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.06), 0 3px 8px rgba(0,0,0,0.05); transition:box-shadow 0.12s ease, border-color 0.12s ease, transform 0.1s ease; }
      .cc-chip:active { transform:translateY(1px); box-shadow:0 1px 2px rgba(0,0,0,0.08); }
      .cc-chip.sel { border-color:rgba(0,0,0,0.42); font-weight:600; box-shadow:0 1px 2px rgba(0,0,0,0.10), 0 8px 18px -5px rgba(0,0,0,0.20); }
      .cc-eff { flex:1; text-align:center; font-size:11.5px; color:var(--c-black); background:rgba(255,255,255,0.85); border:1px solid rgba(0,0,0,0.10); border-radius:8px; padding:6px 4px; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.05); transition:border-color 0.12s ease, box-shadow 0.12s ease, transform 0.1s ease; }
      .cc-eff:active { transform:translateY(1px); }
      .cc-eff.sel { border-color:rgba(0,0,0,0.42); font-weight:600; box-shadow:0 1px 2px rgba(0,0,0,0.10), 0 6px 14px -5px rgba(0,0,0,0.18); }
      .cc-pill { display:inline-block; margin-top:12px; padding:4px 11px; border-radius:100px; font-size:11px; font-weight:600; border:1px solid rgba(0,0,0,0.18); color:var(--c-muted); }
      .cc-dotacc { display:inline-block; width:7px; height:7px; border-radius:50%; background:${LOAD_LINE}; margin-right:5px; vertical-align:middle; }

      .cc-cta { width:100%; height:50px; border-radius:25px; background:#0A0A0A; color:#FDFCF7; border:none; font-size:15px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1), 0 10px 26px -8px rgba(0,0,0,0.4); transition: transform 0.12s ease; }
      .cc-cta:active { transform: translateY(1px); }
    </style>

    <div class="mosaic-page" style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('cc', { variant: 'centered', pulse: false })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:56px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">

        <div class="cc-rise" style="width:100%;max-width:480px;text-align:center;animation-delay:0.04s">
          <h2 style="font-size:clamp(1.5rem,5.4vw,2rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.2">
            ${view.title.replace('{name}', name ? `, ${escapeHtml(name)}` : '')}
          </h2>
          ${view.sub ? `<p style="font-size:13px;color:var(--c-faint);margin:0;line-height:1.5">${view.sub}</p>` : ''}
        </div>

        ${view.bodyHtml}

      </div>

      <div class="cc-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.34s">
        <div style="max-width:480px;margin:0 auto">
          <button id="cc-continue" class="cc-cta">${view.ctaLabel}</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  document.getElementById('cc-continue')?.addEventListener('click', () => {
    // Mode-aware routing lives in the controller: running → workout-preview,
    // tri / HYROX → complete onboarding → main-view.
    nextStep();
  });

  wireAdjustSlider();
  wireSwapChips();
  wireWhyToggles();
}

/** Toggle each "Why does it vary?" note open/closed. */
function wireWhyToggles(): void {
  document.querySelectorAll<HTMLElement>('.cc-why-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const body = btn.parentElement?.querySelector<HTMLElement>('.cc-why-body');
      if (!body) return;
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'Why does it vary? ›' : 'Why does it vary? ⌄';
    });
  });
}

type PlanMode = 'running' | 'triathlon' | 'hyrox';

interface CoachView {
  title: string;     // use {name} for the optional ", Firstname"
  sub: string;
  ctaLabel: string;
  bodyHtml: string;
}

/* ════════════════════════════════════════════════════════════════════════════
 *  Palette — deliberately small. ONE accent for the running load curve, a
 *  cool/warm pair for aerobic-vs-quality, and the canonical (data-carrying)
 *  triathlon discipline colours for the stacked ramps.
 * ════════════════════════════════════════════════════════════════════════════ */

const LOAD_LINE = '#4A7FA5';                 // single calm blue — the running load curve
const LOAD_FILL = 'rgba(74,127,165,0.13)';   // its soft fill
const AEROBIC = '#A9C9E0';                   // cool — easy aerobic volume
const QUALITY = '#D98B4A';                    // warm — tempo / threshold / VO2

// Triathlon discipline colours. Swim sky + run teal are canonical (UX_PATTERNS,
// data-carrying); bike uses a warm red here (Tristan's call — note it diverges
// from the violet on the tri Stats pages). Near-solid fills + white separators
// keep the stacked bands clean rather than muddy/translucent.
const DISC_SOLID: Record<string, string> = { swim: '#38BDF8', bike: '#E05A4E', run: '#14B8A6', brick: '#E0883E', station: '#E0883E' };
const DISC_FILL: Record<string, string> = {
  swim: 'rgba(56,189,248,0.88)',
  bike: 'rgba(224,90,78,0.88)',
  run: 'rgba(20,184,166,0.88)',
  brick: 'rgba(224,136,62,0.88)',
  station: 'rgba(224,136,62,0.88)',
};

const PHASE_LABEL: Record<string, string> = { base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper' };

/** Intensity → RPE for recurring sports (sourced from generator.ts INTENSITY_RPE). */
const INTENSITY_RPE: Record<string, number> = { easy: 3, moderate: 5, hard: 7 };

// Readiness ring geometry (mirrors readiness-view.ts canonical ring).
const RING_R = 46;
const RING_C = +(2 * Math.PI * RING_R).toFixed(2);

/* ════════════════════════════════════════════════════════════════════════════
 *  RUNNING — editorial load arc + per-phase session shift + cross-training.
 * ════════════════════════════════════════════════════════════════════════════ */

function buildRunningView(s: ReturnType<typeof getState>, state: OnboardingState): CoachView {
  const noEvent = !!s.continuousMode;
  const race = runningRaceLabel(s, state);
  const sports = recurringSports(s, state);
  const builtFrom = builtFromSentence(commonKnowFragments(s, state, sports));
  let shape: PlanShape | null = null;
  try {
    shape = derivePlanShape(s);
  } catch (e) {
    console.warn('[CoachContract] plan-shape derivation failed, showing text only:', e);
  }
  const hasShape = !!shape && shape.weeks >= 2 && shape.peakTss > 0;

  const card = cardFactory();
  const sections: string[] = [];

  if (hasShape && shape) {
    sections.push(card(renderPhaseLoad(shape, race, noEvent)));
    if (shape.mixByPhase.length) sections.push(card(renderSessionShift(shape, s)));
  }

  const crossHtml = renderCrossTraining(sports);
  if (crossHtml) sections.push(card(crossHtml));

  sections.push(card(renderFeatureShowcase('running', s, state, sports[0] ?? null)));

  return {
    title: noEvent ? `Here's how we'll work together{name}.` : `Here's how we'll get you there{name}.`,
    sub: builtFrom,
    ctaLabel: 'See your sessions',
    bodyHtml: sections.join(''),
  };
}

/** Editorial single-accent load arc. Phases read as labelled baseline regions
 *  with a subtle peak marker. Load (TSS) is the honest currency — km
 *  under-counts minute-prescribed quality work. */
function renderPhaseLoad(shape: PlanShape, race: string, noEvent: boolean): string {
  const series = shape.weeklyTss;
  const n = series.length;
  const peak = shape.peakTss || 1;
  // Top headroom so the peak doesn't touch the very top (and the pill clears it);
  // baseline sits at 100.
  const PAD_TOP = 18;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const y = (v: number) => PAD_TOP + (1 - v / peak) * (100 - PAD_TOP);

  // Sharp angular line (no smoothing) — the real week-to-week variation is
  // meaningful and Tristan/users want to see it, not an eased arc. No on-chart
  // y-axis: the only honest unit here is canonical TSS, which is abstract to
  // users (Tristan: "no scale, shouldn't be on chart").
  const linePts = series.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const areaPts = `0,100 ${linePts} 100,100`;

  const peakIdx = series.indexOf(peak);
  const peakX = x(peakIdx);
  const peakWk = peakIdx + 1;
  const lastTss = series[n - 1] || 0;
  const taperPct = peak > 0 ? Math.max(0, Math.round((1 - lastTss / peak) * 100)) : 0;
  const peakLabelX = Math.min(80, Math.max(16, peakX));

  const axis = phaseAxisHtml(shape.phases);

  const chart = `
    <div style="position:relative">
      <div style="position:relative;height:128px">
        <svg class="cc-arc" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points="${areaPts}" fill="${LOAD_FILL}" />
          <polyline points="${linePts}" fill="none" stroke="${LOAD_LINE}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        </svg>
        ${axis.dividers}
        <div style="position:absolute;left:${peakLabelX.toFixed(1)}%;top:0;transform:translateX(-50%);font-size:10px;font-weight:600;color:var(--c-black);background:#fff;border:1px solid var(--c-border);padding:1px 7px;border-radius:100px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.06)">Peak · wk ${peakWk}</div>
      </div>
      <div class="cc-axis">${axis.labels}</div>
    </div>`;

  const heading = noEvent ? 'Built in repeating phases.' : `${shape.weeks} weeks, built in phases.`;
  const caption = noEvent
    ? `This line is your weekly training load. It cycles up and down on purpose, with a lighter recovery week built into every block. About <strong>${shape.totalKm} km</strong> of running in all, peaking near <strong>${shape.peakKm} km</strong> in your biggest week.`
    : `This line is your weekly training load. It builds through to a peak around week ${peakWk}, with a lighter recovery week in every block, then sheds about <strong>${taperPct}%</strong> in the taper before your ${race}. About <strong>${shape.totalKm} km</strong> across ${shape.weeks} weeks, peaking near <strong>${shape.peakKm} km</strong> in your biggest week.`;

  return `
    <p class="cc-h">${heading}</p>
    ${chart}
    <p class="cc-p" style="margin-top:14px">${caption}</p>
    ${whyVariesNote()}
  `;
}

/** Session-type shift as one aerobic-vs-quality bar PER PHASE (Base → Build →
 *  Peak → Taper), so the progression is explicit. Two colours, the trend read
 *  at a glance. */
function renderSessionShift(shape: PlanShape, s: ReturnType<typeof getState>): string {
  const split = (pm: PlanShape['mixByPhase'][number]) => {
    let aer = 0;
    let qual = 0;
    for (const b of pm.buckets) {
      if (b.key === 'easy' || b.key === 'long') aer += b.count;
      else qual += b.count;
    }
    const t = aer + qual || 1;
    return { qpct: Math.round((qual / t) * 100) };
  };

  const bars = shape.mixByPhase
    .map((pm) => {
      const { qpct } = split(pm);
      const apct = 100 - qpct;
      return `
        <div style="margin-bottom:12px">
          <div class="cc-shift-lbl">${PHASE_LABEL[pm.ph] ?? pm.ph}</div>
          <div class="cc-shift-bar">
            <div style="flex:${apct};background:${AEROBIC}">${apct >= 12 ? `${apct}%` : ''}</div>
            <div style="flex:${qpct};background:${QUALITY}">${qpct >= 10 ? `${qpct}%` : ''}</div>
          </div>
        </div>`;
    })
    .join('');

  const bias = runnerTypeBias(getRunnerType(s.b || 1.06));

  return `
    <p class="cc-h">How your sessions shift by phase.</p>
    <p class="cc-p" style="margin-bottom:14px">Easy aerobic volume carries the early phases. As race day nears, more of each week becomes quality work.</p>
    ${bars}
    <div class="cc-legend" style="margin:4px 0 12px">
      <span class="k"><span class="sw" style="background:${AEROBIC}"></span>Easy &amp; long</span>
      <span class="k"><span class="sw" style="background:${QUALITY}"></span>Tempo, threshold &amp; VO2</span>
    </div>
    <p class="cc-p">${bias}</p>
  `;
}

/** Truthful description of `applyRunnerTypeBias` (plan_engine.ts). */
function runnerTypeBias(runnerType: string): string {
  switch (runnerType) {
    case 'Speed':
      return `You are naturally quicker over short distances, so we have promoted more <strong>threshold and tempo</strong> work to build the endurance that holds up over longer races.`;
    case 'Endurance':
      return `You are naturally strong over distance, so we have promoted more <strong>VO2 and interval</strong> work to sharpen the top-end speed you can lean on.`;
    default:
      return `You are well balanced across distances, so you get the standard blend of speed and endurance work for your race.`;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 *  TRIATHLON — stacked-by-discipline load ramp + three engines + showcase.
 * ════════════════════════════════════════════════════════════════════════════ */

function buildTriView(s: ReturnType<typeof getState>, state: OnboardingState): CoachView {
  const dist = triDistanceLabel(s, state);
  const weeks = s.tw || state.planDurationWeeks || 0;
  const frags: string[] = [];
  if (state.triBike?.ftp || state.triSwim?.cssSecPer100m) frags.push('your bike and swim benchmarks');
  frags.push(...commonKnowFragments(s, state, []));

  const card = cardFactory();
  const sections: string[] = [];

  sections.push(card(`
    <p class="cc-h">${weeks > 0 ? `${weeks} weeks` : 'Weeks'} of phases toward your ${dist}.</p>
    <p class="cc-p">Each block has a job: build your aerobic base, raise the work across swim, bike and run, then sharpen for race day. Load is tracked per discipline, so no single sport runs away from the others.</p>
  `));

  const triShape = deriveDisciplineLoad(
    s,
    (d) => (d === 'swim' || d === 'bike' || d === 'run' || d === 'brick') ? d : null,
    ['swim', 'bike', 'run', 'brick'],
  );
  const hasBrick = triShape.perWeek.some((w) => (w.loads.brick ?? 0) > 0);
  const ramp = renderDisciplineRamp(triShape, {
    order: hasBrick ? ['bike', 'run', 'brick', 'swim'] : ['bike', 'run', 'swim'],
    legend: [
      { key: 'swim', label: 'Swim' },
      { key: 'bike', label: 'Bike' },
      { key: 'run', label: 'Run' },
      ...(hasBrick ? [{ key: 'brick', label: 'Brick' }] : []),
    ],
    heading: '{weeks} weeks, stacked by discipline.',
    caption: hasBrick
      ? `Your weekly load across swim, bike, run and brick sessions (bike straight into a run). It ramps through build into your peak weeks, then tapers for your ${dist}.`
      : `Your weekly load across swim, bike and run. It ramps through build into your peak weeks, then tapers for your ${dist}.`,
  });
  if (ramp) sections.push(card(ramp));

  const engines = renderEngines(s, state);
  if (engines) sections.push(card(engines));

  sections.push(card(renderFeatureShowcase('triathlon', s, state, null)));

  return {
    title: `Here's how we'll get you there{name}.`,
    sub: builtFromSentence(frags),
    ctaLabel: 'Start training',
    bodyHtml: sections.join(''),
  };
}

/** "Your three engines" — the per-discipline benchmarks we calibrated, in their
 *  canonical colours. Only rows with real data render. */
function renderEngines(s: ReturnType<typeof getState>, state: OnboardingState): string {
  const pref = s.unitPref ?? 'km';
  const ftp = state.triBike?.ftp ?? s.triConfig?.bike?.ftp;
  const css = state.triSwim?.cssSecPer100m ?? s.triConfig?.swim?.cssSecPer100m;
  const runThr = s.pac?.t;

  const row = (disc: string, sub: string, val: string): string =>
    `<div class="cc-xrow"><span class="cc-xname"><span class="cc-ddot" style="background:${DISC_SOLID[disc]}"></span>${cap(disc)} · ${sub}</span><span class="cc-xval"><strong>${val}</strong></span></div>`;

  const rows: string[] = [];
  if (ftp && ftp > 0) rows.push(row('bike', 'FTP', `${Math.round(ftp)} W`));
  if (css && css > 0) rows.push(row('swim', 'CSS', `${fmtPer100(css)} /100m`));
  if (runThr && runThr > 0) rows.push(row('run', 'threshold', `${fp(runThr, pref)}`));
  if (rows.length < 2) return '';

  return `
    <p class="cc-h">Your three engines.</p>
    <p class="cc-p" style="margin-bottom:12px">We calibrated each discipline from your benchmarks, and keep them honest as you train — every one updates when your sessions beat it.</p>
    ${rows.join('')}
  `;
}

/* ════════════════════════════════════════════════════════════════════════════
 *  HYROX — run-vs-stations load ramp + weakest-link card + showcase.
 * ════════════════════════════════════════════════════════════════════════════ */

function buildHyroxView(s: ReturnType<typeof getState>, state: OnboardingState): CoachView {
  const weeks = s.tw || state.planDurationWeeks || 0;
  const frags: string[] = [];
  if ((state.previousHyroxTimeSec ?? 0) > 0) frags.push('your last HYROX time');
  frags.push(...commonKnowFragments(s, state, []));

  const card = cardFactory();
  const sections: string[] = [];

  sections.push(card(`
    <p class="cc-h">${weeks > 0 ? `${weeks} weeks` : 'Weeks'} of phases toward your HYROX race.</p>
    <p class="cc-p">Each block has a job: build your running engine and station strength, raise the work, then sharpen for race day. Running and strength are balanced so neither stalls the other.</p>
  `));

  const ramp = renderDisciplineRamp(
    deriveDisciplineLoad(s, (d) => d === 'run' ? 'run' : (d === 'station' || d === 'brick') ? 'station' : null, ['run', 'station']),
    {
      order: ['run', 'station'],
      legend: [{ key: 'run', label: 'Running' }, { key: 'station', label: 'Stations' }],
      heading: '{weeks} weeks, running and stations.',
      caption: 'Your weekly load across running and the eight stations. The running engine and station strength ramp together, then taper for race day.',
    },
  );
  if (ramp) sections.push(card(ramp));

  const weakest = renderHyroxWeakest(s);
  if (weakest) sections.push(card(weakest));

  sections.push(card(renderFeatureShowcase('hyrox', s, state, null)));

  return {
    title: `Here's how we'll get you there{name}.`,
    sub: builtFromSentence(frags),
    ctaLabel: 'Start training',
    bodyHtml: sections.join(''),
  };
}

/** Weakest-link card — ranks the stations by realistic time-to-gain. Renders
 *  only when a projection is available (race date + calibrated/seed times). */
function renderHyroxWeakest(s: ReturnType<typeof getState>): string {
  let rows: ReturnType<typeof topWeakestLinks> = [];
  try {
    rows = topWeakestLinks(predictHyroxRace(s), 3);
  } catch {
    return '';
  }
  if (!rows.length) return '';

  const items = rows
    .map((r) => {
      const name = STATION_DISPLAY[r.station]?.name ?? String(r.station);
      return `<div class="cc-xrow"><span class="cc-xname">${escapeHtml(name)}</span><span class="cc-xval">~<strong>${Math.round(r.gainableSec)}s</strong> to gain</span></div>`;
    })
    .join('');

  return `
    <p class="cc-h">Where you'll gain the most.</p>
    <p class="cc-p" style="margin-bottom:12px">We rank your stations by the time you can realistically take off each, then program extra work into your weakest links.</p>
    ${items}
  `;
}

/* ════════════════════════════════════════════════════════════════════════════
 *  Plan-shape helpers — stacked-by-discipline load + the shared phase axis.
 * ════════════════════════════════════════════════════════════════════════════ */

interface DiscShape {
  weeks: number;
  perWeek: Array<{ ph: PhaseSegment['ph']; loads: Record<string, number>; mins: number }>;
  peak: number;
  phases: PhaseSegment[];
}

/** Per-week canonical-TSS load grouped by discipline, read from the REAL stored
 *  `triWorkouts` on each plan week (aerobic + anaerobic). Also sums each week's
 *  planned minutes (for the weekly-hours marker). `mapDisc` buckets a workout's
 *  discipline into a render group (or null to ignore). */
function deriveDisciplineLoad(
  s: ReturnType<typeof getState>,
  mapDisc: (d: string | undefined) => string | null,
  groups: string[],
): DiscShape {
  const wks = s.wks ?? [];
  const perWeek = wks.map((wk) => {
    const loads: Record<string, number> = {};
    for (const g of groups) loads[g] = 0;
    let mins = 0;
    for (const w of wk.triWorkouts ?? []) {
      const g = mapDisc(w.discipline);
      if (!g) continue;
      loads[g] += (w.aerobic ?? 0) + (w.anaerobic ?? 0);
      mins += w.estimatedDurationMin ?? 0;
    }
    return { ph: wk.ph, loads, mins };
  });
  const peak = perWeek.reduce((m, d) => Math.max(m, Object.values(d.loads).reduce((a, b) => a + b, 0)), 0);
  return { weeks: wks.length, perWeek, peak, phases: planPhaseSegments(s) };
}

/** Stacked-area load ramp by discipline. Returns '' when there is no plan to
 *  draw (so tri/HYROX views degrade to text + showcase). */
function renderDisciplineRamp(
  shape: DiscShape,
  opts: { order: string[]; legend: { key: string; label: string }[]; heading: string; caption: string },
): string {
  const n = shape.perWeek.length;
  if (n < 2 || shape.peak <= 0) return '';
  const peak = shape.peak;
  // Headroom for the smoothed curve's overshoot. No floating pill any more, so
  // the stack can sit a little higher.
  const PAD_TOP = 16;
  const x = (i: number) => (i / (n - 1)) * 100;
  const yOf = (v: number) => 100 - PAD_TOP - (v / peak) * (100 - PAD_TOP);

  // Stacked bands with LIGHT smoothing (Catmull-Rom) — for a stacked area the
  // point is the discipline balance over time, so easing the week-to-week steps
  // reads calmer without hiding the trend. A thin white separator along each
  // band's top edge keeps adjacent disciplines distinct.
  const cum = new Array(n).fill(0);
  const bands: string[] = [];
  const seps: string[] = [];
  for (const g of opts.order) {
    const upper: Array<{ x: number; y: number }> = [];
    const lower: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < n; i++) {
      const below = cum[i];
      const top = below + (shape.perWeek[i].loads[g] ?? 0);
      upper.push({ x: x(i), y: yOf(top) });
      lower.push({ x: x(i), y: yOf(below) });
      cum[i] = top;
    }
    const upperD = smoothPath(upper);
    const lowerD = 'L' + smoothPath([...lower].reverse()).slice(1); // continue from upper into reversed lower
    bands.push(`<path d="${upperD} ${lowerD} Z" fill="${DISC_FILL[g] ?? 'rgba(0,0,0,0.2)'}" />`);
    seps.push(`<path d="${upperD}" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1" vector-effect="non-scaling-stroke" />`);
  }

  const axis = phaseAxisHtml(shape.phases);
  const chart = `
    <div style="position:relative">
      <div style="position:relative;height:128px">
        <svg class="cc-arc" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${bands.join('')}${seps.join('')}</svg>
        ${axis.dividers}
      </div>
      <div class="cc-axis">${axis.labels}</div>
    </div>`;

  const legend = opts.legend
    .map((l) => `<span class="k"><span class="sw" style="background:${DISC_SOLID[l.key] ?? '#888'}"></span>${l.label}</span>`)
    .join('');

  // Weekly-hours peak figure lives in the caption (a floating pill collides with
  // the dense stack — "rammed in").
  const totals = shape.perWeek.map((d) => Object.values(d.loads).reduce((a, b) => a + b, 0));
  const peakHours = Math.round((shape.perWeek[totals.indexOf(Math.max(...totals))].mins / 60) * 10) / 10;
  const caption = peakHours > 0 ? `${opts.caption} It peaks at about ${peakHours} hours a week.` : opts.caption;

  return `
    <p class="cc-h">${opts.heading.replace('{weeks}', String(shape.weeks))}</p>
    ${chart}
    <div class="cc-legend" style="margin-top:12px">${legend}</div>
    <p class="cc-p" style="margin-top:12px">${caption}</p>
    ${whyVariesNote()}
  `;
}

/** Catmull-Rom → cubic-bezier smoothing (used only for the stacked discipline
 *  ramp; the running line stays sharp). Passes through every real point. */
function smoothPath(P: Array<{ x: number; y: number }>): string {
  if (P.length === 0) return '';
  if (P.length < 3) return `M ${P.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')}`;
  let d = `M ${P[0].x.toFixed(2)} ${P[0].y.toFixed(2)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2] || P[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/** Tappable "Why does it vary?" note — wired in `wireWhyToggles`. The big moves
 *  (deloads, the phase ramp, the taper) are deliberate; small week-to-week
 *  changes are the session mix. */
function whyVariesNote(): string {
  return `
    <div style="margin-top:10px">
      <button type="button" class="cc-why-toggle" style="background:none;border:none;padding:0;font-size:12px;color:var(--c-muted);cursor:pointer">Why does it vary? ›</button>
      <p class="cc-why-body cc-p" style="display:none;margin-top:8px">Harder weeks build fitness; a lighter recovery week in every block lets it consolidate. Volume and intensity also ramp up across the plan, so the trend climbs. Each week's exact load then depends on that week's long run and quality session, so two normal weeks can differ a little. The big moves are deliberate; the small week-to-week changes are just the session mix.</p>
    </div>`;
}

/** Phase regions for any load chart: faint dividers + a neutral label centred
 *  under each contiguous phase segment (HTML overlay, not stretched SVG text). */
function phaseAxisHtml(phases: PhaseSegment[]): { dividers: string; labels: string } {
  const totalW = phases.reduce((a, p) => a + p.weeks, 0) || 1;
  let cum = 0;
  const dividers: string[] = [];
  const labels: string[] = [];
  for (let k = 0; k < phases.length; k++) {
    const seg = phases[k];
    const startFrac = cum / totalW;
    cum += seg.weeks;
    const endFrac = cum / totalW;
    const midPct = ((startFrac + endFrac) / 2) * 100;
    labels.push(`<span style="left:${midPct.toFixed(1)}%">${PHASE_LABEL[seg.ph] ?? seg.ph}</span>`);
    if (k < phases.length - 1) {
      dividers.push(`<div style="position:absolute;left:${(endFrac * 100).toFixed(1)}%;top:0;bottom:0;width:1px;background:var(--c-border)"></div>`);
    }
  }
  return { dividers: dividers.join(''), labels: labels.join('') };
}

/* ════════════════════════════════════════════════════════════════════════════
 *  Cross-training — every recurring sport, with a real worked example (running).
 * ════════════════════════════════════════════════════════════════════════════ */

interface SportLoad {
  key: SportKey;
  label: string;       // lowercase display label
  dur: number;
  freqWord: string;
  tss: number;
  km: number;
}

/** Resolve all recurring sports (deduped) with a real `computeUniversalLoad`
 *  worked example for each. Numbers are never invented. */
function recurringSports(s: ReturnType<typeof getState>, state: OnboardingState): SportLoad[] {
  const acts = Array.isArray(state.recurringActivities) ? state.recurringActivities : [];
  const seen = new Set<string>();
  const out: SportLoad[] = [];
  for (const a of acts) {
    if (!a?.sport || (a.frequency ?? 0) <= 0) continue;
    const key = (SPORT_ALIASES[a.sport] ?? a.sport) as SportKey;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = (SPORT_LABELS[key] ?? a.sport).toLowerCase();
    const dur = Math.max(20, Math.round(a.durationMin || 60));
    const rpe = INTENSITY_RPE[a.intensity] ?? 5;
    const freq = a.frequency ?? 1;
    const freqWord = freq === 1 ? 'once a week' : freq === 2 ? 'twice a week' : `${freq}× a week`;
    let tss = 0;
    let km = 0;
    try {
      const load = computeUniversalLoad({ sport: key, durationMin: dur, rpe }, s.rd || 'half');
      tss = Math.round(load.baseLoad / 5) * 5;
      km = load.equivalentEasyKm;
    } catch {
      /* leave at 0 — row renders without the worked number */
    }
    out.push({ key, label, dur, freqWord, tss, km });
  }
  return out;
}

/** Cross-training card (running). Shows ONE row per recurring sport so the
 *  header and body agree, and connects impromptu sessions to the rebalance. */
function renderCrossTraining(sports: SportLoad[]): string {
  if (!sports.length) return '';
  const heading = sports.length === 1
    ? `Your ${escapeHtml(sports[0].label)}, built in.`
    : 'Your cross-training, built in.';
  const rows = sports
    .map((sp) => {
      const val = sp.tss > 0 && sp.km > 0
        ? `~<strong>${sp.tss} TSS</strong> · ${sp.km} km easy`
        : 'counted as real load';
      return `<div class="cc-xrow"><span class="cc-xname">${cap(escapeHtml(sp.label))} · ${sp.freqWord}</span><span class="cc-xval">${val}</span></div>`;
    })
    .join('');

  return `
    <p class="cc-h">${heading}</p>
    <p class="cc-p" style="margin-bottom:12px">We schedule the sport you already do alongside your runs and count it as real training load, so the week is balanced around it.</p>
    ${rows}
    <p class="cc-p" style="margin-top:12px">Do an extra, unplanned session too? Log it and we trim the runs around it so the week's load stays right.</p>
  `;
}

/* ════════════════════════════════════════════════════════════════════════════
 *  Feature showcase — faithful mini-mockups of the real UI. Shared, mode-aware.
 * ════════════════════════════════════════════════════════════════════════════ */

interface ShowcaseData {
  readinessScore: number;
  readinessReason: string;
  readinessWas: string;
  readinessNow: string;
  readinessCaption: string;
  adjustTag: string;
  adjustUnit: string;
  adjustMin: number;
  adjustMax: number;
  adjustVal: number;
  adjustPaceSec: number;   // 0 = no pace (duration-only)
  adjustSub: string;       // static sub when there's no pace
  adjustCaption: string;
  swapTag: string;
  swapOpts: [string, string];
  rebalanceTag: string;
  rebalanceNote: string;
  rebalanceCaption: string;
}

function showcaseDataForMode(
  mode: PlanMode,
  s: ReturnType<typeof getState>,
  sport: SportLoad | null,
): ShowcaseData {
  const pref = s.unitPref ?? 'km';
  const easyPaceSec = s.pac?.e ?? 0;
  const easyPace = easyPaceSec ? fp(easyPaceSec, pref) : '';
  const sessionWord = mode === 'running' ? 'runs' : 'sessions';
  const logged = sport && sport.tss > 0
    ? { tag: `${cap(sport.label)} +${sport.tss} TSS`, note: `next session eased to balance the week` }
    : { tag: 'Padel +45 TSS', note: 'next session eased to balance the week' };
  const sportEg = sport ? `an extra ${escapeHtml(sport.label)} session` : 'an extra game or ride';
  const rebalanceCaption = `Squeeze in ${sportEg}, a five-a-side, a last-minute game? Log it and we trim the ${sessionWord} around it so the week's load stays right.`;
  const readinessCaption = "Each morning we read your HRV, sleep and recent load. If you are not recovered, today's hard session is eased or moved, automatically.";
  const readinessReason = 'HRV below baseline · short sleep';
  const readinessScore = 52; // Manage Load band — coherent with easing the session

  if (mode === 'triathlon') {
    return {
      readinessScore, readinessReason, readinessCaption,
      readinessWas: 'Bike · 5 × 4 min threshold',
      readinessNow: 'Bike · 50 min Z2',
      adjustTag: 'Wednesday · Bike',
      adjustUnit: 'min', adjustMin: 30, adjustMax: 90, adjustVal: 45, adjustPaceSec: 0,
      adjustSub: 'targets rescale to match',
      adjustCaption: 'Make any swim, bike or run longer or shorter. The targets update with it.',
      swapTag: 'Thursday · Threshold swim',
      swapOpts: ['Easy swim · 1500 m', 'Bike · 60 min Z2'],
      rebalanceTag: logged.tag, rebalanceNote: logged.note, rebalanceCaption,
    };
  }
  if (mode === 'hyrox') {
    return {
      readinessScore, readinessReason, readinessCaption,
      readinessWas: 'Stations · hard intervals',
      readinessNow: 'Easy run · 6 km',
      adjustTag: 'Wednesday · Run',
      adjustUnit: 'km', adjustMin: 3, adjustMax: 10, adjustVal: 5, adjustPaceSec: easyPaceSec,
      adjustSub: easyPace ? `@ ${easyPace}` : 'targets rescale to match',
      adjustCaption: 'Make a run or a station block longer, shorter, easier or harder. The targets update with it.',
      swapTag: 'Thursday · Stations',
      swapOpts: ['Easy run · 6 km', 'Strength · 45 min'],
      rebalanceTag: logged.tag, rebalanceNote: logged.note, rebalanceCaption,
    };
  }
  return {
    readinessScore, readinessReason, readinessCaption,
    readinessWas: 'Threshold · 5 × 1 km',
    readinessNow: 'Easy · 8 km',
    adjustTag: 'Tuesday · Easy run',
    adjustUnit: 'km', adjustMin: 8, adjustMax: 22, adjustVal: 12, adjustPaceSec: easyPaceSec,
    adjustSub: easyPace ? `@ ${easyPace}` : 'pace held',
    adjustCaption: 'Drag a run longer or shorter, or make it easier or harder. The distance, time and pace targets update with it.',
    swapTag: 'Wednesday · Tempo 6 km',
    swapOpts: ['Easy run · 8 km', 'Intervals · 5 × 800 m'],
    rebalanceTag: logged.tag, rebalanceNote: logged.note, rebalanceCaption,
  };
}

/** Readiness label from score (mirrors readiness.ts thresholds). */
function readinessLabelForScore(score: number): ReadinessLabel {
  if (score >= 75) return 'Primed';
  if (score >= 55) return 'On Track';
  if (score >= 35) return 'Manage Load';
  return 'Ease Back';
}

/** Faithful mini-mock: the real readiness ring + score easing today's session. */
function mockReadiness(d: ShowcaseData): string {
  const score = d.readinessScore;
  const label = readinessLabelForScore(score);
  const stops = readinessColorStops(label);
  const offset = +(RING_C * (1 - score / 100)).toFixed(2);
  const ring = `
    <div style="position:relative;width:90px;height:90px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.6);border-radius:50%;border:1px solid rgba(255,255,255,0.7);box-shadow:0 6px 22px -8px rgba(0,0,0,0.16)">
      <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="cc-rdn-grad" x1="20%" y1="90%" x2="80%" y2="10%">
            <stop offset="0%" stop-color="${stops.highlight}"/>
            <stop offset="50%" stop-color="${stops.mid}"/>
            <stop offset="100%" stop-color="${stops.shadow}"/>
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="8"/>
        <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="url(#cc-rdn-grad)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${RING_C}" stroke-dashoffset="${offset}" style="transform-origin:50% 50%"/>
      </svg>
      <div style="position:relative;z-index:1;font-size:25px;font-weight:300;letter-spacing:-0.03em;color:var(--c-black)">${score}</div>
    </div>`;
  return `
    <div class="cc-mock" style="display:flex;gap:14px;align-items:center">
      ${ring}
      <div style="flex:1;min-width:0">
        <div class="cc-mtag">Today · Readiness</div>
        <div style="font-size:13px;font-weight:600;color:var(--c-black);margin:2px 0 5px">${label}</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.4;margin-bottom:8px">${d.readinessReason}</div>
        <div style="display:flex;align-items:center;gap:7px;font-size:12px;flex-wrap:wrap">
          <span style="color:var(--c-faint);text-decoration:line-through">${d.readinessWas}</span>
          <span style="color:var(--c-faint)">→</span>
          <span style="font-weight:600;color:var(--c-black)">${d.readinessNow}</span>
        </div>
      </div>
    </div>`;
}

/** Faithful mini-mock: Adjust — the real m-slider-glass, touchable (wired in
 *  `wireAdjustSlider`). */
function mockAdjust(d: ShowcaseData): string {
  // Easier/harder pacing toggle — only for run-paced sessions (not the
  // duration-only tri bike example).
  const effort = d.adjustPaceSec > 0
    ? `<div style="display:flex;gap:6px;margin-top:11px">
         <button type="button" class="cc-eff" data-adj="8">Easier</button>
         <button type="button" class="cc-eff sel" data-adj="0">As planned</button>
         <button type="button" class="cc-eff" data-adj="-8">Harder</button>
       </div>`
    : '';
  return `
    <div class="cc-mock">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="cc-mtag">${d.adjustTag}</span>
        <span class="cc-mlink">Adjust</span>
      </div>
      <input type="range" id="cc-adj" class="m-slider-glass" min="${d.adjustMin}" max="${d.adjustMax}" step="1" value="${d.adjustVal}"
             data-unit="${d.adjustUnit}" data-pace="${d.adjustPaceSec}" data-sub="${escapeHtml(d.adjustSub)}" style="width:100%">
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:6px">
        <span id="cc-adj-val" style="font-size:15px;font-weight:600;color:var(--c-black)">${d.adjustVal} ${d.adjustUnit}</span>
        <span id="cc-adj-sub" style="font-size:12px;color:var(--c-muted)">${d.adjustSub}</span>
      </div>
      ${effort}
    </div>`;
}

/** Live-wire the Adjust slider so dragging updates the value (and, for runs,
 *  the time at the athlete's real easy pace). */
function wireAdjustSlider(): void {
  const slider = document.getElementById('cc-adj') as HTMLInputElement | null;
  if (!slider) return;
  const valEl = document.getElementById('cc-adj-val');
  const subEl = document.getElementById('cc-adj-sub');
  const unit = slider.dataset.unit ?? '';
  const paceSec = slider.dataset.pace ? parseInt(slider.dataset.pace, 10) : 0;
  const staticSub = slider.dataset.sub ?? '';
  const fmtClock = (sec: number): string => {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  };
  const fmtPaceKm = (p: number): string => `${Math.floor(p / 60)}:${String(Math.round(p % 60)).padStart(2, '0')}/km`;
  // Easier/harder pacing toggle adjusts the pace target (sec/km); slider drives
  // distance + time. Both feed the same readout.
  const effChips = Array.from(document.querySelectorAll<HTMLElement>('.cc-eff'));
  const effortAdj = () => {
    const sel = effChips.find((c) => c.classList.contains('sel'));
    return sel ? parseInt(sel.dataset.adj ?? '0', 10) : 0;
  };
  const update = () => {
    const v = parseInt(slider.value, 10) || 0;
    if (valEl) valEl.textContent = `${v} ${unit}`;
    if (subEl) {
      if (paceSec > 0 && unit === 'km') {
        const p = paceSec + effortAdj();
        subEl.textContent = `@ ${fmtPaceKm(p)} · ${fmtClock(v * p)}`;
      } else {
        subEl.textContent = staticSub;
      }
    }
  };
  slider.addEventListener('input', update);
  effChips.forEach((c) => c.addEventListener('click', () => {
    effChips.forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
    update();
  }));
  update();
}

/** Let the swap-option chips toggle on tap (single-select within the group). */
function wireSwapChips(): void {
  const chips = Array.from(document.querySelectorAll<HTMLElement>('.cc-chip'));
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      chips.forEach((c) => c.classList.remove('sel'));
      chip.classList.add('sel');
    });
  });
}

/** Faithful mini-mock: Swap (a session, two alternatives). */
function mockSwap(d: ShowcaseData): string {
  return `
    <div class="cc-mock">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:11px">
        <span class="cc-mtag">${d.swapTag}</span>
        <span class="cc-mlink">Swap</span>
      </div>
      <div style="display:flex;gap:8px">
        <div class="cc-chip sel">${d.swapOpts[0]}</div>
        <div class="cc-chip">${d.swapOpts[1]}</div>
      </div>
    </div>`;
}

/** Faithful mini-mock: weekly rebalance (a week strip, one day logged, one
 *  eased). Bar heights are illustrative UI content, not a data chart. */
function mockRebalance(d: ShowcaseData): string {
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const heights = [52, 0, 88, 38, 60, 92, 24]; // 0 = rest day
  const loggedIdx = 2;
  const trimIdx = 3;
  const bars = heights
    .map((h, i) => {
      if (h === 0) {
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;height:100%"><div style="flex:1;display:flex;align-items:flex-end;width:100%;justify-content:center"><div style="width:100%;max-width:13px;height:6px;border-radius:3px;background:var(--c-border)"></div></div><span style="font-size:9px;color:var(--c-faint)">${days[i]}</span></div>`;
      }
      let fill: string;
      if (i === loggedIdx) {
        fill = `<div style="width:100%;max-width:13px;height:${h}%;border-radius:3px;background:${LOAD_LINE}"></div>`;
      } else if (i === trimIdx) {
        fill = `<div style="width:100%;max-width:13px;height:${h}%;display:flex;flex-direction:column;justify-content:flex-end"><div style="height:44%;border-radius:3px 3px 0 0;border:1px dashed rgba(0,0,0,0.18);border-bottom:none"></div><div style="height:56%;border-radius:0 0 3px 3px;background:rgba(0,0,0,0.22)"></div></div>`;
      } else {
        fill = `<div style="width:100%;max-width:13px;height:${h}%;border-radius:3px;background:rgba(0,0,0,0.16)"></div>`;
      }
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;height:100%"><div style="flex:1;display:flex;align-items:flex-end;width:100%;justify-content:center">${fill}</div><span style="font-size:9px;color:var(--c-faint)">${days[i]}</span></div>`;
    })
    .join('');

  return `
    <div class="cc-mock">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:11px">
        <span class="cc-mtag">This week</span>
        <span class="cc-mlink">Auto-balanced</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:7px;height:62px">${bars}</div>
      <div style="margin-top:10px;font-size:11px;color:var(--c-muted)"><span class="cc-dotacc"></span>${d.rebalanceTag} · ${d.rebalanceNote}</div>
    </div>`;
}

/** Faithful mini-mock: the injury "Recovery mode" banner (mirrors buildInjuryBanner). */
function mockInjury(): string {
  return `
    <div class="cc-mock">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="min-width:0">
          <div class="cc-mtag">Recovery mode</div>
          <div style="font-size:15px;font-weight:600;color:var(--c-black);margin-top:3px;letter-spacing:-0.01em">Calf niggle</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Rehabilitation</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="cc-mtag">Pain</div>
          <div style="font-size:26px;font-weight:300;line-height:1;color:var(--c-black);letter-spacing:-0.03em;margin-top:2px">3<span style="font-size:12px;color:var(--c-faint);font-weight:400">/10</span></div>
        </div>
      </div>
      <span class="cc-pill">Limited running</span>
    </div>`;
}

function renderFeatureShowcase(
  mode: PlanMode,
  s: ReturnType<typeof getState>,
  _state: OnboardingState,
  sport: SportLoad | null,
): string {
  const d = showcaseDataForMode(mode, s, sport);
  return `
    <p class="cc-h">Built to flex around you.</p>
    <p class="cc-p" style="margin-bottom:6px">We read your load and recovery from every session and reshape the weeks as you go. Here is what that looks like.</p>

    <div class="cc-feat">
      <p class="cc-fl">Readiness sets today's session</p>
      ${mockReadiness(d)}
      <p class="cc-fc">${d.readinessCaption}</p>
    </div>

    <div class="cc-feat">
      <p class="cc-fl">Adjust any session</p>
      ${mockAdjust(d)}
      <p class="cc-fc">${d.adjustCaption}</p>
    </div>

    <div class="cc-feat">
      <p class="cc-fl">Swap it, or generate a fresh one</p>
      ${mockSwap(d)}
      <p class="cc-fc">Not feeling a session? Swap it for another, or generate a new one for any day.</p>
    </div>

    <div class="cc-feat">
      <p class="cc-fl">Do extra, we rebalance</p>
      ${mockRebalance(d)}
      <p class="cc-fc">${d.rebalanceCaption}</p>
    </div>

    <div class="cc-feat">
      <p class="cc-fl">When life gets in the way</p>
      ${mockInjury()}
      <p class="cc-fc">Tell us about a niggle and we drop into recovery mode: load scales back with a return-to-run path that protects it until you are clear.</p>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;gap:9px;align-items:flex-start;font-size:12.5px;color:var(--c-muted);line-height:1.45"><span style="width:6px;height:6px;border-radius:50%;background:var(--c-border-strong);flex:0 0 auto;margin-top:5px"></span><span><strong style="color:var(--c-black);font-weight:600">Illness mode</strong> eases the week until you bounce back.</span></div>
        <div style="display:flex;gap:9px;align-items:flex-start;font-size:12.5px;color:var(--c-muted);line-height:1.45"><span style="width:6px;height:6px;border-radius:50%;background:var(--c-border-strong);flex:0 0 auto;margin-top:5px"></span><span><strong style="color:var(--c-black);font-weight:600">Holiday mode</strong> trims the plan to fit, then picks it back up.</span></div>
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════════════════
 *  Shared helpers
 * ════════════════════════════════════════════════════════════════════════════ */

/** Staggered glass-card factory — keeps the entrance rhythm consistent. */
function cardFactory(): (inner: string) => string {
  let delay = 0.12;
  return (inner: string): string => {
    const html = `<div class="cc-rise cc-card" style="width:100%;max-width:480px;margin-top:14px;animation-delay:${delay.toFixed(2)}s">${inner}</div>`;
    delay += 0.06;
    return html;
  };
}

function commonKnowFragments(s: ReturnType<typeof getState>, _state: OnboardingState, sports: SportLoad[]): string[] {
  const frags: string[] = [];
  if ((s.ctlBaseline ?? 0) >= 20) frags.push('your recent training');
  const hrConf = s.hrCalibratedVdot?.confidence;
  if (hrConf && hrConf !== 'none') frags.push('how your heart rate and recovery respond');
  const sportNames = sports.slice(0, 2).map((sp) => sp.label);
  if (sportNames.length > 0) frags.push(`the ${joinNatural(sportNames)} you play`);
  if (s.commuteConfig?.enabled) frags.push('your commute');
  return frags;
}

function builtFromSentence(frags: string[]): string {
  // No real personalisation signal yet → hide the subhead entirely rather than
  // show a generic non-personalised line (Tristan).
  return frags.length > 0 ? `We shaped it around ${joinNatural(frags)}.` : '';
}

function runningRaceLabel(s: ReturnType<typeof getState>, state: OnboardingState): string {
  if (s.continuousMode) return 'training';
  if (state.selectedRace?.name) return escapeHtml(state.selectedRace.name);
  switch (s.rd) {
    case '5k': return '5K';
    case '10k': return '10K';
    case 'half': return 'half marathon';
    case 'marathon': return 'marathon';
    default: return 'race';
  }
}

function triDistanceLabel(s: ReturnType<typeof getState>, state: OnboardingState): string {
  const d = s.triConfig?.distance ?? state.triDistance;
  if (d === 'ironman') return 'Ironman';
  if (d === '70.3') return '70.3';
  return 'race';
}

function joinNatural(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function cap(str: string): string {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

/** Format seconds as m:ss (for CSS /100m). */
function fmtPer100(sec: number): string {
  const m = Math.floor(sec / 60);
  const ss = Math.round(sec % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
