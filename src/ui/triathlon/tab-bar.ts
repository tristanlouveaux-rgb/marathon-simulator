/**
 * Minimal triathlon tab bar — Plan / Home / Stats.
 *
 * Mirrors the running tab bar's position and styling but routes to
 * triathlon views. Running users see the standard tab bar; triathlon
 * users see this.
 */

import { getState } from '@/state/store';

export type TriTab = 'plan' | 'home' | 'stats';

export function renderTriTabBar(active: TriTab): string {
  return `
    <nav style="
      position:fixed;bottom:0;left:0;right:0;z-index:50;
      background:rgba(253,252,247,0.92);backdrop-filter:blur(12px);
      border-top:1px solid rgba(0,0,0,0.06);
      padding:10px env(safe-area-inset-left) calc(10px + env(safe-area-inset-bottom)) env(safe-area-inset-right);
      display:flex;justify-content:space-around;align-items:center
    ">
      ${renderTab('plan', 'Plan', active === 'plan', ICON_PLAN)}
      ${renderTab('home', 'Home', active === 'home', ICON_HOME)}
      ${renderTab('stats', 'Stats', active === 'stats', ICON_STATS)}
    </nav>
  `;
}

function renderTab(id: TriTab, label: string, active: boolean, icon: string): string {
  return `
    <button
      onclick="window.triGoTab && window.triGoTab('${id}')"
      style="
        background:none;border:none;cursor:pointer;
        display:flex;flex-direction:column;align-items:center;gap:3px;
        padding:4px 12px;
        color:${active ? 'var(--c-black)' : 'var(--c-muted)'};
        opacity:${active ? '1' : '0.7'};
      ">
      <span style="width:22px;height:22px;display:flex;align-items:center;justify-content:center">${icon}</span>
      <span style="font-size:10px;letter-spacing:0.05em;font-weight:${active ? '500' : '400'}">${label}</span>
    </button>
  `;
}

const ICON_PLAN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px"><path d="M8 3v4M16 3v4M3 9h18M5 6h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/></svg>`;
const ICON_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px"><path d="M3 10l9-7 9 7M5 9v11h4v-6h6v6h4V9"/></svg>`;
const ICON_STATS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px"><path d="M3 20V10M10 20V4M17 20v-6"/></svg>`;

/**
 * Global tab-switching hook (set on module load).
 */
declare global {
  interface Window {
    triGoTab?: (id: TriTab) => void;
  }
}

if (typeof window !== 'undefined') {
  window.triGoTab = async (id: TriTab) => {
    const s = getState();
    if (s.eventType !== 'triathlon') return;
    switch (id) {
      case 'plan': {
        const { renderTriathlonPlanView } = await import('./plan-view');
        renderTriathlonPlanView();
        break;
      }
      case 'home': {
        const { renderTriathlonHomeView } = await import('./home-view');
        renderTriathlonHomeView();
        break;
      }
      case 'stats': {
        const { renderTriathlonStatsView } = await import('./stats-view');
        renderTriathlonStatsView();
        break;
      }
    }
  };
}
