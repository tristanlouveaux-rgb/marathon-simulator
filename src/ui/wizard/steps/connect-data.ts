import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { saveState } from '@/state/persistence';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { isNativeiOS, connectAppleHealth } from '@/data/appleHealthSync';
import { getState } from '@/state/store';
import { hasPhysiologySource } from '@/data/sources';
import { openImportActivityModal } from '@/ui/import-activity-modal';

/**
 * Page 3 — Connect your data.
 *
 * Watch-first router. The user tells us which watch they wear; we route to the
 * data path that actually works for that watch:
 *
 *   Apple Watch  → auto-prompts HealthKit (full activity + physiology in one tap)
 *   Garmin       → "build training history" panel: Strava export (.zip) primary,
 *                  Garmin export (.zip) secondary, single .fit/.gpx/.tcx tertiary
 *   Other / none → same export panel (most non-Apple watches sync to Strava)
 *
 * Why no Strava OAuth button here: the Strava API tier we're on caps user count,
 * so OAuth is dev-only for shipped users. The export-archive path is the
 * universal fallback and works on web + iOS. Strava OAuth still works in the
 * Account view for whitelisted accounts.
 *
 * Why no Garmin OAuth button here: same story — Garmin OAuth is restricted to
 * one approved dev account, so for shipped users it's also export-only.
 *
 * On success (HealthKit connected, or any file import completes) the "Continue"
 * CTA appears. Manual-entry skip link sits at the bottom for users without any
 * activity history to upload — they enter PBs by hand at the next step.
 */
