/**
 * Triathlon race-forecast marquee card.
 *
 * Glass-style hero card composed of:
 *   - distance label
 *   - big projected finish time
 *   - "−X min vs today" gap callout
 *   - tolerance line ("±N min · narrows to race day")
 *   - injury recovery note (only when an injury is active — explains how the
 *     forecast factors in blocked/reduced disciplines)
 *   - three per-leg cards (Swim / Bike / Run) with a coloured accent bar each,
 *     showing the projected leg time plus the gap vs today
 *
 * Numbers come from `tri.prediction ?? predictTriathlonRace(state)` — the
 * cached prediction is invalidated on injury change (see injury/modal.ts), so
 * what renders here always reflects the user's current injury state.
 */

import type { SimulatorState } from '@/types/state';
import type { InjuryState } from '@/types/injury';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { isInjuryActive } from '@/ui/injury/modal';
import { getDisciplineCapacity, type DisciplineKey } from '@/injury/engine';
import { ft } from '@/utils/format';

// Vibrant per-leg accents matching the Xcode marquee build. The muted
// DISCIPLINE_COLOURS palette is used for badge chips and load bars elsewhere;
// this marquee uses saturated chart-style accents so the per-leg cards read at
// a glance as the headline summary they are.
const LEG_ACCENT = {
  swim: '#3B82F6',  // blue
  bike: '#DC2626',  // red
  run:  '#16A34A',  // green
} as const;

function fmtShortSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function legCard(
  label: string,
  sec: number,
  currentSec: number | undefined,
  accent: string,
  derivedFlag: boolean,
): string {
  const gap = currentSec != null ? currentSec - sec : null;
  const showGap = gap != null && Math.abs(gap) >= 30;
  const gapColor = gap != null && gap > 0 ? '#16A34A' : '#94A3B8';
  const gapSign = gap != null && gap > 0 ? '−' : '+';
  return `
    <div style="flex:1;min-width:0;border-left:3px solid ${accent};padding:8px 0 8px 12px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <div style="font-size:11px;font-weight:600;color:#64748B;letter-spacing:0.06em;text-transform:uppercase">${label}</div>
        ${derivedFlag ? `<span style="font-size:9px;color:#a89060;background:#FAF3E2;padding:1px 6px;border-radius:6px;font-weight:600;letter-spacing:0.02em">derived</span>` : ''}
      </div>
      <div style="font-size:21px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;font-variant-numeric:tabular-nums;line-height:1.1">${ft(sec)}</div>
      ${showGap ? `<div style="font-size:11px;color:${gapColor};margin-top:5px;font-variant-numeric:tabular-nums;line-height:1.3">${gapSign}${fmtShortSec(Math.abs(gap!))} vs today</div>` : ''}
    </div>
  `;
}

// ── Injury recovery note ─────────────────────────────────────────────────────
//
// Reads InjuryState.resumeWeeksByDiscipline + getDisciplineCapacity per
// discipline. Composes a one-paragraph note that explains how the forecast is
// adjusted for an active injury. Three discipline groups:
//   - blocked   capacity === 0
//   - reduced   0 < capacity < 100
//   - normal    capacity === 100
// Copy is dynamic but matches the canonical phrasing used in the Xcode build.

