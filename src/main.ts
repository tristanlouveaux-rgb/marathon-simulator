/**
 * Mosaic Training Simulator
 * Entry point - initializes the application
 */

import './styles.css';
import { loadState, getState } from '@/state';
import { initWizard } from '@/ui/wizard/controller';
import { renderMainView } from '@/ui/main-view';
import { renderAdminPanel, toggleAdminMode } from '@/ui/admin/master-overview';

/**
 * Initialize application on DOM ready
 */
function bootstrap(): void {
  // Try to load saved state
  const hasState = loadState();
  const state = getState();

  // Check if onboarding is complete
  if (hasState && state.hasCompletedOnboarding) {
    // Show main workout view
    renderMainView();
  } else {
    // Show onboarding wizard
    initWizard();
  }

  // Render admin panel if enabled
  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel && state.isAdmin) {
    adminPanel.innerHTML = renderAdminPanel();
    wireAdminHandlers();
  }

  // Admin mode toggle: Ctrl+Shift+A
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      toggleAdminMode();
    }
  });

  console.log('Mosaic Training Simulator initialized');
}

/**
 * Wire up admin panel event handlers
 */
function wireAdminHandlers(): void {
  document.getElementById('admin-simulate-week')?.addEventListener('click', () => {
    import('@/ui/events').then(({ next }) => {
      next();
    });
  });

  document.getElementById('admin-reset-onboarding')?.addEventListener('click', () => {
    import('@/ui/wizard/controller').then(({ resetOnboarding }) => {
      resetOnboarding();
      window.location.reload();
    });
  });

  document.getElementById('admin-view-all-weeks')?.addEventListener('click', () => {
    import('@/state').then(({ updateState, saveState }) => {
      updateState({ isAdmin: true });
      saveState();
      window.location.reload();
    });
  });
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
