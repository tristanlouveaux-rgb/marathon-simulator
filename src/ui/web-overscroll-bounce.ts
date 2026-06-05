/**
 * Top overscroll spring — all platforms.
 *
 * Neither build rubber-bands natively. On the web (desktop + mobile browsers)
 * the document scroller hits a dead wall at the top. On iOS, Capacitor
 * hardcodes `webView.scrollView.bounces = false` in
 * CAPBridgeViewController.swift (unconditional, no config flag), so WKWebView's
 * native rubber-band never fires either — an earlier version of this file
 * assumed it did and no-op'd on native, which is why the bounce existed on web
 * but not on device. This controller now runs everywhere and adds a matching
 * elastic pull at the top of every page.
 *
 * Mechanics
 * - The scroller is <body>. Page content and the fixed tab bar both live inside
 *   #app-root (each view sets `app-root.innerHTML = ...content... + renderTabBar()`).
 * - We translate only the IN-FLOW children of #app-root (computed position !==
 *   'fixed'). That pins the fixed tab bar and avoids the containing-block trap: a
 *   transform on an ancestor would re-anchor any fixed descendant to it.
 * - Pull distance is damped with Apple's documented UIScrollView rubber-band
 *   curve  b(x) = (1 - 1/((x*c/d) + 1)) * d  with c = 0.55 (the same constant
 *   WebKit uses). The dimension `d` here is MAX_BOUNCE_PX, so the curve follows
 *   input at ~0.55x near zero and asymptotes to that small cap — the page can
 *   never sag far no matter how hard you flick.
 * - Touch (mobile web): finger drives the pull 1:1, then springs back on release.
 * - Wheel/trackpad: a hard flick emits a long momentum tail of events. Holding
 *   the pull for that whole tail reads as lag, so the wheel path runs a per-frame
 *   decay loop instead — fresh input adds impulse, every frame bleeds it off, so
 *   the momentum tail eases back smoothly rather than being held then snapped.
 *
 * Guard: listeners are on `window`, so we only act when the gesture target is
 * inside #app-root. When a full-screen overlay/modal is open (those are appended
 * to <body>, not #app-root) the target is inside the overlay and we skip — the
 * page behind the modal never bounces.
 */

const RUBBER = 0.55; // Apple UIScrollView rubber-band constant (WebKit)
const MAX_BOUNCE_PX = 130; // visual cap on how far the page pulls down (UI value)
const WHEEL_DECAY = 0.82; // per-frame pull bleed-off for trackpad/wheel momentum
const SPRING = 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)'; // touch release ease

