import type { OnboardingState } from '@/types/onboarding';
import type { CommuteConfig } from '@/types/state';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { getState } from '@/state/store';

/**
 * Commute step. "Do you run to work?"
 *
 * Captures the user's commute pattern so the plan engine can fold the easy
 * mileage they're already doing into the prescribed weekly volume. A 5km
 * bidirectional commute three days a week is 30km of easy aerobic stimulus
 * before any prescribed running. The plan should know that and prioritise
 * quality + long-run sessions instead of bolting more easy filler on top.
 *
 * The backpack field captures load-carriage. A 7kg pack on a 70kg runner adds
 * roughly 10% metabolic cost (Knapik et al., load-carriage literature). HR
 * already reflects most of that, but the impact-load (Signal C) gets a small
 * structural-stress adjustment when the activity is tagged as a commute.
 *
 * Writes to `onboarding.runsToWork` and `onboarding.commuteConfig`.
 */

const DAY_OPTIONS = [1, 2, 3, 4, 5];

export function renderCommute(container: HTMLElement, state: OnboardingState): void {
  const cfg = state.commuteConfig;
  // Tri-state: true (Yes chosen), false (No chosen), null (no choice yet).
  // Pre-selecting No on the initial render would imply the user already
  // answered. Keep both pills neutral until the user picks one explicitly.
  const choseYes = state.runsToWork === true || (cfg?.enabled === true);
  const choseNo = state.runsToWork === false && !cfg?.enabled;
  const runsToWork = choseYes; // controls whether the details panel is shown
  const distance = cfg?.distanceKm ?? '';
  const bidirectional = cfg?.isBidirectional ?? true;
  const days = cfg?.commuteDaysPerWeek ?? 3;
  const backpackKg = cfg?.backpackKg ?? '';

  container.innerHTML = `
    <style>
      @keyframes cmRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .cm-rise { opacity:0; animation: cmRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      .cm-card { width:100%; background:#FFFFFF; border-radius:20px; padding:18px 22px; display:flex; flex-direction:column; }
      .cm-row { display:grid; grid-template-columns: 1fr auto; gap:12px; align-items:center; padding:12px 0; }
      .cm-row + .cm-row { border-top:1px solid rgba(0,0,0,0.05); }
      .cm-label { font-size:14px; color:var(--c-black); font-weight:500; }
      .cm-sub { font-size:12px; color:var(--c-faint); margin:3px 0 0; line-height:1.4; }
      .cm-input { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); color:var(--c-black); border-radius:9px; padding:8px 10px; font-size:14px; box-sizing:border-box; outline:none; font-variant-numeric: tabular-nums; }
      .cm-input:focus { border-color:var(--c-black); }
      .cm-suffix { display:flex; align-items:center; gap:8px; }
      .cm-suffix-text { font-size:13px; color:var(--c-faint); white-space:nowrap; }
      .cm-pillrow { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
      .cm-pill { padding:8px 14px; border-radius:9px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.85); font-size:13px; color:var(--c-black); cursor:pointer; text-align:center; transition: all 0.12s ease; min-width:38px; }
      .cm-pill.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }

      .cm-toggle { display:flex; align-items:center; gap:10px; }
      .cm-switch { position:relative; width:42px; height:24px; background:rgba(0,0,0,0.12); border-radius:12px; cursor:pointer; transition: background 0.16s ease; flex-shrink:0; }
      .cm-switch.active { background:var(--c-black); }
      .cm-switch::after { content:''; position:absolute; top:2px; left:2px; width:20px; height:20px; background:#fff; border-radius:50%; transition: transform 0.16s ease; box-shadow: 0 1px 3px rgba(0,0,0,0.18); }
      .cm-switch.active::after { transform: translateX(18px); }

      .cm-cta { width:100%; max-width:460px; height:52px; border-radius:26px; background:var(--c-black); color:#FFFFFF; border:none; font-size:15px; font-weight:600; letter-spacing:0.01em; cursor:pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.20), 0 9px 22px -8px rgba(0,0,0,0.30), 0 3px 8px -2px rgba(0,0,0,0.08); transition: transform 0.12s ease, box-shadow 0.2s ease; display:flex; align-items:center; justify-content:center; }
      .cm-cta:active:not(:disabled) { transform: translateY(1px); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.18), 0 3px 8px -2px rgba(0,0,0,0.12); }
      .cm-cta:disabled { opacity:0.45; cursor:not-allowed; }

      .cm-yesno { display:flex; gap:10px; width:100%; max-width:460px; }
      .cm-yesno button { flex:1; height:52px; border-radius:26px; border:1px solid rgba(0,0,0,0.10); background:#fff; color:var(--c-black); font-size:15px; font-weight:500; cursor:pointer; transition: all 0.14s ease; }
      .cm-yesno button.active { background:var(--c-black); color:#FDFCF7; border-color:var(--c-black); }

      .cm-summary { font-size:13px; color:var(--c-muted); margin:14px 0 0; text-align:center; line-height:1.5; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('cm', { variant: 'asymmetric', side: 'left' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(7, 8)}

        <div class="cm-rise" style="width:100%;max-width:460px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 10px;line-height:1.15">
            Do you run to work?
          </h2>
          <p style="font-size:13.5px;color:var(--c-faint);margin:0;line-height:1.5">
            Commute runs are added on top of your runs-per-week target. The plan tracks the extra volume and surfaces each trip as its own session.
          </p>
        </div>

        <div class="cm-rise cm-yesno" style="margin-top:28px;animation-delay:0.12s">
          <button id="cm-no" class="${choseNo ? 'active' : ''}" data-yn="no">No</button>
          <button id="cm-yes" class="${choseYes ? 'active' : ''}" data-yn="yes">Yes</button>
        </div>

        <div id="cm-details" class="cm-rise shadow-ap cm-card" style="max-width:460px;margin-top:18px;animation-delay:0.18s;display:${runsToWork ? 'flex' : 'none'}">
          <div class="cm-row">
            <div>
              <div class="cm-label">One-way distance</div>
              <p class="cm-sub">From home to work, in kilometres.</p>
            </div>
            <div class="cm-suffix">
              <input id="cm-distance" class="cm-input" type="number" inputmode="decimal" min="1" max="30" step="0.5" placeholder="—" value="${distance}" style="max-width:96px">
              <span class="cm-suffix-text">km</span>
            </div>
          </div>

          <div class="cm-row">
            <div>
              <div class="cm-label">Run both ways</div>
              <p class="cm-sub">To and from work, or just one direction.</p>
            </div>
            <div class="cm-toggle">
              <div id="cm-bidir" class="cm-switch ${bidirectional ? 'active' : ''}" role="switch" aria-checked="${bidirectional}"></div>
            </div>
          </div>

          <div class="cm-row">
            <div>
              <div class="cm-label">Days per week</div>
              <p class="cm-sub">How often you commute by running.</p>
            </div>
            <div class="cm-pillrow">
              ${DAY_OPTIONS.map(d => `<button class="cm-pill ${days === d ? 'active' : ''}" data-days="${d}">${d}</button>`).join('')}
            </div>
          </div>

          <div class="cm-row">
            <div>
              <div class="cm-label">Backpack weight <span style="color:var(--c-faint);font-weight:400">(optional)</span></div>
              <p class="cm-sub">Default load on commute runs. Used to size the structural-stress adjustment. Leave blank if you don't run with a pack.</p>
            </div>
            <div class="cm-suffix">
              <input id="cm-backpack" class="cm-input" type="number" inputmode="decimal" min="0" max="25" step="0.5" placeholder="0" value="${backpackKg}" style="max-width:96px">
              <span class="cm-suffix-text">kg</span>
            </div>
          </div>
        </div>

        <p id="cm-summary" class="cm-rise cm-summary" style="animation-delay:0.24s;display:${runsToWork ? 'block' : 'none'}"></p>

        <div class="cm-rise" style="margin-top:22px;animation-delay:0.28s;width:100%;display:flex;flex-direction:column;align-items:center;gap:8px">
          <p id="cm-hint" style="font-size:12px;color:var(--c-faint);margin:0;text-align:center;display:none"></p>
          <button id="cm-continue" class="cm-cta">Continue</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers();
  refreshSummary();
  refreshGate();
}

/**
 * Build the current commute config from the onboarding state and form values.
 * Returns null if "no" was selected. The caller writes `enabled:false` then.
 */
function readConfigFromState(): CommuteConfig | null {
  const s = getState().onboarding;
  if (!s) return null;
  if (s.runsToWork !== true) return null;
  const cfg = s.commuteConfig;
  if (!cfg) return null;
  return cfg;
}

function summariseConfig(cfg: CommuteConfig | null): string {
  if (!cfg || !cfg.enabled || !cfg.distanceKm || cfg.distanceKm <= 0) return '';
  const perDay = cfg.isBidirectional ? cfg.distanceKm * 2 : cfg.distanceKm;
  const weekly = perDay * cfg.commuteDaysPerWeek;
  const pack = cfg.backpackKg && cfg.backpackKg > 0 ? ` with a ${cfg.backpackKg}kg pack` : '';
  return `That's about ${weekly.toFixed(0)} km/week of easy mileage${pack}.`;
}

