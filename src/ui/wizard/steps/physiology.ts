import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { isSimulatorMode } from '@/main';
import { getState } from '@/state/store';
import { isGarminConnected, isStravaConnected, getAccessToken, SUPABASE_FUNCTIONS_BASE, SUPABASE_ANON_KEY } from '@/data/supabaseClient';
import { syncPhysiologySnapshot } from '@/data/physiologySync';

/** Cached Strava connection status for this wizard session — null = not yet checked */
let _stravaConnectedPhysio: boolean | null = null;

const INPUT = 'background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black);border-radius:8px;padding:8px 12px;font-size:14px;outline:none;text-align:center;box-sizing:border-box';
const CARD = 'background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:20px;margin-bottom:12px';

function selBtn(selected: boolean): string {
  return selected
    ? 'background:var(--c-black);color:#FDFCF7;border:2px solid var(--c-black);border-radius:10px;padding:10px;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s;width:100%'
    : 'background:var(--c-surface);color:var(--c-black);border:2px solid var(--c-border-strong);border-radius:10px;padding:10px;font-size:13px;cursor:pointer;transition:all 0.15s;width:100%';
}

export function renderPhysiology(container: HTMLElement, state: OnboardingState): void {
  const hasGarmin = !isSimulatorMode() && state.watchType === 'garmin';
  const showStrava = !isSimulatorMode();

  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(7, 8)}

      <div style="width:100%;max-width:480px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Fitness Data
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:24px">
          Helps calibrate your training zones. All optional — skip if unsure.
        </p>

        <!-- Gender selector -->
        <div style="${CARD}">
          <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:4px">Gender <span style="font-size:12px;color:var(--c-faint)">(Optional)</span></h3>
          <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">Used to calibrate heart rate training load calculations</p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            <button id="sex-male" style="${selBtn(state.biologicalSex === 'male')}">Male</button>
            <button id="sex-female" style="${selBtn(state.biologicalSex === 'female')}">Female</button>
            <button id="sex-prefer-not" style="${selBtn(state.biologicalSex === 'prefer_not_to_say')};font-size:11px">Prefer not to say</button>
          </div>
        </div>

        ${hasGarmin ? `
        <div style="${CARD}">
          <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:4px">Import from Garmin</h3>
          <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">Pull your VO2 max, LT pace and heart rate data directly from your account.</p>
          <button id="btn-sync-garmin"
            style="width:100%;padding:11px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer">
            Sync from Garmin
          </button>
          <div id="sync-status" style="font-size:12px;text-align:center;margin-top:8px;display:none"></div>
        </div>
        ` : ''}

        <!-- LT Pace -->
        <div style="${CARD}">
          <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:4px">Lactate Threshold Pace <span style="font-size:12px;color:var(--c-faint)">(Optional)</span></h3>
          <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">Fastest pace you can sustain for ~1 hour</p>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="number" id="lt-min" min="2" max="10" placeholder="min"
              value="${state.ltPace ? Math.floor(((getState().unitPref ?? 'km') === 'mi' ? state.ltPace * 1.60934 : state.ltPace) / 60) : ''}"
              style="${INPUT};width:72px">
            <span style="color:var(--c-muted);font-size:16px">:</span>
            <input type="number" id="lt-sec" min="0" max="59" placeholder="sec"
              value="${state.ltPace ? Math.floor(((getState().unitPref ?? 'km') === 'mi' ? state.ltPace * 1.60934 : state.ltPace) % 60) : ''}"
              style="${INPUT};width:72px">
            <span style="font-size:13px;color:var(--c-muted)">${(getState().unitPref ?? 'km') === 'mi' ? '/mi' : '/km'}</span>
          </div>
        </div>

        <!-- VO2 Max -->
        <div style="${CARD}">
          <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:12px">VO2 Max <span style="font-size:12px;color:var(--c-faint)">(Optional)</span></h3>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="number" id="vo2-input" min="20" max="90" step="0.1" placeholder="e.g. 52"
              value="${state.vo2max || ''}"
              style="${INPUT};width:96px">
            <span style="font-size:13px;color:var(--c-muted)">ml/kg/min</span>
          </div>
        </div>

        <!-- Heart Rate -->
        <div style="${CARD}">
          <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:4px">Heart Rate <span style="font-size:12px;color:var(--c-faint)">(Optional)</span></h3>
          <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">For personalised HR training zones</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Resting HR</label>
              <div style="display:flex;align-items:center;gap:6px">
                <input type="number" id="resting-hr" min="30" max="100" placeholder="e.g. 52"
                  value="${state.restingHR || ''}"
                  style="${INPUT};flex:1">
                <span style="font-size:11px;color:var(--c-faint)">bpm</span>
              </div>
            </div>
            <div>
              <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Max HR</label>
              <div style="display:flex;align-items:center;gap:6px">
                <input type="number" id="max-hr" min="120" max="220" placeholder="e.g. 190"
                  value="${state.maxHR || ''}"
                  style="${INPUT};flex:1">
                <span style="font-size:11px;color:var(--c-faint)">bpm</span>
              </div>
            </div>
          </div>
        </div>

        ${showStrava ? `
        <!-- Strava connect -->
        <div style="${CARD}">
          <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:4px">Connect Strava <span style="font-size:12px;color:var(--c-faint)">(Optional)</span></h3>
          ${_stravaConnectedPhysio === null ? `
            <p style="font-size:12px;color:var(--c-faint)">Checking connection…</p>
          ` : _stravaConnectedPhysio === true ? `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 0">
              <span style="color:var(--c-ok);font-size:16px">✓</span>
              <span style="font-size:14px;font-weight:500;color:var(--c-ok)">Strava connected</span>
            </div>
            <p style="font-size:12px;color:var(--c-muted)">Enables accurate HR-based load calculation for cross-training activities.</p>
          ` : `
            <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">Enables accurate HR-based load calculation for cross-training (cycling, tennis, swimming etc.).</p>
            <button id="btn-physio-strava"
              style="width:100%;padding:11px;background:#FC4C02;color:white;border:none;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer">
              Connect Strava
            </button>
            <div id="physio-strava-error" style="font-size:12px;color:var(--c-warn);margin-top:8px;display:none"></div>
          `}
        </div>
        ` : ''}

        <button id="continue-physiology"
          style="margin-top:8px;width:100%;padding:14px 20px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
          Continue
        </button>
        <button id="skip-physiology"
          style="margin-top:10px;width:100%;padding:10px;font-size:14px;color:var(--c-faint);background:none;border:none;cursor:pointer">
          Skip for now
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers();

  // Check Strava connection status for all users
  if (showStrava && _stravaConnectedPhysio === null) {
    isStravaConnected().then((connected) => {
      _stravaConnectedPhysio = connected;
      rerender();
    }).catch(() => {
      _stravaConnectedPhysio = false;
      rerender();
    });
  }
}