function naturalJoin(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function renderInjuryRecoveryNote(s: SimulatorState): string {
  if (!isInjuryActive()) return '';
  const inj: InjuryState | undefined = s.injuryState;
  if (!inj) return '';

  const DISCS: Array<{ key: DisciplineKey; label: string }> = [
    { key: 'swim', label: 'swim' },
    { key: 'bike', label: 'bike' },
    { key: 'run',  label: 'run'  },
  ];

  const blocked: Array<{ label: string; weeks: number | undefined }> = [];
  const reduced: string[] = [];
  for (const d of DISCS) {
    const cap = getDisciplineCapacity(inj, d.key);
    if (cap === 0) {
      blocked.push({ label: d.label, weeks: inj.resumeWeeksByDiscipline?.[d.key] });
    } else if (cap < 100) {
      reduced.push(d.label);
    }
  }

  if (blocked.length === 0 && reduced.length === 0) return '';

  let body = '';
  if (blocked.length > 0) {
    const labels = naturalJoin(blocked.map(b => b.label));
    const verb = blocked.length === 1 ? 'resumes' : 'resume';
    // Take the weeks range across the blocked disciplines so we can say
    // "3 to 4 weeks" when they differ, or just "3 weeks" when they agree.
    const weeks = blocked.map(b => b.weeks).filter((w): w is number => typeof w === 'number');
    let weeksTxt = '';
    if (weeks.length > 0) {
      const lo = Math.min(...weeks);
      const hi = Math.max(...weeks);
      weeksTxt = lo === hi ? ` in ${lo} weeks` : ` in ${lo} to ${hi} weeks`;
    }
    body += `${labels} ${verb}${weeksTxt}`;
  }

  if (reduced.length > 0) {
    const labels = naturalJoin(reduced);
    const verb = reduced.length === 1 ? 'is reduced' : 'are reduced';
    if (blocked.length > 0) {
      body += `, ${labels} ${verb} until then`;
    } else {
      body += `${labels} ${verb}`;
    }
  }

  // Capitalise the first letter of the body.
  const bodyCap = body.charAt(0).toUpperCase() + body.slice(1);

  return `
    <div style="font-size:13px;color:#64748B;line-height:1.5;text-align:center;margin:14px 22px 6px;padding:0">
      Assumes recovery on schedule: ${bodyCap}. Counts each sport only for the weeks it can train.
    </div>
  `;
}

// ── Public render ────────────────────────────────────────────────────────────

export function renderTriForecastMarquee(s: SimulatorState): string {
  const tri = s.triConfig;
  if (!tri) return '';
  const p = tri.prediction ?? predictTriathlonRace(s);
  if (!p || !p.totalSec) return '';

  const distLabel = tri.distance === 'ironman' ? 'Ironman forecast' : '70.3 forecast';
  const halfBandSec = Math.round((p.totalRangeSec[1] - p.totalRangeSec[0]) / 4);
  const halfBandMin = Math.max(1, Math.round(halfBandSec / 60));
  const weeksRemaining = p.projection?.weeksRemaining ?? 0;
  const willNarrow = weeksRemaining > 4;

  // Total gap vs today.
  const gap = p.currentTotalSec != null ? p.currentTotalSec - p.totalSec : null;
  const gapMin = gap != null ? Math.round(gap / 60) : null;
  const showGap = gapMin != null && Math.abs(gapMin) >= 1;
  const gapColor = gap != null && gap > 0 ? '#16A34A' : '#94A3B8';
  const gapSign = gap != null && gap > 0 ? '−' : '+';

  // Derived-marker flags. Surface only when the source of the marker is the
  // auto-derived path (i.e. no explicit user benchmark test).
  const bikeFtpSource = (tri.bike as { ftpSource?: string } | undefined)?.ftpSource;
  const swimCssSource = (tri.swim as { cssSource?: string } | undefined)?.cssSource;
  const bikeDerived = bikeFtpSource === 'derived';
  const swimDerived = swimCssSource === 'derived';

  return `
    <div style="
      background:linear-gradient(180deg,rgba(255,255,255,0.78) 0%,rgba(240,247,255,0.62) 100%);
      backdrop-filter:blur(20px);
      -webkit-backdrop-filter:blur(20px);
      border:1px solid rgba(255,255,255,0.65);
      border-radius:20px;
      box-shadow:0 4px 14px rgba(15,23,42,0.06),0 12px 32px rgba(15,23,42,0.06);
      padding:22px 4px 18px;
      margin-bottom:14px;
    ">
      <div style="font-size:13px;color:#64748B;text-align:center;font-weight:500">${distLabel}</div>

      <div style="font-size:48px;font-weight:300;color:#0F172A;letter-spacing:-0.03em;line-height:1;text-align:center;margin-top:8px;font-variant-numeric:tabular-nums">${ft(p.totalSec)}</div>

      ${showGap
        ? `<div style="font-size:14px;font-weight:500;color:${gapColor};text-align:center;margin-top:10px;font-variant-numeric:tabular-nums">${gapSign}${Math.abs(gapMin!)} min vs today</div>`
        : ''}

      <div style="font-size:12px;color:#94A3B8;text-align:center;margin-top:6px">±${halfBandMin} min${willNarrow ? ' · narrows to race day' : ''}</div>

      ${renderInjuryRecoveryNote(s)}

      <div style="display:flex;gap:0;margin:18px 18px 0;padding-top:4px">
        ${legCard('Swim', p.swimSec, p.currentSwimSec, LEG_ACCENT.swim, swimDerived)}
        ${legCard('Bike', p.bikeSec, p.currentBikeSec, LEG_ACCENT.bike, bikeDerived)}
        ${legCard('Run',  p.runSec,  p.currentRunSec,  LEG_ACCENT.run,  false)}
      </div>
    </div>
  `;
}
