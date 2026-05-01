import type { OnboardingState, Marathon, TrainingFocus } from '@/types/onboarding';
import type { RaceDistance } from '@/types/training';
import { getMarathonsByDistance, formatRaceDate, calculateWeeksUntil } from '@/data/marathons';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Page 5 — Race / Target (mode-branched).
 *
 * Running path: race picker (5K/10K/half/marathon) + scrollable event list (half/marathon)
 * or plan-duration stepper (5K/10K) + optional custom date.
 *
 * Fitness path: focus picker (speed / balanced / endurance) + optional target date.
 *
 * Hyrox/Triathlon: auto-skip. No screen yet — those modes go to the next step silently.
 *
 * Aesthetic clone of `goals.ts` / `review.ts`:
 * - Apple 3-layer shadow (`.shadow-ap`)
 * - Row pills with `.rt-row-*` (scoped prefix; mirrors `.cs-row-*` / `.r-row-*`)
 * - Monochrome, no tinted cards, no accent colour on navigation
 * - `rtRise` entry animation
 */

type TrainingMode = 'running' | 'hyrox' | 'triathlon' | 'fitness';

/** How many races to show in the scrollable event list. 16 gives enough tiles to
 * cover the world-majors + second tier without overwhelming the scroll region. */
const RACE_LIST_SHOWN = 16;
/** Minimum plan weeks by distance. Marathons need 8 weeks minimum for a meaningful
 * progression (shorter than that is a sharpening block, not a marathon build).
 * Shorter distances allow 4-week minimums. Locked 2026-04-22. */
const MIN_PLAN_WEEKS_BY_DISTANCE: Record<RaceDistance, number> = {
  '5k': 4,
  '10k': 4,
  'half': 4,
  'marathon': 8,
};
/** Maximum plan weeks the stepper allows. */
const MAX_PLAN_WEEKS = 52;

function minWeeksFor(distance: RaceDistance | null): number {
  return distance ? MIN_PLAN_WEEKS_BY_DISTANCE[distance] : 4;
}

/**
 * Fitness-path focus options.
 *
 * `track` selects Just-Track mode: no plan generated, activity tracking only.
 * The handler sets `trackOnly: true` on the onboarding state so the controller
 * can skip plan-preview and initialization can short-circuit plan generation.
 *
 * Lock order (Decision 5, 2026-04-22): endurance / speed / both / track.
 */
const FOCUS_OPTIONS: { id: TrainingFocus; label: string; sub: string }[] = [
  { id: 'endurance', label: 'Endurance',  sub: 'Aerobic base, longer efforts.' },
  { id: 'speed',     label: 'Speed',      sub: 'Build raw speed at shorter distances.' },
  { id: 'both',      label: 'Balanced',   sub: 'Speed and endurance in equal measure.' },
  { id: 'track',     label: 'Just track', sub: 'Log activities only. No plan, no workouts.' },
];

