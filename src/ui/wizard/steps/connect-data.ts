import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { maybeOfferAccountSave } from '../save-account-overlay';
import { saveState } from '@/state/persistence';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { isNativeiOS, connectAppleHealth } from '@/data/appleHealthSync';
import { getState, updateState } from '@/state/store';
import { hasPhysiologySource } from '@/data/sources';
import { openImportActivityModal } from '@/ui/import-activity-modal';
import { isValidAccessCode, isReviewerCode } from '@/constants/access-codes';
import { connectWithStravaButton } from '@/ui/strava-brand';
import { startStravaConnect } from '@/data/stravaSync';
import { startGarminConnect } from '@/data/garminOAuth';
import { GARMIN_CONNECT_ENABLED } from '@/constants/feature-flags';

/**
 * Page 3. Show us where you're at.
 *
 * Seeds Mosaic's model of the athlete: training history, personal bests, recovery
 * signals. Two real choices, plus an always-available manual floor:
 *
 *   Apple Watch / Apple Health (iOS)  → HealthKit pulls workouts + sleep + HRV +
 *                                       resting HR automatically, AND derives PBs
 *                                       from the synced run history (no typing).
 *   Apple Watch / Apple Health (web)  → loud "open the iOS app" card + upload fallback.
 *   Garmin                            → access code → live Strava connect (the beta
 *                                       pipe, capped at 10 athletes), else manual upload.
 *
 * Garmin's own API is closed to us and the Garmin->Apple Health bridge drops splits,
 * so Strava is the quality pipe for Garmin users. It's gated behind a beta access code
 * (constants/access-codes.ts) so public users don't burn the 10 Standard-Tier slots.
 *
 * Continue is always visible. Before any connect/upload it's a bordered "Continue
 * without uploading" with an honest caption; after a HealthKit connect, Strava connect,
 * or upload it morphs into the dark primary CTA. Connected users skip the manual-entry
 * step (PBs are derived and stay editable on the post-plan reveal); only no-data users
 * are routed to manual PB entry.
 */

/** Module flag: did the user complete a file import this visit? Feeds the Continue routing. */
let didUpload = false;
/** Did the user already tap Continue once with no data source? Arms the deliberate skip. */
let skipArmed = false;

