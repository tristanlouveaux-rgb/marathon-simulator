/**
 * Marker-bump detector — pure logic. Compares current CSS / FTP / VDOT against
 * the last-notified snapshot stored on `triConfig.notifiedMarkers` and
 * returns a list of "improvement" deltas worth surfacing as toasts.
 *
 * **Side of the line**: tracking. Pure function; the caller (main.ts) owns
 * the toast call AND the state mutation that updates `notifiedMarkers` after
 * surfacing — two-step design so we never accidentally swallow a delta if a
 * render error eats the toast.
 *
 * Thresholds in `triathlon-constants.ts`:
 *   - FTP: +5 W
 *   - CSS: -5 sec/100m (faster = lower)
 *   - VDOT: +1 point
 *
 * Direction: only positive improvements are surfaced. A regression in any
 * marker is silent — it'll show up in the prediction and stats anyway, and
 * we don't want to punish detraining with a popup.
 */

import type { SimulatorState } from '@/types/state';
import {
  MARKER_BUMP_THRESHOLD_FTP_W,
  MARKER_BUMP_THRESHOLD_CSS_SEC,
  MARKER_BUMP_THRESHOLD_VDOT,
} from '@/constants/triathlon-constants';

export interface MarkerBump {
  marker: 'ftp' | 'css' | 'vdot';
  /** Previous value — used in toast copy ("295W → 310W"). Null = first observation. */
  from: number | null;
  to: number;
  /** Magnitude of improvement. Positive for FTP/VDOT (higher better); positive
   *  for CSS too (we represent it as seconds-saved-per-100m for clarity). */
  improvement: number;
  /** Pre-formatted toast text the caller can pass straight into the toast UI. */
  toastText: string;
}

/**
 * Compare current markers against `triConfig.notifiedMarkers` and return any
 * that crossed the threshold in the improving direction. Pure function.
 */
export function detectMarkerBumps(state: SimulatorState): MarkerBump[] {
  const tri = state.triConfig;
  if (!tri) return [];

  const notified = tri.notifiedMarkers ?? {};
  const bumps: MarkerBump[] = [];

  // FTP — higher is better.
  const ftpNow = tri.bike?.ftp;
  if (ftpNow != null && ftpNow > 0) {
    const ftpPrev = notified.ftp ?? null;
    if (ftpPrev != null && ftpNow - ftpPrev >= MARKER_BUMP_THRESHOLD_FTP_W) {
      bumps.push({
        marker: 'ftp',
        from: ftpPrev,
        to: ftpNow,
        improvement: ftpNow - ftpPrev,
        toastText: `FTP improved ${ftpPrev}W → ${ftpNow}W`,
      });
    }
  }

  // CSS — lower sec/100m is better. We surface "improvement" as seconds saved.
  const cssNow = tri.swim?.cssSecPer100m;
  if (cssNow != null && cssNow > 0) {
    const cssPrev = notified.cssSecPer100m ?? null;
    if (cssPrev != null && cssPrev - cssNow >= MARKER_BUMP_THRESHOLD_CSS_SEC) {
      bumps.push({
        marker: 'css',
        from: cssPrev,
        to: cssNow,
        improvement: cssPrev - cssNow,
        toastText: `Swim CSS improved ${fmtCss(cssPrev)} → ${fmtCss(cssNow)}`,
      });
    }
  }

  // VDOT — higher is better.
  const vdotNow = state.v;
  if (vdotNow != null && vdotNow > 0) {
    const vdotPrev = notified.vdot ?? null;
    if (vdotPrev != null && vdotNow - vdotPrev >= MARKER_BUMP_THRESHOLD_VDOT) {
      bumps.push({
        marker: 'vdot',
        from: vdotPrev,
        to: vdotNow,
        improvement: vdotNow - vdotPrev,
        toastText: `VDOT improved ${vdotPrev.toFixed(1)} → ${vdotNow.toFixed(1)}`,
      });
    }
  }

  return bumps;
}

/**
 * After surfacing the bumps to the user, call this to snapshot the current
 * marker values onto `triConfig.notifiedMarkers` so we don't re-pop on the
 * next launch. Mutates state. Caller must `saveState()`.
 *
 * Always called even if no bumps fired — keeps the snapshot fresh against
 * the current values. First-launch behaviour: writes baseline values without
 * surfacing anything (next launch's deltas are then real).
 */
export function snapshotNotifiedMarkers(state: SimulatorState): void {
  const tri = state.triConfig;
  if (!tri) return;
  tri.notifiedMarkers = {
    ftp: tri.bike?.ftp,
    cssSecPer100m: tri.swim?.cssSecPer100m,
    vdot: state.v,
  };
}

function fmtCss(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')}/100m`;
}
