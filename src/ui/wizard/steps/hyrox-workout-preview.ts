import type { OnboardingState } from '@/types/onboarding';
import { nextStep } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';

/**
 * HYROX workout preview — the "research showcase" step for HYROX athletes.
 *
 * Replaces the earlier review-page recap. Mirrors the running and triathlon
 * preview pattern: a non-interactive card grid showing every session type the
 * plan engine prescribes, anchored to the underlying training principle.
 *
 * Card content is sourced from `src/workouts/hyrox-generators.ts` and
 * `src/constants/hyrox-constants.ts`. The intent is to show users that the
 * plan isn't a wall of easy runs — variety is intentional and ramps with the
 * phase.
 */

interface HyroxWorkoutCard {
  kind: string;
  name: string;
  oneLine: string;
  example: string;
  science: string;
}

const RUN_CARDS: HyroxWorkoutCard[] = [
  {
    kind: 'run_easy',
    name: 'Easy run',
    oneLine: 'Zone 2 aerobic running. Builds the engine that 8 × 1km demands.',
    example: '45 min conversational pace. RPE 4. ~6.5 km at intermediate pace.',
    science: 'Aerobic base — Bompa & Haff 2009; Stöggl & Sperlich 2014.',
  },
  {
    kind: 'run_tempo',
    name: 'Tempo run',
    oneLine: 'Sustained sub-threshold work. Lifts your race pace ceiling.',
    example: '10 min WU · 20 min @ 85% HRmax · 5 min CD. RPE 6.',
    science: 'Threshold velocity — Faude et al. 2009.',
  },
  {
    kind: 'run_intervals',
    name: 'Interval run',
    oneLine: 'VO2-max repeats. Top-end aerobic capacity for race surges.',
    example: '15 min WU · 6 × 800m @ 5km pace, 90s recovery · 10 min CD. RPE 8.',
    science: 'VO2max protocol — Billat 2001; Buchheit & Laursen 2013.',
  },
];

const STATION_CARDS: HyroxWorkoutCard[] = [
  {
    kind: 'station_technique',
    name: 'Station technique',
    oneLine: 'Skill-focused circuits at controlled effort. Form first.',
    example: '3 rounds: 4 stations × race distance, 60s between stations, 3 min between rounds. RPE 5.',
    science: 'Motor pattern stability — Schmidt & Lee 2014.',
  },
  {
    kind: 'station_density',
    name: 'Station density',
    oneLine: 'AMRAP-style higher-volume station work. Race specificity.',
    example: '2 rounds at race pace, 30s between stations, 2 min between rounds. RPE 7.',
    science: 'Specificity + lactate clearance — Sparkes & Behm 2010.',
  },
];

const BRICK_CARDS: HyroxWorkoutCard[] = [
  {
    kind: 'brick',
    name: 'Brick session',
    oneLine: 'Run + station rounds in race order. The signature HYROX session.',
    example: '4 × (1 km run + 1 station). Builds the run-to-station transition that decides finish times.',
    science: 'Compound conditioning — Coffey & Hawley 2017.',
  },
  {
    kind: 'mini_brick',
    name: 'Mini brick',
    oneLine: 'Shorter brick for early phases or beginner athletes.',
    example: '4 × (500m run + erg). Half the volume, same transition stimulus.',
    science: 'Progressive overload — Issurin 2010.',
  },
];

const sections: Array<{ label: string; cards: HyroxWorkoutCard[] }> = [
  { label: 'Run sessions',     cards: RUN_CARDS },
  { label: 'Station sessions', cards: STATION_CARDS },
  { label: 'Brick sessions',   cards: BRICK_CARDS },
];

export function renderHyroxWorkoutPreview(container: HTMLElement, _state: OnboardingState): void {
  container.innerHTML = `
    <style>
      @keyframes hwpRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .hwp-rise { opacity:0; animation: hwpRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .hwp-section-label { font-size:11px; color:var(--c-muted); letter-spacing:0.14em; text-transform:uppercase; font-weight:500; margin:18px 0 10px 4px; }
      .hwp-section-label:first-of-type { margin-top:8px; }

      .hwp-grid { display:grid; grid-template-columns:1fr; gap:10px; }
      @media (min-width: 640px) { .hwp-grid { grid-template-columns:1fr 1fr; } }

      .hwp-card { position:relative; background:rgba(255,255,255,0.58); backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px); border:1px solid rgba(255,255,255,0.7); border-radius:14px; padding:14px 16px; box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,0.4); }
      .hwp-card-name { font-size:15px; font-weight:500; color:var(--c-black); letter-spacing:-0.005em; }
      .hwp-card-oneline { font-size:13px; color:var(--c-black); opacity:0.85; margin-top:3px; line-height:1.4; }
      .hwp-card-example { font-size:12px; color:var(--c-muted); margin-top:8px; line-height:1.45; font-variant-numeric:tabular-nums; }
      .hwp-card-science { font-size:11px; color:var(--c-faint); margin-top:6px; letter-spacing:0.01em; font-style:italic; }

      .hwp-intro { font-size:13px; color:var(--c-faint); margin:0; line-height:1.5; }
      .hwp-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:18px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('hwp', { variant: 'whisper' })}
        ${buildSunGlint('low')}
      </div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(7, 8)}

        <div class="hwp-rise" style="width:100%;max-width:720px;text-align:center;margin-bottom:14px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.5rem,5vw,1.9rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 6px;line-height:1.15">
            What your training looks like
          </h2>
          <p class="hwp-intro">Seven session types. Each one earns its place. Variety ramps as your base develops — base phase leans aerobic, build phase adds tempo and density, peak phase gets race-specific bricks.</p>
        </div>

        <div style="width:100%;max-width:720px">
          ${sections.map((sec, gi) => `
            <div class="hwp-rise" style="animation-delay:${0.1 + gi * 0.06}s">
              <div class="hwp-section-label">${sec.label}</div>
              <div class="hwp-grid">
                ${sec.cards.map(buildCardHTML).join('')}
              </div>
            </div>
          `).join('')}
          <button id="hwp-continue" class="hwp-cta hwp-rise" style="animation-delay:0.4s">Looks good, build my plan</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  document.getElementById('hwp-continue')?.addEventListener('click', () => nextStep());
}

function buildCardHTML(w: HyroxWorkoutCard): string {
  return `
    <div class="hwp-card" data-kind="${w.kind}">
      <div class="hwp-card-name">${w.name}</div>
      <div class="hwp-card-oneline">${w.oneLine}</div>
      <div class="hwp-card-example">${w.example}</div>
      <div class="hwp-card-science">${w.science}</div>
    </div>
  `;
}
