import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { getState } from '@/state/store';

/**
 * Page 4 — About You
 *
 * Age + sex are required (max-HR estimation, HR-zone modelling). Weight is
 * shown for triathlon/cycling only because watts-per-kg drives the cycling
 * fitness tier; running/hyrox/fitness modes don't need it. Bike weight
 * is triathlon-only and feeds climb-time prediction.
 */
export function renderAboutYou(container: HTMLElement, state: OnboardingState): void {
  const isTriathlon = state.trainingMode === 'triathlon';
  const isCycling = state.trainingMode === 'cycling';
  const showWeight = isTriathlon || isCycling;

  container.innerHTML = `
    <style>
      @keyframes ayRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .ay-rise { opacity:0; animation: ayRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      .ay-card { width:100%; background:#FFFFFF; border-radius:20px; padding:18px 22px; display:flex; flex-direction:column; }
      .ay-row { display:grid; grid-template-columns: 1fr auto; gap:12px; align-items:center; padding:12px 0; }
      .ay-row + .ay-row { border-top:1px solid rgba(0,0,0,0.05); }
      .ay-label { font-size:14px; color:var(--c-black); font-weight:500; }
      .ay-sub { font-size:12px; color:var(--c-faint); margin:3px 0 0; line-height:1.4; }
      .ay-input { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); color:var(--c-black); border-radius:9px; padding:8px 10px; font-size:14px; box-sizing:border-box; outline:none; font-variant-numeric: tabular-nums; }
      .ay-input:focus { border-color:var(--c-black); }
      .ay-suffix { display:flex; align-items:center; gap:8px; }
      .ay-suffix-text { font-size:13px; color:var(--c-faint); white-space:nowrap; }
      .ay-pillrow { display:flex; gap:6px; }
      .ay-pill { padding:8px 14px; border-radius:9px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.85); font-size:13px; color:var(--c-black); cursor:pointer; text-align:center; transition: all 0.12s ease; }
      .ay-pill.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }

      /* Continue CTA — same shape as cs-secondary on connect-strava so the
         progression reads as a single visual family. */
      .ay-cta { width:100%; max-width:460px; height:52px; border-radius:26px; background:var(--c-black); color:#FFFFFF; border:none; font-size:15px; font-weight:600; letter-spacing:0.01em; cursor:pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.20), 0 9px 22px -8px rgba(0,0,0,0.30), 0 3px 8px -2px rgba(0,0,0,0.08); transition: transform 0.12s ease, box-shadow 0.2s ease; display:flex; align-items:center; justify-content:center; }
      .ay-cta:active:not(:disabled) { transform: translateY(1px); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.18), 0 3px 8px -2px rgba(0,0,0,0.12); }
      .ay-cta:disabled { opacity:0.45; cursor:not-allowed; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('ay', { variant: 'asymmetric', side: 'right' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(4, 8)}

        <div class="ay-rise" style="width:100%;max-width:460px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 10px;line-height:1.15">
            About you
          </h2>
          <p style="font-size:13.5px;color:var(--c-faint);margin:0;line-height:1.5">
            We use these to estimate your max heart rate and size training zones.
          </p>
        </div>

        <div class="ay-rise shadow-ap ay-card" style="max-width:460px;margin-top:28px;animation-delay:0.12s">
          ${renderRows(state, showWeight, isTriathlon)}
        </div>

        <div class="ay-rise" style="margin-top:22px;animation-delay:0.20s;width:100%;display:flex;flex-direction:column;align-items:center;gap:8px">
          <p id="ay-hint" style="font-size:12px;color:var(--c-faint);margin:0;text-align:center;display:none"></p>
          <button id="ay-continue" class="ay-cta">Continue</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers();
  refreshGate();
}

function renderRows(state: OnboardingState, showWeight: boolean, isTriathlon: boolean): string {
  const age = state.age ?? '';
  const weight = state.bodyWeightKg ?? '';
  const sex = state.biologicalSex ?? '';
  const bikeWeight = state.triBike?.bikeWeightKg ?? '';
  const sexPills: Array<['male' | 'female' | 'prefer_not_to_say', string]> = [
    ['male', 'Male'],
    ['female', 'Female'],
    ['prefer_not_to_say', 'Other'],
  ];
  return `
    <div class="ay-row">
      <div>
        <div class="ay-label">Age</div>
        <p class="ay-sub">So we can estimate your max heart rate.</p>
      </div>
      <div class="ay-suffix">
        <input id="ay-age" class="ay-input" type="number" inputmode="numeric" min="14" max="90" placeholder="—" value="${age}" style="max-width:96px">
        <span class="ay-suffix-text">years</span>
      </div>
    </div>
    <div class="ay-row">
      <div>
        <div class="ay-label">Sex</div>
        <p class="ay-sub">Heart rate response and recovery norms differ slightly between men and women.</p>
      </div>
      <div class="ay-pillrow">
        ${sexPills.map(([val, label]) => `
          <button class="ay-pill ${sex === val ? 'active' : ''}" data-sex="${val}">${label}</button>
        `).join('')}
      </div>
    </div>
    ${showWeight ? `
    <div class="ay-row">
      <div>
        <div class="ay-label">Weight <span style="color:var(--c-faint);font-weight:400">(optional)</span></div>
        <p class="ay-sub">Cycling tier is measured in watts per kg, not raw watts.${isTriathlon ? ' You can update this later under Bike setup for sharper power and climb-time numbers.' : ''}</p>
      </div>
      <div class="ay-suffix">
        <input id="ay-weight" class="ay-input" type="number" inputmode="decimal" min="35" max="180" step="0.5" placeholder="—" value="${weight}" style="max-width:96px">
        <span class="ay-suffix-text">kg</span>
      </div>
    </div>
    ` : ''}
    ${isTriathlon ? `
    <div class="ay-row">
      <div>
        <div class="ay-label">Bike weight</div>
        <p class="ay-sub">Used for climb-time prediction. Heavier bikes lose time on hills.</p>
      </div>
      <div class="ay-suffix">
        <input id="ay-bikew" class="ay-input" type="number" inputmode="decimal" min="5" max="20" step="0.1" placeholder="—" value="${bikeWeight}" style="max-width:96px">
        <span class="ay-suffix-text">kg</span>
      </div>
    </div>
    ` : ''}
  `;
}

/**
 * Age + sex are required to advance: max-HR estimation and HR-zone modelling
 * both depend on them. Weight stays optional (sex-based fallback exists).
 */
function refreshGate(): void {
  const s = getState().onboarding;
  if (!s) return;
  const missing: string[] = [];
  if (!s.age || s.age <= 0) missing.push('age');
  if (!s.biologicalSex) missing.push('sex');

  const hint = document.getElementById('ay-hint');
  const cta = document.getElementById('ay-continue') as HTMLButtonElement | null;
  const blocked = missing.length > 0;

  if (hint) {
    if (blocked) {
      hint.textContent = `Add your ${missing.join(' and ')} above to continue.`;
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  }
  if (cta) cta.disabled = blocked;
}

function wireHandlers(): void {
  const ageInput = document.getElementById('ay-age') as HTMLInputElement | null;
  ageInput?.addEventListener('input', () => {
    const v = Number(ageInput.value);
    updateOnboarding({ age: Number.isFinite(v) && v > 0 ? v : undefined });
    refreshGate();
  });

  const weightInput = document.getElementById('ay-weight') as HTMLInputElement | null;
  weightInput?.addEventListener('change', () => {
    const v = Number(weightInput.value);
    updateOnboarding({ bodyWeightKg: Number.isFinite(v) && v > 0 ? v : undefined });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-sex]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-sex') as 'male' | 'female' | 'prefer_not_to_say';
      updateOnboarding({ biologicalSex: value });
      document.querySelectorAll<HTMLButtonElement>('[data-sex]').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-sex') === value);
      });
      refreshGate();
    });
  });

  const bikeWeightInput = document.getElementById('ay-bikew') as HTMLInputElement | null;
  bikeWeightInput?.addEventListener('change', () => {
    const v = parseFloat(bikeWeightInput.value);
    const onb = (getState().onboarding ?? {}) as OnboardingState;
    const next = Number.isFinite(v) && v >= 5 && v <= 20 ? Math.round(v * 10) / 10 : undefined;
    updateOnboarding({ triBike: { ...(onb.triBike ?? {}), bikeWeightKg: next } });
  });

  const cta = document.getElementById('ay-continue') as HTMLButtonElement | null;
  cta?.addEventListener('click', () => {
    if (cta.disabled) return;
    nextStep();
  });
}
