import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';

/**
 * Toggle admin mode on/off
 */
export function toggleAdminMode(): void {
  const s = getState();
  updateState({ isAdmin: !s.isAdmin });
  saveState();
  window.location.reload();
}

/**
 * Render the admin panel (floating bottom-right)
 */
export function renderAdminPanel(): string {
  const s = getState();
  if (!s.isAdmin) return '';

  return `
    <div class="fixed bottom-4 right-4 bg-purple-950 border border-purple-700 rounded-lg p-3 z-50 shadow-xl">
      <div class="flex items-center justify-between mb-3">
        <div class="text-xs text-purple-300 font-bold">Admin Mode</div>
        <button id="admin-close" class="text-purple-400 hover:text-purple-200 text-xs">
          Close
        </button>
      </div>
      <div class="space-y-2">
        <button id="admin-simulate-week"
          class="w-full py-2 px-3 bg-purple-800 hover:bg-purple-700 rounded text-purple-200 text-xs font-medium transition-colors">
          Simulate Week Complete
        </button>
        <button id="admin-reset-onboarding"
          class="w-full py-2 px-3 bg-purple-800 hover:bg-purple-700 rounded text-purple-200 text-xs font-medium transition-colors">
          Reset Onboarding
        </button>
        <button id="admin-view-all-weeks"
          class="w-full py-2 px-3 bg-purple-800 hover:bg-purple-700 rounded text-purple-200 text-xs font-medium transition-colors">
          Unlock All Weeks
        </button>
        <button id="admin-clear-state"
          class="w-full py-2 px-3 bg-red-900 hover:bg-red-800 rounded text-red-200 text-xs font-medium transition-colors">
          Clear All Data
        </button>
      </div>
      <div class="mt-3 pt-2 border-t border-purple-800 text-xs text-purple-400">
        <div>Week: ${s.w || 1} / ${s.tw || 16}</div>
        <div>VDOT: ${s.v?.toFixed(1) || '-'}</div>
        <div class="text-purple-500 mt-1">Ctrl+Shift+A to toggle</div>
      </div>
    </div>
  `;
}

/**
 * Wire admin panel event handlers
 * Called after rendering the panel
 */
export function wireAdminPanelHandlers(): void {
  document.getElementById('admin-close')?.addEventListener('click', () => {
    toggleAdminMode();
  });

  document.getElementById('admin-clear-state')?.addEventListener('click', () => {
    if (confirm('Clear ALL data including saved plans? This cannot be undone.')) {
      import('@/state/persistence').then(({ clearState }) => {
        clearState();
        window.location.reload();
      });
    }
  });
}
