import type { OnboardingState } from '@/types/onboarding';
import { nextStep } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';

/**
 * Triathlon workout preview — the "research showcase" step for triathletes.
 *
 * Shows the swim, bike, run and brick session types the plan draws from.
 * Showcase only: no opt-out toggles. Triathlon plans interleave three
 * disciplines plus brick days; per-card exclusion would create infeasible
 * weeks, so the cards are non-interactive.
 *
 * Cards mirror the running/cycling preview visuals (glass spec, type,
 * science note) but lay out as a responsive 2-column grid above 640px so
 * the 17 cards across four sections don't make the page run forever.
 *
 * Card content is sourced from the canonical workout libraries:
 *   - swim:  src/workouts/swim.ts
 *   - bike:  src/workouts/bike.ts (shared with standalone cycling)
 *   - run:   running plan engine (same as marathon mode)
 *   - brick: src/workouts/brick.ts
 */

interface TriWorkoutCard {
  kind: string;
  name: string;
  oneLine: string;
  example: string;
  science: string;
}

const SWIM_CARDS: TriWorkoutCard[] = [
  {
    kind: 'swim_technique',
    name: 'Swim technique',
    oneLine: 'Drills and short reps. Body position, catch, breathing.',
    example: '200m WU · 4×50m catch-up + 4×50m fingertip drag · 4×150m easy · 200m CD.',
    science: 'Stroke economy — Toussaint & Truijens 2005.',
  },
  {
    kind: 'swim_endurance',
    name: 'Endurance swim',
    oneLine: 'Sustained aerobic volume below CSS.',
    example: '200m WU · 4×400m steady, 30s rest · 200m CD.',
    science: 'Aerobic base — Maglischo 2003.',
  },
  {
    kind: 'swim_threshold',
    name: 'CSS intervals',
    oneLine: 'Critical Swim Speed work. Lifts threshold pace directly.',
    example: '200m WU · 10×100m @ CSS, 15s rest · 200m CD.',
    science: 'Critical speed — Wakayoshi 1992.',
  },
  {
    kind: 'swim_speed',
    name: 'Swim speed',
    oneLine: 'Short sharp work above CSS for top-end.',
    example: '200m WU · 12×50m fast (CSS −5s/100m), 30s rest · 200m CD.',
    science: 'Anaerobic capacity — Pyne et al. 2001.',
  },
];

const BIKE_CARDS: TriWorkoutCard[] = [
  {
    kind: 'bike_endurance',
    name: 'Endurance ride',
    oneLine: 'Steady aerobic work below tempo.',
    example: '2h @ 65% FTP / Z2 HR. Conversational throughout.',
    science: 'Aerobic base — Coggan & Allen Z2.',
  },
  {
    kind: 'bike_tempo',
    name: 'Tempo ride',
    oneLine: 'Sustained sub-threshold load.',
    example: '15 min WU · 3×10 min @ 85% FTP, 3 min easy · 5 min CD.',
    science: 'Z3 — economy and fat oxidation.',
  },
  {
    kind: 'bike_sweet_spot',
    name: 'Sweet spot',
    oneLine: 'High stimulus, manageable fatigue.',
    example: '15 min WU · 2×20 min @ 88% FTP, 5 min recovery · 10 min CD.',
    science: '88–95% FTP — Seiler-adjacent SST band.',
  },
  {
    kind: 'bike_threshold',
    name: 'Threshold intervals',
    oneLine: 'Lifts FTP directly.',
    example: '15 min WU · 2×15 min @ 98% FTP, 5 min recovery · 10 min CD.',
    science: 'Z4 — Coggan & Allen Ch.7.',
  },
  {
    kind: 'bike_vo2',
    name: 'VO2 intervals',
    oneLine: 'Long reps above FTP for aerobic ceiling.',
    example: '20 min WU · 5×3 min @ 115% FTP, 3 min recovery · 10 min CD.',
    science: 'Z5 — accumulates time at VO2max.',
  },
  {
    kind: 'bike_hills',
    name: 'Hill repeats',
    oneLine: 'Force production on the climbs.',
    example: '20 min WU · 5×4 min climbs @ 95% FTP · 10 min CD.',
    science: 'Strength-endurance carryover.',
  },
  {
    kind: 'bike_over_under',
    name: 'Over-unders',
    oneLine: 'Lactate clearance at threshold.',
    example: '15 min WU · 3×(3 min @ 105% → 3 min @ 95%) · 10 min CD.',
    science: 'Coggan & Allen 2019 Ch.7.',
  },
  {
    kind: 'bike_vo2_micros',
    name: 'VO2 micro-intervals',
    oneLine: 'Maximum time at VO2max with lower lactate.',
    example: '20 min WU · 2×(10×30s @ 120% FTP / 30s easy) · 10 min CD.',
    science: 'Billat 2001; Rønnestad 2014.',
  },
  {
    kind: 'bike_vlamax',
    name: 'Neuromuscular sprints',
    oneLine: 'Peak power and rate of force development.',
    example: '20 min WU · 8×10s max @ 160%+ FTP, 3 min recovery · 10 min CD.',
    science: 'PCr/glycolytic — Gastin 2001.',
  },
];

