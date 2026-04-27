/**
 * Rest-overlay for guided runs. Shown during recovery steps.
 * Renders a big countdown, the next step preview, and skip/+30s controls.
 * Subscribes to the active GuideController's cue events for show/hide and
 * patches the countdown from `getProgress(data)` on every tracker tick.
 */

import type { GpsLiveData } from '@/types';
import type { Step } from '@/guided/timeline';
import type { CueEvent } from '@/guided/engine';
import type { GuideController } from '@/guided/controller';
import { getState } from '@/state';
import type { UnitPref } from '@/utils/format';

const OVERLAY_ID = 'guided-rest-overlay';

function formatCountdown(sec: number): string {
  const s = Math.ceil(Math.max(0, sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}:${String(rem).padStart(2, '0')}` : `${rem}s`;
}

function formatPace(secPerKm: number | undefined, pref: UnitPref): string {
  if (secPerKm == null || secPerKm <= 0) return '';
  const sec = pref === 'mi' ? secPerKm * 1.60934 : secPerKm;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}${pref === 'mi' ? '/mi' : '/km'}`;
}

function nextStepSummary(step: Step, pref: UnitPref): string {
  const pace = formatPace(step.targetPaceSec, pref);
  if (step.type === 'work') {
    const dur = step.durationSec != null ? `${Math.round(step.durationSec)}s` : '';
    const dist = step.distanceM != null ? `${Math.round(step.distanceM)}m` : '';
    const amount = dur || dist;
    return [step.label, amount, pace].filter(Boolean).join(' · ');
  }
  if (step.type === 'warmup') return `Warm-up · ${Math.round((step.distanceM ?? 0) / 100) / 10} km easy`;
  if (step.type === 'cooldown') return `Cool-down · ${Math.round((step.distanceM ?? 0) / 100) / 10} km easy`;
  return step.label;
}

function buildOverlayHTML(step: Step, nextStep: Step | null, remainingSec: number, extensionRemaining: number, pref: UnitPref): string {
  const countdown = formatCountdown(remainingSec);
  const nextLine = nextStep ? `Next: ${nextStepSummary(nextStep, pref)}` : 'Last recovery';
  const extendDisabled = extensionRemaining < 30;
  const extendStyle = extendDisabled
    ? 'flex:1;padding:11px 12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;color:var(--c-faint);font-size:13px;font-weight:500;cursor:not-allowed;opacity:0.5'
    : 'flex:1;padding:11px 12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;color:var(--c-black);font-size:13px;font-weight:500;cursor:pointer';
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4"
         id="${OVERLAY_ID}-backdrop"
         style="background:rgba(0,0,0,0.45)">
      <div class="w-full max-w-sm rounded-2xl p-5"
           style="background:var(--c-surface)">
        <div style="font-size:13px;color:var(--c-muted);letter-spacing:0.04em">Recover</div>
        <div id="guided-rest-countdown" style="font-size:72px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--c-black);line-height:1;margin:8px 0 16px">${countdown}</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:4px">${step.label}</div>
        <div id="guided-rest-next" style="font-size:14px;color:var(--c-black);font-weight:500;margin-bottom:20px">${nextLine}</div>
        <div style="display:flex;gap:10px">
          <button id="guided-rest-extend" ${extendDisabled ? 'disabled' : ''}
            style="${extendStyle}">+30s</button>
          <button id="guided-rest-skip"
            style="flex:1;padding:11px 12px;border-radius:10px;border:1px solid var(--c-border-strong);background:transparent;color:var(--c-black);font-size:13px;font-weight:600;cursor:pointer">Skip rest</button>
        </div>
      </div>
    </div>
  `;
}

function currentNextStep(controller: GuideController): Step | null {
  const tl = controller.getTimeline();
  const cur = controller.currentStep();
  if (!cur) return null;
  return tl.steps[cur.idx + 1] ?? null;
}

export function mountGuidedOverlay(controller: GuideController): void {
  // Only one active mount at a time.
  unmountGuidedOverlay();

  const cueHandler = (event: CueEvent): void => {
    if (event.type === 'stepStart' && event.step.type === 'recovery') {
      showOverlay(controller, event.step);
    } else if (event.type === 'stepEnd' && event.step.type === 'recovery') {
      removeOverlay();
    } else if (event.type === 'timelineComplete') {
      removeOverlay();
    }
  };
  controller.onCue(cueHandler);

  // Stash the handler on window so unmount can clear it.
  (window as any).__guidedOverlayCue = cueHandler;

  // If the controller is already on a recovery step (re-entering the tab mid-rest), show immediately.
  const cur = controller.currentStep();
  if (cur?.type === 'recovery') showOverlay(controller, cur);
}

export function unmountGuidedOverlay(): void {
  removeOverlay();
  const prev = (window as any).__guidedOverlayCue;
  if (prev) {
    // We don't have the controller ref here — caller is responsible for offCue via controller.destroy().
    (window as any).__guidedOverlayCue = null;
  }
}

function showOverlay(controller: GuideController, step: Step): void {
  const pref: UnitPref = getState().unitPref ?? 'km';
  const next = currentNextStep(controller);
  const remaining = step.durationSec ?? 0;
  const extensionRemaining = controller.currentStepExtensionRemaining();
  const existing = document.getElementById(`${OVERLAY_ID}-backdrop`);
  const html = buildOverlayHTML(step, next, remaining, extensionRemaining, pref);
  if (existing) {
    existing.outerHTML = html;
  } else {
    const container = document.createElement('div');
    container.id = OVERLAY_ID;
    container.innerHTML = html;
    document.body.appendChild(container);
  }
  wireControls(controller);
}

function wireControls(controller: GuideController): void {
  document.getElementById('guided-rest-skip')?.addEventListener('click', () => {
    // Dynamic import breaks the circular: gps-events imports guided-overlay.
    import('./gps-events').then(({ guidedSkipStep }) => guidedSkipStep());
    removeOverlay();
  });
  document.getElementById('guided-rest-extend')?.addEventListener('click', () => {
    import('./gps-events').then(({ guidedExtendCurrentStep }) => {
      guidedExtendCurrentStep(30);
      const cur = controller.currentStep();
      if (cur?.type === 'recovery') showOverlay(controller, cur);
    });
  });
  document.getElementById(`${OVERLAY_ID}-backdrop`)?.addEventListener('click', (e) => {
    // Backdrop click dismisses — countdown continues underneath.
    if ((e.target as HTMLElement).id === `${OVERLAY_ID}-backdrop`) removeOverlay();
  });
}

function removeOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
  const orphan = document.getElementById(`${OVERLAY_ID}-backdrop`);
  if (orphan) orphan.parentElement?.remove();
}

/** Call on every tracker tick to update the countdown display. */
export function updateGuidedOverlay(controller: GuideController, data: GpsLiveData): void {
  const countdownEl = document.getElementById('guided-rest-countdown');
  if (!countdownEl) return;
  const cur = controller.currentStep();
  if (!cur || cur.type !== 'recovery') {
    removeOverlay();
    return;
  }
  const progress = controller.getProgress(data);
  if (progress.stepRemainingSec == null) return;
  countdownEl.textContent = formatCountdown(progress.stepRemainingSec);
}
