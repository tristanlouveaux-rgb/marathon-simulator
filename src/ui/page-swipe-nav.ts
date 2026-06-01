import { navigateToTab, getActiveTab, SWIPE_TAB_ORDER, type TabId } from './tab-bar';

/**
 * Swipe between main tabs (flick-to-slide).
 *
 * A horizontal flick on the page navigates to the adjacent tab in
 * SWIPE_TAB_ORDER (home, plan, forecast, stats). Lightweight by design: only one
 * page is ever live. The outgoing page (the current #app-root) is repositioned as
 * a fixed overlay and slides off in the flick direction, revealing the freshly
 * rendered next page beneath it. We never mount two heavy pages at once, and we
 * never animate the *incoming* layer — its render is async (dynamic import per
 * tab), so animating it would race the import. Animating the always-present
 * outgoing layer is robust to that.
 *
 * Conflict avoidance:
 * - Vertical scroll wins: a gesture only counts as a swipe when it is clearly
 *   horizontal (|dx| dominates |dy|) and clears the distance threshold.
 * - Plan's per-week swipe is retired in favour of this; weeks still change via the
 *   chevron buttons and the numbered week pills.
 * - Skips gestures that start inside a horizontally scrollable element, on a
 *   draggable plan workout card, or anywhere outside #app-root (i.e. over an open
 *   overlay/modal, which is appended to <body>).
 */

const SWIPE_MIN_PX = 60; // distance to count as a swipe (matches the old plan-week swipe)
const AXIS_RATIO = 1.4; // |dx| must beat |dy| by this factor — keeps vertical scroll free
const MAX_DURATION_MS = 700; // a flick, not a slow drag
const SLIDE = 'transform 0.26s cubic-bezier(0.4, 0, 0.2, 1)';
const SLIDE_CLEANUP_MS = 460; // fallback removal if transitionend never fires

export function installPageSwipeNav(): void {
  if (typeof window === 'undefined') return;

  let animating = false;

  const startsInHorizontalScroller = (target: EventTarget | null): boolean => {
    let el = target as HTMLElement | null;
    const root = document.getElementById('app-root');
    while (el && el !== root) {
      if (el.scrollWidth > el.clientWidth + 2) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      el = el.parentElement;
    }
    return false;
  };

  const eligible = (target: EventTarget | null): boolean => {
    if (animating) return false;
    const root = document.getElementById('app-root');
    if (!root || !target || !root.contains(target as Node)) return false; // overlay/modal open
    const t = target as HTMLElement;
    // Let a draggable workout card own the gesture (running / tri / hyrox plans).
    if (t.closest('.plan-workout-card, .tri-workout-card, .hyrox-workout-card')) return false;
    if (startsInHorizontalScroller(target)) return false;
    return true;
  };

  const targetTab = (from: TabId, dir: 1 | -1): TabId | null => {
    const i = SWIPE_TAB_ORDER.indexOf(from);
    if (i < 0) return null;
    const j = i + dir;
    if (j < 0 || j >= SWIPE_TAB_ORDER.length) return null; // no wrap at the ends
    return SWIPE_TAB_ORDER[j];
  };

  // Slide the current page off `dir` (1 = leftward/next, -1 = rightward/prev) while
  // the next page renders beneath it.
  const slideTo = (tab: TabId, dir: 1 | -1) => {
    const old = document.getElementById('app-root');
    if (!old) { navigateToTab(tab); return; }
    animating = true;

    const scrollY = window.scrollY;
    old.removeAttribute('id'); // free up #app-root for the new page
    old.style.position = 'fixed';
    old.style.top = '0';
    old.style.left = '0';
    old.style.right = '0';
    old.style.zIndex = '60'; // above the new page (incl. its z-40 tab bar)
    old.style.pointerEvents = 'none';
    old.style.willChange = 'transform';
    old.style.transform = `translate3d(0, ${-scrollY}px, 0)`; // hold the scrolled view in place

    const fresh = document.createElement('div');
    fresh.id = 'app-root';
    old.parentNode?.insertBefore(fresh, old);

    window.scrollTo(0, 0);
    navigateToTab(tab); // renders into the new #app-root (sync or async)

    requestAnimationFrame(() => {
      old.style.transition = SLIDE;
      old.style.transform = `translate3d(${dir > 0 ? '-100%' : '100%'}, ${-scrollY}px, 0)`;
    });

    const cleanup = () => {
      old.removeEventListener('transitionend', cleanup);
      old.remove();
      animating = false;
    };
    old.addEventListener('transitionend', cleanup);
    window.setTimeout(() => { if (old.parentNode) cleanup(); }, SLIDE_CLEANUP_MS);
  };

  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  let armed = false;
  let fromTab: TabId | null = null;

  window.addEventListener(
    'touchstart',
    (e) => {
      armed = e.touches.length === 1 && eligible(e.target);
      if (!armed) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      t0 = e.timeStamp;
      fromTab = getActiveTab();
    },
    { passive: true },
  );

  window.addEventListener(
    'touchend',
    (e) => {
      if (!armed || !fromTab) return;
      armed = false;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - x0;
      const dy = touch.clientY - y0;
      const dt = e.timeStamp - t0;
      if (
        dt > MAX_DURATION_MS ||
        Math.abs(dx) < SWIPE_MIN_PX ||
        Math.abs(dx) < Math.abs(dy) * AXIS_RATIO
      ) {
        return; // too slow, too short, or too vertical
      }
      const dir: 1 | -1 = dx < 0 ? 1 : -1; // swipe left = next tab
      const tab = targetTab(fromTab, dir);
      if (tab) slideTo(tab, dir);
    },
    { passive: true },
  );

  window.addEventListener('touchcancel', () => { armed = false; }, { passive: true });
}