export function renderConnectData(container: HTMLElement, state: OnboardingState): void {
  const initialChoice = state.chosenWatch;

  container.innerHTML = `
    <style>
      @keyframes cdRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .cd-rise { opacity:0; animation: cdRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      /* Watch picker tiles — large tap targets, neutral fill, icon + label + sub */
      .cd-watch { width:100%; background:#FFFFFF; border:1px solid var(--c-border); border-radius:18px; padding:18px 18px; display:flex; align-items:center; gap:14px; cursor:pointer; text-align:left; transition: transform 0.12s ease, box-shadow 0.2s ease, border-color 0.2s ease; }
      .cd-watch:hover { border-color: var(--c-border-strong); }
      .cd-watch:active { transform: translateY(0.5px) scale(0.99); }
      .cd-watch-icon { flex:0 0 40px; width:40px; height:40px; border-radius:12px; background:rgba(0,0,0,0.04); color:var(--c-black); display:flex; align-items:center; justify-content:center; }
      .cd-watch-icon svg { width:22px; height:22px; stroke-width:1.5; }
      .cd-watch-text { flex:1; min-width:0; }
      .cd-watch-label { font-size:15px; font-weight:500; color:var(--c-black); line-height:1.2; margin:0; }
      .cd-watch-sub { font-size:12.5px; color:var(--c-faint); line-height:1.45; margin:3px 0 0; }
      .cd-watch-chev { flex:0 0 16px; color:var(--c-muted); }
      .cd-watch-chev svg { width:16px; height:16px; stroke-width:1.5; }

      /* History panel — shown after Garmin / Other is picked */
      .cd-history-card { width:100%; background:#FFFFFF; border-radius:20px; padding:18px 20px; display:flex; flex-direction:column; gap:14px; }
      .cd-history-row { display:flex; flex-direction:column; gap:6px; }
      .cd-history-label { font-size:14px; font-weight:500; color:var(--c-black); line-height:1.3; margin:0; }
      .cd-history-sub { font-size:12.5px; color:var(--c-faint); line-height:1.5; margin:0; }
      .cd-history-sub a { color:var(--c-black); text-decoration:underline; }
      .cd-history-divider { height:1px; background:var(--c-border); margin:4px 0; }

      /* Primary CTA (dark fill) and secondary CTA (bordered, no fill) */
      .cd-cta-primary { width:100%; height:48px; border-radius:24px; background:var(--c-black); color:#FFFFFF; border:none; font-size:14px; font-weight:500; cursor:pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.20), 0 9px 22px -8px rgba(0,0,0,0.30); transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .cd-cta-primary:active:not(:disabled) { transform: translateY(1px); }
      .cd-cta-primary:disabled { opacity:0.55; cursor:wait; }
      .cd-cta-secondary { width:100%; height:44px; border-radius:22px; background:transparent; color:var(--c-black); border:1px solid var(--c-border-strong); font-size:13.5px; font-weight:500; cursor:pointer; }
      .cd-cta-secondary:active { transform: translateY(0.5px); }

      /* Status dot (connected state) */
      .cd-status-dot { width:8px; height:8px; border-radius:50%; background:var(--c-ok); display:inline-block; margin-right:8px; vertical-align:middle; }

      /* Skip / change link — muted text */
      .cd-link { background:none; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; padding:10px 6px; text-decoration:underline; }
      .cd-link:active { color:var(--c-black); }

      .cd-err { font-size:12px; color:var(--c-danger, #B91C1C); margin:8px 0 0; text-align:center; display:none; }
      .cd-info { font-size:12px; color:var(--c-muted); margin:8px 0 0; text-align:center; display:none; }

      /* Phase visibility — JS toggles which one shows */
      #cd-picker, #cd-history { display:none; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <!-- Background layers: cool-blue atmosphere → asymmetric (right) rings → sun glint -->
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('cd', { variant: 'asymmetric', side: 'right' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(3, 8)}

        <div class="cd-rise" style="width:100%;max-width:460px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 id="cd-heading" style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 10px;line-height:1.15">
            Which watch do you wear?
          </h2>
          <p id="cd-sub" style="font-size:13.5px;color:var(--c-faint);margin:0;line-height:1.5">
            How you track shapes what we can pull in. Pick one to start.
          </p>
        </div>

        <!-- ─────────── Phase 1: watch picker ─────────── -->
        <div id="cd-picker" class="cd-rise" style="width:100%;max-width:460px;margin-top:28px;flex-direction:column;gap:10px;animation-delay:0.12s">

          <button class="cd-watch" data-watch="apple">
            <div class="cd-watch-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
                <path d="M9 3h6"/><path d="M9 21h6"/>
                <circle cx="12" cy="12" r="2.5"/>
              </svg>
            </div>
            <div class="cd-watch-text">
              <p class="cd-watch-label">Apple Watch</p>
              <p class="cd-watch-sub">Sleep, HRV, resting HR, and run history sync through Apple Health.</p>
            </div>
            <div class="cd-watch-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          </button>

          <button class="cd-watch" data-watch="garmin">
            <div class="cd-watch-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="7"/>
                <path d="M12 9v3l2 1"/>
                <path d="M9 3h6"/><path d="M9 21h6"/>
              </svg>
            </div>
            <div class="cd-watch-text">
              <p class="cd-watch-label">Garmin</p>
              <p class="cd-watch-sub">We'll import your training history from a Strava or Garmin export.</p>
            </div>
            <div class="cd-watch-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          </button>

          <button class="cd-watch" data-watch="other">
            <div class="cd-watch-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"/>
                <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>
              </svg>
            </div>
            <div class="cd-watch-text">
              <p class="cd-watch-label">Other watch, or none</p>
              <p class="cd-watch-sub">Coros, Polar, Suunto, phone GPS. We'll work with whatever history you can give us.</p>
            </div>
            <div class="cd-watch-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          </button>
        </div>

        <!-- ─────────── Phase 2: history panel (Garmin / Other) ─────────── -->
        <div id="cd-history" class="cd-rise" style="width:100%;max-width:460px;margin-top:28px;flex-direction:column;gap:14px;animation-delay:0.12s">

          <div class="cd-history-card shadow-ap">
            <div class="cd-history-row">
              <p class="cd-history-label">Upload your Strava export</p>
              <p class="cd-history-sub">Best heart rate data and route detail. Request your archive at <a href="https://www.strava.com/athlete/delete_your_account" target="_blank" rel="noopener">strava.com → Settings → Download or Delete</a>. The export takes a few days to arrive by email.</p>
              <button id="cd-upload-strava" class="cd-cta-primary" style="margin-top:6px">Upload Strava .zip</button>
            </div>

            <div class="cd-history-divider"></div>

            <div class="cd-history-row">
              <p class="cd-history-label">Upload your Garmin export</p>
              <p class="cd-history-sub">If you don't use Strava. Request at <a href="https://www.garmin.com/account/datamanagement/" target="_blank" rel="noopener">garmin.com/account/datamanagement</a>. The export takes a few days to arrive by email.</p>
              <button id="cd-upload-garmin" class="cd-cta-secondary" style="margin-top:6px">Upload Garmin .zip</button>
            </div>

            <div class="cd-history-divider"></div>

            <div class="cd-history-row">
              <p class="cd-history-label">Have a single activity file?</p>
              <p class="cd-history-sub">Open a run on connect.garmin.com or strava.com, choose Export Original, and upload the .fit, .gpx, or .tcx file here.</p>
              <button id="cd-upload-single" class="cd-cta-secondary" style="margin-top:6px">Upload single file</button>
            </div>
          </div>

          <p id="cd-history-status" class="cd-info"></p>

          <button id="cd-change-watch" class="cd-link" style="align-self:center">← Different watch</button>
        </div>

        <!-- ─────────── Apple Watch status (errors / non-iOS notice) ─────────── -->
        <p id="cd-apple-error" class="cd-err" style="max-width:460px"></p>
        <p id="cd-apple-info" class="cd-info" style="max-width:460px"></p>

        <!-- ─────────── Footer: Continue + skip ─────────── -->
        <div class="cd-rise" style="margin-top:22px;animation-delay:0.28s;display:flex;flex-direction:column;align-items:center;gap:6px">
          <button id="cd-continue" class="cd-link" style="display:none;color:var(--c-black);font-weight:500">Continue →</button>
          <button id="cd-skip" class="cd-link">Enter manually</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers();

  // Re-enter at the phase the user last left, so back-button + OAuth-return
  // land them where they expect.
  if (initialChoice === 'apple') {
    // Apple already connected on a previous visit? Show continue inline; don't
    // re-prompt HealthKit (would re-show the iOS permission sheet).
    if (hasPhysiologySource(getState() as any, 'apple')) {
      showPicker(); // keep picker visible so user can change choice
      revealContinue();
    } else {
      // Picked Apple before but didn't finish — re-show picker so they can retry.
      showPicker();
    }
  } else if (initialChoice === 'garmin' || initialChoice === 'other') {
    showHistory();
  } else {
    showPicker();
  }
}

function showPicker(): void {
  const picker = document.getElementById('cd-picker');
  const history = document.getElementById('cd-history');
  const heading = document.getElementById('cd-heading');
  const sub = document.getElementById('cd-sub');
  if (picker) picker.style.display = 'flex';
  if (history) history.style.display = 'none';
  if (heading) heading.textContent = 'Which watch do you wear?';
  if (sub) sub.textContent = 'How you track shapes what we can pull in. Pick one to start.';
}

function showHistory(): void {
  const picker = document.getElementById('cd-picker');
  const history = document.getElementById('cd-history');
  const heading = document.getElementById('cd-heading');
  const sub = document.getElementById('cd-sub');
  if (picker) picker.style.display = 'none';
  if (history) history.style.display = 'flex';
  if (heading) heading.textContent = 'Build your training history';
  if (sub) sub.textContent = 'Upload an export from your activity app. We use it to seed your fitness and personal bests.';
}

function wireHandlers(): void {
  document.querySelectorAll<HTMLElement>('.cd-watch').forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.getAttribute('data-watch') as 'apple' | 'garmin' | 'other';
      handleWatchChoice(choice);
    });
  });

  document.getElementById('cd-change-watch')?.addEventListener('click', () => {
    updateOnboarding({ chosenWatch: undefined });
    saveState();
    showPicker();
    const continueBtn = document.getElementById('cd-continue') as HTMLButtonElement | null;
    if (continueBtn) continueBtn.style.display = 'none';
  });

  document.getElementById('cd-upload-strava')?.addEventListener('click', () => openImporter());
  document.getElementById('cd-upload-garmin')?.addEventListener('click', () => openImporter());
  document.getElementById('cd-upload-single')?.addEventListener('click', () => openImporter());

  document.getElementById('cd-continue')?.addEventListener('click', () => {
    // skippedStrava drives whether the next step is manual-entry or about-you.
    // Apple-Watch path: we have physiology + activity history, but no Strava
    // best_efforts, so route through manual-entry to capture PBs by hand.
    // Import-archive path: same — activities are in but PB derivation from raw
    // imports is a follow-up. For now both lead to manual-entry.
    updateOnboarding({ skippedStrava: true });
    saveState();
    nextStep();
  });

  document.getElementById('cd-skip')?.addEventListener('click', () => {
    updateOnboarding({ skippedStrava: true });
    saveState();
    nextStep();
  });
}

function handleWatchChoice(choice: 'apple' | 'garmin' | 'other'): void {
  updateOnboarding({ chosenWatch: choice, currentStep: 'connect-data' });
  saveState();

  if (choice === 'apple') {
    triggerAppleHealth();
  } else {
    showHistory();
  }
}

async function triggerAppleHealth(): Promise<void> {
  const errEl = document.getElementById('cd-apple-error');
  const infoEl = document.getElementById('cd-apple-info');
  if (errEl) errEl.style.display = 'none';
  if (infoEl) infoEl.style.display = 'none';

  // On web / Android the @capgo/capacitor-health bridge is a no-op. Tell the
  // user the option exists in the iOS app and let them fall through to the
  // export panel — the watch-picker stays visible so they can switch.
  if (!isNativeiOS()) {
    if (infoEl) {
      infoEl.innerHTML = 'Apple Health sync only works in the Mosaic iOS app. <button id="cd-apple-fallback" class="cd-link" style="display:inline;padding:0;font-size:12px">Upload an export instead →</button>';
      infoEl.style.display = 'block';
    }
    document.getElementById('cd-apple-fallback')?.addEventListener('click', () => {
      updateOnboarding({ chosenWatch: 'other' });
      saveState();
      showHistory();
    });
    return;
  }

  // Already connected? Just reveal Continue.
  if (hasPhysiologySource(getState() as any, 'apple')) {
    if (infoEl) {
      infoEl.innerHTML = '<span class="cd-status-dot"></span>Apple Health connected. Workouts will sync after Continue.';
      infoEl.style.display = 'block';
    }
    revealContinue();
    return;
  }

  if (infoEl) {
    infoEl.textContent = 'Requesting Apple Health permissions…';
    infoEl.style.display = 'block';
  }

  const result = await connectAppleHealth();
  if (result.ok) {
    if (infoEl) {
      infoEl.innerHTML = '<span class="cd-status-dot"></span>Apple Health connected. Workouts will sync after Continue.';
      infoEl.style.display = 'block';
    }
    revealContinue();
  } else {
    if (infoEl) infoEl.style.display = 'none';
    if (errEl) {
      errEl.textContent = result.reason === 'permission-denied'
        ? 'Permissions not granted. Open Settings → Privacy → Health → Mosaic to allow access.'
        : `Apple Health connection failed (${result.reason}).`;
      errEl.style.display = 'block';
    }
  }
}

function openImporter(): void {
  openImportActivityModal({
    onComplete: () => {
      const statusEl = document.getElementById('cd-history-status');
      if (statusEl) {
        statusEl.innerHTML = '<span class="cd-status-dot"></span>Import complete. You can upload more, or continue.';
        statusEl.style.display = 'block';
      }
      revealContinue();
    },
  });
}

function revealContinue(): void {
  const continueBtn = document.getElementById('cd-continue') as HTMLButtonElement | null;
  const skipBtn = document.getElementById('cd-skip') as HTMLButtonElement | null;
  if (continueBtn) continueBtn.style.display = 'block';
  if (skipBtn) skipBtn.style.display = 'none';
}
