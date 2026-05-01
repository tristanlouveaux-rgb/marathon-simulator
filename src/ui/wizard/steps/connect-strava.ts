import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { saveState } from '@/state/persistence';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import {
  getAccessToken,
  SUPABASE_FUNCTIONS_BASE,
  SUPABASE_ANON_KEY,
  isStravaConnected,
  isGarminConnected,
  resetGarminBackfillGuard,
} from '@/data/supabaseClient';
import { isNativeiOS, connectAppleHealth } from '@/data/appleHealthSync';
import { getState } from '@/state/store';
import { hasPhysiologySource } from '@/data/sources';

/**
 * Page 3 — Connect Strava
 *
 * Primary action is a branded Strava-orange CTA (the one permitted non-neutral colour on this
 * screen, since it is the permission grant for a branded third-party). Secondary action is a
 * muted text link to fall back to manual entry.
 *
 * If the user is already connected (returning from OAuth, or linked on a previous session)
 * we silently advance to the next step — no intermediate confirmation screen.
 */
export function renderConnectStrava(container: HTMLElement, state: OnboardingState): void {
  // We no longer auto-skip when Strava is already connected — the user needs
  // to see the Garmin / Apple options too (added 2026-04-27). Existing-Strava
  // state is reflected in the CTA's connected style instead.

  container.innerHTML = `
    <style>
      @keyframes csRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .cs-rise { opacity:0; animation: csRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      /* Apple-style 3-layer shadow, same as goals.ts */
      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      /* Value-prop card */
      .cs-card { width:100%; background:#FFFFFF; border-radius:20px; padding:20px 22px; display:flex; flex-direction:column; gap:14px; }
      .cs-row { display:flex; align-items:flex-start; gap:14px; }
      .cs-row-icon { flex:0 0 28px; width:28px; height:28px; border-radius:8px; background:rgba(0,0,0,0.04); color:var(--c-black); display:flex; align-items:center; justify-content:center; margin-top:1px; }
      .cs-row-icon svg { width:16px; height:16px; stroke-width:1.5; }
      .cs-row-text { flex:1; min-width:0; }
      .cs-row-label { font-size:14px; font-weight:500; color:var(--c-black); line-height:1.3; margin:0; }
      .cs-row-sub { font-size:12.5px; color:var(--c-faint); line-height:1.45; margin:2px 0 0; }
      .cs-privacy { font-size:11.5px; color:var(--c-faint); text-align:center; margin:14px 0 0; line-height:1.5; }

      /* Primary CTA — Strava orange */
      .cs-cta { width:100%; height:52px; border-radius:26px; background:#FC4C02; color:#FFFFFF; border:none; font-size:15px; font-weight:600; letter-spacing:0.01em; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 2px rgba(252,76,2,0.20), 0 9px 22px -8px rgba(252,76,2,0.35), 0 3px 8px -2px rgba(0,0,0,0.08); transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .cs-cta:active { transform: translateY(1px); box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), 0 1px 2px rgba(252,76,2,0.18), 0 3px 8px -2px rgba(0,0,0,0.12); }
      .cs-cta[disabled] { opacity:0.55; cursor:wait; }

      /* Secondary skip link — muted text only, no colour, no border */
      .cs-skip { background:none; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; padding:10px 6px; text-decoration:underline; }
      .cs-skip:active { color:var(--c-black); }

      /* Secondary CTAs (Garmin, Apple) — same height + radius as the Strava CTA so
         all three providers read as equally important. Dark fill (not Strava-orange)
         keeps a small visual hierarchy: Strava is the primary "we need this" data
         source, Garmin/Apple are co-equal physiology providers. */
      .cs-secondary { width:100%; height:52px; border-radius:26px; background:var(--c-black); color:#FFFFFF; border:none; font-size:15px; font-weight:600; letter-spacing:0.01em; cursor:pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.20), 0 9px 22px -8px rgba(0,0,0,0.30), 0 3px 8px -2px rgba(0,0,0,0.08); transition: transform 0.12s ease, box-shadow 0.2s ease; display:flex; align-items:center; justify-content:center; gap:10px; }
      .cs-secondary:active:not(:disabled) { transform: translateY(1px); box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.18), 0 3px 8px -2px rgba(0,0,0,0.12); }
      .cs-secondary:disabled { opacity:0.55; cursor:wait; }
      .cs-secondary.connected { background:rgba(46,125,50,0.08); color:#2e7d32; cursor:default; box-shadow:none; border:1px solid rgba(46,125,50,0.3); }

      .cs-err { font-size:12px; color:var(--c-danger, #B91C1C); margin-top:10px; text-align:center; display:none; }

      /* About-you card — age, weight, sex. Same visual language as cs-card,
         tighter spacing because the rows are inputs not value-props. */
      .cs-au-row { display:grid; grid-template-columns: 100px 1fr; gap:12px; align-items:center; padding:8px 0; }
      .cs-au-row + .cs-au-row { border-top:1px solid rgba(0,0,0,0.05); }
      .cs-au-label { font-size:13px; color:var(--c-black); font-weight:500; }
      .cs-au-sub { font-size:11.5px; color:var(--c-faint); margin:2px 0 0; line-height:1.4; }
      .cs-au-input { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); color:var(--c-black); border-radius:9px; padding:8px 10px; font-size:14px; width:100%; box-sizing:border-box; outline:none; font-variant-numeric: tabular-nums; }
      .cs-au-input:focus { border-color:var(--c-black); }
      .cs-au-suffix { display:flex; align-items:center; gap:8px; }
      .cs-au-suffix-text { font-size:13px; color:var(--c-faint); white-space:nowrap; }
      .cs-au-pillrow { display:flex; gap:6px; }
      .cs-au-pill { flex:1; padding:8px 10px; border-radius:9px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.85); font-size:13px; color:var(--c-black); cursor:pointer; text-align:center; transition: all 0.12s ease; }
      .cs-au-pill.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 38%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(3, 7)}

        <div class="cs-rise" style="width:100%;max-width:460px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 10px;line-height:1.15">
            Connect Strava
          </h2>
          <p style="font-size:13.5px;color:var(--c-faint);margin:0;line-height:1.5">
            We read your recent runs so your plan is built on real data, not guesses.
          </p>
        </div>

        <div class="cs-rise shadow-ap cs-card" style="max-width:460px;margin-top:28px;animation-delay:0.12s">
          <div class="cs-row">
            <div class="cs-row-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/></svg>
            </div>
            <div class="cs-row-text">
              <p class="cs-row-label">Personal bests</p>
              <p class="cs-row-sub">5K, 10K, half, marathon — pulled from your fastest efforts.</p>
            </div>
          </div>
          <div class="cs-row">
            <div class="cs-row-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M8 19v-6"/><path d="M12 19v-10"/><path d="M16 19v-4"/><path d="M20 19v-8"/></svg>
            </div>
            <div class="cs-row-text">
              <p class="cs-row-label">Weekly volume</p>
              <p class="cs-row-sub">Average km over the last 4 weeks, so load ramps from where you actually are.</p>
            </div>
          </div>
          <div class="cs-row">
            <div class="cs-row-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 4 5-7 4 5"/></svg>
            </div>
            <div class="cs-row-text">
              <p class="cs-row-label">Fitness estimate</p>
              <p class="cs-row-sub">VDOT from your harder runs to size pace zones correctly.</p>
            </div>
          </div>
          <p class="cs-privacy">Read-only. Nothing is posted to your Strava feed.</p>
        </div>

        <div class="cs-rise" style="width:100%;max-width:460px;margin-top:28px;animation-delay:0.20s">
          <button id="cs-connect" class="cs-cta" aria-label="Connect Strava">
            <svg id="cs-strava-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M13.828 2 8 13.5h3.48L13.828 9l2.347 4.5h3.48L13.828 2Zm2.293 13.5-1.747 3.352L12.626 15.5h-2.5L14.374 23l4.25-7.5h-2.503Z"/>
            </svg>
            <span id="cs-strava-label">Connect Strava</span>
          </button>
          <p id="cs-error" class="cs-err"></p>
        </div>

        <!-- Secondary providers: Garmin (OAuth, web + iOS) and Apple Health (iOS native).
             These deliver physiology that Strava can't: resting HR, HRV, sleep — needed for
             HR-calibrated VDOT and recovery scoring. Apple block hides on non-iOS. -->
        <div class="cs-rise" style="width:100%;max-width:460px;margin-top:18px;animation-delay:0.24s">
          <p style="font-size:11.5px;color:var(--c-faint);text-align:center;margin:0 0 10px;letter-spacing:0.04em;text-transform:uppercase">Plus your watch (optional)</p>

          <button id="cs-connect-garmin" class="cs-secondary" aria-label="Connect Garmin">
            <span style="display:flex;align-items:center;gap:10px;justify-content:center">
              <span id="cs-garmin-label">Connect Garmin</span>
            </span>
          </button>
          <p id="cs-garmin-status" style="font-size:12px;color:var(--c-muted);text-align:center;margin:6px 0 0;display:none"></p>
          <p id="cs-garmin-error" class="cs-err"></p>

          <div id="cs-apple-wrap" style="margin-top:10px;display:none">
            <button id="cs-connect-apple" class="cs-secondary" aria-label="Connect Apple Health">
              <span style="display:flex;align-items:center;gap:10px;justify-content:center">
                <span id="cs-apple-label">Connect Apple Health</span>
              </span>
            </button>
            <p id="cs-apple-status" style="font-size:12px;color:var(--c-muted);text-align:center;margin:6px 0 0;display:none"></p>
            <p id="cs-apple-error" class="cs-err"></p>
          </div>

          <p style="font-size:11.5px;color:var(--c-faint);text-align:center;margin:10px 0 0;line-height:1.5">Pulls resting HR, HRV, and sleep so we can calibrate your VDOT from your training.</p>
        </div>

        <!-- About-you: age, weight, sex. All optional except where noted; weight
             falls back to a sex-based default and "Other" maps to male defaults
             internally. Lives on this page because it's the same logical theme:
             "things we need to know to make the plan accurate." -->
        <div class="cs-rise shadow-ap cs-card" style="max-width:460px;margin-top:18px;animation-delay:0.26s">
          <p style="font-size:11.5px;color:var(--c-faint);margin:-2px 0 6px;letter-spacing:0.04em;text-transform:uppercase">About you</p>
          ${renderAboutYouRows(state)}
        </div>

        <div class="cs-rise" style="margin-top:14px;animation-delay:0.30s;display:flex;flex-direction:column;align-items:center;gap:6px">
          <p id="cs-au-hint" style="font-size:12px;color:var(--c-faint);margin:0 0 4px;text-align:center;display:none"></p>
          <button id="cs-continue" class="cs-skip" style="display:none;color:var(--c-black);font-weight:500">Continue →</button>
          <button id="cs-skip" class="cs-skip">Enter manually</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state);
  wireAboutYouHandlers();
}

/**
 * About-you card rows. Each row uses one-line plain-language explanations —
 * we don't say "iTRIMP β coefficient" or "max HR estimate" because most users
 * have no map for those. We say what the input does for them.
 */
function renderAboutYouRows(state: OnboardingState): string {
  const age = state.age ?? '';
  const weight = state.bodyWeightKg ?? '';
  const sex = state.biologicalSex ?? '';
  const bikeWeight = state.triBike?.bikeWeightKg ?? '';
  const isTriathlon = state.trainingMode === 'triathlon';
  const sexPills: Array<['male' | 'female' | 'prefer_not_to_say', string]> = [
    ['male', 'Male'],
    ['female', 'Female'],
    ['prefer_not_to_say', 'Other'],
  ];
  return `
    <div class="cs-au-row">
      <div>
        <div class="cs-au-label">Age</div>
        <p class="cs-au-sub">So we can estimate your max heart rate.</p>
      </div>
      <div class="cs-au-suffix">
        <input id="cs-au-age" class="cs-au-input" type="number" inputmode="numeric" min="14" max="90" placeholder="—" value="${age}" style="max-width:96px">
        <span class="cs-au-suffix-text">years</span>
      </div>
    </div>
    <div class="cs-au-row">
      <div>
        <div class="cs-au-label">Weight <span style="color:var(--c-faint);font-weight:400">(optional)</span></div>
        <p class="cs-au-sub">Cycling tier is measured in watts per kg, not raw watts.${isTriathlon ? ' You can update this later under Bike setup for sharper power and climb-time numbers.' : ''}</p>
      </div>
      <div class="cs-au-suffix">
        <input id="cs-au-weight" class="cs-au-input" type="number" inputmode="decimal" min="35" max="180" step="0.5" placeholder="—" value="${weight}" style="max-width:96px">
        <span class="cs-au-suffix-text">kg</span>
      </div>
    </div>
    ${isTriathlon ? `
    <div class="cs-au-row">
      <div>
        <div class="cs-au-label">Bike weight</div>
        <p class="cs-au-sub">Used for climb-time prediction. Heavier bikes lose time on hills.</p>
      </div>
      <div class="cs-au-suffix">
        <input id="cs-au-bikew" class="cs-au-input" type="number" inputmode="decimal" min="5" max="20" step="0.1" placeholder="—" value="${bikeWeight}" style="max-width:96px">
        <span class="cs-au-suffix-text">kg</span>
      </div>
    </div>
    ` : ''}
    <div class="cs-au-row">
      <div>
        <div class="cs-au-label">Sex</div>
        <p class="cs-au-sub">Heart rate response and recovery norms differ slightly between men and women.</p>
      </div>
      <div class="cs-au-pillrow">
        ${sexPills.map(([val, label]) => `
          <button class="cs-au-pill ${sex === val ? 'active' : ''}" data-sex="${val}">${label}</button>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Age + sex are required to advance: max-HR estimation and HR-zone modelling
 * both depend on them, so silently letting the user skip past produces a plan
 * built on guessed defaults. Weight stays optional (sex-based fallback exists).
 */
function refreshAboutYouGate(): void {
  const s = getState().onboarding;
  if (!s) return;
  const missing: string[] = [];
  if (!s.age || s.age <= 0) missing.push('age');
  if (!s.biologicalSex) missing.push('sex');

  const hint = document.getElementById('cs-au-hint');
  const skipBtn = document.getElementById('cs-skip') as HTMLButtonElement | null;
  const continueBtn = document.getElementById('cs-continue') as HTMLButtonElement | null;
  const blocked = missing.length > 0;

  if (hint) {
    if (blocked) {
      hint.textContent = `Add your ${missing.join(' and ')} above to continue.`;
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  }
  if (skipBtn) {
    skipBtn.disabled = blocked;
    skipBtn.style.opacity = blocked ? '0.45' : '';
    skipBtn.style.cursor = blocked ? 'not-allowed' : 'pointer';
  }
  if (continueBtn) {
    continueBtn.disabled = blocked;
    continueBtn.style.opacity = blocked ? '0.45' : '';
    continueBtn.style.cursor = blocked ? 'not-allowed' : 'pointer';
  }
}

function wireAboutYouHandlers(): void {
  const ageInput = document.getElementById('cs-au-age') as HTMLInputElement | null;
  // 'input' fires on every keystroke so the gate updates as soon as a valid
  // age is typed; 'change' alone would only release the gate on blur.
  ageInput?.addEventListener('input', () => {
    const v = Number(ageInput.value);
    updateOnboarding({ age: Number.isFinite(v) && v > 0 ? v : undefined });
    refreshAboutYouGate();
  });

  const weightInput = document.getElementById('cs-au-weight') as HTMLInputElement | null;
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
      refreshAboutYouGate();
    });
  });

  const bikeWeightInput = document.getElementById('cs-au-bikew') as HTMLInputElement | null;
  bikeWeightInput?.addEventListener('change', () => {
    const v = parseFloat(bikeWeightInput.value);
    const onb = (getState().onboarding ?? {}) as OnboardingState;
    const next = Number.isFinite(v) && v >= 5 && v <= 20 ? Math.round(v * 10) / 10 : undefined;
    updateOnboarding({ triBike: { ...(onb.triBike ?? {}), bikeWeightKg: next } });
  });

  refreshAboutYouGate();
}

function wireHandlers(_state: OnboardingState): void {
  const cta = document.getElementById('cs-connect') as HTMLButtonElement | null;
  const stravaLabel = document.getElementById('cs-strava-label');
  const stravaIcon = document.getElementById('cs-strava-icon');
  const errorEl = document.getElementById('cs-error') as HTMLElement | null;
  const continueBtn = document.getElementById('cs-continue') as HTMLButtonElement | null;
  const skipBtn = document.getElementById('cs-skip') as HTMLButtonElement | null;

  // If Strava is already connected (returning user, or just completed OAuth),
  // morph the CTA into a connected state and reveal the Continue button.
  // The user still needs the Garmin / Apple buttons below — that's why we no
  // longer auto-advance.
  isStravaConnected().then((connected) => {
    if (connected && cta && stravaLabel) {
      stravaLabel.textContent = '✓ Strava connected';
      // Strip the orange brand colour to a muted connected style.
      cta.style.background = 'rgba(46,125,50,0.08)';
      cta.style.color = '#2e7d32';
      cta.style.boxShadow = 'none';
      cta.disabled = true;
      if (stravaIcon) stravaIcon.style.display = 'none';
      if (continueBtn) continueBtn.style.display = 'block';
      if (skipBtn) skipBtn.style.display = 'none';
    }
  }).catch(() => { /* check failed — leave button as Connect */ });

  const showError = (msg: string) => {
    if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
    if (cta) cta.disabled = false;
  };

  cta?.addEventListener('click', async () => {
    if (cta.disabled) return;
    cta.disabled = true;
    if (errorEl) errorEl.style.display = 'none';

    // Mark this step as the return destination so the OAuth callback lands us here.
    updateOnboarding({ currentStep: 'connect-strava', skippedStrava: false });
    saveState();

    try {
      const token = await getAccessToken();
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/strava-auth-start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ appOrigin: window.location.origin }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        showError(`Could not start Strava connection (${res.status}). ${text}`);
        return;
      }
      const data = await res.json();
      if (data?.url) {
        window.location.href = data.url;
      } else {
        showError('Strava did not return an authorisation URL.');
      }
    } catch (err) {
      showError(`Strava connection error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  });

  document.getElementById('cs-skip')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    updateOnboarding({ skippedStrava: true });
    saveState();
    nextStep();
  });

  // Continue button — only visible when at least Strava is connected. Advances
  // through the normal flow (no skippedStrava flag, so review reads from history).
  continueBtn?.addEventListener('click', () => {
    if (continueBtn.disabled) return;
    updateOnboarding({ skippedStrava: false });
    saveState();
    nextStep();
  });

  wireGarminHandler();
  wireAppleHandler();
}

