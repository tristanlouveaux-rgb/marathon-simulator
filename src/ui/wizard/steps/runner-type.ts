import type { OnboardingState } from '@/types/onboarding';
import type { RunnerType } from '@/types/training';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

const TYPE_DESCRIPTIONS: Record<RunnerType, string> = {
  Speed:
    'You excel at shorter, faster races. Your training will build on that speed while developing the endurance to carry it further.',
  Balanced:
    'You perform consistently across all distances. Your training blends speed and endurance work in equal measure.',
  Endurance:
    'You shine over longer distances. Your training will sharpen your speed while building on your natural aerobic strength.',
};

/**
 * Render the runner type confirmation page.
 */
export function renderRunnerType(container: HTMLElement, state: OnboardingState): void {
  const calculatedType = state.calculatedRunnerType || 'Balanced';
  const activeType = state.confirmedRunnerType || calculatedType;

  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(7, 8)}

      <div style="width:100%;max-width:480px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Your Runner Profile
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
          Here's your running style, based on your race times.
        </p>

        <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:24px">
          <!-- Spectrum -->
          ${renderSpectrum(activeType)}

          <!-- Type selector -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:24px">
            ${renderTypeButton('Speed', activeType)}
            ${renderTypeButton('Balanced', activeType)}
            ${renderTypeButton('Endurance', activeType)}
          </div>

          <!-- Description -->
          <p id="type-description" style="font-size:14px;color:var(--c-muted);line-height:1.6;margin-top:16px">
            ${TYPE_DESCRIPTIONS[activeType]}
          </p>

          <p style="font-size:12px;color:var(--c-faint);margin-top:10px">
            This shapes your race prediction and training emphasis. Tap to change if it doesn't feel right.
          </p>

          <button id="confirm-type"
            style="margin-top:20px;width:100%;padding:14px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
            Continue
          </button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state, calculatedType);
}

function renderSpectrum(activeType: RunnerType): string {
  const positions: Record<RunnerType, string> = {
    Speed: '16.67%',
    Balanced: '50%',
    Endurance: '83.33%',
  };

  const dotColors: Record<RunnerType, string> = {
    Speed: '#F97316',
    Balanced: '#22C55E',
    Endurance: '#3B82F6',
  };

  return `
    <div style="position:relative;padding-top:4px">
      <div style="height:10px;border-radius:5px;background:linear-gradient(to right, #F97316, #22C55E, #3B82F6);opacity:0.7"></div>
      <div style="position:absolute;top:0;transition:left 0.4s ease;" id="spectrum-dot"
           style="left:${positions[activeType]}">
        <div style="position:absolute;left:${positions[activeType]};transform:translateX(-50%);width:20px;height:20px;border-radius:50%;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.2);border:2.5px solid ${dotColors[activeType]}"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:12px;color:var(--c-faint)">
        <span>Speed</span>
        <span>Balanced</span>
        <span>Endurance</span>
      </div>
    </div>
  `;
}

function renderTypeButton(type: RunnerType, activeType: RunnerType): string {
  const isActive = type === activeType;
  const typeColors: Record<RunnerType, string> = { Speed: '#F97316', Balanced: '#22C55E', Endurance: '#3B82F6' };

  return `
    <button data-type="${type}"
      style="${isActive
        ? `background:${typeColors[type]};color:white;border:2px solid ${typeColors[type]}`
        : 'background:var(--c-bg);color:var(--c-black);border:1.5px solid var(--c-border-strong)'
      };border-radius:10px;padding:12px 4px;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s;width:100%" class="type-option">
      ${type}
    </button>
  `;
}

function wireEventHandlers(state: OnboardingState, calculatedType: RunnerType): void {
  document.getElementById('confirm-type')?.addEventListener('click', () => {
    const finalType = state.confirmedRunnerType || calculatedType;
    updateState({ typ: finalType });
    saveState();
    nextStep();
  });

  document.querySelectorAll('.type-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type') as RunnerType;
      updateOnboarding({ confirmedRunnerType: type });
      updateState({ typ: type });
      saveState();
      rerender(state);
    });
  });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderRunnerType(container, currentState);
    }
  });
}
