/**
 * coach-paywall.ts
 * ================
 * Subscribe-or-leave surface shown inside the Coach view on iOS for users
 * without an active AI Coach entitlement. Replaces the rules-based classic
 * coach for iOS-only. The web/Android build still renders classic coach as
 * the non-subscriber fallback.
 *
 * App Store Review Guideline 3.1.3 compliance (auto-renewing subscriptions):
 *   - Length of subscription periods + cost shown clearly per package
 *   - Free trial duration disclosed
 *   - Payment charged to Apple ID at purchase confirmation
 *   - Subscription auto-renews unless cancelled ≥ 24h before period end
 *   - How to manage / cancel (Settings → Apple ID → Subscriptions)
 *   - Restore Purchases link visible
 *   - Terms of Use + Privacy Policy links visible
 *   - NO mention of external payment methods (Stripe, web checkout). Guideline
 *     3.1.3(a) anti-steering
 */

import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildScrollAtmosphereBackground, buildSunGlint } from './page-flair';
import { showSimpleToast } from './toast';
import {
  getCoachOfferings,
  purchaseCoachPackage,
  restoreCoachPurchases,
} from '@/coach/revenuecat-client';
import { resetEntitlementCache } from '@/coach/entitlement';
import { COACH_OFFERING_ID } from '@/coach/revenuecat-config';
import type { PurchasesPackage } from '@revenuecat/purchases-capacitor';

// ─── Design tokens (mirror coach-view) ────────────────────────────────────────

const CREAM   = '#FAF9F6';
const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';
const BORDER  = '#F1F5F9';
const CARD_SHADOW = '0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)';

// ─── Public URLs (must match docs/LEGAL_CHECKLIST.md) ─────────────────────────

const TERMS_URL   = 'https://www.mosaicrunning.run/terms.html';
const PRIVACY_URL = 'https://www.mosaicrunning.run/privacy.html';

// ─── Module state ─────────────────────────────────────────────────────────────

let _packages: PurchasesPackage[] = [];
let _selectedIdentifier: string | null = null;
let _purchaseInFlight = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pull the display price from a RevenueCat package. The SDK localises the
 *  string per the user's App Store country, so a UK user sees "£4.99". */
function priceLabel(pkg: PurchasesPackage): string {
  return pkg.product?.priceString ?? '';
}

/** Identify a package as monthly/annual by RevenueCat's reserved identifiers
 *  ($rc_monthly / $rc_annual). Falls back to subscription period inspection. */
function periodLabel(pkg: PurchasesPackage): 'monthly' | 'annual' | 'other' {
  if (pkg.identifier === '$rc_monthly') return 'monthly';
  if (pkg.identifier === '$rc_annual') return 'annual';
  const unit = pkg.product?.subscriptionPeriod;
  if (unit?.includes('M') && !unit.includes('Y')) return 'monthly';
  if (unit?.includes('Y')) return 'annual';
  return 'other';
}

function packageCardHtml(pkg: PurchasesPackage, selected: boolean): string {
  const period = periodLabel(pkg);
  const isAnnual = period === 'annual';
  const title = period === 'monthly' ? 'Monthly' : period === 'annual' ? 'Annual' : pkg.identifier;
  const price = priceLabel(pkg);
  const subline = period === 'monthly'
    ? 'Billed every month'
    : period === 'annual'
      ? 'Billed once a year'
      : '';

  return `
    <button data-pkg-id="${escHtml(pkg.identifier)}"
      class="paywall-pkg ${selected ? 'is-selected' : ''}"
      style="
        display:flex;align-items:center;justify-content:space-between;
        width:100%;padding:14px 16px;margin-bottom:10px;
        background:#FFFFFF;border:${selected ? '2px solid #0F172A' : `1px solid ${BORDER}`};
        border-radius:14px;cursor:pointer;text-align:left;
        box-shadow:${selected ? '0 2px 6px rgba(15,23,42,0.08)' : 'none'};
        transition:border-color 120ms, box-shadow 120ms;
      ">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:15px;font-weight:600;color:${TEXT_M}">${title}</span>
          ${isAnnual ? `<span style="font-size:10px;font-weight:600;color:${TEXT_M};background:${BORDER};padding:2px 6px;border-radius:6px">Save 17%</span>` : ''}
        </div>
        ${subline ? `<div style="font-size:12px;color:${TEXT_S};margin-top:2px">${subline}</div>` : ''}
      </div>
      <div style="font-size:16px;font-weight:600;color:${TEXT_M}">${escHtml(price)}</div>
    </button>
  `;
}