export function renderConnectData(container: HTMLElement, state: OnboardingState): void {
  // Post-OAuth resume: a live connect (Strava or Garmin) bounced the browser back with
  // ?strava=connected / ?garmin=connected. initWizard() (and therefore this render) runs
  // in main.ts BEFORE the OAuth handler strips that query string, so the live URL is a
  // reliable, ONE-TIME signal — present only on the immediate post-OAuth reload. Auto-advance
  // past this step; data lands in the background and on the post-plan reveal.
  const returnedFrom = (() => {
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.get('strava') === 'connected') return 'strava';
      if (p.get('garmin') === 'connected') return 'garmin';
    } catch { /* no-op */ }
    return null;
  })();
  if (returnedFrom) {
    updateOnboarding({ skippedStrava: false });
    if (returnedFrom === 'strava') {
      updateState({ stravaConnected: true });
      updateOnboarding({ stravaUnlocked: true, chosenWatch: 'other' });
      saveState();
      // "Connect both": Strava covers runs, splits, and PBs but not recovery. On iPhone,
      // Apple Health is the recovery pipe a Garmin user still wants, so land back on this
      // step with Strava marked connected and Apple Health nudged, rather than auto-advancing.
      // Advance only when nothing more is addable here: on web (HealthKit can't run in a
      // browser), when Apple Health is already connected, or when direct Garmin is enabled
      // (the recovery card is "Connect Garmin", a separate pairing we don't auto-nudge).
      const appleConnected =
        hasPhysiologySource(getState() as any, 'apple') || !!(getState() as any).appleHealthConnected;
      if (!isNativeiOS() || appleConnected || GARMIN_CONNECT_ENABLED) {
        // Data now syncing → the one moment the anonymous account is worth
        // saving (ISSUE-270). Overlay no-ops for non-anonymous sessions.
        maybeOfferAccountSave(() => nextStep());
        return;
      }
      // Fall through to the normal render; main.ts strips the ?strava query after this pass.
      // Offer the account save on top of the rendered step (no navigation on close).
      setTimeout(() => maybeOfferAccountSave(() => {}), 0);
    } else {
      // Garmin direct connect (?garmin=connected) provides runs + recovery in one — main.ts's
      // handler set the physiology source, so nothing is left to pair. Advance.
      saveState();
      maybeOfferAccountSave(() => nextStep());
      return;
    }
  }

  didUpload = false;
  skipArmed = false;

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

      /* History panel — shown after "Garmin" is picked, or after Apple-on-web fallback */
      .cd-history-card { width:100%; background:#FFFFFF; border-radius:20px; padding:18px 20px; display:flex; flex-direction:column; gap:14px; }
      .cd-history-row { display:flex; flex-direction:column; gap:6px; }
      .cd-history-label { font-size:14px; font-weight:500; color:var(--c-black); line-height:1.3; margin:0; }
      .cd-history-sub { font-size:12.5px; color:var(--c-faint); line-height:1.5; margin:0; }
      .cd-history-sub a { color:var(--c-black); text-decoration:underline; }
      .cd-history-divider { height:1px; background:var(--c-border); margin:4px 0; }

      /* Access-code input row */
      .cd-code-row { display:flex; gap:8px; margin-top:6px; }
      .cd-code-input { flex:1; min-width:0; height:44px; border-radius:12px; border:1px solid var(--c-border-strong); background:#FFFFFF; padding:0 14px; font-size:14px; color:var(--c-black); }
      .cd-code-input:focus { outline:none; border-color:var(--c-black); }

      /* Continue CTA — two visual modes:
         .pre  = bordered, no fill: pre-connect state, signals "you can go, but with less data"
         .post = dark fill: after a connect or upload, signals "ready to go" */
      .cd-continue { width:100%; max-width:300px; height:48px; border-radius:24px; font-size:14px; font-weight:500; cursor:pointer; transition: transform 0.12s ease, box-shadow 0.2s ease, background 0.2s ease, color 0.2s ease; display:flex; align-items:center; justify-content:center; gap:6px; }
      .cd-continue.pre { background:transparent; color:var(--c-muted); border:none; box-shadow:none; text-decoration:underline; font-weight:500; }
      .cd-continue.pre:hover { color:var(--c-black); }
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
      .cd-cta-secondary:disabled { opacity:0.55; cursor:wait; }

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
              <p class="cd-watch-label">Apple Watch / Apple Health</p>
              <p class="cd-watch-sub">Runs, sleep, HRV, and resting heart rate sync automatically. We even find your PBs from your run history. One tap.</p>
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
              <p class="cd-watch-label">Garmin</p>
              <p class="cd-watch-sub">${GARMIN_CONNECT_ENABLED
                ? 'Connect Garmin for your runs, sleep, HRV, and resting heart rate.'
                : 'On iPhone, your Garmin sleep and heart rate come in through Apple Health. For run splits, connect Strava or upload an export.'}</p>
            </div>
            <div class="cd-watch-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
          </button>

          <p class="cd-why">Heart rate calibrates your load. Sleep and HRV calibrate your recovery. Apple Health is the only path that delivers both automatically right now.</p>

          <!-- Apple-on-web fallback: loud card (shown when Apple is tapped on a non-iOS device) -->
          <div id="cd-apple-web" class="cd-history-card shadow-ap" style="display:none;text-align:left;margin-top:16px">
            <div class="cd-history-row">
              <p class="cd-history-label">Apple Health needs the iPhone app</p>
              <p class="cd-history-sub">Apple Watch syncs through Apple Health, which only works in the Mosaic iOS app. Open Mosaic on your iPhone to connect your watch and we'll pull everything automatically. Testing on a computer? Upload an export instead.</p>
              <button id="cd-apple-web-upload" class="cd-cta-secondary" style="margin-top:6px">Upload an export</button>
            </div>
          </div>
        </div>

        <!-- ─────────── Phase 2: Garmin → Strava (access code) + history upload ─────────── -->
        <div id="cd-history" class="cd-rise" style="width:100%;max-width:460px;margin-top:28px;flex-direction:column;gap:14px;animation-delay:0.12s">

          ${GARMIN_CONNECT_ENABLED ? `
          <!-- Connect Garmin directly. Gated behind GARMIN_CONNECT_ENABLED: built and
               ready, hidden until Garmin's webhook is approved for production. -->
          <div class="cd-history-card shadow-ap">
            <div class="cd-history-row">
              <p class="cd-history-label">Connect Garmin</p>
              <p class="cd-history-sub">Pull your runs, sleep, HRV, and resting heart rate straight from Garmin. Per-km run splits still come from Strava.</p>
              <button id="cd-connect-garmin" class="cd-cta-primary" style="margin-top:6px">Connect Garmin</button>
              <p id="cd-garmin-err" class="cd-err" style="text-align:left"></p>
            </div>
          </div>
          ` : `
          <!-- While direct Garmin is gated off, Apple Health is the recovery pipe for Garmin
               users: sleep, HRV, and resting HR flow through HealthKit on iPhone. Real one-tap
               button — prompts HealthKit on iOS, points at the iPhone app on web (upload is in
               the card below). Mirrors the GARMIN_CONNECT_ENABLED "Connect Garmin" card above. -->
          <div class="cd-history-card shadow-ap">
            <div class="cd-history-row">
              <p class="cd-history-label">Connect Apple Health</p>
              <p class="cd-history-sub">On iPhone, your Garmin sleep, HRV, and resting heart rate flow through Apple Health. Connect it for your recovery signals. Strava below adds your per-km run splits.</p>
              <button id="cd-connect-apple-health" class="cd-cta-primary" style="margin-top:6px">Connect Apple Health</button>
              <p id="cd-apple-done" class="cd-history-sub" style="display:none;margin-top:8px"></p>
            </div>
          </div>
          `}

          <!-- Connect through Strava (the beta pipe for Garmin users) -->
          <div class="cd-history-card shadow-ap">
            <div class="cd-history-row">
              <p class="cd-history-label">Connect through Strava</p>
              <p class="cd-history-sub">The best path for Garmin: we pull your runs, heart rate, and PBs automatically. Enter your beta access code to connect.</p>

              <div id="cd-code-wrap">
                <div class="cd-code-row">
                  <input id="cd-access-code" class="cd-code-input" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Access code" />
                  <button id="cd-code-submit" class="cd-cta-secondary" style="width:auto;padding:0 18px">Unlock</button>
                </div>
                <p id="cd-code-err" class="cd-err" style="text-align:left"></p>
              </div>

              <div id="cd-strava-wrap" style="display:none;margin-top:4px">
                ${connectWithStravaButton('cd-connect-strava', 44)}
                <p id="cd-strava-err" class="cd-err" style="text-align:left"></p>
              </div>
              <p id="cd-strava-done" class="cd-history-sub" style="display:none;margin-top:8px"></p>
            </div>
          </div>

          <!-- Manual upload (no code, or no Strava). Hidden once Strava connects — the live
               connection already carries the full history, so manual upload is redundant. -->
          <div id="cd-upload-card" class="cd-history-card shadow-ap">
            <div class="cd-history-row">
              <p class="cd-history-label">Or upload your history</p>
              <p class="cd-history-sub">No code? Export from Strava (<a href="https://www.strava.com/athlete/delete_your_account" target="_blank" rel="noopener">Settings → Download or Delete</a>) or Garmin (<a href="https://www.garmin.com/account/datamanagement/" target="_blank" rel="noopener">garmin.com/account/datamanagement</a>) and upload the .zip. The email takes a few hours to a few days.</p>
              <button id="cd-upload-strava" class="cd-cta-secondary" style="margin-top:6px">Upload Strava .zip</button>
              <button id="cd-upload-garmin" class="cd-cta-secondary">Upload Garmin .zip</button>
            </div>

            <div class="cd-history-divider"></div>

            <div class="cd-history-row">
              <p class="cd-history-label">A single run</p>
              <p class="cd-history-sub">Got just one .fit, .gpx, or .tcx file? Drop it here and we'll start from that.</p>
              <button id="cd-upload-single" class="cd-cta-secondary" style="margin-top:6px">Upload single file</button>
            </div>
          </div>

          <p id="cd-history-status" class="cd-info"></p>

          <button id="cd-change-watch" class="cd-link" style="align-self:center">← Back</button>
        </div>

        <!-- ─────────── Apple Watch status (errors / iOS permission flow) ─────────── -->
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

  // Re-enter at the phase the user last left, so back-button + OAuth-return land
  // them where they expect.
  if (initialChoice === 'apple') {
    showPicker();
    if (hasPhysiologySource(getState() as any, 'apple')) {
      markContinueReady('Apple Health connected. Workouts will sync after Continue.');
    }
  } else if (initialChoice === 'other') {
    showHistory(); // reflects connected sources + nudges the other via refreshHistoryConnectedState
    // Unlocked a code but not yet connected? Reveal the connect button. (revealStravaConnect
    // is a no-op once Strava is connected — the card then shows its done line instead.)
    if (state.stravaUnlocked) revealStravaConnect();
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
  if (sub) {
    // The two cards carry complementary data, so a Garmin user wants both: Apple Health for
    // recovery (sleep/HRV/resting HR), Strava for runs, splits, and PBs. Frame it that way.
    // When direct Garmin is enabled the recovery card is "Connect Garmin" instead, so the
    // "connect both" framing only applies while GARMIN_CONNECT_ENABLED is off.
    sub.textContent = GARMIN_CONNECT_ENABLED
      ? 'Connect Garmin for your runs and recovery, or Strava for per-km splits. Upload an export if you prefer.'
      : 'Two sources, both worth connecting: Apple Health for recovery, Strava for your runs and PBs. No Strava code? Upload an export below.';
  }
  refreshHistoryConnectedState();
}

/**
 * "Connect both" hub: reflect which sources are connected and nudge the other. Apple Health
 * (recovery: sleep/HRV/resting HR) and Strava (runs/splits/PBs) are complementary for Garmin
 * users, so once one connects we mark it done and point at the other. Continue goes ready as
 * soon as either lands. Safe to call on any phase — guarded getElementById no-ops when the
 * cards aren't present (e.g. picker phase, or the GARMIN_CONNECT_ENABLED Garmin card).
 */
function refreshHistoryConnectedState(): void {
  const s = getState() as any;
  const appleConnected = hasPhysiologySource(s, 'apple') || !!s.appleHealthConnected;
  const stravaConnected = !!s.stravaConnected;

  // Apple Health card → connected line, button hidden. (Only exists while GARMIN_CONNECT_ENABLED is off.)
  if (appleConnected) {
    const appleBtn = document.getElementById('cd-connect-apple-health');
    const appleDone = document.getElementById('cd-apple-done');
    if (appleBtn) appleBtn.style.display = 'none';
    if (appleDone) {
      const nudge = stravaConnected ? '' : ' Add Strava below for your run splits and PBs.';
      appleDone.innerHTML = `<span class="cd-status-dot"></span>Apple Health connected. Recovery signals will sync.${nudge}`;
      appleDone.style.display = 'block';
    }
  }

  // Strava card → connected line, code input + connect button hidden. The live Strava
  // connection already carries the full run history, so hide the manual upload card too.
  if (stravaConnected) {
    const codeWrap = document.getElementById('cd-code-wrap');
    const stravaWrap = document.getElementById('cd-strava-wrap');
    const stravaDone = document.getElementById('cd-strava-done');
    const uploadCard = document.getElementById('cd-upload-card');
    if (codeWrap) codeWrap.style.display = 'none';
    if (stravaWrap) stravaWrap.style.display = 'none';
    if (uploadCard) uploadCard.style.display = 'none';
    if (stravaDone) {
      // Only nudge Apple Health when its card is actually present (GARMIN_CONNECT_ENABLED off).
      const nudge = (!appleConnected && !GARMIN_CONNECT_ENABLED)
        ? ' Add Apple Health above for your recovery signals.'
        : '';
      stravaDone.innerHTML = `<span class="cd-status-dot"></span>Strava connected. Runs and PBs are syncing.${nudge}`;
      stravaDone.style.display = 'block';
    }
  }

  if (appleConnected || stravaConnected) markContinueReady();
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

  // Apple-on-web fallback → jump to the upload panel.
  document.getElementById('cd-apple-web-upload')?.addEventListener('click', () => {
    updateOnboarding({ chosenWatch: 'other' });
    saveState();
    showHistory();
  });

  // Access code → reveal Strava connect.
  const submitCode = () => {
    const input = document.getElementById('cd-access-code') as HTMLInputElement | null;
    const err = document.getElementById('cd-code-err');
    if (!input) return;
    if (isReviewerCode(input.value)) {
      // App Store reviewer: seed a complete sample account and jump into the app.
      import('@/state/demo-data').then(({ seedReviewerDemo }) => {
        if (seedReviewerDemo()) window.location.reload();
      });
      return;
    }
    if (isValidAccessCode(input.value)) {
      updateOnboarding({ stravaUnlocked: true });
      saveState();
      if (err) err.style.display = 'none';
      revealStravaConnect();
    } else {
      if (err) { err.textContent = "That code isn't recognised. Check it, or upload an export below."; err.style.display = 'block'; }
    }
  };
  document.getElementById('cd-code-submit')?.addEventListener('click', submitCode);
  document.getElementById('cd-access-code')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); submitCode(); }
  });

  // Live Strava connect (redirects out to Strava OAuth, returns via main.ts).
  document.getElementById('cd-connect-strava')?.addEventListener('click', async () => {
    const btn = document.getElementById('cd-connect-strava') as HTMLButtonElement | null;
    const err = document.getElementById('cd-strava-err');
    if (err) err.style.display = 'none';
    try {
      if (btn) btn.style.pointerEvents = 'none';
      await startStravaConnect();
    } catch {
      if (btn) btn.style.pointerEvents = 'auto';
      if (err) { err.textContent = 'Could not start Strava connect. Try again in a moment.'; err.style.display = 'block'; }
    }
  });

  // Live Garmin connect (gated behind GARMIN_CONNECT_ENABLED — the button only renders
  // when the flag is on; this handler is a no-op otherwise since the element is absent).
  document.getElementById('cd-connect-garmin')?.addEventListener('click', async () => {
    const btn = document.getElementById('cd-connect-garmin') as HTMLButtonElement | null;
    const err = document.getElementById('cd-garmin-err');
    if (err) err.style.display = 'none';
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
      await startGarminConnect();
    } catch {
      if (btn) { btn.disabled = false; btn.textContent = 'Connect Garmin'; }
      if (err) { err.textContent = 'Could not start Garmin connect. Try again in a moment.'; err.style.display = 'block'; }
    }
  });

  // Garmin users' recovery pipe while direct Garmin is gated off: connect Apple Health
  // straight from the Garmin panel. One tap. (Element only present when GARMIN_CONNECT_ENABLED
  // is off; on iOS this prompts HealthKit, on web it points at the iPhone app.)
  document.getElementById('cd-connect-apple-health')?.addEventListener('click', () => {
    // Keep chosenWatch as 'other' so the user stays in this "connect both" hub (re-entry
    // returns them here to add Strava), rather than bouncing back to the Apple picker tile.
    if (!isNativeiOS()) {
      // HealthKit can't run in a browser. Point at the iPhone app; upload is in the card below.
      const statusEl = document.getElementById('cd-history-status');
      if (statusEl) {
        statusEl.textContent = 'Apple Health only connects in the Mosaic iPhone app. Open Mosaic on your iPhone, or upload an export below.';
        statusEl.style.display = 'block';
      }
      return;
    }
    triggerAppleHealth();
  });

  document.getElementById('cd-upload-strava')?.addEventListener('click', () => openImporter());
  document.getElementById('cd-upload-garmin')?.addEventListener('click', () => openImporter());
  document.getElementById('cd-upload-single')?.addEventListener('click', () => openImporter());

  document.getElementById('cd-continue')?.addEventListener('click', () => {
    // Routing: connected/uploaded users skip the manual-entry step — their PBs are
    // derived (Apple from run GPS, Strava from best_efforts) and stay editable on the
    // post-plan reveal. Only a user with no data source goes to manual PB entry.
    const s = getState() as any;
    const appleConnected = hasPhysiologySource(s, 'apple') || !!s.appleHealthConnected;
    const hasData = appleConnected || !!s.stravaConnected || didUpload;

    // Strongly nudge: skipping with no data source takes two deliberate taps. The first arms
    // the skip and states the cost; the second proceeds. Connected/uploaded users (hasData)
    // advance on the first tap as before.
    if (!hasData && !skipArmed) {
      skipArmed = true;
      const btn = document.getElementById('cd-continue') as HTMLButtonElement | null;
      const caption = document.getElementById('cd-continue-caption');
      if (btn) btn.textContent = 'Continue without data';
      if (caption) {
        caption.textContent = 'Without a watch connection or upload, the plan and predictions run on personal bests alone. Connect above for a sharper plan, or tap Continue again to proceed.';
        caption.style.display = 'block';
      }
      return;
    }

    updateOnboarding({ skippedStrava: !hasData });
    saveState();
    if (hasData) {
      // Apple Health / file-upload users have syncing data too — same one-time
      // save-account moment as the OAuth-return paths (ISSUE-270). No-data
      // skippers are not prompted; nothing is at stake yet.
      maybeOfferAccountSave(() => nextStep());
      return;
    }
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
    if (getState().onboarding?.stravaUnlocked || getState().stravaConnected) revealStravaConnect();
  }
}

