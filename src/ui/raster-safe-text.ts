/**
 * Raster-safe text swapping for WKWebView glass surfaces.
 *
 * Text that lives inside a `backdrop-filter:blur(...)` glass card retains its
 * old glyph raster when only `textContent` is mutated. On WKWebView the new
 * text then composites on top of the stale bitmap — the "LcReading your
 * physiologyry" ghost seen on the onboarding loading screens. An opacity fade
 * does NOT invalidate that cached raster (the bug recurred for months under a
 * fade-then-mutate approach).
 *
 * The reliable fix is to REPLACE THE NODE rather than mutate its text. A
 * brand-new DOM node forces a fresh raster: the compositor cannot carry over a
 * bitmap for a node that did not previously exist. `cloneNode(false)` preserves
 * the id, class and inline styling so the swap is seamless.
 *
 * Use these helpers for ANY text that updates in place inside a glassy /
 * backdrop-filter surface (loading labels, progress counters, status lines).
 */

/**
 * Instantly swap an element's text by replacing the node. No fade — use for
 * rapidly-updating text such as progress counters ("Reading archive… 4/12")
 * where a cross-fade on every tick would distract.
 *
 * Returns the live node (the fresh replacement, or the original when the text
 * was unchanged). Callers that hold a reference across multiple updates must
 * either reassign from the return value or re-query by id each call, because
 * the original node is detached after the first swap.
 */
export function setRasterSafeText(el: HTMLElement, newText: string): HTMLElement {
  if ((el.textContent ?? '') === newText) return el;
  const fresh = el.cloneNode(false) as HTMLElement;
  fresh.textContent = newText;
  el.replaceWith(fresh);
  return fresh;
}

/**
 * Cross-fade an element's text: fade to opacity 0, then once the old glyphs are
 * invisible replace the node with a fresh clone carrying the new text and fade
 * that in. Use for calm label transitions (onboarding step labels, status
 * lines) where the change should feel smooth rather than snap.
 *
 * `fadeMs` MUST match the element's CSS `transition: opacity` duration so the
 * swap fires only once the old text is fully faded — swapping mid-fade reveals
 * the half-faded old glyphs under the new text. The caller owns the
 * pending-timer slot (`getTimer`/`setTimer`) so a fresh swap cancels an
 * in-flight one and fades can't stack. No-op when the text is unchanged
 * (prevents needless re-fades on a heartbeat). Requires the element to carry a
 * class with the matching opacity transition.
 */
export function swapFadedText(
  el: HTMLElement,
  newText: string,
  getTimer: () => number | null,
  setTimer: (id: number | null) => void,
  fadeMs = 240,
): void {
  if ((el.textContent ?? '').trim() === newText.trim()) return;
  const pending = getTimer();
  if (pending !== null) window.clearTimeout(pending);
  el.style.opacity = '0';
  setTimer(window.setTimeout(() => {
    setTimer(null);
    // Re-query: another swap (or a full re-render) may have replaced the node
    // while this fade was in flight. Operate on whatever currently carries the id.
    const live = (el.id ? document.getElementById(el.id) : null) ?? el;
    if (!live.isConnected) return;
    const fresh = live.cloneNode(false) as HTMLElement;
    fresh.textContent = newText;
    fresh.style.opacity = '0';
    live.replaceWith(fresh);
    void fresh.offsetHeight; // force layout so opacity 0 → 1 actually transitions
    fresh.style.opacity = '1';
  }, fadeMs));
}