function refreshSummary(): void {
  const cfg = readConfigFromState();
  const el = document.getElementById('cm-summary');
  if (!el) return;
  const text = summariseConfig(cfg);
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}

/**
 * The user must answer yes or no. Yes additionally requires a distance > 0
 * and a days-per-week count. Backpack is optional.
 */
function refreshGate(): void {
  const s = getState().onboarding;
  const cta = document.getElementById('cm-continue') as HTMLButtonElement | null;
  const hint = document.getElementById('cm-hint');
  if (!s || !cta || !hint) return;

  let blocked = false;
  let message = '';

  if (s.runsToWork === null) {
    blocked = true;
    message = 'Tap Yes or No to continue.';
  } else if (s.runsToWork === true) {
    const cfg = s.commuteConfig;
    if (!cfg || !cfg.distanceKm || cfg.distanceKm <= 0) {
      blocked = true;
      message = 'Add the one-way distance to continue.';
    }
  }

  cta.disabled = blocked;
  if (blocked) {
    hint.textContent = message;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

/**
 * Write the current form values back to `commuteConfig`. Centralised so every
 * field handler produces a complete, consistent config (no partials on state).
 */
function persistConfig(): void {
  const s = getState().onboarding;
  if (!s) return;

  if (s.runsToWork !== true) {
    updateOnboarding({ commuteConfig: { enabled: false, distanceKm: 0, isBidirectional: false, commuteDaysPerWeek: 0 } });
    return;
  }

  const distEl = document.getElementById('cm-distance') as HTMLInputElement | null;
  const bidirEl = document.getElementById('cm-bidir');
  const backpackEl = document.getElementById('cm-backpack') as HTMLInputElement | null;

  const dist = distEl ? Number(distEl.value) : NaN;
  const distance = Number.isFinite(dist) && dist > 0 ? dist : 0;
  const isBidirectional = bidirEl?.classList.contains('active') ?? true;
  const days = s.commuteConfig?.commuteDaysPerWeek ?? 3;
  const backpackRaw = backpackEl ? Number(backpackEl.value) : NaN;
  const backpackKg = Number.isFinite(backpackRaw) && backpackRaw > 0 ? backpackRaw : undefined;

  const cfg: CommuteConfig = {
    enabled: distance > 0,
    distanceKm: distance,
    isBidirectional,
    commuteDaysPerWeek: Math.min(Math.max(days, 1), 5),
    ...(backpackKg ? { backpackKg } : {}),
  };

  updateOnboarding({ commuteConfig: cfg });
}

function wireHandlers(): void {
  const details = document.getElementById('cm-details');
  const summary = document.getElementById('cm-summary');

  document.querySelectorAll<HTMLButtonElement>('[data-yn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-yn');
      const yes = value === 'yes';
      updateOnboarding({ runsToWork: yes });
      document.querySelectorAll<HTMLButtonElement>('[data-yn]').forEach((b) => {
        b.classList.toggle('active', (b.getAttribute('data-yn') === 'yes') === yes);
      });
      if (details) details.style.display = yes ? 'flex' : 'none';
      if (summary) summary.style.display = yes ? 'block' : 'none';
      persistConfig();
      refreshSummary();
      refreshGate();
    });
  });

  const distInput = document.getElementById('cm-distance') as HTMLInputElement | null;
  distInput?.addEventListener('input', () => {
    persistConfig();
    refreshSummary();
    refreshGate();
  });

  const bidirEl = document.getElementById('cm-bidir');
  bidirEl?.addEventListener('click', () => {
    bidirEl.classList.toggle('active');
    bidirEl.setAttribute('aria-checked', bidirEl.classList.contains('active') ? 'true' : 'false');
    persistConfig();
    refreshSummary();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = Number(btn.getAttribute('data-days'));
      if (!Number.isFinite(value)) return;
      const s = getState().onboarding;
      if (!s) return;
      const existing = s.commuteConfig ?? { enabled: true, distanceKm: 0, isBidirectional: true, commuteDaysPerWeek: value };
      updateOnboarding({ commuteConfig: { ...existing, commuteDaysPerWeek: value } });
      document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((b) => {
        b.classList.toggle('active', Number(b.getAttribute('data-days')) === value);
      });
      refreshSummary();
    });
  });

  const backpackInput = document.getElementById('cm-backpack') as HTMLInputElement | null;
  backpackInput?.addEventListener('input', () => {
    persistConfig();
    refreshSummary();
  });

  const cta = document.getElementById('cm-continue') as HTMLButtonElement | null;
  cta?.addEventListener('click', () => {
    if (cta.disabled) return;
    persistConfig();
    nextStep();
  });
}
