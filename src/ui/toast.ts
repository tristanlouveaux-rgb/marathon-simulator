/**
 * Assignment Toast — shows a brief summary after Garmin activities are processed.
 * Auto-dismisses after 5s; tap anywhere on toast to dismiss early.
 * No queue — replaces any existing toast.
 */

const TOAST_ID = 'mosaic-assignment-toast';

/**
 * Show a floating assignment toast with one line per assignment.
 *
 * Line formats:
 *   "{ActivityName} → {WorkoutName} {DayAbbr}"   — slot match
 *   "{ActivityName} → Excess load"                — overflow
 *   "{ActivityName} → Logged (no plan impact)"    — log only
 */
export function showAssignmentToast(lines: string[]): void {
  if (lines.length === 0) return;

  // Remove any existing toast
  document.getElementById(TOAST_ID)?.remove();

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  // Position above tab bar (56px height + safe area)
  toast.className = [
    'fixed left-4 right-4 z-[200]',
    'rounded-xl shadow-xl',
    'px-4 py-3',
    'flex flex-col gap-1',
    'animate-fade-in',
  ].join(' ');
  toast.style.background = 'var(--c-surface)';
  toast.style.border = '1px solid var(--c-border-strong)';
  toast.style.bottom = 'calc(56px + env(safe-area-inset-bottom, 0px) + 8px)';

  toast.innerHTML = lines.map(line => {
    const [left, right] = line.split(' → ');
    const rightStyle = right?.startsWith('Excess') ? `color:var(--c-caution)` :
                       right?.startsWith('Logged') ? `color:var(--c-faint)` : `color:var(--c-ok)`;
    return `
      <div class="flex items-center justify-between gap-3 text-xs">
        <span class="truncate" style="color:var(--c-muted)">${escHtml(left ?? line)}</span>
        ${right ? `<span class="shrink-0" style="${rightStyle}">→ ${escHtml(right)}</span>` : ''}
      </div>`;
  }).join('');

  document.body.appendChild(toast);

  // Auto-dismiss after 5s
  let timer = window.setTimeout(() => toast.remove(), 5000);

  // Tap to dismiss early
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    toast.remove();
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
