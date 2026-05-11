import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { getState } from '@/state/store';

/**
 * Workout preview — the "research showcase" step.
 *
 * Shows the session types a user's plan will draw from, with one-line
 * literature anchors. Each toggleable card lets the user opt out of
 * session types they don't want — exclusions feed the plan engine.
 *
 * Supports running and cycling modes. Triathlon and HYROX don't use this step.
 *
 * Running: easy and long are locked (foundational). For 5K/10K races, long
 * is unlockable (shorter race = long run less critical). Marathon pace is
 * only shown for half/marathon targets.
 *
 * Cycling: all 9 bike session types shown; none locked.
 */

interface WorkoutCard {
  kind: string;
  name: string;
  category: string;
  oneLine: string;
  example: string;
  science: string;
  /** If true, the card cannot be toggled off — shown with a lock badge. */
  locked?: boolean;
}

// ─── Running catalog ──────────────────────────────────────────────────────────

const RUN_WORKOUTS_FOUNDATION: WorkoutCard[] = [
  {
    kind: 'easy',
    name: 'Easy run',
    category: 'Foundation',
    oneLine: 'Aerobic base at conversational effort.',
    example: '40–60 min at Z2 HR. Full sentences throughout.',
    science: 'Aerobic base — Seiler 80/20 low-intensity volume.',
    locked: true,
  },
  {
    kind: 'long',
    name: 'Long run',
    category: 'Foundation',
    oneLine: 'Weekly long effort. Builds fat oxidation and durability.',
    example: '60–150 min at easy-to-moderate effort. Steady throughout.',
    science: 'Peripheral adaptation — Coyle 1988; fat oxidation — Holloszy & Coyle 1984.',
    locked: true, // may be overridden to false for 5k/10k
  },
];

const RUN_WORKOUTS_QUALITY: WorkoutCard[] = [
  {
    kind: 'threshold',
    name: 'Threshold intervals',
    category: 'Quality',
    oneLine: 'Raises lactate threshold directly.',
    example: '15 min WU · 3×8 min @ LT pace, 2 min jog · 10 min CD.',
    science: 'Z4 lactate threshold — Daniels 2005, Pfitzinger & Douglas 2009.',
  },
  {
    kind: 'vo2',
    name: 'VO2 intervals',
    category: 'Quality',
    oneLine: 'Accumulates time at VO2max for aerobic ceiling gains.',
    example: '20 min WU · 5×3 min @ 5K effort, 2 min jog · 10 min CD.',
    science: 'Time at VO2max — Billat 2001; Ronnestad & Mujika 2014.',
  },
  {
    kind: 'float',
    name: 'Fartlek and Float',
    category: 'Quality',
    oneLine: 'Moderate-effort recovery forces lactate clearance adaptation.',
    example: '20 min WU · 6×3 min hard / 2 min float (MP effort) · 10 min CD.',
    science: 'MCT1/MCT4 lactate transport — Brooks 2009; Hudson & Fitzgerald 2008.',
  },
];

const RUN_WORKOUTS_RACE_SPECIFIC: WorkoutCard[] = [
  {
    kind: 'marathon_pace',
    name: 'Marathon pace',
    category: 'Race-specific',
    oneLine: 'Sustained running at goal race pace. Metabolic specificity.',
    example: '15 min WU · 16–24 km @ goal marathon pace · 5 min CD.',
    science: 'Race-pace metabolic specificity — Coyle 2007; Daniels 2005 Ch.9.',
  },
];

// ─── Cycling catalog (unchanged) ─────────────────────────────────────────────