const RUN_CARDS: TriWorkoutCard[] = [
  {
    kind: 'run_easy',
    name: 'Easy run',
    oneLine: 'Aerobic base at conversational effort.',
    example: '40–60 min at Z2 HR. Full sentences throughout.',
    science: 'Aerobic base — Seiler 80/20 low-intensity volume.',
  },
  {
    kind: 'run_long',
    name: 'Long run',
    oneLine: 'Weekly long effort. Builds fat oxidation and durability.',
    example: '60–120 min at easy-to-moderate effort. Steady throughout.',
    science: 'Peripheral adaptation — Coyle 1988; fat oxidation — Holloszy & Coyle 1984.',
  },
  {
    kind: 'run_threshold',
    name: 'Threshold intervals',
    oneLine: 'Raises lactate threshold directly.',
    example: '15 min WU · 3×8 min @ LT pace, 2 min jog · 10 min CD.',
    science: 'Z4 lactate threshold — Daniels 2005, Pfitzinger & Douglas 2009.',
  },
];

const BRICK_CARDS: TriWorkoutCard[] = [
  {
    kind: 'brick',
    name: 'Brick — bike + run',
    oneLine: 'Run off the bike. Trains transition mechanics and pacing discipline.',
    example: 'BIKE 45 min @ 78% FTP (endurance Z2), straight into RUN 20 min @ steady Z2. Transition under 2 min.',
    science: 'Run-off-the-bike specificity — Millet & Vleck 2000; Bernard 2003.',
  },
];

export function renderTriWorkoutPreview(container: HTMLElement, _state: OnboardingState): void {
  const sections: Array<{ label: string; cards: TriWorkoutCard[] }> = [
    { label: 'Swim', cards: SWIM_CARDS },
    { label: 'Bike', cards: BIKE_CARDS },
    { label: 'Run', cards: RUN_CARDS },
    { label: 'Brick', cards: BRICK_CARDS },
  ];

  container.innerHTML = `
    <style>
      @keyframes twpRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .twp-rise { opacity:0; animation: twpRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .twp-section-label { font-size:11px; color:var(--c-muted); letter-spacing:0.14em; text-transform:uppercase; font-weight:500; margin:18px 0 10px 4px; }
      .twp-section-label:first-of-type { margin-top:8px; }

      .twp-grid { display:grid; grid-template-columns:1fr; gap:10px; }
      @media (min-width: 640px) { .twp-grid { grid-template-columns:1fr 1fr; } }

      /* Canonical onboarding glass spec — opacity 0.58 + blur(24px) is locked. */
      .twp-card { position:relative; background:rgba(255,255,255,0.58); backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px); border:1px solid rgba(255,255,255,0.7); border-radius:14px; padding:14px 16px; box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,0.4); }
      .twp-card-name { font-size:15px; font-weight:500; color:var(--c-black); letter-spacing:-0.005em; }
      .twp-card-oneline { font-size:13px; color:var(--c-black); opacity:0.85; margin-top:3px; line-height:1.4; }
      .twp-card-example { font-size:12px; color:var(--c-muted); margin-top:8px; line-height:1.45; font-variant-numeric:tabular-nums; }
      .twp-card-science { font-size:11px; color:var(--c-faint); margin-top:6px; letter-spacing:0.01em; font-style:italic; }

      .twp-intro { font-size:13px; color:var(--c-faint); margin:0; line-height:1.5; }
      .twp-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:18px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('twp', { variant: 'whisper' })}
        ${buildSunGlint('low')}
      </div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(7, 8)}

        <div class="twp-rise" style="width:100%;max-width:720px;text-align:center;margin-bottom:14px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.5rem,5vw,1.9rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 6px;line-height:1.15">
            What your training looks like
          </h2>
          <p class="twp-intro">The session types your plan draws from across swim, bike, run and brick days, anchored to the literature elite triathlon coaches prescribe.</p>
        </div>

        <div style="width:100%;max-width:720px">
          ${sections.map((sec, gi) => `
            <div class="twp-rise" style="animation-delay:${0.1 + gi * 0.06}s">
              <div class="twp-section-label">${sec.label}</div>
              <div class="twp-grid">
                ${sec.cards.map(buildCardHTML).join('')}
              </div>
            </div>
          `).join('')}
          <button id="twp-continue" class="twp-cta twp-rise" style="animation-delay:0.4s">Looks good, build my plan</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  document.getElementById('twp-continue')?.addEventListener('click', () => nextStep());
}

function buildCardHTML(w: TriWorkoutCard): string {
  return `
    <div class="twp-card" data-kind="${w.kind}">
      <div class="twp-card-name">${w.name}</div>
      <div class="twp-card-oneline">${w.oneLine}</div>
      <div class="twp-card-example">${w.example}</div>
      <div class="twp-card-science">${w.science}</div>
    </div>
  `;
}