async function triggerStravaAuth(errorElId: string): Promise<void> {
  const errorEl = document.getElementById(errorElId);
  try {
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
      if (errorEl) { errorEl.textContent = `Failed (${res.status})`; errorEl.style.display = ''; }
      return;
    }
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err instanceof Error ? err.message : 'Unknown error';
      errorEl.style.display = '';
    }
  }
}

function rerender(): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderPhysiology(container, currentState);
    }
  });
}

function wireEventHandlers(): void {
  // Gender selector
  document.getElementById('sex-male')?.addEventListener('click', () => { updateOnboarding({ biologicalSex: 'male' }); rerender(); });
  document.getElementById('sex-female')?.addEventListener('click', () => { updateOnboarding({ biologicalSex: 'female' }); rerender(); });
  document.getElementById('sex-prefer-not')?.addEventListener('click', () => { updateOnboarding({ biologicalSex: 'prefer_not_to_say' }); rerender(); });

  // Strava connect button
  document.getElementById('btn-physio-strava')?.addEventListener('click', () => triggerStravaAuth('physio-strava-error'));

  // Sync from Garmin button
  document.getElementById('btn-sync-garmin')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-garmin') as HTMLButtonElement;
    const statusEl = document.getElementById('sync-status');

    btn.disabled = true;
    btn.textContent = 'Syncing…';

    try {
      const connected = await isGarminConnected();
      if (!connected) {
        showStatus(statusEl, 'Garmin not linked — enter data manually or go back to connect', 'amber');
        btn.disabled = false;
        btn.textContent = 'Sync from Garmin';
        return;
      }

      (document.getElementById('lt-min') as HTMLInputElement).value = '';
      (document.getElementById('lt-sec') as HTMLInputElement).value = '';
      (document.getElementById('vo2-input') as HTMLInputElement).value = '';
      (document.getElementById('resting-hr') as HTMLInputElement).value = '';
      (document.getElementById('max-hr') as HTMLInputElement).value = '';

      const snap = await syncPhysiologySnapshot(1);
      let populated = 0;

      if (snap.ltPace) {
        // Display in user's unit (Garmin returns sec/km; convert to sec/mi if needed)
        const displayLT = (getState().unitPref ?? 'km') === 'mi' ? snap.ltPace * 1.60934 : snap.ltPace;
        (document.getElementById('lt-min') as HTMLInputElement).value = String(Math.floor(displayLT / 60));
        (document.getElementById('lt-sec') as HTMLInputElement).value = String(Math.floor(displayLT % 60));
        populated++;
      }
      if (snap.vo2) { (document.getElementById('vo2-input') as HTMLInputElement).value = String(Math.round(snap.vo2 * 10) / 10); populated++; }
      if (snap.restingHR) { (document.getElementById('resting-hr') as HTMLInputElement).value = String(snap.restingHR); populated++; }
      if (snap.maxHR) { (document.getElementById('max-hr') as HTMLInputElement).value = String(snap.maxHR); populated++; }

      if (populated > 0) {
        showStatus(statusEl, `Imported ${populated} value${populated > 1 ? 's' : ''} — review and adjust if needed`, 'green');
        btn.textContent = 'Sync again';
      } else {
        showStatus(statusEl, 'Nothing from Garmin yet — open Garmin Connect on your phone to force a sync, then try again.', 'blue');
        btn.textContent = 'Try again';
      }
      btn.disabled = false;
    } catch {
      showStatus(statusEl, 'Sync failed — enter data manually below', 'red');
      btn.disabled = false;
      btn.textContent = 'Sync from Garmin';
    }
  });

  // Continue
  document.getElementById('continue-physiology')?.addEventListener('click', () => { if (saveFields()) nextStep(); });

  // Skip
  document.getElementById('skip-physiology')?.addEventListener('click', () => { nextStep(); });

  // HR clamping on blur
  (['resting-hr', 'max-hr'] as const).forEach(id => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return;
    input.addEventListener('blur', () => {
      const val = +input.value;
      if (!val) return;
      if (id === 'resting-hr') { if (val < 30) input.value = '30'; if (val > 120) input.value = '120'; }
      else { if (val < 100) input.value = '100'; if (val > 240) input.value = '240'; }
    });
  });
}

