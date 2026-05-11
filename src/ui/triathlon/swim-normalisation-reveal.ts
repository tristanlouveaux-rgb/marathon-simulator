/**
 * Swim-environment chip selector. Used in two places:
 *   1. The triathlon onboarding wizard's review step — writes back to
 *      `onboarding.triSwim` via an injected `onSave` callback.
 *   2. The account-view "Swim environment" row — writes directly to
 *      `triConfig.swim` (default behaviour when no callback is provided).
 *
 * Originally also fired as a one-time auto-reveal on the forecast page;
 * that pattern was retired (2026-05-11) because it kept popping on
 * re-renders and didn't carry enough visual depth. The choice is now
 * captured once at onboarding (or via settings) and never auto-pops.
 *
 * File name kept for import stability.
 */

import { getMutableState, getState, saveState } from '@/state';
import type { SimulatorState } from '@/types/state';

const OVERLAY_ID = 'swim-env-editor';

type OwDefault = NonNullable<NonNullable<SimulatorState['triConfig']>['swim']>['defaultOwSwimEnvironment'];

/** Chip choices. `pool` is the "primarily a pool swimmer" marker — on save
 *  we clear `defaultOwSwimEnvironment` so rare OW swims fall through to the
 *  wetsuit-lake baseline (factor 1.0). */
export type SwimEnvironmentChoice = 'pool' | NonNullable<OwDefault>;

export interface SwimEnvironmentEditorOpts {
  /** Initial chip selection. When omitted, no chip is pre-selected. */
  initial?: SwimEnvironmentChoice;
  /** Save callback. When provided, the editor calls this on Save and does
   *  not mutate triConfig. The caller is responsible for persisting state.
   *  When omitted, the editor writes directly to triConfig.swim. */
  onSave?: (choice: SwimEnvironmentChoice) => void;
}

/** Open the chip selector. No-op if already open. */
export function openSwimEnvironmentEditor(opts: SwimEnvironmentEditorOpts = {}): void {
  if (document.getElementById(OVERLAY_ID)) return;
  const seed = opts.initial
    ?? getState().triConfig?.swim?.primarySwimEnvironment
    ?? getState().triConfig?.swim?.defaultOwSwimEnvironment;
  open(seed, opts.onSave);
}

function open(initial: SwimEnvironmentChoice | undefined, onSave?: (choice: SwimEnvironmentChoice) => void): void {
  let choice: SwimEnvironmentChoice | undefined = initial;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  function render(): void {
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="swim-env-title"
           style="
             width:min(420px,100%);
             max-height:90vh;
             overflow-y:auto;
             background:rgba(255,255,255,0.92);
             backdrop-filter:blur(16px);
             -webkit-backdrop-filter:blur(16px);
             border-radius:16px;
             box-shadow:0 8px 32px rgba(0,0,0,0.18);
             padding:20px;
             position:relative;
           ">
        <button id="swim-env-close" aria-label="Close"
                style="position:absolute;top:12px;right:12px;width:28px;height:28px;border:none;background:transparent;color:var(--c-muted);font-size:18px;cursor:pointer;line-height:1;padding:0">×</button>

        <div id="swim-env-title" style="font-size:16px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;margin-bottom:14px;padding-right:28px">
          Where do you mostly swim?
        </div>

        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px">
          ${chip('pool', 'Pool', choice)}
          ${chip('wetsuit-lake', 'Lake, wetsuit', choice)}
          ${chip('non-wetsuit-lake', 'Lake, no wetsuit', choice)}
          ${chip('ocean', 'Ocean / sea', choice)}
          ${chip('river', 'River', choice)}
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button id="swim-env-cancel"
                  style="padding:10px 16px;background:transparent;border:none;color:var(--c-muted);font-size:14px;cursor:pointer">Cancel</button>
          <button id="swim-env-save"
                  ${choice ? '' : 'disabled'}
                  style="padding:10px 18px;background:${choice ? 'var(--c-black, #0F172A)' : 'rgba(15,23,42,0.25)'};border:none;border-radius:10px;color:#FDFCF7;font-size:14px;font-weight:500;cursor:${choice ? 'pointer' : 'not-allowed'}">Save</button>
        </div>
      </div>
    `;
    wire();
  }

  function chip(value: SwimEnvironmentChoice, label: string, current: SwimEnvironmentChoice | undefined): string {
    const selected = current === value;
    return `
      <button data-choice="${value}"
              style="
                width:100%;
                padding:12px 14px;
                background:${selected ? 'var(--c-black, #0F172A)' : 'rgba(255,255,255,0.6)'};
                border:1px solid ${selected ? 'var(--c-black, #0F172A)' : 'rgba(0,0,0,0.08)'};
                border-radius:10px;
                color:${selected ? '#FDFCF7' : '#0F172A'};
                font-size:14px;
                font-weight:500;
                cursor:pointer;
                text-align:left;
              ">${label}</button>
    `;
  }

  function wire(): void {
    overlay.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        choice = btn.dataset.choice as SwimEnvironmentChoice;
        render();
      });
    });
    document.getElementById('swim-env-close')?.addEventListener('click', close);
    document.getElementById('swim-env-cancel')?.addEventListener('click', close);
    document.getElementById('swim-env-save')?.addEventListener('click', save);
  }

  function save(): void {
    if (!choice) return;
    if (onSave) {
      onSave(choice);
    } else {
      const m = getMutableState();
      if (m.triConfig) {
        if (!m.triConfig.swim) m.triConfig.swim = {};
        m.triConfig.swim.primarySwimEnvironment = choice;
        // pool = "primarily a pool swimmer" — clear OW default so rare OW
        // swims fall through to the wetsuit-lake baseline.
        m.triConfig.swim.defaultOwSwimEnvironment = choice === 'pool' ? undefined : choice;
        if (m.triConfig.prediction) m.triConfig.prediction = undefined;
        saveState();
      }
    }
    overlay.remove();
  }

  function close(): void {
    overlay.remove();
  }

  render();
}