const BIKE_WORKOUTS: WorkoutCard[] = [
  {
    kind: 'endurance',
    name: 'Endurance ride',
    category: 'Endurance',
    oneLine: 'Steady aerobic work below tempo.',
    example: '2h @ 65% FTP / Z2 HR. Conversational throughout.',
    science: 'Aerobic base — Coggan & Allen Z2.',
  },
  {
    kind: 'tempo',
    name: 'Tempo ride',
    category: 'Endurance',
    oneLine: 'Sustained sub-threshold load.',
    example: '15 min WU · 3×10 min @ 85% FTP, 3 min easy · 5 min CD.',
    science: 'Z3 — economy and fat oxidation.',
  },
  {
    kind: 'sweet_spot',
    name: 'Sweet spot',
    category: 'Quality',
    oneLine: 'High stimulus, manageable fatigue.',
    example: '15 min WU · 2×20 min @ 88% FTP, 5 min recovery · 10 min CD.',
    science: '88–95% FTP — Seiler-adjacent SST band.',
  },
  {
    kind: 'threshold',
    name: 'Threshold intervals',
    category: 'Quality',
    oneLine: 'Lifts FTP directly.',
    example: '15 min WU · 2×15 min @ 98% FTP, 5 min recovery · 10 min CD.',
    science: 'Z4 — Coggan & Allen Ch.7.',
  },
  {
    kind: 'vo2',
    name: 'VO2 intervals',
    category: 'Quality',
    oneLine: 'Long reps above FTP for aerobic ceiling.',
    example: '20 min WU · 5×3 min @ 115% FTP, 3 min recovery · 10 min CD.',
    science: 'Z5 — accumulates time at VO2max.',
  },
  {
    kind: 'hills',
    name: 'Hill repeats',
    category: 'Quality',
    oneLine: 'Force production on the climbs.',
    example: '20 min WU · 5×4 min climbs @ 95% FTP · 10 min CD.',
    science: 'Strength-endurance carryover.',
  },
  {
    kind: 'over_under',
    name: 'Over-unders',
    category: 'Pro-grade',
    oneLine: 'Lactate clearance at threshold.',
    example: '15 min WU · 3×(3 min @ 105% → 3 min @ 95%) · 10 min CD.',
    science: 'Coggan & Allen 2019 Ch.7.',
  },
  {
    kind: 'vo2_micros',
    name: 'VO2 micro-intervals',
    category: 'Pro-grade',
    oneLine: 'Maximum time at VO2max with lower lactate.',
    example: '20 min WU · 2×(10×30s @ 120% FTP / 30s easy) · 10 min CD.',
    science: 'Billat 2001; Rønnestad 2014 (cycling).',
  },
  {
    kind: 'vlamax',
    name: 'Neuromuscular sprints',
    category: 'Pro-grade',
    oneLine: 'Peak power and rate of force development.',
    example: '20 min WU · 8×10s max @ 160%+ FTP, 3 min recovery · 10 min CD.',
    science: 'PCr/glycolytic — Gastin 2001.',
  },
];

// ─── Entry point ──────────────────────────────────────────────────────────────

export function renderWorkoutPreview(container: HTMLElement, state: OnboardingState): void {
  const isRunning = !state.trainingMode || state.trainingMode === 'running';
  if (isRunning) {
    renderRunWorkoutPreview(container, state);
  } else {
    renderCyclingWorkoutPreview(container, state);
  }
}

// ─── Running variant ──────────────────────────────────────────────────────────

function renderRunWorkoutPreview(container: HTMLElement, state: OnboardingState): void {
  const raceDistance = state.raceDistance;
  // Long run is locked for half/marathon; unlockable for 5k/10k (shorter race = less critical)
  const longLocked = raceDistance === 'half' || raceDistance === 'marathon' || !raceDistance;
  // Marathon pace only relevant for half/marathon targets
  const showMarathonPace = raceDistance === 'half' || raceDistance === 'marathon' || !raceDistance;

  const foundation = RUN_WORKOUTS_FOUNDATION.map(w =>
    w.kind === 'long' ? { ...w, locked: longLocked } : w,
  );
  const quality = RUN_WORKOUTS_QUALITY;
  const raceSpecific = showMarathonPace ? RUN_WORKOUTS_RACE_SPECIFIC : [];

  const excluded = new Set(state.runningExcludedWorkouts ?? []);

  const categories: Array<{ label: string; cards: WorkoutCard[] }> = [
    { label: 'Foundation', cards: foundation },
    { label: 'Quality', cards: quality },
    ...(raceSpecific.length > 0 ? [{ label: 'Race-specific', cards: raceSpecific }] : []),
  ];

  container.innerHTML = buildPreviewHTML({
    title: 'What your plan looks like',
    intro: 'The session types your plan draws from, each anchored to published training literature.',
    tapHint: 'Tap any unlocked card to opt out.',
    categories,
    excluded,
    stepNum: 7,
    totalSteps: 8,
  });

  wireRunToggles(excluded);

  document.getElementById('wp-continue')?.addEventListener('click', () => nextStep());
}