function saveFields(): boolean {
  const ltMin = +(document.getElementById('lt-min') as HTMLInputElement)?.value || 0;
  const ltSec = +(document.getElementById('lt-sec') as HTMLInputElement)?.value || 0;
  const vo2 = +(document.getElementById('vo2-input') as HTMLInputElement)?.value || null;
  const ltPaceRaw = (ltMin > 0 || ltSec > 0) ? ltMin * 60 + ltSec : null;
  // Convert sec/mi → sec/km if user entered in miles
  const ltPace = ltPaceRaw != null && (getState().unitPref ?? 'km') === 'mi' ? ltPaceRaw / 1.60934 : ltPaceRaw;
  const restingHR = +(document.getElementById('resting-hr') as HTMLInputElement)?.value || null;
  const maxHR = +(document.getElementById('max-hr') as HTMLInputElement)?.value || null;

  if (restingHR !== null && (restingHR < 30 || restingHR > 120)) {
    alert('Please enter a sensible Resting HR (30–120 bpm)');
    return false;
  }
  if (maxHR !== null && (maxHR < 100 || maxHR > 240)) {
    alert('Please enter a sensible Max HR (100–240 bpm)');
    return false;
  }

  updateOnboarding({ ltPace, vo2max: vo2, restingHR, maxHR });
  return true;
}

function showStatus(el: HTMLElement | null, msg: string, colour: 'green' | 'amber' | 'red' | 'blue'): void {
  if (!el) return;
  const colours = { green: 'var(--c-ok)', amber: 'var(--c-caution)', red: 'var(--c-warn)', blue: 'var(--c-accent)' };
  el.textContent = msg;
  el.style.color = colours[colour];
  el.style.display = '';
}
