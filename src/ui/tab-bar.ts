/**
 * Bottom tab bar.
 * Running/cycling: Home | Plan | Stats (3 tabs)
 * Triathlon:       Home | Plan | Forecast | Stats (4 tabs)
 *
 * Mode is auto-detected from state — no call-site changes needed.
 */

import { getState } from '@/state/store';

export type TabId = 'home' | 'plan' | 'record' | 'forecast' | 'stats' | 'account';

const HOME_ICON = `<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
                   <polyline points="9 22 9 12 15 12 15 22"/>`;
const PLAN_ICON = `<rect x="3" y="4" width="18" height="18" rx="2"/>
                   <path d="M16 2v4M8 2v4M3 10h18"/>
                   <path d="M8 14h4M8 17h8"/>`;
const FORECAST_ICON = `<path d="M4 22V4"/>
                        <path d="M4 4h14l-3.5 5 3.5 5H4"/>`;
const STATS_ICON = `<path d="M18 20V10M12 20V4M6 20v-6"/>`;

/**
 * Render the bottom tab bar HTML.
 * @param activeTab - Currently active tab
 * @param _isSimulator - Unused, kept for call-site compat
 */
export function renderTabBar(activeTab: TabId, _isSimulator?: boolean): string {
  const _et = getState().eventType;
  const isTriathlon = _et === 'triathlon';
  const isHyrox = _et === 'hyrox';

  const tabs: { id: TabId; label: string; icon: string }[] = (isTriathlon || isHyrox)
    ? [
        { id: 'home',     label: 'Home',     icon: HOME_ICON },
        { id: 'plan',     label: 'Plan',     icon: PLAN_ICON },
        { id: 'forecast', label: 'Forecast', icon: FORECAST_ICON },
        { id: 'stats',    label: 'Stats',    icon: STATS_ICON },
      ]
    : [
        { id: 'home',  label: 'Home',  icon: HOME_ICON },
        { id: 'plan',  label: 'Plan',  icon: PLAN_ICON },
        { id: 'stats', label: 'Stats', icon: STATS_ICON },
      ];

  const tabsHtml = tabs.map(tab => {
    const isActive = tab.id === activeTab;
    return `
      <button data-tab="${tab.id}" class="tab-bar-btn flex-1 flex flex-col items-center gap-1 py-2 transition-colors ${isActive ? 'tab-active' : 'tab-inactive'}">
        <svg class="w-[22px] h-[22px]" fill="none" stroke="currentColor" stroke-width="${isActive ? '2' : '1.5'}" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${tab.icon}</svg>
        <span class="text-[10px] font-semibold uppercase tracking-[0.07em]">${tab.label}</span>
      </button>
    `;
  }).join('');

  return `
    <nav id="bottom-tab-bar" class="fixed bottom-0 left-0 right-0 z-40 mosaic-tab-bar" style="padding-bottom: env(safe-area-inset-bottom, 0px)">
      <div class="max-w-lg mx-auto flex">
        ${tabsHtml}
      </div>
    </nav>
  `;
}

// Single live callback — replaced each time a view mounts. Never stacks.
let _tabHandler: ((tab: TabId) => void) | null = null;

// One permanent delegated listener on document. Set up once, never re-added.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest?.('.tab-bar-btn');
    if (btn && _tabHandler) {
      const tab = btn.getAttribute('data-tab') as TabId;
      if (tab) {
        import('./guided-overlay').then(({ unmountGuidedOverlay }) => unmountGuidedOverlay());
        _tabHandler(tab);
      }
    }
  });
}

/**
 * Register the navigation callback for tab bar clicks.
 * Replaces the previous callback — no listener accumulation.
 */
export function wireTabBarHandlers(onChange: (tab: TabId) => void): void {
  _tabHandler = onChange;
}