function wireRunToggles(excluded: Set<string>): void {
  document.querySelectorAll<HTMLElement>('.wp-card[data-kind]').forEach((card) => {
    if (card.dataset.locked === 'true') return; // locked cards are non-interactive
    card.addEventListener('click', () => {
      const kind = card.getAttribute('data-kind');
      if (!kind) return;
      const current = new Set(((getState().onboarding as OnboardingState | null)?.runningExcludedWorkouts ?? []));
      if (current.has(kind)) {
        current.delete(kind);
        card.classList.remove('excluded');
        card.setAttribute('aria-checked', 'true');
        card.setAttribute('aria-label', card.getAttribute('aria-label')?.replace('excluded', 'included') ?? '');
      } else {
        current.add(kind);
        card.classList.add('excluded');
        card.setAttribute('aria-checked', 'false');
        card.setAttribute('aria-label', card.getAttribute('aria-label')?.replace('included', 'excluded') ?? '');
      }
      updateOnboarding({ runningExcludedWorkouts: Array.from(current) });
    });
  });
}

// ─── Cycling variant (unchanged behaviour) ────────────────────────────────────

function renderCyclingWorkoutPreview(container: HTMLElement, state: OnboardingState): void {
  const cycleCategories = ['Endurance', 'Quality', 'Pro-grade'];
  const grouped: Record<string, WorkoutCard[]> = { Endurance: [], Quality: [], 'Pro-grade': [] };
  for (const w of BIKE_WORKOUTS) grouped[w.category].push(w);

  const excluded = new Set(state.cyclingExcludedWorkouts ?? []);
  const categories = cycleCategories.map(label => ({ label, cards: grouped[label] }));

  container.innerHTML = buildPreviewHTML({
    title: 'What your training looks like',
    intro: 'The kinds of bike sessions your plan draws from, anchored to the literature elite coaches prescribe.',
    tapHint: 'Tap any card to opt out — your plan will skip that type.',
    categories,
    excluded,
    stepNum: 6,
    totalSteps: 8,
    proGradeLabel: true,
  });

  wireCyclingToggles(excluded);
  document.getElementById('wp-continue')?.addEventListener('click', () => nextStep());
}

function wireCyclingToggles(_excluded: Set<string>): void {
  document.querySelectorAll<HTMLElement>('.wp-card[data-kind]').forEach((card) => {
    card.addEventListener('click', () => {
      const kind = card.getAttribute('data-kind');
      if (!kind) return;
      const current = new Set(((getState().onboarding as OnboardingState | null)?.cyclingExcludedWorkouts ?? []));
      if (current.has(kind)) {
        current.delete(kind);
        card.classList.remove('excluded');
        card.setAttribute('aria-checked', 'true');
      } else {
        current.add(kind);
        card.classList.add('excluded');
        card.setAttribute('aria-checked', 'false');
      }
      updateOnboarding({ cyclingExcludedWorkouts: Array.from(current) });
    });
  });
}

// ─── Shared HTML builder ──────────────────────────────────────────────────────

