/**
 * HYROX plan view.
 *
 * Mirrors `src/ui/triathlon/plan-view.ts` in structure.
 * Three-discipline mini-bars: Run | Station | Brick.
 * Benchmark calibration card surfaces on current week until done or dismissed.
 */

import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { renderHyroxWorkoutCard } from './workout-card';
import {
  renderHyroxBenchmarkCard,
  wireHyroxBenchmarkCard,
  shouldShowBenchmarkCard,
} from './benchmark-card';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from '../page-flair';
import type { Workout } from '@/types/state';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ─── Module-level navigation state ───────────────────────────────────────────
let _viewWeek: number | null = null;
let _dragSuppressClick = false;

function navigateTab(tab: TabId): void {
  _viewWeek = null;
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'forecast') {
    import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderHyroxStatsView }) => renderHyroxStatsView());
  } else if (tab === 'account') {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render
// ─────────────────────────────────────────────────────────────────────────────

export function renderHyroxPlanView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const hx = s.hyroxConfig;
  if (!hx) return;

  const viewWeek = _viewWeek ?? s.w;
  const isFutureWeek = viewWeek > s.w;
  const wk = s.wks?.[viewWeek - 1];
  const workouts: Workout[] = wk?.triWorkouts ?? [];

  const band = hx.athleteBand;
  const format = hx.format ?? 'open_singles';
  const phase = wk?.ph ? capitalize(wk.ph) : '';
  const raceDate = hx.raceDate ?? s.onboarding?.customRaceDate;
  const raceDays = raceDate ? daysUntil(raceDate) : 0;
  const raceCountdownDisplay = raceDays > 14 ? `${Math.floor(raceDays / 7)}` : `${raceDays}`;
  const raceCountdownUnit = raceDays > 14 ? 'weeks' : 'days';

  // Weekly totals
  const totalMin = workouts.reduce((acc, w) => acc + estimateMinutes(w), 0);
  const totalMtl = workouts.reduce((acc, w) => acc + (w.musculoTendonLoad ?? 0), 0);

  // Per-discipline minute totals
  const minByDisc = { run: 0, station: 0, brick: 0 };
  for (const w of workouts) {
    const d = w.discipline as string;
    if (d === 'station') minByDisc.station += estimateMinutes(w);
    else if (d === 'brick') minByDisc.brick += estimateMinutes(w);
    else minByDisc.run += estimateMinutes(w);
  }

  // Group by day
  const byDay: Record<number, Workout[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const w of workouts) {
    const d = w.dayOfWeek ?? 4;
    byDay[d] = byDay[d] ?? [];
    byDay[d].push(w);
  }

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  const bandLabel = band.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  container.innerHTML = `
    <style>
      @keyframes hxFloatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hxf { opacity:0; animation:hxFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>
    <div class="mosaic-page" style="background:${atmosphereGradient('sky')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxp', { variant: 'asymmetric', side: 'right', palette: 'sky', pulse: true })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Header — race countdown + avatar only (action buttons live in pill row) -->
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px" class="hxf">
          ${raceDays > 0 ? `
            <div style="display:flex;align-items:baseline;gap:4px;padding:4px 14px;border-radius:100px;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.06)">
              <span style="font-size:11px;font-weight:500;color:#64748B">Race in</span>
              <span style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:#0F172A;line-height:1">${raceCountdownDisplay}</span>
              <span style="font-size:11px;font-weight:500;color:#64748B">${raceCountdownUnit}</span>
            </div>
          ` : ''}
          <button id="hx-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <!-- Hero with pill row matching triathlon -->
        <div class="hxf" style="text-align:center;padding:20px 20px 10px;animation-delay:0.06s">
          <div style="font-size:48px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;line-height:1">HYROX</div>
          <div style="font-size:15px;font-weight:500;color:#64748B;margin-top:6px">${bandLabel} · ${(format === 'pro_singles' || format === 'pro_doubles') ? 'Pro' : 'Open'} ${(format === 'open_doubles' || format === 'pro_doubles') ? 'Doubles' : 'Singles'}</div>
          ${phase ? `<div style="font-size:17px;font-weight:700;color:#0F172A;margin-top:8px;letter-spacing:-0.01em">${phase}</div>` : ''}
          ${s.w && s.tw ? `<div style="font-size:14px;font-weight:500;color:#64748B;margin-top:4px">${s.w > s.tw ? 'Plan complete' : `Week ${s.w} of ${s.tw}`}</div>` : ''}

          ${viewWeek === s.w ? `
            <div style="display:flex;justify-content:center;gap:8px;margin-top:18px;flex-wrap:wrap">
              <button id="hx-add-session-btn" class="m-btn-glass">+ Add session</button>
            </div>
          ` : ''}
        </div>

        <!-- Weekly summary strip -->
        <div class="hxf" style="padding:16px 20px 8px;animation-delay:0.10s">
          <div style="background:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);display:flex;gap:16px;justify-content:space-between">
            <div style="flex:1;text-align:center">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Weekly hours</div>
              <div style="font-size:20px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${fmtHours(totalMin)}</div>
            </div>
            <div style="flex:1;text-align:center;border-left:1px solid rgba(0,0,0,0.06);border-right:1px solid rgba(0,0,0,0.06)">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Sessions</div>
              <div style="font-size:20px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${workouts.length}</div>
            </div>
            <div style="flex:1;text-align:center">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">MTL load</div>
              <div style="font-size:20px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${Math.round(totalMtl)}</div>
            </div>
          </div>
          <!-- Discipline mini-bars -->
          <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            ${renderDisciplineMini('run', minByDisc.run, totalMin)}
            ${renderDisciplineMini('station', minByDisc.station, totalMin)}
            ${renderDisciplineMini('brick', minByDisc.brick, totalMin)}
          </div>
          <div style="text-align:center;font-size:11px;color:var(--c-faint);margin-top:6px">Hours per discipline this week</div>
        </div>

        <!-- Week navigation pills -->
        <div class="hxf" style="padding:8px 20px 8px;animation-delay:0.14s">
          <div style="display:flex;gap:5px;overflow-x:auto;padding:2px 0;-webkit-overflow-scrolling:touch">
            ${Array.from({ length: s.tw ?? 18 }, (_, i) => {
              const wkNum = i + 1;
              const active = wkNum === viewWeek;
              return `<button data-hx-week-nav="${wkNum}" style="flex-shrink:0;min-width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:${active ? 600 : 500};font-variant-numeric:tabular-nums;border-radius:8px;border:none;background:${active ? '#0F172A' : 'rgba(255,255,255,0.75)'};color:${active ? '#fff' : 'var(--c-muted)'};box-shadow:${active ? '0 2px 6px rgba(0,0,0,0.15)' : '0 1px 2px rgba(0,0,0,0.04)'};cursor:pointer">${wkNum}</button>`;
            }).join('')}
          </div>
        </div>

        <!-- Future-week draft banner -->
        ${isFutureWeek ? `<div style="margin:4px 20px 8px;padding:12px 15px;background:rgba(255,255,255,0.7);border:1px solid rgba(0,0,0,0.06);border-radius:12px;font-size:13px;font-weight:500;color:#64748B;line-height:1.5">Draft. Final workouts depend on the preceding week\'s performance.</div>` : ''}

        <!-- Benchmark calibration card (current week only) -->
        ${shouldShowBenchmarkCard(s, viewWeek) ? renderHyroxBenchmarkCard(s) : ''}

        <!-- Day-by-day -->
        <div class="hxf" style="padding:12px 20px;animation-delay:0.18s">
          ${Array.from({ length: 7 }, (_, d) => renderDay(d, byDay[d] ?? [], isFutureWeek, raceDays > 0 ? raceDays : null)).join('')}
        </div>

      </div>

      ${renderTabBar('plan')}
    </div>
  `;

  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Benchmark card
  if (shouldShowBenchmarkCard(s, viewWeek)) {
    wireHyroxBenchmarkCard(() => renderHyroxPlanView());
  }

  // Account button
  document.getElementById('hx-account-btn')?.addEventListener('click', () => navigateTab('account'));

  // Add session button — opens the HYROX-specific session picker.
  // Lets the user add a session in keeping with the current week's phase.
  document.getElementById('hx-add-session-btn')?.addEventListener('click', () => {
    import('./add-session-modal').then(({ openHyroxAddSessionModal }) =>
      openHyroxAddSessionModal(() => renderHyroxPlanView())
    );
  });

  // Week navigation pills
  document.querySelectorAll<HTMLElement>('[data-hx-week-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wkNum = parseInt(btn.getAttribute('data-hx-week-nav') || '0', 10);
      if (!wkNum) return;
      _viewWeek = wkNum === getState().w ? null : wkNum;
      renderHyroxPlanView();
    });
  });

  // Workout card tap → detail modal (current week only)
  document.querySelectorAll<HTMLElement>('.hyrox-workout-card').forEach((el) => {
    el.addEventListener('click', () => {
      if (isFutureWeek) return;
      if (_dragSuppressClick) { _dragSuppressClick = false; return; }
      const id = el.getAttribute('data-hx-workout-id');
      if (!id) return;
      const st = getState();
      const wkRow = st.wks?.[viewWeek - 1];
      const found = (wkRow?.triWorkouts ?? []).find((x: any) => (x.id || x.n) === id);
      if (found) {
        import('./workout-detail-modal').then(({ openHyroxWorkoutDetail }) => openHyroxWorkoutDetail(found));
      }
    });
  });

  wireHyroxWorkoutTouchDnd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Touch DnD — reorder within week (same pattern as triathlon plan-view)
// ─────────────────────────────────────────────────────────────────────────────

let _touchDragId = '';
let _touchDragDay = -1;
let _touchStartX = 0;
let _touchStartY = 0;
let _touchDragging = false;
let _touchClone: HTMLElement | null = null;
let _touchSourceCard: HTMLElement | null = null;
let _touchLastHighlight: HTMLElement | null = null;

function wireHyroxWorkoutTouchDnd(): void {
  document.querySelectorAll<HTMLElement>('.hyrox-workout-card').forEach((card) => {
    card.addEventListener('touchstart', (e) => {
      _touchDragId = card.getAttribute('data-hx-workout-id') || '';
      _touchDragDay = parseInt(card.getAttribute('data-hx-day-of-week') || '-1', 10);
      const touch = e.touches[0];
      _touchStartX = touch.clientX;
      _touchStartY = touch.clientY;
      _touchDragging = false;
      _touchSourceCard = card;
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!_touchDragId) return;
      const touch = e.touches[0];
      const dx = touch.clientX - _touchStartX;
      const dy = touch.clientY - _touchStartY;
      if (!_touchDragging && Math.sqrt(dx * dx + dy * dy) < 8) return;

      if (!_touchDragging) {
        _touchDragging = true;
        if (_touchSourceCard) _touchSourceCard.style.opacity = '0.4';
        _touchClone = card.cloneNode(true) as HTMLElement;
        _touchClone.style.cssText = `position:fixed;pointer-events:none;opacity:0.75;z-index:9999;width:${card.offsetWidth}px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,0.18);`;
        document.body.appendChild(_touchClone);
      }

      e.preventDefault();
      if (_touchClone) {
        _touchClone.style.left = `${touch.clientX - card.offsetWidth / 2}px`;
        _touchClone.style.top  = `${touch.clientY - 30}px`;
      }

      if (_touchLastHighlight) {
        _touchLastHighlight.style.outline = '';
        _touchLastHighlight.style.background = '';
        _touchLastHighlight = null;
      }

      if (_touchClone) _touchClone.style.visibility = 'hidden';
      const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
      if (_touchClone) _touchClone.style.visibility = '';

      const targetCard = el?.closest<HTMLElement>('.hyrox-workout-card');
      if (targetCard && targetCard !== card) {
        targetCard.style.outline = '2px solid #0F172A';
        targetCard.style.outlineOffset = '-2px';
        _touchLastHighlight = targetCard;
        return;
      }
      const targetRow = el?.closest<HTMLElement>('.hx-day-row');
      if (targetRow && !el?.closest('.hyrox-workout-card')) {
        const tDay = parseInt(targetRow.getAttribute('data-hx-day-drop') || '-1', 10);
        if (tDay >= 0 && tDay !== _touchDragDay) {
          targetRow.style.background = 'rgba(15,23,42,0.04)';
          _touchLastHighlight = targetRow;
        }
      }
    }, { passive: false });

    card.addEventListener('touchend', (e) => {
      if (!_touchDragging || !_touchDragId) {
        _touchDragId = '';
        _touchDragDay = -1;
        _touchSourceCard = null;
        _touchDragging = false;
        return;
      }

      if (_touchClone) { _touchClone.remove(); _touchClone = null; }
      if (_touchSourceCard) { _touchSourceCard.style.opacity = ''; }
      if (_touchLastHighlight) {
        _touchLastHighlight.style.outline = '';
        _touchLastHighlight.style.background = '';
        _touchLastHighlight = null;
      }

      const touch = e.changedTouches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;

      const srcId = _touchDragId;
      const srcDay = _touchDragDay;
      _touchDragId = '';
      _touchDragDay = -1;
      _touchDragging = false;
      _touchSourceCard = null;
      _dragSuppressClick = true;
      setTimeout(() => { _dragSuppressClick = false; }, 0);

      const targetCard = el?.closest<HTMLElement>('.hyrox-workout-card');
      if (targetCard && targetCard !== card) {
        const targetId = targetCard.getAttribute('data-hx-workout-id') || '';
        const targetDay = parseInt(targetCard.getAttribute('data-hx-day-of-week') || '-1', 10);
        if (targetId && targetDay >= 0 && targetDay !== srcDay) {
          swapWorkoutDays(srcId, targetId, srcDay, targetDay);
          renderHyroxPlanView();
          return;
        }
      }
      const targetRow = el?.closest<HTMLElement>('.hx-day-row');
      if (targetRow && !el?.closest('.hyrox-workout-card')) {
        const targetDay = parseInt(targetRow.getAttribute('data-hx-day-drop') || '-1', 10);
        if (targetDay >= 0 && targetDay !== srcDay) {
          moveWorkoutToDay(srcId, targetDay);
          renderHyroxPlanView();
        }
      }
    });
  });
}

function swapWorkoutDays(idA: string, idB: string, dayA: number, dayB: number): void {
  const ms = getMutableState();
  const wk = ms.wks?.[ms.w - 1];
  if (!wk?.triWorkouts) return;
  const a = wk.triWorkouts.find((w: Workout) => (w.id || w.n) === idA);
  const b = wk.triWorkouts.find((w: Workout) => (w.id || w.n) === idB);
  if (!a || !b) return;
  a.dayOfWeek = dayB;
  b.dayOfWeek = dayA;
  saveState();
}

function moveWorkoutToDay(id: string, targetDay: number): void {
  const ms = getMutableState();
  const wk = ms.wks?.[ms.w - 1];
  if (!wk?.triWorkouts) return;
  const w = wk.triWorkouts.find((x: Workout) => (x.id || x.n) === id);
  if (w) { w.dayOfWeek = targetDay; saveState(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Day renderer
// ─────────────────────────────────────────────────────────────────────────────

function renderDay(d: number, list: Workout[], isFutureWeek: boolean, daysToRace: number | null): string {
  const dayLabel = DAY_NAMES[d];
  if (list.length === 0) {
    return `
      <div class="hx-day-row" data-hx-day-drop="${d}" style="margin-bottom:14px;padding:6px 8px;border-radius:10px;transition:background 0.15s">
        <div style="display:flex;align-items:center;gap:12px;border-radius:6px">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-muted);min-width:40px">${dayLabel}</span>
          <span style="flex:1;height:1px;background:rgba(0,0,0,0.06)"></span>
          <span style="font-size:11px;color:var(--c-faint);font-weight:500">Rest</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="hx-day-row" data-hx-day-drop="${d}" style="margin-bottom:16px;padding:6px 8px;border-radius:10px;transition:background 0.15s">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;border-radius:6px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#0F172A;min-width:40px">${dayLabel}</span>
        <span style="flex:1;height:1px;background:rgba(0,0,0,0.06)"></span>
        <span style="font-size:11px;color:var(--c-faint);font-weight:500">${list.length > 1 ? `${list.length} sessions` : ''}</span>
      </div>
      ${list.map((w) => renderHyroxWorkoutCard(w, { interactive: !isFutureWeek, daysToRace })).join('')}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderDisciplineMini(d: 'run' | 'station' | 'brick', mins: number, totalMin: number): string {
  const colour = d === 'run' ? '#7a845c' : d === 'station' ? '#b8742c' : '#5b6ea0';
  const label = d === 'run' ? 'Run' : d === 'station' ? 'Station' : 'Brick';
  const pct = totalMin > 0 ? Math.round((mins / totalMin) * 100) : 0;
  return `
    <div style="background:#fff;border-radius:10px;padding:8px 10px;box-shadow:0 1px 2px rgba(0,0,0,0.04)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:10px;font-weight:600;color:${colour};letter-spacing:0.04em;text-transform:uppercase">${label}</span>
        <span style="font-size:11px;color:var(--c-muted);font-variant-numeric:tabular-nums">${fmtHours(mins)}</span>
      </div>
      <div style="height:3px;background:rgba(0,0,0,0.05);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${colour};transition:width 0.3s"></div>
      </div>
    </div>
  `;
}

function fmtHours(mins: number): string {
  if (mins <= 0) return '—';
  const rounded = mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function estimateMinutes(w: any): number {
  if (typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0) return w.estimatedDurationMin;
  const matches = Array.from(String(w.d || '').matchAll(/(\d+)\s*min/g)) as RegExpMatchArray[];
  if (!matches.length) return 45;
  return matches.reduce((acc: number, m: RegExpMatchArray) => Math.max(acc, parseInt(m[1], 10)), 0);
}

function daysUntil(isoDate: string): number {
  const target = new Date(isoDate).getTime();
  const now = new Date().setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((target - now) / 86400000));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
