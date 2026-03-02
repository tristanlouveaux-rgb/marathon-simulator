import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Render the training frequency selection (Step 5)
 * Asks for runs per week and sports per week
 */
export function renderFrequency(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div class="min-h-screen flex flex-col items-center justify-center px-6 py-12" style="background:var(--c-bg)">
      ${renderProgressIndicator(5, 10)}

      <div class="max-w-lg w-full">
        <!-- Title -->
        <h2 class="text-2xl md:text-3xl font-light mb-2 text-center" style="color:var(--c-black)">
          Training Frequency
        </h2>
        <p class="text-center mb-8" style="color:var(--c-faint)">
          How much time can you dedicate to training?
        </p>

        <div class="space-y-8">
          <!-- Running Background -->
          ${renderExperienceSelector(state.experienceLevel)}

          <!-- Runs per week -->
          ${renderRunsSelector(state.runsPerWeek)}

          <!-- Sports per week -->
          ${renderSportsSelector(state.sportsPerWeek)}

          <!-- Info note -->
          <div class="rounded-xl p-4" style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2)">
            <div class="flex gap-3">
              <svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20" style="color:var(--c-ok)">
                <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
              </svg>
              <div>
                <p class="text-sm font-medium" style="color:var(--c-ok)">Smart cross-training</p>
                <p class="text-xs mt-1" style="color:var(--c-muted)">
                  Our intelligent model accounts for your other sports and can replace some runs
                  with cross-training to optimize your training load.
                </p>
              </div>
            </div>
          </div>
        </div>

        <button id="continue-frequency"
          class="mt-8 w-full py-3 rounded-xl transition-all font-medium"
          style="background:var(--c-black);color:#FDFCF7;border:none">
          Continue
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state);
}

function renderRunsSelector(currentValue: number): string {
  return `
    <div>
      <label class="block text-sm mb-3" style="color:var(--c-faint)">
        Runs per week
      </label>
      <div class="grid grid-cols-7 gap-2">
        ${[1, 2, 3, 4, 5, 6, 7].map(n => `
          <button data-runs="${n}"
            class="runs-btn py-3 rounded-lg font-medium transition-all"
            style="${currentValue === n
      ? 'background:var(--c-black);color:#FDFCF7;border:none'
      : 'background:rgba(0,0,0,0.06);color:var(--c-muted);border:none'}">
            ${n}
          </button>
        `).join('')}
      </div>
      <p class="text-xs mt-2" style="color:var(--c-faint)">
        ${getRunsRecommendation(currentValue)}
      </p>
    </div>
  `;
}

function renderSportsSelector(currentValue: number): string {
  return `
    <div>
      <label class="block text-sm mb-3" style="color:var(--c-faint)">
        Other sports sessions per week
        <span style="color:var(--c-faint)">(optional)</span>
      </label>
      <div class="grid grid-cols-6 gap-2">
        ${[0, 1, 2, 3, 4, 5].map(n => `
          <button data-sports="${n}"
            class="sports-btn py-3 rounded-lg font-medium transition-all"
            style="${currentValue === n
      ? 'background:var(--c-black);color:#FDFCF7;border:none'
      : 'background:rgba(0,0,0,0.06);color:var(--c-muted);border:none'}">
            ${n}
          </button>
        `).join('')}
      </div>
      <p class="text-xs mt-2" style="color:var(--c-faint)">
        Include football, cycling, swimming, gym, etc.
      </p>
      <p class="text-xs mt-2" style="color:var(--c-muted)">
        If you don't play a certain sport regularly but know you'll play different sports
        a number of times a week, just choose "General Sport" when logging and we'll fit
        it into the plan.
      </p>
    </div>
  `;
}

function renderExperienceSelector(current: string): string {
  const options = [
    { key: 'total_beginner', title: 'Total Beginner', desc: 'Never run before' },
    { key: 'beginner', title: 'Beginner', desc: 'Running < 6 months, lower volume' },
    { key: 'novice', title: 'Novice', desc: 'Occasional 5ks/10ks for fitness' },
    { key: 'intermediate', title: 'Intermediate', desc: 'Consistent weekly runner, raced before' },
    { key: 'advanced', title: 'Advanced', desc: 'Dedicated runner, training year-round' },
    { key: 'competitive', title: 'Competitive', desc: 'High performance / Club level' },
    { key: 'returning', title: 'Returning Athlete', desc: 'Strong endurance history (Marathons/Ironman) but rebuilding fitness' },
    { key: 'hybrid', title: 'Hybrid Athlete', desc: 'High fitness from other sports (Rugby, Rowing, Cycling, CrossFit) but low running mileage' },
  ];

  return `
    <div>
      <label class="block text-sm mb-3" style="color:var(--c-faint)">Running Background</label>
      <div class="space-y-2">
        ${options.map(o => `
          <button data-exp="${o.key}"
            class="exp-btn w-full p-3 rounded-xl text-left transition-all"
            style="${current === o.key
      ? 'border:2px solid var(--c-black);background:rgba(0,0,0,0.06)'
      : 'border:2px solid var(--c-border);background:var(--c-surface)'}">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-sm font-medium" style="${current === o.key ? 'color:var(--c-black)' : 'color:var(--c-black)'}">${o.title}</span>
                <span class="text-xs ml-2" style="color:var(--c-faint)">${o.desc}</span>
              </div>
              ${current === o.key ? '<svg class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" style="color:var(--c-ok)"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' : ''}
            </div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function getRunsRecommendation(runs: number): string {
  if (runs <= 2) return 'Good for beginners or those with limited time';
  if (runs <= 3) return 'A solid foundation for most runners';
  if (runs <= 4) return 'Recommended for intermediate runners';
  if (runs <= 5) return 'Optimal for most training plans';
  return 'Advanced training volume';
}

function wireEventHandlers(state: OnboardingState): void {
  // Experience selection
  document.querySelectorAll('.exp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const exp = btn.getAttribute('data-exp') as OnboardingState['experienceLevel'];
      if (exp) {
        updateOnboarding({ experienceLevel: exp });
        rerender(state);
      }
    });
  });

  // Runs selection
  document.querySelectorAll('.runs-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const runs = parseInt(btn.getAttribute('data-runs') || '4');
      updateOnboarding({ runsPerWeek: runs });
      rerender(state);
    });
  });

  // Sports selection
  document.querySelectorAll('.sports-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sports = parseInt(btn.getAttribute('data-sports') || '0');
      updateOnboarding({ sportsPerWeek: sports });
      rerender(state);
    });
  });

  // Continue
  document.getElementById('continue-frequency')?.addEventListener('click', () => {
    nextStep();
  });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) {
        renderFrequency(container, currentState);
      }
    }
  });
}