/**
 * Garmin secondary CTA. OAuth flow — POST `/garmin-auth-start`, redirect,
 * callback returns to this step (we save `currentStep` first). Updates
 * button state inline; `bootstrap()` in main.ts handles `?garmin=connected`.
 */
function wireGarminHandler(): void {
  const btn = document.getElementById('cs-connect-garmin') as HTMLButtonElement | null;
  const label = document.getElementById('cs-garmin-label');
  const status = document.getElementById('cs-garmin-status');
  const errEl = document.getElementById('cs-garmin-error');
  if (!btn || !label) return;

  // Initial state — already-connected check
  isGarminConnected().then((connected) => {
    if (connected) {
      btn.classList.add('connected');
      btn.disabled = true;
      label.textContent = '✓ Garmin connected';
      if (status) {
        status.textContent = 'Resting HR, max HR, HRV, and sleep will sync after setup.';
        status.style.display = 'block';
      }
    }
  }).catch(() => { /* offline / edge fn down — leave button as Connect */ });

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    label.textContent = 'Opening Garmin…';
    if (errEl) errEl.style.display = 'none';

    updateOnboarding({ currentStep: 'connect-strava' });
    saveState();
    resetGarminBackfillGuard();

    try {
      const token = await getAccessToken();
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/garmin-auth-start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ appOrigin: window.location.origin }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (errEl) {
          errEl.textContent = `Could not start Garmin connection (${res.status}). ${text}`.trim();
          errEl.style.display = 'block';
        }
        btn.disabled = false;
        label.textContent = 'Connect Garmin';
        return;
      }
      const data = await res.json();
      if (data?.url) {
        window.location.href = data.url;
      } else {
        if (errEl) {
          errEl.textContent = 'Garmin did not return an authorisation URL.';
          errEl.style.display = 'block';
        }
        btn.disabled = false;
        label.textContent = 'Connect Garmin';
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = `Garmin connection error: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errEl.style.display = 'block';
      }
      btn.disabled = false;
      label.textContent = 'Connect Garmin';
    }
  });
}

/**
 * Apple Health secondary CTA. iOS-native HealthKit only — entire wrapper
 * stays hidden on web/Android. On click, calls `connectAppleHealth()`
 * which prompts permissions, runs initial sync, marks Apple as the source.
 */
function wireAppleHandler(): void {
  const wrap = document.getElementById('cs-apple-wrap');
  const btn = document.getElementById('cs-connect-apple') as HTMLButtonElement | null;
  const label = document.getElementById('cs-apple-label');
  const status = document.getElementById('cs-apple-status');
  const errEl = document.getElementById('cs-apple-error');
  if (!wrap || !btn || !label) return;

  // Hide entirely off iOS.
  if (!isNativeiOS()) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';

  if (hasPhysiologySource(getState() as any, 'apple')) {
    btn.classList.add('connected');
    btn.disabled = true;
    label.textContent = '✓ Apple Health connected';
    if (status) {
      status.textContent = 'Sleep, HRV, resting HR will sync from your watch.';
      status.style.display = 'block';
    }
  }

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    label.textContent = 'Requesting permissions…';
    if (errEl) errEl.style.display = 'none';

    const result = await connectAppleHealth();
    if (result.ok) {
      btn.classList.add('connected');
      label.textContent = '✓ Apple Health connected';
      if (status) {
        status.textContent = 'Sleep, HRV, resting HR will sync from your watch.';
        status.style.display = 'block';
      }
    } else {
      const msg = result.reason === 'permission-denied'
        ? 'Permissions not granted. Open Settings → Privacy → Health → Mosaic to allow access.'
        : `Apple Health connection failed (${result.reason}).`;
      if (errEl) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }
      btn.disabled = false;
      label.textContent = 'Connect Apple Health';
    }
  });
}
