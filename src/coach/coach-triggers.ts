/**
 * coach-triggers.ts
 * =================
 * Deterministic detector for proactive coach insights. Runs on app launch
 * (called from main.ts) and appends unseen insights to `state.coachInsightQueue`.
 *
 * The detector is pure state-logic — NO LLM calls. Cost: 0. Only when the user
 * taps the resulting Home card does an LLM call happen (same path as opening
 * Coach manually, counts against the daily rate limit).
 *
 * Guard pattern: each trigger has a `triggerId` that includes an event marker
 * (date, week number, marker value). Once an insight with that id has been
 * appended, the trigger won't fire again — `notifiedMarkers`-style discipline.
 */

import type { SimulatorState } from '@/types/state';
import { computeDailyCoach } from '@/calculations/daily-coach';

export interface CoachInsight {
  triggerId: string;
  headline: string;
  primer: string;
  createdISO: string;
}

/** Inspect state, return any newly fireable insights (excluding ones whose
 *  triggerId already exists in the queue). Caller appends to state. */
export function evaluateCoachTriggers(state: SimulatorState): CoachInsight[] {
  const existing = new Set((state.coachInsightQueue ?? []).map(i => i.triggerId));
  const out: CoachInsight[] = [];

  const push = (insight: CoachInsight) => {
    if (!existing.has(insight.triggerId)) out.push(insight);
  };

  // ─── HRV suppressed ─────────────────────────────────────────────────────────
  // We don't have per-day HRV samples on state, but the daily-coach signal uses
  // a 7-day average. If that average is >15% below baseline, the suppression is
  // persistent. Gate by week so the same trigger doesn't refire daily.
  try {
    const coach = computeDailyCoach(state);
    const sig = coach.signals;
    if (sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0) {
      const pct = (sig.hrv - sig.hrvBaseline) / sig.hrvBaseline;
      if (pct < -0.15) {
        // pct is negative here; use abs() in the user-facing copy so "below
        // baseline" isn't doubly-encoded by the minus sign.
        const pctAbs = Math.abs(Math.round(pct * 100));
        push({
          triggerId: `hrv_low_w${state.w}`,
          headline: `HRV is ${pctAbs}% below baseline this week.`,
          primer: `My 7-day HRV average is ${pctAbs}% below baseline. Should I adjust this week's training?`,
          createdISO: new Date().toISOString(),
        });
      }
    }
  } catch { /* daily-coach can throw on partially hydrated state; skip the trigger */ }

  // ─── Race week — T-7 days out ───────────────────────────────────────────────
  // Tri race date
  const triRaceDateStr = state.triConfig?.raceDate;
  if (triRaceDateStr) {
    const days = Math.floor((new Date(triRaceDateStr).getTime() - Date.now()) / 86_400_000);
    if (days >= 0 && days <= 7) {
      push({
        triggerId: `race_week_${triRaceDateStr}`,
        headline: 'Race week. Want a taper sanity-check?',
        primer: 'It\'s race week. Walk me through the taper, anything I should change or just hold?',
        createdISO: new Date().toISOString(),
      });
    }
  }

  // ─── Marker bump (notable change in FTP / CSS / VDOT since last notified) ──
  const nm = state.triConfig?.notifiedMarkers;
  const triFtp = state.triConfig?.bike?.ftp;
  if (nm && typeof nm.ftp === 'number' && typeof triFtp === 'number') {
    const delta = triFtp - nm.ftp;
    if (Math.abs(delta) >= 5) {
      push({
        triggerId: `ftp_bump_${triFtp}`,
        headline: `FTP refresh: ${delta > 0 ? '+' : ''}${Math.round(delta)} W vs last seen.`,
        primer: `My FTP changed by ${delta > 0 ? '+' : ''}${Math.round(delta)} W. What does that mean for the race plan?`,
        createdISO: new Date().toISOString(),
      });
    }
  }

  // VDOT bump (running)
  if (typeof state.v === 'number' && nm && typeof nm.vdot === 'number') {
    const delta = state.v - nm.vdot;
    if (Math.abs(delta) >= 1) {
      push({
        triggerId: `vdot_bump_${Math.round(state.v * 10)}`,
        headline: `VDOT moved ${delta > 0 ? '+' : ''}${delta.toFixed(1)}.`,
        primer: `My VDOT shifted by ${delta > 0 ? '+' : ''}${delta.toFixed(1)} — should pacing or any sessions change?`,
        createdISO: new Date().toISOString(),
      });
    }
  }

  return out;
}

/** Mark all insights for a given triggerId as seen — called when the user taps
 *  the card to open Coach, or dismisses with the X. */
export function markInsightSeen(state: SimulatorState, triggerId: string): void {
  if (!state.coachInsightQueue) return;
  for (const i of state.coachInsightQueue) {
    if (i.triggerId === triggerId) i.seen = true;
  }
}

export type QueuedInsight = NonNullable<SimulatorState['coachInsightQueue']>[number];

/** Get the top unseen insight, if any. */
export function topUnseenInsight(state: SimulatorState): QueuedInsight | null {
  const q = state.coachInsightQueue;
  if (!q || q.length === 0) return null;
  return q.find(i => !i.seen) ?? null;
}
