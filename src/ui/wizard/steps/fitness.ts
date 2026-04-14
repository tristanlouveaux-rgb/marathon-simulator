import type { OnboardingState } from '@/types/onboarding';
import { nextStep, goToStep, updateOnboarding, getOnboardingState } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { isSimulatorMode } from '@/main';
import { getAccessToken, SUPABASE_FUNCTIONS_BASE, SUPABASE_ANON_KEY, isGarminConnected, isStravaConnected, resetGarminBackfillGuard } from '@/data/supabaseClient';
import { updateState } from '@/state/store';
import { saveState } from '@/state/persistence';

/** Cached Garmin connection status for this wizard session — null = not yet checked */
let _garminConnected: boolean | null = null;
/** Cached Strava connection status for this wizard session — null = not yet checked */
let _stravaConnected: boolean | null = null;

const CARD = 'background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:20px;margin-bottom:12px';

function selBtn(selected: boolean, accent?: string): string {
  if (selected && accent) {
    return `background:${accent};color:white;border:2px solid ${accent};border-radius:10px;padding:12px;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.15s;width:100%`;
  }
  return selected
    ? 'background:var(--c-black);color:#FDFCF7;border:2px solid var(--c-black);border-radius:10px;padding:12px;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.15s;width:100%'
    : 'background:var(--c-surface);color:var(--c-black);border:2px solid var(--c-border-strong);border-radius:10px;padding:12px;font-size:14px;cursor:pointer;transition:all 0.15s;width:100%';
}

/**
 * Fitness step: Connect Strava (required), then optional watch for sleep/recovery.
 */
