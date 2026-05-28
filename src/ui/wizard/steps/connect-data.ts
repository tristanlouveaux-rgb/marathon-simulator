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
 * Page 3. Show us where you're at.
 *
 * The job of this step is to seed Mosaic's model of the athlete: training history,
 * personal bests, recovery signals. The more the system sees here, the sharper the
 * plan and the race predictions. Auto-sync from Garmin and Strava is restricted
 * for our current API tier, so for shipped users this is a manual step:
 *
 *   Apple Watch (iOS app)  → HealthKit pulls workouts + sleep + HRV + resting HR
 *   Apple Watch (web)      → soft-push "install the iOS app for sleep" + upload fallback
 *   Anything else          → unified export panel (Strava .zip primary, Garmin .zip,
 *                            single .fit/.gpx/.tcx)
 *
 * We collapsed an earlier 3-tile picker (Apple / Garmin / Other) into 2 because
 * Garmin and Other routed to the same screen, which made the split read as
 * arbitrary. Now: Apple stands alone because it's the only path that delivers
 * physiology automatically; everything else funnels into the same upload screen.
 *
 * Continue is always visible. Before any upload it's a bordered "Continue without
 * uploading" with a one-line honest caption about consequence; after an upload or
 * HealthKit connect it morphs into the dark primary CTA. We removed the "Enter
 * manually" wording because users read it as a downgrade rather than a real choice.
 */
