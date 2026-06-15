/**
 * One-time opt-in popup for the body-mass cross-training swap.
 *
 * Shown once, the first time a heavier-than-population-average athlete lands on
 * their plan. Explains the adjustment in plain language and lets them keep it or
 * turn it off. After they decide, it never shows again and the app's normal live
 * adaptation (HR/pace → effort, VDOT, ramp) takes over.
 *
 * Default posture is ON for heavy users (`bodyMassSwapEnabled === undefined` is
 * treated as on by the generator), so the plan they're looking at already
 * reflects the gentle swap; this popup confirms it or turns it off. Turning it
 * off takes effect on the next plan generation (week rollover / replan). We
 * don't force a rebuild.
 *
 * Physics-framed, qualitative copy (no percentage) chosen by Tristan: states
 * the mechanical fact, reads the same for tall / muscular / heavy. Centered
 * glass overlay. Hard once-only guard: module-level boolean + the persisted
 * tri-state flag, set on creation.
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import type { SimulatorState } from '@/types/state';
import { isAboveReferenceMass } from '@/calculations/body-mass-adaptations';

let shownThisSession = false;

export function maybeShowBodyMassReveal(s: SimulatorState): void {
  if (shownThisSession) return;
  if (s.bodyMassSwapEnabled !== undefined) return;     // already decided
  if (!isAboveReferenceMass(s)) return;                // not above population average
  if (document.getElementById('body-mass-reveal-overlay')) return;

  shownThisSession = true;

  const overlay = document.createElement('div');
  overlay.id = 'body-mass-reveal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:210;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" aria-label="Plan tuned for your size" style="position:relative;max-width:420px;width:100%;background:rgba(255,255,255,0.92);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-radius:16px;padding:26px 24px 20px;box-shadow:0 12px 40px rgba(0,0,0,0.18);border:1px solid rgba(255,255,255,0.6)">
      <h2 style="font-size:18px;font-weight:600;color:var(--c-black);margin:0 0 12px">Tuned for your size</h2>
      <p style="font-size:14px;line-height:1.6;color:var(--c-muted);margin:0 0 18px">At your weight, more load goes through your joints each kilometre. We've eased back some of your easy running and leaned on low-impact cross-training (bike, swim, or elliptical) to protect your joints as you build. As your training data comes in, the plan adapts to you automatically. You can switch this off any time in Account.</p>
      <button id="bmr-keep" class="m-btn-primary" style="width:100%;padding:12px;font-size:14px;margin-bottom:8px">Keep it</button>
      <button id="bmr-off" class="m-btn-secondary" style="width:100%;padding:11px;font-size:14px">No thanks</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const decide = (enabled: boolean) => {
    const ms = getMutableState();
    ms.bodyMassSwapEnabled = enabled;
    try { saveState(); } catch { /* ignore */ }
    overlay.remove();
  };
  overlay.querySelector('#bmr-keep')?.addEventListener('click', () => decide(true));
  overlay.querySelector('#bmr-off')?.addEventListener('click', () => decide(false));
}