export function installWebOverscrollBounce(): void {
  if (typeof window === 'undefined') return;

  // Suppress the browser's own overscroll (white rubber-band on iOS Safari,
  // pull-to-refresh / glow on Chrome) so our spring is the only overscroll
  // affordance and a hard momentum fling to the top can never flash the bare body
  // colour. Set on both html and body since which one is the scroller varies.
  // Harmless on the Capacitor build — native bounce is already off there.
  document.documentElement.style.overscrollBehavior = 'none';
  document.body.style.overscrollBehavior = 'none';

  let targets: HTMLElement[] = [];
  let pull = 0; // raw accumulated overscroll in px (pre-damping)
  let appliedY = 0; // last damped offset actually painted
  let active = false;
  let wheelTicking = false;
  let raf = 0;

  const appRootHas = (target: EventTarget | null): boolean => {
    const root = document.getElementById('app-root');
    return !!root && !!target && root.contains(target as Node);
  };

  // What moves during the bounce: the IN-FLOW content *inside* each page wrapper,
  // not the wrapper itself. Every view wraps its content in a `min-height:100vh`
  // root div that carries the page background (a solid colour or the atmosphere
  // gradient via `atmosphereGradient()`). If we translated that wrapper, its
  // gradient would slide down with the content and expose the bare body colour
  // above — the white flash at the top. Translating only the wrapper's in-flow
  // children (skipping absolute/fixed decorative layers: atmosphere base, sun
  // glint, rings, and the fixed tab bar) leaves the gradient pinned, so the gap
  // revealed at the top shows the sky end of the atmosphere — matching iOS.
  const isInFlow = (el: HTMLElement): boolean => {
    const pos = getComputedStyle(el).position;
    return pos === 'static' || pos === 'relative';
  };

  const collectTargets = (): HTMLElement[] => {
    const root = document.getElementById('app-root');
    if (!root) return [];
    const out: HTMLElement[] = [];
    for (const wrap of root.children) {
      if (!(wrap instanceof HTMLElement) || !isInFlow(wrap)) continue; // skip fixed tab bar
      const kids = [...wrap.children].filter(
        (el): el is HTMLElement => el instanceof HTMLElement && isInFlow(el),
      );
      if (kids.length) out.push(...kids);
      else out.push(wrap); // no inner content layer — move the node itself
    }
    return out;
  };

  const damp = (raw: number): number => {
    if (raw <= 0) return 0;
    return (1 - 1 / ((raw * RUBBER) / MAX_BOUNCE_PX + 1)) * MAX_BOUNCE_PX;
  };

  const applyTransform = () => {
    appliedY = damp(pull);
    const t = appliedY > 0.5 ? `translate3d(0, ${appliedY.toFixed(1)}px, 0)` : '';
    for (const el of targets) el.style.transform = t;
  };

  const begin = () => {
    if (active) return;
    active = true;
    targets = collectTargets();
    for (const el of targets) el.style.transition = 'none';
  };

  // Touch release: spring the (still-extended) content back to rest.
  const springBack = () => {
    if (!active) return;
    active = false;
    pull = 0;
    const sprung = appliedY > 0.5;
    appliedY = 0;
    for (const el of targets) {
      if (sprung) {
        el.style.transition = SPRING;
        el.style.transform = '';
        const clear = () => {
          el.style.transition = '';
          el.removeEventListener('transitionend', clear);
        };
        el.addEventListener('transitionend', clear);
      } else {
        el.style.transition = '';
        el.style.transform = '';
      }
    }
  };

  // ── Touch (mobile web) — engage at the top boundary, even mid-gesture ───────
  // Eligibility is NOT locked to scrollY at touchstart: a drag that begins
  // mid-page and continues down past the top must still bounce. We anchor the
  // moment the scroll first reaches the top, then treat further downward travel
  // from that anchor as the overscroll pull.
  let touchInRoot = false;
  let touchActive = false;
  let anchorY: number | null = null;

  const scheduleTouchPaint = () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; applyTransform(); });
  };

  window.addEventListener(
    'touchstart',
    (e) => {
      touchInRoot = appRootHas(e.target); // skip only when an overlay owns the screen
      anchorY = null;
      touchActive = false;
    },
    { passive: true },
  );

  window.addEventListener(
    'touchmove',
    (e) => {
      if (!touchInRoot) return;
      const y = e.touches[0]?.clientY ?? 0;
      if (window.scrollY <= 0) {
        if (anchorY === null) anchorY = y; // just reached the top — anchor here
        const over = y - anchorY; // downward travel past the top
        if (over > 0) {
          e.preventDefault(); // own the overscroll; suppress native bounce / refresh
          begin();
          touchActive = true;
          pull = over;
          scheduleTouchPaint();
          return;
        }
        if (touchActive) { pull = 0; scheduleTouchPaint(); }
      } else {
        // Scrolling within content — let native scroll run, re-anchor next time.
        anchorY = null;
        if (touchActive) { touchActive = false; springBack(); }
      }
    },
    { passive: false },
  );

  const endTouch = () => {
    if (touchActive) springBack();
    touchActive = false;
    touchInRoot = false;
    anchorY = null;
  };
  window.addEventListener('touchend', endTouch, { passive: true });
  window.addEventListener('touchcancel', endTouch, { passive: true });

  // ── Wheel / trackpad (desktop) — impulse + per-frame decay ──────────────────
  const wheelTick = () => {
    if (touchActive) { wheelTicking = false; return; } // touch owns the gesture
    pull *= WHEEL_DECAY;
    if (pull < 0.5) {
      wheelTicking = false;
      pull = 0;
      appliedY = 0;
      for (const el of targets) { el.style.transition = ''; el.style.transform = ''; }
      active = false;
      return;
    }
    applyTransform();
    requestAnimationFrame(wheelTick);
  };

  window.addEventListener(
    'wheel',
    (e) => {
      const atTop = window.scrollY <= 0;
      // Only a genuine upward pull at the very top feeds the bounce. Anything else
      // is ignored; the decay loop cleans up any residual pull on its own.
      if (!atTop || e.deltaY >= 0 || !appRootHas(e.target)) return;
      e.preventDefault();
      begin();
      pull += -e.deltaY;
      if (!wheelTicking) { wheelTicking = true; requestAnimationFrame(wheelTick); }
    },
    { passive: false },
  );
}