export function renderFitness(container: HTMLElement, state: OnboardingState): void {
  const sim = isSimulatorMode();
  const stravaOk = sim || _stravaConnected === true;

  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(6, 7)}

      <div style="width:100%;max-width:480px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Connect Strava
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:24px">
          Mosaic uses Strava for heart rate data, training load, and plan calibration.
        </p>

        ${!sim ? `
        <!-- Strava connect (always shown, required) -->
        <div style="${CARD}">
          ${_stravaConnected === null ? `
            <div style="width:100%;padding:11px;background:var(--c-bg);color:var(--c-faint);border:1.5px solid var(--c-border);border-radius:10px;font-size:14px;text-align:center">
              Checking connection…
            </div>
          ` : _stravaConnected === true ? `
            <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:10px;margin-bottom:8px">
              <span style="color:var(--c-ok);font-size:16px">✓</span>
              <span style="font-size:14px;font-weight:500;color:var(--c-ok)">Strava connected</span>
            </div>
            <p style="font-size:12px;color:var(--c-muted)">Training history will be imported to personalise your plan.</p>
          ` : `
            <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">Strava provides the heart rate and activity data that powers your training plan. All watch brands (Garmin, Apple Watch, Polar, COROS, Suunto) sync to Strava.</p>
            <button id="btn-wizard-strava"
              style="width:100%;padding:11px;background:#FC4C02;color:white;border:none;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer">
              Connect Strava
            </button>
            <div id="wizard-strava-error" style="font-size:12px;color:var(--c-warn);margin-top:8px;display:none"></div>
          `}
        </div>
        ` : ''}

        <!-- Watch picker (shown after Strava connected) -->
        ${stravaOk ? `
        <div style="${CARD}">
          <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:4px">Sleep and recovery tracking</h3>
          <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">Do you wear a device that tracks sleep?</p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            <button id="watch-garmin" style="${selBtn(state.watchType === 'garmin')}">Garmin</button>
            <button id="watch-apple" style="${selBtn(state.watchType === 'apple')}">Apple Watch</button>
            <button id="watch-none" style="${selBtn(state.hasSmartwatch === false)}">No watch</button>
          </div>
        </div>

        <!-- Garmin connect -->
        ${state.watchType === 'garmin' ? `
        <div style="${CARD}">
          <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:8px">Connect Garmin for sleep and HRV</h3>
          ${_garminConnected === null ? `
            <div style="width:100%;padding:11px;background:var(--c-bg);color:var(--c-faint);border:1.5px solid var(--c-border);border-radius:10px;font-size:14px;text-align:center">
              Checking connection…
            </div>
          ` : _garminConnected === true ? `
            <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:10px;margin-bottom:8px">
              <span style="color:var(--c-ok);font-size:16px">✓</span>
              <span style="font-size:14px;font-weight:500;color:var(--c-ok)">Garmin connected</span>
            </div>
          ` : `
            <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">Garmin provides sleep stages, HRV, resting heart rate, and VO2max automatically.</p>
            <button id="btn-wizard-garmin"
              style="width:100%;padding:11px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer">
              Connect Garmin
            </button>
            <div id="wizard-garmin-error" style="font-size:12px;color:var(--c-warn);margin-top:8px;display:none"></div>
          `}
        </div>
        ` : ''}

        <!-- Apple Watch note -->
        ${state.watchType === 'apple' ? `
        <div style="${CARD}">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:36px;height:36px;border-radius:10px;background:var(--c-bg);border:1px solid var(--c-border);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <svg style="width:20px;height:20px;color:var(--c-muted)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </div>
            <div>
              <h3 style="font-size:14px;font-weight:500;color:var(--c-black)">Apple Watch syncs sleep, HRV, and recovery</h3>
              <p style="font-size:12px;color:var(--c-muted);margin-top:2px">Data syncs from HealthKit each time you open the app.</p>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- No watch note -->
        ${state.hasSmartwatch === false ? `
        <div style="${CARD}">
          <p style="font-size:12px;color:var(--c-muted);line-height:1.4">No problem. Strava handles your training load. You can log sleep manually each morning for recovery tracking, or connect a watch later in Settings.</p>
        </div>
        ` : ''}
        ` : ''}

        <button id="continue-fitness"
          style="margin-top:16px;width:100%;padding:14px 20px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;opacity:${stravaOk && (state.watchType || state.hasSmartwatch === false) ? '1' : '0.4'}"
          ${stravaOk && (state.watchType || state.hasSmartwatch === false) ? '' : 'disabled'}>
          Continue
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state);

  // Check Garmin connection status so we can show the right badge
  if (!sim && state.watchType === 'garmin' && _garminConnected === null) {
    isGarminConnected().then((connected) => {
      _garminConnected = connected;
      rerender();
    }).catch(() => {
      _garminConnected = false;
      rerender();
    });
  }

  // Always check Strava status (required for all users)
  if (!sim && _stravaConnected === null) {
    isStravaConnected().then((connected) => {
      _stravaConnected = connected;
      rerender();
    }).catch(() => {
      _stravaConnected = false;
      rerender();
    });
  }
}

function wireEventHandlers(state: OnboardingState): void {
  // Watch picker: Garmin (for sleep/recovery)
  document.getElementById('watch-garmin')?.addEventListener('click', () => {
    if (state.watchType !== 'garmin') _garminConnected = null;
    updateOnboarding({ hasSmartwatch: true, watchType: 'garmin' });
    updateState({ wearable: 'garmin', connectedSources: { physiology: 'garmin' } });
    saveState();
    rerender();
  });

  // Watch picker: Apple Watch (for sleep/recovery)
  document.getElementById('watch-apple')?.addEventListener('click', () => {
    updateOnboarding({ hasSmartwatch: true, watchType: 'apple' });
    updateState({ wearable: 'apple', connectedSources: { physiology: 'apple' } });
    saveState();
    rerender();
  });

  // Watch picker: No watch
  document.getElementById('watch-none')?.addEventListener('click', () => {
    updateOnboarding({ hasSmartwatch: false, watchType: undefined });
    updateState({ wearable: undefined, connectedSources: undefined });
    saveState();
    rerender();
  });

  // Connect Strava button (wizard) — saves step before redirect so we land on strava-history
  document.getElementById('btn-wizard-strava')?.addEventListener('click', async () => {
    const errorEl = document.getElementById('wizard-strava-error');
    try {
      updateOnboarding({ currentStep: 'strava-history' });
      saveState();
      const token = await getAccessToken();
      const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/strava-auth-start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (errorEl) { errorEl.textContent = `Failed to start Strava auth (${res.status}): ${text}`; errorEl.style.display = ''; }
        updateOnboarding({ currentStep: 'fitness' });
        saveState();
        return;
      }
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = `Strava auth error: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errorEl.style.display = '';
      }
      updateOnboarding({ currentStep: 'fitness' });
      saveState();
    }
  });

  // Continue → persist wearable choice and advance
  document.getElementById('continue-fitness')?.addEventListener('click', () => {
    const fresh = getOnboardingState();
    const wt = fresh?.watchType as 'garmin' | 'apple' | undefined;
    const physiology = wt === 'garmin' || wt === 'apple' ? wt : undefined;
    updateState({
      stravaConnected: _stravaConnected === true || isSimulatorMode(),
      wearable: wt ?? undefined,
      connectedSources: physiology ? { physiology } : undefined,
    });
    saveState();
    nextStep();
  });

  // Connect Garmin button (wizard)
  document.getElementById('btn-wizard-garmin')?.addEventListener('click', async () => {
    const errorEl = document.getElementById('wizard-garmin-error');
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
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (errorEl) { errorEl.textContent = `Failed to start Garmin auth (${res.status}): ${text}`; errorEl.style.display = ''; }
        return;
      }
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch (err) {
      if (err instanceof Error && err.message === 'SESSION_EXPIRED') {
        if (errorEl) { errorEl.textContent = 'Session expired — please sign in again'; errorEl.style.display = ''; }
      } else if (errorEl) {
        errorEl.textContent = `Garmin auth error: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errorEl.style.display = '';
      }
    }
  });
}

function rerender(): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderFitness(container, currentState);
    }
  });
}