export function renderRaceTarget(container: HTMLElement, state: OnboardingState): void {
  const mode = resolveMode(state);

  // Just-Track mode: nothing to configure. Skip silently.
  if (state.trackOnly === true) {
    console.log('[race-target] trackOnly; skipping screen.');
    nextStep();
    return;
  }

  // Auto-skip for modes we don't handle yet.
  if (mode !== 'running' && mode !== 'fitness') {
    console.log(`[race-target] Mode=${mode ?? 'null'}; skipping screen.`);
    nextStep();
    return;
  }

  container.innerHTML = `
    <style>
      @keyframes rtRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .rt-rise { opacity:0; animation: rtRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      /* Row / pill surfaces (scoped). */
      .rt-row { display:flex; align-items:center; gap:14px; width:100%; background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:14px 16px; text-align:left; color:var(--c-black); cursor:pointer; transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .rt-row:active { transform: translateY(0.5px) scale(0.997); }
      .rt-row.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); box-shadow: 0 0 0 1px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.10); }

      /* Race-card left thumbnail: square art tile, city gradient fallback, grayscale photo when imageUrl present. */
      .rt-race-thumb { flex:0 0 56px; width:56px; height:56px; border-radius:12px; overflow:hidden; position:relative; box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 1px 2px rgba(0,0,0,0.08); }
      .rt-race-thumb .rt-thumb-img { position:absolute; inset:0; background-size:cover; background-position:center; filter: grayscale(1) contrast(1.05); }
      .rt-race-thumb .rt-thumb-vignette { position:absolute; inset:0; background: linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,0.32) 100%); }
      .rt-race-thumb .rt-thumb-mono { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:rgba(253,252,247,0.92); font-size:17px; font-weight:500; letter-spacing:-0.01em; }
      .rt-race-thumb .rt-thumb-landmark { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:rgba(253,252,247,0.88); }
      .rt-race-thumb .rt-thumb-landmark svg { width:38px; height:38px; }
      .rt-row.selected .rt-race-thumb { box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 2px rgba(0,0,0,0.4); }

      .rt-row-body { flex:1; min-width:0; }
      .rt-row-label { font-size:15px; font-weight:500; line-height:1.2; margin:0; letter-spacing:-0.005em; }
      .rt-row-sub { font-size:12px; color:var(--c-faint); margin:3px 0 0; line-height:1.35; }
      .rt-row.selected .rt-row-sub { color: rgba(253,252,247,0.7); }

      /* Distance grid — 4 small pills. 5 columns only if ultra is enabled; we match goals.ts 5-col. */
      .rt-dist-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; }
      .rt-dist { display:flex; flex-direction:column; align-items:center; justify-content:center; background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:14px; padding:12px 6px; color:var(--c-black); cursor:pointer; transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .rt-dist:active { transform: translateY(0.5px) scale(0.99); }
      .rt-dist.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); box-shadow: 0 0 0 1px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.10); }
      .rt-dist-label { font-size:14px; font-weight:500; }
      .rt-dist-sub { font-size:10px; opacity:0.65; margin-top:2px; }
      .rt-dist.selected .rt-dist-sub { opacity: 0.7; }

      /* Micro section label (mirrors goals.ts). */
      .rt-micro { display:block; font-size:11px; color:var(--c-faint); letter-spacing:0.08em; margin:0 0 10px; }

      /* Week stepper — mirrors goals.ts week selector surface. */
      .rt-stepper { display:flex; align-items:center; gap:12px; background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:8px; }
      .rt-stepper-btn { width:38px; height:38px; font-size:18px; }
      .rt-stepper-readout { flex:1; text-align:center; }
      .rt-stepper-readout .v { font-size:22px; font-weight:300; color:var(--c-black); }
      .rt-stepper-readout .u { font-size:13px; color:var(--c-muted); margin-left:4px; }

      /* Race list — scrollable. */
      .rt-race-list { display:flex; flex-direction:column; gap:10px; max-height:260px; overflow-y:auto; padding-right:4px; }

      /* Custom date surface. */
      .rt-date-card { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:14px 16px; }
      .rt-date-input { width:100%; box-sizing:border-box; background:var(--c-bg); border:1.5px solid var(--c-border-strong); color:var(--c-black); border-radius:10px; padding:10px 12px; font-size:15px; outline:none; }
      .rt-date-note { font-size:12px; color:var(--c-faint); margin:8px 0 0; }

      /* Segmented control — used for Ongoing / Set duration on the fitness path. */
      .rt-seg { border:none; background:transparent; color:var(--c-black); border-radius:10px; padding:10px 8px; font-size:14px; font-weight:500; cursor:pointer; transition: background 0.15s ease, color 0.15s ease; }
      .rt-seg.selected { background:#0A0A0A; color:#FDFCF7; }

      /* Toggle link — muted, no colour, no border (per UI rules). */
      .rt-toggle { background:none; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; padding:8px 6px; text-decoration:underline; }
      .rt-toggle:active { color:var(--c-black); }

      /* CTA — monochrome pill (matches review.ts). */
      .rt-cta { width:100%; height:50px; border-radius:25px; background:#0A0A0A; color:#FDFCF7; border:none; font-size:15px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1), 0 8px 22px -8px rgba(0,0,0,0.35); transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .rt-cta:active { transform: translateY(1px); }
      .rt-cta[disabled] { opacity:0.35; cursor:not-allowed; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 32%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(4, 7)}

        <div class="rt-rise" style="width:100%;max-width:460px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            ${renderHeading(mode, state)}
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            ${renderSubheading(mode, state)}
          </p>
        </div>

        <div class="rt-rise" style="width:100%;max-width:460px;margin-top:22px;animation-delay:0.12s;display:flex;flex-direction:column;gap:16px">
          ${mode === 'running' ? renderRunningBlock(state) : renderFitnessBlock(state)}
        </div>
      </div>

      <div class="rt-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.28s">
        <div style="max-width:460px;margin:0 auto">
          <button id="rt-continue" class="rt-cta" ${canContinue(mode, state) ? '' : 'disabled'}>Continue</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state, mode);
}

/* ---------- Running block ---------- */

function renderHeading(mode: TrainingMode | null, state: OnboardingState): string {
  if (mode === 'running') {
    if (state.trainingForEvent === null) return 'Training for an event?';
    if (state.trainingForEvent === false) return "What's your focus?";
    return 'Pick your target';
  }
  return "What's your focus?";
}

function renderSubheading(mode: TrainingMode | null, state: OnboardingState): string {
  if (mode === 'running') {
    if (state.trainingForEvent === null) return "We'll tailor the plan either way.";
    if (state.trainingForEvent === false) return 'Tell us what you want to build.';
    return 'Distance first, then the event or a date.';
  }
  return 'Tell us what you want to build.';
}

function renderRunningBlock(state: OnboardingState): string {
  // Gate: no Y/N answer yet → show only the Yes/No pair.
  if (state.trainingForEvent === null) {
    return renderEventYesNo(state);
  }

  // No event → focus picker (endurance/speed/both) + plan length.
  if (state.trainingForEvent === false) {
    return `${renderEventYesNo(state)}${renderRunningFocusPicker(state)}${renderFitnessDurationBlock(state)}`;
  }

  // Yes → distance + race/date picker.
  const distanceBlock = renderDistanceGrid(state);
  const eventBlock =
    (state.raceDistance === 'half' || state.raceDistance === 'marathon')
      ? renderEventPicker(state)
      : (state.raceDistance === '5k' || state.raceDistance === '10k')
        ? renderWeeksStepper(state)
        : '';
  return `${renderEventYesNo(state)}${distanceBlock}${eventBlock}`;
}

/** Yes / No segmented pair at the top of the running flow. */
function renderEventYesNo(state: OnboardingState): string {
  const yes = state.trainingForEvent === true;
  const no = state.trainingForEvent === false;
  return `
    <div>
      <label class="rt-micro">TRAINING FOR AN EVENT?</label>
      <div class="shadow-ap" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px;background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);border-radius:14px">
        <button data-event-answer="yes" class="rt-seg ${yes ? 'selected' : ''}">Yes</button>
        <button data-event-answer="no"  class="rt-seg ${no ? 'selected' : ''}">No</button>
      </div>
    </div>
  `;
}

/** Running-mode focus picker (no Just Track — that's a separate mode tile). */
function renderRunningFocusPicker(state: OnboardingState): string {
  const options: { id: TrainingFocus; label: string; sub: string }[] = [
    { id: 'endurance', label: 'Endurance', sub: 'Aerobic base, longer efforts.' },
    { id: 'speed',     label: 'Speed',     sub: 'Build raw speed at shorter distances.' },
    { id: 'both',      label: 'Balanced',  sub: 'Speed and endurance in equal measure.' },
  ];
  return `
    <div>
      <label class="rt-micro">FOCUS</label>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${options.map(o => {
          const selected = state.trainingFocus === o.id;
          return `
            <button data-focus="${o.id}" class="rt-row shadow-ap ${selected ? 'selected' : ''}">
              <div class="rt-row-body">
                <p class="rt-row-label">${o.label}</p>
                <p class="rt-row-sub">${o.sub}</p>
              </div>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderDistanceGrid(state: OnboardingState): string {
  const distances: { id: RaceDistance; label: string; sub: string }[] = [
    { id: '5k',       label: '5K',       sub: '3.1 mi' },
    { id: '10k',      label: '10K',      sub: '6.2 mi' },
    { id: 'half',     label: 'Half',     sub: '13.1 mi' },
    { id: 'marathon', label: 'Marathon', sub: '26.2 mi' },
  ];
  return `
    <div>
      <label class="rt-micro">DISTANCE</label>
      <div class="rt-dist-grid">
        ${distances.map(d => `
          <button data-dist="${d.id}" class="rt-dist ${state.raceDistance === d.id ? 'selected' : ''}">
            <span class="rt-dist-label">${d.label}</span>
            <span class="rt-dist-sub">${d.sub}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderWeeksStepper(state: OnboardingState): string {
  const weeks = state.planDurationWeeks;
  const minWeeks = minWeeksFor(state.raceDistance);
  return `
    <div>
      <label class="rt-micro">PLAN DURATION</label>
      <div class="shadow-ap rt-stepper">
        <button id="rt-weeks-minus" class="m-btn-glass m-btn-glass--inset m-btn-glass--icon rt-stepper-btn" style="opacity:${weeks <= minWeeks ? '0.3' : '1'}" ${weeks <= minWeeks ? 'disabled' : ''}>−</button>
        <div class="rt-stepper-readout">
          <span class="v">${weeks}</span><span class="u">weeks</span>
        </div>
        <button id="rt-weeks-plus" class="m-btn-glass m-btn-glass--inset m-btn-glass--icon rt-stepper-btn" style="opacity:${weeks >= MAX_PLAN_WEEKS ? '0.3' : '1'}" ${weeks >= MAX_PLAN_WEEKS ? 'disabled' : ''}>+</button>
      </div>
    </div>
  `;
}

/**
 * City landmark line-illustrations, keyed by race id or lowercased city.
 * Rendered inside the thumb when `imageUrl` is absent. Falls back to the
 * two-letter monogram for any race without a landmark entry.
 */
const RACE_LANDMARKS: Record<string, string> = {
  // London — Tower Bridge
  london: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18h18"/><path d="M5 8h4v10H5z"/><path d="M15 8h4v10h-4z"/><path d="M5 8l2-2 2 2"/><path d="M15 8l2-2 2 2"/><path d="M9 11c2 2 4 2 6 0"/><path d="M9 15h6"/></svg>`,
  // Berlin — Brandenburg Gate
  berlin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19h18"/><path d="M3 7h18"/><path d="M3 9h18"/><path d="M5 9v10"/><path d="M9 9v10"/><path d="M12 9v10"/><path d="M15 9v10"/><path d="M19 9v10"/><path d="M10 7V4h4v3"/></svg>`,
  // Boston — Zakim Bridge
  boston: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 17L12 3l1.5 14"/><path d="M3 19h18"/><path d="M12 4L4 19"/><path d="M12 4l8 15"/><path d="M12 9l-5 10"/><path d="M12 9l5 10"/></svg>`,
  // NYC — Empire State Building
  nyc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><path d="M11 6h2v3h-2z"/><path d="M9 9h6v4h-6z"/><path d="M7 13h10v7"/><path d="M7 20v-7"/><path d="M3 20h18"/></svg>`,
  'nyc-half': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><path d="M11 6h2v3h-2z"/><path d="M9 9h6v4h-6z"/><path d="M7 13h10v7"/><path d="M7 20v-7"/><path d="M3 20h18"/></svg>`,
  // Chicago — Willis Tower
  chicago: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v3"/><path d="M14 3v3"/><path d="M7 6h10v14"/><path d="M7 20V6"/><path d="M7 10h10"/><path d="M7 14h10"/><path d="M3 20h18"/></svg>`,
  // Tokyo — Tokyo Tower
  tokyo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2"/><path d="M12 5L7 20"/><path d="M12 5l5 15"/><path d="M9 12h6"/><path d="M8.5 14h7"/><path d="M3 20h18"/></svg>`,
  // Paris — Eiffel Tower
  paris: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2"/><path d="M12 5c-1 6 -4 10 -5 15"/><path d="M12 5c1 6 4 10 5 15"/><path d="M9.5 11h5"/><path d="M8 17c1.5 -1.5 6.5 -1.5 8 0"/><path d="M3 20h18"/></svg>`,
  // Valencia — Hemisfèric (Ciutat de les Arts)
  valencia: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15c2 -8 16 -8 18 0"/><path d="M3 15h18"/><path d="M5 18h14"/><circle cx="12" cy="12" r="2"/></svg>`,
  // Sydney — Opera House sails
  sydney: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19h18"/><path d="M4 19c0 -4 2 -7 5 -8"/><path d="M9 19c0 -5 2 -9 5 -10"/><path d="M13 19c0 -4 2 -7 5 -8"/><path d="M3 21h18"/></svg>`,
  // Amsterdam — canal house gables
  amsterdam: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19h18"/><path d="M5 19V10l2-2 2 2v9"/><path d="M9 19V9l2.5-2.5L14 9v10"/><path d="M14 19v-7l2-2 2 2v7"/><path d="M3 21h18"/></svg>`,
};

function getRaceLandmark(race: { id: string; city?: string }): string | null {
  const byId = RACE_LANDMARKS[race.id];
  if (byId) return byId;
  const cityKey = (race.city || '').toLowerCase().replace(/[^a-z]/g, '');
  return RACE_LANDMARKS[cityKey] ?? null;
}

/**
 * Left-side thumb for a race row. Uses `race.imageUrl` when present (greyscale
 * treated), otherwise prefers a city landmark SVG, falling back to a
 * deterministic charcoal gradient with two-letter monogram. Real photos can
 * be dropped into `src/assets/races/<id>.jpg` and wired via `imageUrl`.
 */
function renderRaceThumb(race: { id: string; name: string; city?: string; imageUrl?: string }): string {
  if (race.imageUrl) {
    return `
      <div class="rt-race-thumb">
        <div class="rt-thumb-img" style="background-image:url('${race.imageUrl}')"></div>
        <div class="rt-thumb-vignette"></div>
      </div>
    `;
  }
  const seed = race.id;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const base = 14 + (h % 18);
  const peak = 30 + (h % 18);
  const bg = `linear-gradient(135deg, #${base.toString(16).padStart(2,'0')}${base.toString(16).padStart(2,'0')}${base.toString(16).padStart(2,'0')} 0%, #${peak.toString(16).padStart(2,'0')}${peak.toString(16).padStart(2,'0')}${peak.toString(16).padStart(2,'0')} 55%, #141414 100%)`;
  const landmark = getRaceLandmark(race);
  if (landmark) {
    return `
      <div class="rt-race-thumb" style="background:${bg}">
        <div class="rt-thumb-landmark">${landmark}</div>
        <div class="rt-thumb-vignette"></div>
      </div>
    `;
  }
  const source = race.city || race.name;
  const monogram = source.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  return `
    <div class="rt-race-thumb" style="background:${bg}">
      <div class="rt-thumb-mono">${monogram}</div>
      <div class="rt-thumb-vignette"></div>
    </div>
  `;
}

function renderEventPicker(state: OnboardingState): string {
  const distance = state.raceDistance === 'marathon' ? 'marathon' : 'half';
  const races = getMarathonsByDistance(distance, minWeeksFor(state.raceDistance));
  const usingCustomDate = state.customRaceDate !== null;

  if (usingCustomDate) {
    return `
      <div>
        <label class="rt-micro">RACE DATE</label>
        <div class="shadow-ap rt-date-card">
          <input type="date" id="rt-custom-date" class="rt-date-input" value="${state.customRaceDate || ''}">
          ${state.customRaceDate ? `<p class="rt-date-note" id="rt-weeks-note">${calculateWeeksUntil(state.customRaceDate)} weeks of training</p>` : ''}
        </div>
        <div style="text-align:center;margin-top:8px">
          <button id="rt-toggle-date" class="rt-toggle">Browse races instead</button>
        </div>
      </div>
    `;
  }

  return `
    <div>
      <label class="rt-micro">SELECT YOUR EVENT</label>
      <div class="rt-race-list">
        ${races.slice(0, RACE_LIST_SHOWN).map(race => {
          const selected = state.selectedRace?.id === race.id;
          return `
            <button data-race-id="${race.id}" class="rt-row shadow-ap ${selected ? 'selected' : ''}">
              ${renderRaceThumb(race)}
              <div class="rt-row-body">
                <p class="rt-row-label">${race.name}</p>
                <p class="rt-row-sub">${formatRaceDate(race.date)}${race.city ? ' · ' + race.city : ''}</p>
              </div>
              <span style="font-size:12px;font-weight:600;opacity:${selected ? '0.9' : '0.7'};flex-shrink:0">${race.weeksUntil ?? '--'}wk</span>
            </button>
          `;
        }).join('')}
      </div>
      <div style="text-align:center;margin-top:10px">
        <button id="rt-toggle-date" class="rt-toggle">Enter a custom date instead</button>
      </div>
    </div>
  `;
}

/* ---------- Fitness block ---------- */

function renderFitnessBlock(state: OnboardingState): string {
  const trackOnly = state.trackOnly === true;
  return `
    <div>
      <label class="rt-micro">FOCUS</label>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${FOCUS_OPTIONS.map(o => {
          const selected = o.id === 'track'
            ? trackOnly
            : (!trackOnly && state.trainingFocus === o.id);
          return `
            <button data-focus="${o.id}" class="rt-row shadow-ap ${selected ? 'selected' : ''}">
              <div class="rt-row-body">
                <p class="rt-row-label">${o.label}</p>
                <p class="rt-row-sub">${o.sub}</p>
              </div>
            </button>
          `;
        }).join('')}
      </div>
    </div>
    ${trackOnly ? '' : renderFitnessDurationBlock(state)}
  `;
}

/**
 * Fitness path duration picker. Segmented Ongoing / Set duration.
 * - Ongoing: `continuousMode: true` — no target date, plan regenerates rolling.
 * - Set duration: weeks stepper reusing the 5K/10K stepper handlers.
 *
 * Locked 2026-04-22: replaces the previous optional target-date block because
 * "fitness with a target date" was confusing — if the user has a date, they're
 * in running mode. Fitness mode is goal-less by definition.
 */
function renderFitnessDurationBlock(state: OnboardingState): string {
  const continuous = state.continuousMode !== false; // default true
  return `
    <div>
      <label class="rt-micro">PLAN LENGTH</label>
      <div class="shadow-ap" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px;background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);border-radius:14px">
        <button data-fit-mode="ongoing" class="rt-seg ${continuous ? 'selected' : ''}">Ongoing</button>
        <button data-fit-mode="fixed"   class="rt-seg ${continuous ? '' : 'selected'}">Set duration</button>
      </div>
      ${continuous ? `
        <p class="rt-date-note" style="margin-top:10px">A rolling plan that keeps rebuilding week-by-week. No end date.</p>
      ` : `
        <div class="shadow-ap rt-stepper" style="margin-top:10px">
          <button id="rt-weeks-minus" class="m-btn-glass m-btn-glass--inset m-btn-glass--icon rt-stepper-btn" style="opacity:${state.planDurationWeeks <= 4 ? '0.3' : '1'}" ${state.planDurationWeeks <= 4 ? 'disabled' : ''}>−</button>
          <div class="rt-stepper-readout">
            <span class="v">${state.planDurationWeeks}</span><span class="u">weeks</span>
          </div>
          <button id="rt-weeks-plus" class="m-btn-glass m-btn-glass--inset m-btn-glass--icon rt-stepper-btn" style="opacity:${state.planDurationWeeks >= MAX_PLAN_WEEKS ? '0.3' : '1'}" ${state.planDurationWeeks >= MAX_PLAN_WEEKS ? 'disabled' : ''}>+</button>
        </div>
      `}
    </div>
  `;
}

/* ---------- Validation ---------- */

function canContinue(mode: TrainingMode | null, state: OnboardingState): boolean {
  if (mode === 'running') {
    // "No event" sub-path: user wants a focus-based plan, not a race target.
    if (state.trainingForEvent === false) return !!state.trainingFocus;
    if (!state.raceDistance) return false;
    if (state.raceDistance === 'half' || state.raceDistance === 'marathon') {
      return !!(state.selectedRace || state.customRaceDate);
    }
    // 5K / 10K — needs a plan duration (always set by default, so just confirm > 0).
    return state.planDurationWeeks >= minWeeksFor(state.raceDistance);
  }
  if (mode === 'fitness') return !!state.trainingFocus;
  return false;
}

function resolveMode(state: OnboardingState): TrainingMode | null {
  if (state.trainingMode) return state.trainingMode;
  if (state.trainingForEvent === true) return 'running';
  if (state.trainingForEvent === false) return 'fitness';
  return null;
}

/* ---------- Handlers ---------- */

function wireHandlers(state: OnboardingState, mode: TrainingMode | null): void {
  const races = (state.raceDistance === 'half' || state.raceDistance === 'marathon')
    ? getMarathonsByDistance(state.raceDistance === 'marathon' ? 'marathon' : 'half', minWeeksFor(state.raceDistance))
    : [];

  // Event Yes/No (running path).
  document.querySelectorAll<HTMLElement>('[data-event-answer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ans = btn.getAttribute('data-event-answer');
      if (ans === 'yes') {
        updateOnboarding({
          trainingForEvent: true,
          continuousMode: false,
          trainingFocus: null,
        });
      } else {
        updateOnboarding({
          trainingForEvent: false,
          continuousMode: true,
          raceDistance: null,
          selectedRace: null,
          customRaceDate: null,
        });
      }
      rerender();
    });
  });

  // Distance pick (running path).
  document.querySelectorAll<HTMLElement>('[data-dist]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dist = btn.getAttribute('data-dist') as RaceDistance;
      // Preserve the default plan duration from defaultOnboardingState when already set;
      // reset race + customDate when distance switches so stale selections don't persist.
      updateOnboarding({
        raceDistance: dist,
        selectedRace: null,
        customRaceDate: null,
      });
      rerender();
    });
  });

  // Race selection (half/marathon).
  document.querySelectorAll<HTMLElement>('[data-race-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-race-id');
      const race = races.find((r: Marathon) => r.id === id);
      if (!race) return;
      updateOnboarding({
        selectedRace: race,
        planDurationWeeks: race.weeksUntil ?? state.planDurationWeeks,
        customRaceDate: null,
      });
      rerender();
    });
  });

  // Toggle between race list and custom date (running half/marathon).
  document.getElementById('rt-toggle-date')?.addEventListener('click', () => {
    if (state.customRaceDate !== null) {
      updateOnboarding({ customRaceDate: null });
    } else {
      updateOnboarding({ customRaceDate: '', selectedRace: null });
    }
    rerender();
  });

  // Custom-date input (running half/marathon).
  const dateInput = document.getElementById('rt-custom-date') as HTMLInputElement | null;
  if (dateInput) {
    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() + 1);
    dateInput.max = maxDate.toISOString().split('T')[0];
    dateInput.addEventListener('change', () => {
      const v = dateInput.value;
      if (!v) return;
      const weeks = calculateWeeksUntil(v);
      const min = minWeeksFor(state.raceDistance);
      if (weeks < min) {
        dateInput.setCustomValidity(`Race must be at least ${min} weeks away`);
        dateInput.reportValidity();
        return;
      }
      if (weeks > MAX_PLAN_WEEKS) {
        dateInput.setCustomValidity('Race must be within 1 year');
        dateInput.reportValidity();
        return;
      }
      dateInput.setCustomValidity('');
      updateOnboarding({ customRaceDate: v, planDurationWeeks: weeks, selectedRace: null });
      const note = document.getElementById('rt-weeks-note');
      if (note) note.textContent = `${weeks} weeks of training`;
      else rerender();
    });
  }

  // Weeks stepper (5K / 10K / fitness Set-duration).
  // Update the DOM in place to avoid the full-rerender flash.
  const applyStepperDOM = (weeks: number, minW: number) => {
    const readout = document.querySelector<HTMLElement>('.rt-stepper-readout .v');
    if (readout) readout.textContent = String(weeks);
    const minus = document.getElementById('rt-weeks-minus') as HTMLButtonElement | null;
    const plus  = document.getElementById('rt-weeks-plus')  as HTMLButtonElement | null;
    if (minus) {
      minus.disabled = weeks <= minW;
      minus.style.opacity = weeks <= minW ? '0.3' : '1';
    }
    if (plus) {
      plus.disabled = weeks >= MAX_PLAN_WEEKS;
      plus.style.opacity = weeks >= MAX_PLAN_WEEKS ? '0.3' : '1';
    }
    // Re-enable / disable Continue — it depends on weeks ≥ min for 5K/10K.
    const cta = document.getElementById('rt-continue') as HTMLButtonElement | null;
    if (cta) cta.disabled = !canContinue(mode, { ...state, planDurationWeeks: weeks });
  };

  document.getElementById('rt-weeks-minus')?.addEventListener('click', () => {
    import('../controller').then(({ getOnboardingState }) => {
      const cur = getOnboardingState() || state;
      const weeks = cur.planDurationWeeks - 1;
      const minW = minWeeksFor(cur.raceDistance);
      if (weeks >= minW) {
        updateOnboarding({ planDurationWeeks: weeks });
        applyStepperDOM(weeks, minW);
      }
    });
  });
  document.getElementById('rt-weeks-plus')?.addEventListener('click', () => {
    import('../controller').then(({ getOnboardingState }) => {
      const cur = getOnboardingState() || state;
      const weeks = cur.planDurationWeeks + 1;
      const minW = minWeeksFor(cur.raceDistance);
      if (weeks <= MAX_PLAN_WEEKS) {
        updateOnboarding({ planDurationWeeks: weeks });
        applyStepperDOM(weeks, minW);
      }
    });
  });

  // Focus picker (fitness path). The 'track' id flags Just-Track mode: activity
  // logging only, no plan. Clearing a prior target date keeps state consistent
  // with the date-picker being hidden for track-only.
  document.querySelectorAll<HTMLElement>('[data-focus]').forEach(btn => {
    btn.addEventListener('click', () => {
      const focus = btn.getAttribute('data-focus') as TrainingFocus;
      if (focus === 'track') {
        updateOnboarding({
          trainingFocus: 'track',
          trackOnly: true,
          customRaceDate: null,
          selectedRace: null,
          continuousMode: true,
        });
      } else {
        updateOnboarding({
          trainingFocus: focus,
          trackOnly: false,
          continuousMode: state.customRaceDate === null,
        });
      }
      rerender();
    });
  });

  // Fitness plan-length segmented. Ongoing (no end) vs Set duration (stepper).
  document.querySelectorAll<HTMLElement>('[data-fit-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-fit-mode');
      if (m === 'ongoing') {
        updateOnboarding({ continuousMode: true, customRaceDate: null });
      } else {
        // Default to 12 weeks when switching to Set-duration for the first time.
        const cur = state.planDurationWeeks;
        const weeks = cur >= 4 && cur <= MAX_PLAN_WEEKS ? cur : 12;
        updateOnboarding({ continuousMode: false, planDurationWeeks: weeks });
      }
      rerender();
    });
  });

  // Continue.
  document.getElementById('rt-continue')?.addEventListener('click', () => {
    import('../controller').then(({ getOnboardingState }) => {
      const cur = getOnboardingState() || state;
      if (!canContinue(mode, cur)) return;
      nextStep();
    });
  });
}

function rerender(): void {
  import('../controller').then(({ getOnboardingState }) => {
    const cur = getOnboardingState();
    if (!cur) return;
    const container = document.getElementById('app-root');
    if (container) renderRaceTarget(container, cur);
  });
}
