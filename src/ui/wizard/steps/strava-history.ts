/**
 * strava-history.ts
 * =================
 * Phase C2 — History-informed onboarding step.
 *
 * Shown after Strava OAuth completes. Fetches training history,
 * displays a summary (avg TSS, avg km, detected tier, sports),
 * and lets the user confirm or skip.
 *
 * "Use this" → sets athleteTier + ctlBaseline + detectedWeeklyKm on state,
 *              then advances to physiology.
 * "Enter manually" → advances to physiology without changing history state.
 */

import type { OnboardingState } from '@/types/onboarding';
import { goToStep } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { fetchStravaHistory } from '@/data/stravaSync';
import { getMutableState, getState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { TIER_ACWR_CONFIG } from '@/calculations/fitness-model';

// ---------------------------------------------------------------------------
// Tier labels (spec §2)
const TIER_LABELS: Record<string, string> = {
  beginner:    'New to structured training',
  recreational: 'Recreational runner',
  trained:     'Trained runner',
  performance: 'Performance athlete',
  high_volume: 'High-volume athlete',
};

const TIER_DESCRIPTIONS: Record<string, string> = {
  beginner:    "You're building your base. We'll keep load increases gentle to protect against injury.",
  recreational: "You train regularly with some structure. Your body handles moderate load increases well.",
  trained:     "You're consistently trained. Your body adapts quickly to increased load.",
  performance: "You have a high training base. You can handle significant load increases with good recovery.",
  high_volume: "Your chronic load is very high. Your body is adapted to sustained heavy training.",
};

const CARD = 'background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:20px;margin-bottom:12px';

// ---------------------------------------------------------------------------
// Main render

export function renderStravaHistory(container: HTMLElement, _state: OnboardingState): void {
  const s = getState();

  if (!s.stravaHistoryFetched) {
    renderLoadingState(container);
    // Kick off the fetch — will re-render on completion
    fetchStravaHistory(8).then(() => {
      const fresh = getState();
      if (fresh.stravaHistoryFetched) {
        renderSummaryState(container);
      } else {
        renderErrorState(container);
      }
    }).catch(() => {
      renderErrorState(container);
    });
    return;
  }

  renderSummaryState(container);
}

// ---------------------------------------------------------------------------
// Loading spinner

function renderLoadingState(container: HTMLElement): void {
  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px">
      ${renderProgressIndicator(6, 8)}
      <div style="max-width:480px;width:100%;text-align:center">
        <div style="margin-bottom:32px">
          <div style="width:56px;height:56px;margin:0 auto;border-radius:50%;border:3px solid rgba(0,0,0,0.08);border-top-color:#FC4C02;animation:spin 1s linear infinite"></div>
          <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
        </div>
        <h2 style="font-size:1.4rem;font-weight:300;color:var(--c-black);margin-bottom:10px">Analysing your training history…</h2>
        <p style="font-size:14px;color:var(--c-muted)">Looking at your last 8 weeks of Strava data</p>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Error state

function renderErrorState(container: HTMLElement): void {
  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px">
      ${renderProgressIndicator(6, 8)}
      <div style="max-width:480px;width:100%;text-align:center">
        <div style="font-size:2.5rem;margin-bottom:16px">⚠️</div>
        <h2 style="font-size:1.3rem;font-weight:300;color:var(--c-black);margin-bottom:10px">Couldn't load history</h2>
        <p style="font-size:14px;color:var(--c-muted);margin-bottom:32px;line-height:1.6">We couldn't fetch your Strava history right now. You can continue and your history will load in the background.</p>
        <button id="sh-continue-manual"
          style="width:100%;padding:14px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
          Continue without history
        </button>
      </div>
      ${renderBackButton(true)}
    </div>
  `;

  document.getElementById('sh-continue-manual')?.addEventListener('click', () => {
    goToStep('physiology');
  });
}

// ---------------------------------------------------------------------------
// Summary screen

function renderSummaryState(container: HTMLElement): void {
  const s = getState();

  const tier = s.athleteTier ?? 'recreational';
  const tierLabel = TIER_LABELS[tier] ?? 'Recreational runner';
  const tierDesc = TIER_DESCRIPTIONS[tier] ?? '';
  const tierConfig = TIER_ACWR_CONFIG[tier];
  const acwrSafeUpper = tierConfig?.safeUpper ?? 1.3;

  const avgTSS = s.historicWeeklyTSS && s.historicWeeklyTSS.length > 0
    ? Math.round(s.historicWeeklyTSS.reduce((a, b) => a + b, 0) / s.historicWeeklyTSS.length)
    : null;

  const avgKm = s.detectedWeeklyKm ?? null;
  const weeksFound = s.historicWeeklyTSS?.length ?? 0;
  const hasEnoughData = weeksFound >= 2;

  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:64px 24px 96px">
      ${renderProgressIndicator(6, 8)}

      <div style="max-width:480px;width:100%;margin-top:16px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:2rem;margin-bottom:12px">📊</div>
          <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);margin-bottom:6px">
            We found ${weeksFound} week${weeksFound !== 1 ? 's' : ''} of training history
          </h2>
          <p style="font-size:14px;color:var(--c-muted)">From your connected Strava account</p>
        </div>

        <!-- Summary stats -->
        <div style="${CARD}">
          ${avgTSS !== null ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${avgKm !== null ? '12px' : '0'}">
            <span style="font-size:14px;color:var(--c-muted)">Avg weekly load</span>
            <span style="font-size:14px;font-weight:600;color:var(--c-black)">${avgTSS} TSS/week</span>
          </div>` : ''}
          ${avgKm !== null ? `
          <div style="display:flex;justify-content:space-between;align-items:center;${avgTSS !== null ? 'padding-top:12px;border-top:1px solid var(--c-border)' : ''}">
            <span style="font-size:14px;color:var(--c-muted)">Avg running volume</span>
            <span style="font-size:14px;font-weight:600;color:var(--c-black)">${avgKm} km/week</span>
          </div>` : ''}
          ${!hasEnoughData ? `
          <div style="padding-top:12px;border-top:1px solid var(--c-border);margin-top:12px">
            <p style="font-size:12px;color:var(--c-caution)">Limited history — we'll build a more accurate baseline as you train.</p>
          </div>` : ''}
        </div>

        <!-- Athlete tier card -->
        <div id="sh-tier-card" style="${CARD}">
          <div style="display:flex;align-items:flex-start;gap:12px">
            <div style="flex:1">
              <p style="font-size:12px;color:var(--c-muted);margin-bottom:4px">Based on this, you're a</p>
              <h3 style="font-size:16px;font-weight:500;color:var(--c-black);margin-bottom:4px">${tierLabel}</h3>
              <p style="font-size:12px;color:var(--c-muted);line-height:1.6">${tierDesc}</p>
            </div>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--c-border);display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;color:var(--c-faint)">Safe load increase: up to ${Math.round((acwrSafeUpper - 1) * 100)}% per week</span>
            <button id="sh-tier-info" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;text-decoration:underline;padding:0">Change</button>
          </div>
        </div>

        ${avgKm !== null ? `
        <!-- Plan start point -->
        <div style="${CARD}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="color:var(--c-ok);font-size:14px">✓</span>
            <span style="font-size:14px;font-weight:500;color:var(--c-black)">Your plan starts at ${avgKm} km/week</span>
          </div>
          <p style="font-size:12px;color:var(--c-faint)">Matched to your recent training level, then ramping toward your goal.</p>
        </div>
        ` : '<div style="margin-bottom:12px"></div>'}

        <!-- CTA buttons -->
        <button id="sh-use-history"
          style="width:100%;padding:14px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;margin-bottom:10px">
          Use this — Recommended
        </button>
        <button id="sh-skip-history"
          style="width:100%;padding:10px;background:none;border:none;font-size:14px;color:var(--c-muted);cursor:pointer">
          I'll enter manually
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers();
}