function getPaywallHTML(loading: boolean): string {
  const annual = _packages.find(p => periodLabel(p) === 'annual');
  const monthly = _packages.find(p => periodLabel(p) === 'monthly');
  const ordered = [annual, monthly].filter(Boolean) as PurchasesPackage[];
  const selectedId = _selectedIdentifier ?? ordered[0]?.identifier ?? null;

  const packagesHtml = ordered.map(p => packageCardHtml(p, p.identifier === selectedId)).join('');

  return `
    <style>
      #coach-view { box-sizing:border-box; }
      #coach-view *, #coach-view *::before, #coach-view *::after { box-sizing:inherit; }
      @keyframes paywallFadeUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:none} }
      .pw-fade { opacity:0;animation:paywallFadeUp 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="coach-view" style="position:relative;min-height:100vh;background:${CREAM};font-family:var(--f);overflow-x:hidden">

      ${buildScrollAtmosphereBackground('cv', 'rose', { haloCenter: { cx: 200, cy: 550 } })}${buildSunGlint('low')}

      <div style="position:relative;z-index:10;padding-bottom:96px">

        <!-- Header -->
        <div style="padding:56px 20px 12px;display:flex;align-items:center;justify-content:space-between">
          <button id="coach-back-btn" style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.08);display:flex;align-items:center;justify-content:center;color:${TEXT_M}">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="font-size:20px;font-weight:700;color:${TEXT_M}">AI Coach</div>
          <div style="width:36px"></div>
        </div>

        <!-- Value prop -->
        <div class="pw-fade" style="margin:8px 20px 20px;background:#FFFFFF;border-radius:18px;padding:20px;box-shadow:${CARD_SHADOW}">
          <div style="font-size:22px;font-weight:700;color:${TEXT_M};line-height:1.25;margin-bottom:10px">A coach that reads your data.</div>
          <div style="font-size:14px;color:${TEXT_S};line-height:1.55">
            Personal AI that reads four weeks of your training, readiness, and sleep, then recommends specific changes to your plan. Swap a workout, reduce a hard day, ask why your CTL is climbing. The Coach explains the call and applies the change when you confirm.
          </div>
          <div style="margin-top:14px;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:${TEXT_M}">
            <span style="display:inline-block;width:6px;height:6px;background:${TEXT_M};border-radius:50%"></span>
            7-day free trial. Cancel anytime.
          </div>
        </div>

        <!-- Plan picker -->
        <div class="pw-fade" style="margin:0 20px 12px;animation-delay:80ms">
          ${loading
            ? `<div style="padding:32px;text-align:center;color:${TEXT_L};font-size:13px">Loading subscription options…</div>`
            : packagesHtml || `<div style="padding:32px;text-align:center;color:${TEXT_L};font-size:13px">Subscription unavailable. Pull to refresh or try again later.</div>`
          }
        </div>

        <!-- Primary CTA -->
        <div class="pw-fade" style="margin:8px 20px 16px;animation-delay:120ms">
          <button id="paywall-subscribe-btn" class="m-btn-glass" style="width:100%;height:52px;font-size:16px;font-weight:600"
            ${(_packages.length === 0 || loading) ? 'disabled' : ''}>
            Start 7-day free trial
          </button>
        </div>

        <!-- Restore Purchases -->
        <div class="pw-fade" style="margin:0 20px 16px;text-align:center;animation-delay:160ms">
          <button id="paywall-restore-btn" style="font-size:13px;color:${TEXT_S};background:none;border:none;cursor:pointer;padding:6px 12px">
            Restore Purchases
          </button>
        </div>

        <!-- Apple 3.1.3 required disclosure paragraph -->
        <div class="pw-fade" style="margin:8px 20px 16px;font-size:11px;color:${TEXT_L};line-height:1.55;animation-delay:200ms">
          Payment will be charged to your Apple ID account at confirmation of purchase. The subscription renews automatically unless cancelled at least 24 hours before the end of the current period. Your account will be charged for renewal within 24 hours of the end of the current period. Manage subscriptions or cancel in your device Settings under Apple ID.
        </div>

        <!-- Terms + Privacy -->
        <div class="pw-fade" style="margin:8px 20px 24px;font-size:12px;color:${TEXT_L};text-align:center;animation-delay:240ms">
          <a href="${TERMS_URL}" target="_blank" rel="noopener" style="color:${TEXT_S};text-decoration:underline;text-decoration-color:${TEXT_L}">Terms of Use</a>
          <span style="margin:0 8px">·</span>
          <a href="${PRIVACY_URL}" target="_blank" rel="noopener" style="color:${TEXT_S};text-decoration:underline;text-decoration-color:${TEXT_L}">Privacy Policy</a>
        </div>

      </div>
    </div>

    ${renderTabBar('home')}
  `;
}

