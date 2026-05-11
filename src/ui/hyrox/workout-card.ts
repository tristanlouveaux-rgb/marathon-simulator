/**
 * HYROX workout card component.
 *
 * Three discipline flavours: run (green), station (amber), brick (slate-blue).
 * Station and brick cards show the component list (stations + distances / run distance).
 * MTL chip surfaces on station and brick cards where it's meaningful.
 */

import type { Workout } from '@/types/state';
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { ECCENTRIC_HEAVY_STATIONS } from '@/constants/hyrox-constants';

// ─── Discipline colours ───────────────────────────────────────────────────────

type HyroxDisc = 'run' | 'station' | 'brick';

function discColours(disc: HyroxDisc): { accent: string; badgeBg: string; badgeText: string; label: string } {
  switch (disc) {
    case 'run':
      return { accent: '#7a845c', badgeBg: 'rgba(122,132,92,0.14)', badgeText: '#4f5a3b', label: 'Run' };
    case 'station':
      return { accent: '#b8742c', badgeBg: 'rgba(184,116,44,0.14)', badgeText: '#8a5820', label: 'Station' };
    case 'brick':
      return { accent: '#5b6ea0', badgeBg: 'rgba(91,110,160,0.14)', badgeText: '#3d4f80', label: 'Brick' };
  }
}

function workoutDisc(w: Workout): HyroxDisc {
  if (w.discipline === 'station') return 'station';
  if (w.discipline === 'brick') return 'brick';
  return 'run';
}

// ─── Component list renderer ─────────────────────────────────────────────────

function renderComponents(components: HyroxComponent[]): string {
  if (!components.length) return '';
  const lines = components.map(c => {
    if (c.type === 'run') {
      const km = c.distanceM ? (c.distanceM / 1000).toFixed(c.distanceM >= 1000 ? 0 : 1) : null;
      return `<li style="margin-bottom:2px">${km ? `${km}km run` : 'Run'}</li>`;
    }
    const display = STATION_DISPLAY[c.type as HyroxStation];
    if (!display) return '';
    const dist = c.reps ? `${c.reps} reps` : display.distance;
    return `<li style="margin-bottom:2px">${display.name} — ${dist}</li>`;
  });

  return `
    <ul style="margin:8px 0 0;padding-left:16px;font-size:12px;color:var(--c-muted);line-height:1.5;list-style:disc">
      ${lines.join('')}
    </ul>
  `;
}

// ─── Main card renderer ───────────────────────────────────────────────────────

/**
 * Render a single HYROX workout card.
 * @param w - Workout to render
 * @param opts.interactive - If false, suppresses tap feedback (future-week preview)
 * @param opts.daysToRace  - Days until race. When ≤10, eccentric-heavy sessions show a taper note.
 */
export function renderHyroxWorkoutCard(
  w: Workout,
  opts: { interactive?: boolean; daysToRace?: number | null } = {}
): string {
  const { interactive = true, daysToRace = null } = opts;
  const disc = workoutDisc(w);
  const { accent, badgeBg, badgeText, label } = discColours(disc);

  const dur = w.estimatedDurationMin;
  const durStr = dur ? (dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60 > 0 ? `${dur % 60}m` : ''}`.trim() : `${dur}m`) : null;
  const mtl = w.musculoTendonLoad;
  const showMTL = disc !== 'run' && mtl != null && mtl > 0;
  const id = w.id || w.n;

  const components = (w as any).hyroxComponents as HyroxComponent[] | undefined;
  const showComponents = (disc === 'station' || disc === 'brick') && components?.length;

  // Taper eccentric warning: within 10 days of race AND session contains a high-eccentric station.
  const hasEccentricStation = components?.some(
    c => c.type !== 'run' && ECCENTRIC_HEAVY_STATIONS.includes(c.type as HyroxStation)
  ) ?? false;
  const showTaperWarning = daysToRace != null && daysToRace <= 10 && daysToRace > 0 && hasEccentricStation;

  return `
    <div
      class="hyrox-workout-card"
      data-hx-workout-id="${escAttr(id)}"
      data-hx-day-of-week="${w.dayOfWeek ?? -1}"
      style="
        background:#fff;border-radius:14px;
        padding:16px 18px;margin-bottom:10px;
        box-shadow:0 2px 4px rgba(0,0,0,0.06),0 6px 18px rgba(0,0,0,0.05);
        ${interactive ? 'cursor:pointer;transition:transform 0.15s ease,box-shadow 0.15s ease;' : ''}
      "
    >
      <!-- Badge row -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <span style="display:inline-flex;align-items:center;background:${badgeBg};color:${badgeText};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:3px 9px;border-radius:100px">${label}</span>
        ${durStr ? `<span style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">${durStr}</span>` : ''}
        <span style="flex:1"></span>
        ${showMTL ? `<span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">MTL ${Math.round(mtl!)}</span>` : ''}
        <span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">RPE ${w.rpe ?? w.r ?? 5}</span>
      </div>
      <!-- Name -->
      <div style="font-size:18px;font-weight:700;color:#0F172A;margin-bottom:5px;letter-spacing:-0.01em">${escAttr(w.n)}</div>
      <!-- Description -->
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5">${escAttr(w.d || '')}</div>
      <!-- Component list for station/brick -->
      ${showComponents ? renderComponents(components!) : ''}
      <!-- Taper eccentric warning -->
      ${showTaperWarning ? `
        <div style="margin-top:8px;padding:6px 10px;border-radius:8px;background:rgba(184,116,44,0.07);border:1px solid rgba(184,116,44,0.2);font-size:11px;color:#8a5820;line-height:1.4">
          Race in ${daysToRace} day${daysToRace === 1 ? '' : 's'} — technique pace only for eccentric stations.
        </div>
      ` : ''}
      <!-- Tap CTA -->
      ${interactive ? `
        <div style="margin-top:10px;display:flex;align-items:center;gap:4px;font-size:11px;color:${accent};font-weight:600">
          <span>Tap for details</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>
      ` : ''}
    </div>
  `;
}

function escAttr(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