export function renderConnectData(container: HTMLElement, state: OnboardingState): void {
  const rawChoice = state.chosenWatch as 'apple' | 'other' | 'garmin' | undefined;
  // Legacy 'garmin' from the 3-tile picker → collapsed to 'other'.
  const initialChoice: 'apple' | 'other' | undefined =
    rawChoice === 'garmin' ? 'other' : rawChoice;

  container.innerHTML = `
    <style>
      @keyframes cdRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .cd-rise { opacity:0; animation: cdRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      /* Watch picker tiles — large tap targets, neutral fill, icon + label + sub */
      .cd-watch { width:100%; background:#FFFFFF; border:1px solid var(--c-border); border-radius:18px; padding:18px 18px; display:flex; align-items:center; gap:14px; cursor:pointer; text-align:left; transition: transform 0.12s ease, box-shadow 0.2s ease, border-color 0.2s ease; }
      .cd-watch:hover { border-color: var(--c-border-strong); }
      .cd-watch:active { transform: translateY(0.5px) scale(0.99); }
      .cd-watch-icon { flex:0 0 40px; width:40px; height:40px; border-radius:12px; background:#F1F5F9; color:var(--c-black); display:flex; align-items:center; justify-content:center; }
      .cd-watch-icon svg { width:22px; height:22px; stroke-width:1.5; }
      .cd-watch-text { flex:1; min-width:0; }
      .cd-watch-label { font-size:15px; font-weight:500; color:var(--c-black); line-height:1.2; margin:0; }
      .cd-watch-sub { font-size:12.5px; color:var(--c-faint); line-height:1.45; margin:3px 0 0; }
      .cd-watch-chev { flex:0 0 16px; color:var(--c-muted); }
      .cd-watch-chev svg { width:16px; height:16px; stroke-width:1.5; }

      /* Why-we-ask caption under the picker */
      .cd-why { font-size:12px; color:var(--c-faint); line-height:1.55; margin:14px 0 0; padding:0 4px; text-align:center; }

      /* History panel — shown after "Other" is picked, or after Apple-on-web fallback */
      .cd-history-card { width:100%; background:#FFFFFF; border-radius:20px; padding:18px 20px; display:flex; flex-direction:column; gap:14px; }
      .cd-history-row { display:flex; flex-direction:column; gap:6px; }
      .cd-history-label { font-size:14px; font-weight:500; color:var(--c-black); line-height:1.3; margin:0; }
      .cd-history-sub { font-size:12.5px; color:var(--c-faint); line-height:1.5; margin:0; }
      .cd-history-sub a { color:var(--c-black); text-decoration:underline; }
      .cd-history-divider { height:1px; background:var(--c-border); margin:4px 0; }

      /* Continue CTA — two visual modes:
         .pre  = bordered, no fill: pre-upload state, signals "you can go, but with less data"
         .post = dark fill: after an upload or HealthKit connect, signals "ready to go" */
      .cd-continue { width:100%; max-width:300px; height:48px; border-radius:24px; font-size:14px; font-weight:500; cursor:pointer; transition: transform 0.12s ease, box-shadow 0.2s ease, background 0.2s ease, color 0.2s ease; display:flex; align-items:center; justify-content:center; gap:6px; }
      .cd-continue.pre { background:transparent; color:var(--c-black); border:1px solid var(--c-border-strong); }
      .cd-continue.post { background:var(--c-black); color:#FFFFFF; border:none; box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.20), 0 9px 22px -8px rgba(0,0,0,0.30); }
      .cd-continue:active { transform: translateY(1px); }

      /* Continue caption — only shown in .pre state to set expectations honestly */
      .cd-continue-caption { font-size:11.5px; color:var(--c-faint); line-height:1.55; margin:8px 0 0; text-align:center; max-width:320px; }

      /* Upload buttons inside the history card */
      .cd-cta-primary { width:100%; height:48px; border-radius:24px; background:var(--c-black); color:#FFFFFF; border:none; font-size:14px; font-weight:500; cursor:pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.20), 0 9px 22px -8px rgba(0,0,0,0.30); transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .cd-cta-primary:active:not(:disabled) { transform: translateY(1px); }
      .cd-cta-primary:disabled { opacity:0.55; cursor:wait; }
      .cd-cta-secondary { width:100%; height:44px; border-radius:22px; background:transparent; color:var(--c-black); border:1px solid var(--c-border-strong); font-size:13.5px; font-weight:500; cursor:pointer; }
      .cd-cta-secondary:active { transform: translateY(0.5px); }

      /* Status dot (connected state) */
      .cd-status-dot { width:8px; height:8px; border-radius:50%; background:var(--c-ok); display:inline-block; margin-right:8px; vertical-align:middle; }

      /* Muted text link for inline fallbacks ("Different watch", inline "upload instead") */
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
            Show us where you're at
          </h2>
          <p id="cd-sub" style="font-size:13.5px;color:var(--c-faint);margin:0;line-height:1.5">
            Mosaic learns from your training history. The more we see, the sharper your plan and race predictions get.
          </p>
        </div>

        <!-- ─────────── Phase 1: watch picker (2 tiles) ─────────── -->
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
              <p class="cd-watch-sub">Sleep, HRV, resting HR, and runs sync through Apple Health. One tap.</p>
            </div>
            <div class="cd-watch-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          </button>

          <button class="cd-watch" data-watch="other">
            <div class="cd-watch-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 9v3l2 1"/>
              </svg>
            </div>
            <div class="cd-watch-text">
              <p class="cd-watch-label">Garmin, Coros, Polar, or other</p>
              <p class="cd-watch-sub">Garmin doesn't yet let us pull this automatically. Upload an export and we'll pull in your runs and heart rate.</p>
            </div>
            <div class="cd-watch-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          </button>

          <p class="cd-why">Heart rate calibrates your load. Sleep and HRV calibrate your recovery. Apple Health is the only path that delivers both automatically right now.</p>
        </div>

        <!-- ─────────── Phase 2: history panel (Other, or Apple-on-web fallback) ─────────── -->
        <div id="cd-history" class="cd-rise" style="width:100%;max-width:460px;margin-top:28px;flex-direction:column;gap:14px;animation-delay:0.12s">

          <div class="cd-history-card shadow-ap">
            <div class="cd-history-row">
              <p class="cd-history-label">Upload your Strava export</p>
              <p class="cd-history-sub">Best heart rate detail and route history. Request your archive at <a href="https://www.strava.com/athlete/delete_your_account" target="_blank" rel="noopener">strava.com → Settings → Download or Delete</a>. The email arrives in a few hours, sometimes a day.</p>
              <button id="cd-upload-strava" class="cd-cta-primary" style="margin-top:6px">Upload Strava .zip</button>
            </div>

            <div class="cd-history-divider"></div>

            <div class="cd-history-row">
              <p class="cd-history-label">Upload your Garmin export</p>
              <p class="cd-history-sub">If you don't use Strava. Request at <a href="https://www.garmin.com/account/datamanagement/" target="_blank" rel="noopener">garmin.com/account/datamanagement</a>. The export usually takes a few days to arrive by email.</p>
              <button id="cd-upload-garmin" class="cd-cta-secondary" style="margin-top:6px">Upload Garmin .zip</button>
            </div>

            <div class="cd-history-divider"></div>

            <div class="cd-history-row">
              <p class="cd-history-label">A single run</p>
              <p class="cd-history-sub">Got just one .fit, .gpx, or .tcx file? Drop it here and we'll start from that.</p>
              <button id="cd-upload-single" class="cd-cta-secondary" style="margin-top:6px">Upload single file</button>
            </div>
          </div>

          <p id="cd-history-status" class="cd-info"></p>

          <button id="cd-change-watch" class="cd-link" style="align-self:center">← Different watch</button>
        </div>

        <!-- ─────────── Apple Watch status (errors / non-iOS push) ─────────── -->
        <p id="cd-apple-error" class="cd-err" style="max-width:460px"></p>
        <p id="cd-apple-info" class="cd-info" style="max-width:460px"></p>

        <!-- ─────────── Footer: Continue (always visible) + caption ─────────── -->
        <div class="cd-rise" style="margin-top:26px;animation-delay:0.28s;display:flex;flex-direction:column;align-items:center;width:100%">
          <button id="cd-continue" class="cd-continue pre">Continue without uploading</button>
          <p id="cd-continue-caption" class="cd-continue-caption">Your plan will start from PBs only. Less accurate, but you can add data anytime from Account.</p>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers();

  // Re-enter at the phase the user last left, so back-button + OAuth-return
  // land them where they expect.
  if (initialChoice === 'apple') {
    // Apple already connected on a previous visit? Show picker (so they can switch)
    // and morph Continue into the post-success styling.
    if (hasPhysiologySource(getState() as any, 'apple')) {
      showPicker();
      markContinueReady('Apple Health connected. Workouts will sync after Continue.');
    } else {
      // Picked Apple before but didn't finish. Re-show picker so they can retry.
      showPicker();
    }
  } else if (initialChoice === 'other') {
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
  if (heading) heading.textContent = "Show us where you're at";
  if (sub) sub.textContent = 'Mosaic learns from your training history. The more we see, the sharper your plan and race predictions get.';
}

function showHistory(): void {
  const picker = document.getElementById('cd-picker');
  const history = document.getElementById('cd-history');
  const heading = document.getElementById('cd-heading');
  const sub = document.getElementById('cd-sub');
  if (picker) picker.style.display = 'none';
  if (history) history.style.display = 'flex';
  if (heading) heading.textContent = 'Build your training history';
  if (sub) sub.textContent = 'An export gives us your runs, heart rate, and routes. We use it to size your fitness and read your personal bests.';
}

function wireHandlers(): void {
  document.querySelectorAll<HTMLElement>('.cd-watch').forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.getAttribute('data-watch') as 'apple' | 'other';
      handleWatchChoice(choice);
    });
  });

  document.getElementById('cd-change-watch')?.addEventListener('click', () => {
    updateOnboarding({ chosenWatch: undefined });
    saveState();
    showPicker();
    resetContinueToPre();
  });

  document.getElementById('cd-upload-strava')?.addEventListener('click', () => openImporter());
  document.getElementById('cd-upload-garmin')?.addEventListener('click', () => openImporter());
  document.getElementById('cd-upload-single')?.addEventListener('click', () => openImporter());

  document.getElementById('cd-continue')?.addEventListener('click', () => {
    // skippedStrava drives whether the next step is manual-entry or about-you.
    // Apple-Watch path: we have physiology + activity history, but no Strava
    // best_efforts, so route through manual-entry to capture PBs by hand.
    // Import-archive path: same. Activities are in but PB derivation from raw
    // imports is a follow-up.
    // Continue-without-uploading path: also manual-entry.
    updateOnboarding({ skippedStrava: true });
    saveState();
    nextStep();
  });
}

function handleWatchChoice(choice: 'apple' | 'other'): void {
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

  // On web / Android the @capgo/capacitor-health bridge is a no-op. Push the iOS
  // install hard. Apple Health is the *only* path that delivers sleep + HRV +
  // resting HR automatically, so this is the moment to make that case. Then
  // offer a fallback to the export panel so the user isn't stuck.
  if (!isNativeiOS()) {
    if (infoEl) {
      infoEl.innerHTML =
        'Apple Health sync runs in the Mosaic iOS app. ' +
        "It's the only way we can pull your sleep, HRV, and resting heart rate automatically. " +
        'Open Mosaic on your iPhone to connect, or <button id="cd-apple-fallback" class="cd-link" style="display:inline;padding:0;font-size:12px">upload an export here</button> in the meantime.';
      infoEl.style.display = 'block';
    }
    document.getElementById('cd-apple-fallback')?.addEventListener('click', () => {
      updateOnboarding({ chosenWatch: 'other' });
      saveState();
      showHistory();
    });
    return;
  }

  // Already connected? Just flag Continue as ready.
  if (hasPhysiologySource(getState() as any, 'apple')) {
    markContinueReady('Apple Health connected. Workouts will sync after Continue.');
    return;
  }

  if (infoEl) {
    infoEl.textContent = 'Requesting Apple Health permissions…';
    infoEl.style.display = 'block';
  }

  const result = await connectAppleHealth();
  if (result.ok) {
    markContinueReady('Apple Health connected. Workouts will sync after Continue.');
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
      markContinueReady();
    },
  });
}

/**
 * Morph Continue from pre-action (bordered, with consequence caption) to post-action
 * (dark fill, no caption). Optionally inject a status line into the Apple-info area.
 */
function markContinueReady(appleStatusHtml?: string): void {
  const btn = document.getElementById('cd-continue') as HTMLButtonElement | null;
  const caption = document.getElementById('cd-continue-caption');
  if (btn) {
    btn.classList.remove('pre');
    btn.classList.add('post');
    btn.textContent = 'Continue →';
  }
  if (caption) caption.style.display = 'none';
  if (appleStatusHtml) {
    const infoEl = document.getElementById('cd-apple-info');
    if (infoEl) {
      infoEl.innerHTML = `<span class="cd-status-dot"></span>${appleStatusHtml}`;
      infoEl.style.display = 'block';
    }
  }
}

/**
 * Reset Continue back to the pre-action bordered+caption look. Called when the user
 * taps "Different watch" so they're not starting fresh with a green-lit Continue.
 */
function resetContinueToPre(): void {
  const btn = document.getElementById('cd-continue') as HTMLButtonElement | null;
  const caption = document.getElementById('cd-continue-caption');
  if (btn) {
    btn.classList.remove('post');
    btn.classList.add('pre');
    btn.textContent = 'Continue without uploading';
  }
  if (caption) caption.style.display = 'block';
}
