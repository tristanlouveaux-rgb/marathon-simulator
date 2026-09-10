/**
 * Post-first-run Check-in coachmark.
 *
 * The first time a user finishes a run, the Check-in button gets a one-time
 * attention pulse plus a small tooltip that reframes Check-in around the common,
 * low-stakes case: logging sore legs or a niggle so the plan adapts. It is NOT a
 * break-glass injury tool only — a low pain log (the injury modal's 0–10 slider)
 * is exactly how a niggle gets recorded.
 *
 * Discoverability gap: users do not find Check-in until they are already hurt and
 * hunting for it. This surfaces it at the first receptive moment instead.
 *
 * Once-only guard (per UX_PATTERNS "Feature reveals"): BOTH a module-level
 * `shownThisSession` boolean AND a persisted `s.checkinHintSeen`, set on creation
 * (not on dismiss) so it never reappears.
 */

import type { SimulatorState } from '@/types/state';
import { getMutableState, saveState } from '@/state';

let shownThisSession = false;

const TOOLTIP_ID = 'checkin-hint-tooltip';

/** Has the user completed at least one run/session?
 *  Cross-mode signal: a matched activity populates `garminActuals` on the week,
 *  or a workout/adhoc workout flips to `status === 'completed'`. */
function hasCompletedFirstActivity(s: SimulatorState): boolean {
  const weeks = s.wks ?? [];
  for (const wk of weeks) {
    if (wk.garminActuals && Object.keys(wk.garminActuals).length > 0) return true;
    if (wk.adhocWorkouts?.some((w) => w.status === 'completed')) return true;
  }
  return false;
}

/** Draw the pulse + tooltip anchored to the Home Check-in button.
 *  Pure DOM work — no guards. Returns false if the button isn't present or a
 *  blocking overlay is open (caller decides whether to retry). */
function drawCheckinHint(): boolean {
  const btn = document.getElementById('home-checkin-btn');
  if (!btn) return false;

  // Don't stack on top of any open modal/overlay (e.g. week debrief).
  if (document.querySelector('.fixed.inset-0.z-50')) return false;
  if (document.getElementById(TOOLTIP_ID)) return false;

  btn.classList.add('m-checkin-pulse');

  const rect = btn.getBoundingClientRect();
  const tip = document.createElement('div');
  tip.id = TOOLTIP_ID;
  tip.setAttribute('role', 'status');
  const tipWidth = Math.min(260, window.innerWidth - 24);
  let left = rect.left + rect.width / 2 - tipWidth / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - tipWidth - 12));
  const top = rect.bottom + 10;
  const pointerLeft = rect.left + rect.width / 2 - left;

  tip.style.cssText = `
    position:fixed; top:${top}px; left:${left}px; width:${tipWidth}px; z-index:60;
    background:rgba(255,255,255,0.92); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
    border:1px solid rgba(255,255,255,0.6); border-radius:14px; padding:12px 14px;
    box-shadow:0 6px 24px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.06);
    cursor:pointer; font-family:var(--f);`;
  tip.innerHTML = `
    <div style="position:absolute;top:-5px;left:${Math.max(12, Math.min(pointerLeft, tipWidth - 12)) - 5}px;
                width:10px;height:10px;background:rgba(255,255,255,0.92);
                border-left:1px solid rgba(255,255,255,0.6);border-top:1px solid rgba(255,255,255,0.6);
                transform:rotate(45deg)"></div>
    <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">Sore legs or a niggle?</div>
    <div style="font-size:12.5px;line-height:1.45;color:var(--c-muted)">Log it in Check-in and the plan adapts around it. Same place for illness or time off.</div>`;

  document.body.appendChild(tip);

  const dismiss = () => {
    tip.remove();
    btn.classList.remove('m-checkin-pulse');
    document.removeEventListener('click', onDocClick, true);
  };
  // Capture-phase so the button's own open handler still fires; we just clean up.
  const onDocClick = () => dismiss();

  tip.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  // Defer the document listener a tick so the click that triggered render doesn't dismiss instantly.
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  return true;
}

/**
 * Show the Check-in coachmark once, after the first completed run.
 * Safe to call on every Home render — guards make it a no-op after the first time.
 * Call after `wireHomeHandlers()` so the button exists and is wired.
 */
export function maybeShowCheckinHint(s: SimulatorState): void {
  if (shownThisSession || s.checkinHintSeen) return;
  if (!hasCompletedFirstActivity(s)) return;

  // Defer so the Home entrance animation settles before we measure the button
  // and draw attention to it.
  setTimeout(() => {
    // Set guards only when we actually draw — a blocking overlay means retry on
    // the next Home render, so we don't burn the once-only chance.
    if (drawCheckinHint()) {
      shownThisSession = true;
      const mutable = getMutableState();
      mutable.checkinHintSeen = true;
      saveState();
    }
  }, 700);
}

/**
 * DEV preview: force the coachmark regardless of guards or first-run state.
 * Wired to `window.__previewCheckinHint()` in main.ts's dev block. Does NOT
 * persist `checkinHintSeen`, so it can be re-run freely.
 */
export function forceShowCheckinHint(): void {
  document.getElementById(TOOLTIP_ID)?.remove();
  if (!drawCheckinHint()) {
    console.warn('[checkin-hint] no #home-checkin-btn — navigate to the Home tab first');
  }
}
