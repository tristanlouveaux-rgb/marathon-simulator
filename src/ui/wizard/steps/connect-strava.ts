import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { saveState } from '@/state/persistence';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import {
  getAccessToken,
  SUPABASE_FUNCTIONS_BASE,
  SUPABASE_ANON_KEY,
  isStravaConnected,
} from '@/data/supabaseClient';

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
  // Mount-time check — if already linked, skip straight past this screen.
  // Fire-and-forget; the button stays usable while the check is in flight.
  isStravaConnected()
    .then(connected => {
      if (connected) {
        try { window.wizardNext(); } catch { nextStep(); }
      }
    })
    .catch(() => {
      // Check failed (offline, edge fn down). Let the user proceed manually.
    });

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

      .cs-err { font-size:12px; color:var(--c-danger, #B91C1C); margin-top:10px; text-align:center; display:none; }
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M13.828 2 8 13.5h3.48L13.828 9l2.347 4.5h3.48L13.828 2Zm2.293 13.5-1.747 3.352L12.626 15.5h-2.5L14.374 23l4.25-7.5h-2.503Z"/>
            </svg>
            Connect Strava
          </button>
          <p id="cs-error" class="cs-err"></p>
        </div>

        <div class="cs-rise" style="margin-top:14px;animation-delay:0.28s">
          <button id="cs-skip" class="cs-skip">Enter manually</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state);
}

function wireHandlers(_state: OnboardingState): void {
  const cta = document.getElementById('cs-connect') as HTMLButtonElement | null;
  const errorEl = document.getElementById('cs-error') as HTMLElement | null;

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

  document.getElementById('cs-skip')?.addEventListener('click', () => {
    updateOnboarding({ skippedStrava: true });
    saveState();
    try { window.wizardNext(); } catch { nextStep(); }
  });
}
