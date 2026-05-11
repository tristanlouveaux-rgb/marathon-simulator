import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { saveState } from '@/state/persistence';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { poweredByStrava } from '@/ui/strava-brand';
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

      /* Primary CTA — official Strava button image */
      .cs-cta { background:none; border:none; padding:0; cursor:pointer; width:100%; display:flex; justify-content:center; }
      .cs-cta:disabled { cursor:default; }
      .cs-cta img { display:block; width:100%; max-width:237px; height:auto; }

      /* Connected state — bordered pill with no fill, status dot + muted text.
         Matches account-view.ts pattern; no green tint, no green border. */
      .cs-cta-connected { width:100%; max-width:237px; height:48px; border-radius:24px; background:transparent; color:var(--c-black); font-size:14px; font-weight:500; display:none; align-items:center; justify-content:center; border:1px solid var(--c-border-strong); margin:0 auto; }
      .cs-status-dot { width:8px; height:8px; border-radius:50%; background:var(--c-ok); display:inline-block; margin-right:8px; vertical-align:middle; }

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
      /* Connected state — match Strava-connected pill: bordered, no fill, status
         dot + muted text. Drops the dark fill so "connected" reads as a passive
         status, not an active CTA. */
      .cs-secondary.connected { background:transparent; color:var(--c-black); cursor:default; box-shadow:none; border:1px solid var(--c-border-strong); font-weight:500; font-size:14px; height:48px; border-radius:24px; }

      .cs-err { font-size:12px; color:var(--c-danger, #B91C1C); margin-top:10px; text-align:center; display:none; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <!-- Background layers: cool-blue atmosphere → asymmetric (right) rings → sun glint -->
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('cs', { variant: 'asymmetric', side: 'right' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(3, 8)}

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
          <p class="cs-privacy" style="margin-top:5px">Heart rate streams let us calibrate your load precisely, beyond just distance and duration.</p>
        </div>

        <div class="cs-rise" style="width:100%;max-width:460px;margin-top:28px;animation-delay:0.20s">
          <button id="cs-connect" class="cs-cta" aria-label="Connect with Strava">
            <img id="cs-strava-img" src="/connect-with-strava.svg" alt="Connect with Strava">
          </button>
          <div id="cs-strava-connected" class="cs-cta-connected"><span class="cs-status-dot"></span>Strava connected</div>
          <p id="cs-error" class="cs-err"></p>
          <div style="margin-top:16px;text-align:center">
            ${poweredByStrava(18, 0.6)}
          </div>
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

          <div id="cs-apple-wrap" style="margin-top:10px">
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

        <div class="cs-rise" style="margin-top:22px;animation-delay:0.28s;display:flex;flex-direction:column;align-items:center;gap:6px">
          <button id="cs-continue" class="cs-skip" style="display:none;color:var(--c-black);font-weight:500">Continue →</button>
          <button id="cs-skip" class="cs-skip">Enter manually</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers();
}

function wireHandlers(): void {
  const cta = document.getElementById('cs-connect') as HTMLButtonElement | null;
  const stravaImg = document.getElementById('cs-strava-img') as HTMLImageElement | null;
  const stravaConnected = document.getElementById('cs-strava-connected');
  const errorEl = document.getElementById('cs-error') as HTMLElement | null;
  const continueBtn = document.getElementById('cs-continue') as HTMLButtonElement | null;
  const skipBtn = document.getElementById('cs-skip') as HTMLButtonElement | null;

  // If Strava is already connected (returning user, or just completed OAuth),
  // morph the CTA into a connected state and reveal the Continue button.
  // The user still needs the Garmin / Apple buttons below — that's why we no
  // longer auto-advance.
  isStravaConnected().then((connected) => {
    if (connected && cta) {
      if (stravaImg) stravaImg.style.display = 'none';
      if (stravaConnected) stravaConnected.style.display = 'flex';
      cta.disabled = true;
      revealContinueButton();
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

  // Continue button — visible when ANY source is connected (Strava, Garmin,
  // or Apple Health). Strava-connected users follow the auto-fill PB flow;
  // Apple- or Garmin-only users skip the Strava data chain (skippedStrava=true)
  // and enter PBs manually in the review step. The flag is decided live at
  // click time, not at render time, because Garmin OAuth re-enters this page
  // and the user may have toggled state in between.
  continueBtn?.addEventListener('click', async () => {
    if (continueBtn.disabled) return;
    const stravaOk = await isStravaConnected().catch(() => false);
    updateOnboarding({ skippedStrava: !stravaOk });
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
      label.innerHTML = '<span class="cs-status-dot"></span>Garmin connected';
      if (status) {
        status.textContent = 'Resting HR, max HR, HRV, and sleep will sync after setup.';
        status.style.display = 'block';
      }
      revealContinueButton();
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

  // Off iOS native, the @capgo/capacitor-health bridge is a no-op — there
  // is no HealthKit to talk to. Rather than hide the button (which gives
  // the false impression we don't support Apple Watch at all), render it
  // in an "iOS app only" state so the user knows the option exists and
  // sees what they'd get on the iOS build. Click shows a soft explainer.
  if (!isNativeiOS()) {
    btn.disabled = true;
    btn.style.opacity = '0.55';
    btn.style.cursor = 'default';
    label.textContent = 'Apple Watch — iOS app only';
    if (status) {
      status.textContent = 'Sleep, HRV, resting HR, and 16w of workouts. Available in the Mosaic iOS app.';
      status.style.display = 'block';
    }
    return;
  }

  if (hasPhysiologySource(getState() as any, 'apple')) {
    btn.classList.add('connected');
    btn.disabled = true;
    label.innerHTML = '<span class="cs-status-dot"></span>Apple Health connected';
    if (status) {
      status.textContent = 'Sleep, HRV, resting HR will sync from your watch.';
      status.style.display = 'block';
    }
    revealContinueButton();
  }

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    label.textContent = 'Requesting permissions…';
    if (errEl) errEl.style.display = 'none';

    const result = await connectAppleHealth();
    if (result.ok) {
      btn.classList.add('connected');
      label.innerHTML = '<span class="cs-status-dot"></span>Apple Health connected';
      if (status) {
        // The 16-week activity backfill happens at the review step (after
        // age has been entered), so we promise the workout sync here even
        // though it hasn't started yet — keeps the user-facing copy honest.
        status.textContent = 'Sleep, HRV, resting HR connected. Workouts will sync after Continue.';
        status.style.display = 'block';
      }
      revealContinueButton();
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

/**
 * Show the shared "Continue →" button and hide the "Enter manually" link.
 * Called after any provider (Strava / Garmin / Apple) connects successfully —
 * the user has data, so manual entry is no longer the right CTA.
 */
function revealContinueButton(): void {
  const continueBtn = document.getElementById('cs-continue') as HTMLButtonElement | null;
  const skipBtn = document.getElementById('cs-skip') as HTMLButtonElement | null;
  if (continueBtn) continueBtn.style.display = 'block';
  if (skipBtn) skipBtn.style.display = 'none';
}