function buildPreviewHTML(opts: {
  title: string;
  intro: string;
  tapHint: string;
  categories: Array<{ label: string; cards: WorkoutCard[] }>;
  excluded: Set<string>;
  stepNum: number;
  totalSteps: number;
  proGradeLabel?: boolean;
}): string {
  const { title, intro, tapHint, categories, excluded, stepNum, totalSteps, proGradeLabel } = opts;

  const categoryBlocks = categories.map((cat, gi) => `
    <div class="wp-rise" style="animation-delay:${0.1 + gi * 0.06}s">
      <div class="wp-section-label">${cat.label}${proGradeLabel && cat.label === 'Pro-grade' ? ' &middot; new in your plan' : ''}</div>
      ${cat.cards.map((w) => buildCardHTML(w, excluded)).join('')}
    </div>
  `).join('');

  return `
    <style>
      @keyframes wpRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .wp-rise { opacity:0; animation: wpRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .wp-section-label { font-size:11px; color:var(--c-muted); letter-spacing:0.14em; text-transform:uppercase; font-weight:500; margin:18px 0 10px 4px; }
      .wp-section-label:first-of-type { margin-top:8px; }

      /* Canonical onboarding glass spec — opacity 0.58 + blur(24px) is locked. */
      .wp-card { position:relative; background:rgba(255,255,255,0.58); backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px); border:1px solid rgba(255,255,255,0.7); border-radius:14px; padding:14px 48px 14px 16px; margin-bottom:10px; box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,0.4); cursor:pointer; transition:opacity 0.18s ease,background 0.18s ease; }
      .wp-card.excluded { opacity:0.45; background:rgba(255,255,255,0.32); }
      .wp-card.locked { cursor:default; }
      .wp-card-name { font-size:15px; font-weight:500; color:var(--c-black); letter-spacing:-0.005em; }
      .wp-card-oneline { font-size:13px; color:var(--c-black); opacity:0.85; margin-top:3px; line-height:1.4; }
      .wp-card-example { font-size:12px; color:var(--c-muted); margin-top:8px; line-height:1.45; font-variant-numeric:tabular-nums; }
      .wp-card-science { font-size:11px; color:var(--c-faint); margin-top:6px; letter-spacing:0.01em; font-style:italic; }

      /* Glassy circular check — filled = included, empty = excluded, lock icon = locked. */
      .wp-check { position:absolute; top:50%; right:14px; transform:translateY(-50%); width:24px; height:24px; border-radius:50%; background:rgba(255,255,255,0.7); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid rgba(0,0,0,0.12); display:flex; align-items:center; justify-content:center; box-shadow:inset 0 1px 0 rgba(255,255,255,0.5); transition:background 0.18s ease,border-color 0.18s ease; }
      .wp-check svg { width:14px; height:14px; color:var(--c-black); transition:opacity 0.15s ease; }
      .wp-card:not(.excluded):not(.locked) .wp-check { background:var(--c-black); border-color:var(--c-black); }
      .wp-card:not(.excluded):not(.locked) .wp-check svg { color:#FDFCF7; opacity:1; }
      .wp-card.excluded .wp-check svg { opacity:0; }
      .wp-card.locked .wp-check { background:rgba(0,0,0,0.04); border-color:rgba(0,0,0,0.1); }
      .wp-card.locked .wp-check svg { color:var(--c-muted); opacity:0.6; }

      .wp-intro { font-size:13px; color:var(--c-faint); margin:0 0 4px; line-height:1.5; }
      .wp-tap-hint { font-size:12px; color:var(--c-faint); text-align:center; margin:8px 0 14px; }
      .wp-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:14px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('wp', { variant: 'whisper' })}
        ${buildSunGlint('low')}
      </div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(stepNum, totalSteps)}

        <div class="wp-rise" style="width:100%;max-width:480px;text-align:center;margin-bottom:14px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.5rem,5vw,1.9rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 6px;line-height:1.15">
            ${title}
          </h2>
          <p class="wp-intro">${intro}</p>
          <p class="wp-tap-hint">${tapHint}</p>
        </div>

        <div style="width:100%;max-width:480px">
          ${categoryBlocks}
          <button id="wp-continue" class="wp-cta wp-rise" style="animation-delay:0.36s">Looks good, build my plan</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;
}

function buildCardHTML(w: WorkoutCard, excluded: Set<string>): string {
  const isLocked = !!w.locked;
  const isExcluded = !isLocked && excluded.has(w.kind);

  // Lock icon SVG
  const lockIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 8"/></svg>`;

  const classes = ['wp-card', isExcluded ? 'excluded' : '', isLocked ? 'locked' : ''].filter(Boolean).join(' ');

  return `
    <div class="${classes}" data-kind="${w.kind}" data-locked="${isLocked}"
      role="${isLocked ? 'presentation' : 'checkbox'}"
      aria-checked="${isLocked ? undefined : String(!isExcluded)}"
      aria-label="${w.name} — ${isLocked ? 'required' : isExcluded ? 'excluded' : 'included'} in plan">
      <div class="wp-card-name">${w.name}${isLocked ? '<span style="font-size:10px;font-weight:500;color:var(--c-faint);margin-left:8px;letter-spacing:0.06em;text-transform:uppercase;vertical-align:middle">Required</span>' : ''}</div>
      <div class="wp-card-oneline">${w.oneLine}</div>
      <div class="wp-card-example">${w.example}</div>
      <div class="wp-card-science">${w.science}</div>
      <div class="wp-check" aria-hidden="true">${isLocked ? lockIcon : checkIcon}</div>
    </div>
  `;
}