// ─── Render + wire ────────────────────────────────────────────────────────────

let _onBack: (() => void) | null = null;

export async function renderCoachPaywall(opts: { onBack?: () => void } = {}): Promise<void> {
  _onBack = opts.onBack ?? _onBack;

  const container = document.getElementById('app-root');
  if (!container) return;

  // First paint: skeleton while we fetch the offering.
  container.innerHTML = getPaywallHTML(true);
  wirePaywallHandlers();

  // Fetch the offering. Returns null on web/Android, or when RevenueCat
  // dashboard isn't yet configured. The skeleton becomes "unavailable".
  const offering = await getCoachOfferings();
  _packages = offering?.availablePackages ?? [];
  _selectedIdentifier = _packages.find(p => periodLabel(p) === 'annual')?.identifier
    ?? _packages[0]?.identifier
    ?? null;

  container.innerHTML = getPaywallHTML(false);
  wirePaywallHandlers();

  if (_packages.length === 0) {
    console.warn(`[paywall] no packages available. RevenueCat offering '${COACH_OFFERING_ID}' is empty or unreachable`);
  }
}

function wirePaywallHandlers(): void {
  wireTabBarHandlers(navigateTab);

  document.getElementById('coach-back-btn')?.addEventListener('click', () => {
    if (_onBack) _onBack();
    else void import('./home-view').then(m => m.renderHomeView());
  });

  // Plan selection.
  document.querySelectorAll<HTMLElement>('.paywall-pkg').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-pkg-id');
      if (!id) return;
      _selectedIdentifier = id;
      // Re-render cheap: just rebuild the package list area.
      void renderCoachPaywall({ onBack: _onBack ?? undefined });
    });
  });

  // Subscribe CTA.
  document.getElementById('paywall-subscribe-btn')?.addEventListener('click', () => {
    void onSubscribe();
  });

  // Restore Purchases.
  document.getElementById('paywall-restore-btn')?.addEventListener('click', () => {
    void onRestore();
  });
}

async function onSubscribe(): Promise<void> {
  if (_purchaseInFlight) return;
  const pkg = _packages.find(p => p.identifier === _selectedIdentifier);
  if (!pkg) {
    showSimpleToast('No subscription selected.', 'error');
    return;
  }
  _purchaseInFlight = true;
  try {
    await purchaseCoachPackage(pkg);
    resetEntitlementCache();
    showSimpleToast('Welcome to AI Coach. Your trial has started.');
    // Re-enter the Coach view. Entitlement is now active.
    void import('./coach-view').then(m => m.renderCoachView({ onBack: _onBack ?? undefined }));
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    // RevenueCat surfaces user-cancelled with a specific shape; silence it.
    if (msg.includes('UserCancelled') || msg.includes('PurchaseCancelledError')) {
      // No toast on cancel. The user knows they cancelled.
    } else {
      console.error('[paywall] purchase failed:', msg);
      showSimpleToast('Purchase could not be completed. Please try again.', 'error');
    }
  } finally {
    _purchaseInFlight = false;
  }
}

async function onRestore(): Promise<void> {
  const result = await restoreCoachPurchases();
  resetEntitlementCache();
  if (result.restored) {
    showSimpleToast('Subscription restored. Welcome back.');
    void import('./coach-view').then(m => m.renderCoachView({ onBack: _onBack ?? undefined }));
  } else {
    showSimpleToast('No active subscription found on this Apple ID.');
  }
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') void import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') void import('./main-view').then(m => m.renderMainView());
  else if (tab === 'forecast') void import('./triathlon/forecast-view').then(m => m.renderTriathlonForecastView());
  else if (tab === 'record') void import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') void import('./stats-view').then(m => m.renderStatsView());
}