// ---------------------------------------------------------------------------
// Event handlers

function wireHandlers(): void {
  // "Use this" — accept history-derived values, advance
  document.getElementById('sh-use-history')?.addEventListener('click', () => {
    const s = getMutableState();
    // Flag that the user accepted history (C3 plan rebuild will use these values)
    s.stravaHistoryAccepted = true;
    saveState();
    goToStep('physiology');
  });

  // "Enter manually" — skip history, advance
  document.getElementById('sh-skip-history')?.addEventListener('click', () => {
    goToStep('physiology');
  });

  // "Change" tier link — show tier picker inline
  document.getElementById('sh-tier-info')?.addEventListener('click', () => {
    showTierPicker();
  });
}

// ---------------------------------------------------------------------------
// Tier picker (inline override)

function showTierPicker(): void {
  const card = document.getElementById('sh-tier-card');
  if (!card || document.getElementById('tier-picker')) return;

  const s = getState();
  const current = s.athleteTierOverride ?? s.athleteTier ?? 'recreational';

  const tiers = ['beginner', 'recreational', 'trained', 'performance', 'high_volume'] as const;

  const pickerEl = document.createElement('div');
  pickerEl.id = 'tier-picker';
  pickerEl.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid var(--c-border);display:flex;flex-direction:column;gap:8px';
  pickerEl.innerHTML = `
    <p style="font-size:12px;color:var(--c-muted);margin-bottom:4px">Select your tier manually:</p>
    ${tiers.map(t => `
      <button class="tier-pick-btn" data-tier="${t}"
        style="width:100%;text-align:left;padding:10px 14px;border-radius:8px;font-size:14px;cursor:pointer;transition:all 0.15s;
               ${t === current
                 ? 'background:var(--c-black);color:#FDFCF7;border:2px solid var(--c-black)'
                 : 'background:var(--c-bg);color:var(--c-black);border:1.5px solid var(--c-border-strong)'}">
        ${TIER_LABELS[t]}
      </button>
    `).join('')}
  `;

  card.appendChild(pickerEl);

  document.querySelectorAll('.tier-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTier = (btn as HTMLElement).dataset.tier as typeof tiers[number];
      const ms = getMutableState();
      ms.athleteTierOverride = selectedTier;
      saveState();
      // Re-render
      const ob = getState().onboarding;
      if (ob) renderSummaryState(document.getElementById('app-root')!);
    });
  });
}