/** Swap the access-code input for the Strava connect button. */
function revealStravaConnect(): void {
  // Already connected? refreshHistoryConnectedState owns the card (done line, no button).
  if (getState().stravaConnected) return;
  const codeWrap = document.getElementById('cd-code-wrap');
  const stravaWrap = document.getElementById('cd-strava-wrap');
  if (codeWrap) codeWrap.style.display = 'none';
  if (stravaWrap) stravaWrap.style.display = 'block';
}

async function triggerAppleHealth(): Promise<void> {
  const errEl = document.getElementById('cd-apple-error');
  const infoEl = document.getElementById('cd-apple-info');
  if (errEl) errEl.style.display = 'none';
  if (infoEl) infoEl.style.display = 'none';

  // On web / Android the HealthKit bridge is a no-op. Surface the loud card that
  // makes the "open the iOS app" case and offers an export fallback.
  if (!isNativeiOS()) {
    const webCard = document.getElementById('cd-apple-web');
    if (webCard) webCard.style.display = 'flex';
    return;
  }

  // Already connected? Just flag Continue as ready.
  if (hasPhysiologySource(getState() as any, 'apple')) {
    markAppleHealthConnected();
    return;
  }

  if (infoEl) {
    infoEl.textContent = 'Requesting Apple Health permissions…';
    infoEl.style.display = 'block';
  }

  const result = await connectAppleHealth();
  if (result.ok) {
    markAppleHealthConnected();
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

/**
 * Apple Health connected — surface it where the user is. In the "connect both" history hub
 * (Garmin path) the card's own done line carries the confirmation and nudges Strava; on the
 * Apple picker tile there's no card, so fall back to the global status line. Either way
 * Continue goes ready.
 */
function markAppleHealthConnected(): void {
  const onHistory = document.getElementById('cd-history')?.style.display === 'flex';
  if (onHistory) {
    refreshHistoryConnectedState();
  } else {
    // Apple picker tile = a native Apple Watch user. HealthKit carries the full picture
    // (runs with GPS splits, heart rate, sleep/HRV/resting HR, and PBs from run history),
    // so state plainly that nothing else is needed — they don't need Strava or an upload.
    markContinueReady('Apple Health connected. Runs, heart rate, and recovery now sync automatically. Nothing else to add.');
  }
}

function openImporter(): void {
  openImportActivityModal({
    onComplete: () => {
      didUpload = true;
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
 * taps "Back" so they're not starting fresh with a green-lit Continue.
 */
function resetContinueToPre(): void {
  skipArmed = false;
  const btn = document.getElementById('cd-continue') as HTMLButtonElement | null;
  const caption = document.getElementById('cd-continue-caption');
  if (btn) {
    btn.classList.remove('post');
    btn.classList.add('pre');
    btn.textContent = 'Continue without uploading';
  }
  if (caption) {
    caption.textContent = 'Your plan will start from PBs only. Less accurate, but you can add data anytime from Account.';
    caption.style.display = 'block';
  }
}
