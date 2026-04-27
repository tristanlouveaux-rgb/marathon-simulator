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
  // Classification needs at least 2 different-distance PBs to detect a
  // speed/endurance lean from the ratio. With 0 or 1 PB it's noise — skip the
  // screen entirely. The engine falls back to 'Balanced' until enough data
  // accrues via real race entries.
  const pbs = state.pbs ?? {};
  const pbCount = [pbs.k5, pbs.k10, pbs.h, pbs.m].filter(v => v != null && v > 0).length;
  if (pbCount < 2) {
    console.log(`[runner-type] Only ${pbCount} PB(s) on file — skipping classification screen.`);
    try { window.wizardNext(); } catch { nextStep(); }
    return;
  }

  const calculatedType = state.calculatedRunnerType || 'Balanced';
  const activeType = state.confirmedRunnerType || calculatedType;

  container.innerHTML = `
    <style>
      .rp-card { background:rgba(255,255,255,0.95); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); border:1px solid rgba(0,0,0,0.06); border-radius:20px; padding:24px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }
    </style>
    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 42%, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;width:100%;max-width:480px">
      ${renderProgressIndicator(7, 8)}

        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Your Runner Profile
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
          Here's your running style, based on your race times.
        </p>

        <div class="rp-card">
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
  // Positions are the centre of each segment along the 0–100% track.
  const positions: Record<RunnerType, number> = {
    Speed: 16.67,
    Balanced: 50,
    Endurance: 83.33,
  };
  const pct = positions[activeType];

  return `
    <div style="position:relative;padding:6px 0 0">
      <!-- Track -->
      <div style="height:6px;border-radius:3px;background:rgba(0,0,0,0.08);position:relative;overflow:hidden">
        <!-- Filled portion (charcoal) up to the marker position -->
        <div style="position:absolute;top:0;left:0;height:100%;width:${pct}%;background:var(--c-black);transition:width 0.4s ease"></div>
      </div>
      <!-- Marker: single element, transform:translateX(-50%) centres it on its left position. -->
      <div id="spectrum-dot"
           style="position:absolute;top:-1px;left:${pct}%;transform:translateX(-50%);width:16px;height:16px;border-radius:50%;background:#FDFCF7;border:2px solid var(--c-black);box-shadow:0 1px 4px rgba(0,0,0,0.18);transition:left 0.4s ease"></div>
      <div style="display:flex;justify-content:space-between;margin-top:12px;font-size:12px;color:var(--c-faint)">
        <span>Speed</span>
        <span>Balanced</span>
        <span>Endurance</span>
      </div>
    </div>
  `;
}

function renderTypeButton(type: RunnerType, activeType: RunnerType): string {
  const isActive = type === activeType;
  return `
    <button data-type="${type}"
      style="${isActive
        ? 'background:#0A0A0A;color:#FDFCF7;border:1px solid rgba(0,0,0,0.9);box-shadow: 0 0 0 1px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.08)'
        : 'background:#FFFFFF;color:var(--c-black);border:1px solid rgba(0,0,0,0.08);box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06)'
      };border-radius:12px;padding:12px 4px;font-size:13px;font-weight:500;cursor:pointer;transition:background 0.15s, color 0.15s, box-shadow 0.2s;width:100%" class="type-option">
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
