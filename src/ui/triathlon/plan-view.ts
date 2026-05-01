/**
 * Triathlon plan view — mirrors the running plan visual language.
 *
 * Same page shell as `plan-view.ts` (sky gradient, centred hero, Coach +
 * Check-in buttons, real tab bar), with the workout list replaced by a
 * tri-aware day-grouped layout. Running users never hit this — they see
 * the full `renderPlanView()`.
 */

import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { renderTriWorkoutCard } from './workout-card';
import { openTriWorkoutDetail } from './workout-detail-modal';
import { renderBenchmarkTestsCard, wireBenchmarkTestsCard } from './benchmark-tests-card';
import { DAY_NAMES } from '@/workouts/scheduler.triathlon';
import type { Workout } from '@/types/state';

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'record') {
    import('../record-view').then(({ renderRecordView }) => renderRecordView());
  } else if (tab === 'stats') {
    import('../stats-view').then(({ renderStatsView }) => renderStatsView());
  } else if (tab === 'account') {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render
// ─────────────────────────────────────────────────────────────────────────────

export function renderTriathlonPlanView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const tri = s.triConfig;
  if (!tri) return;

  const viewWeek = s.w;
  const wk = s.wks?.[viewWeek - 1];
  const workouts = wk?.triWorkouts ?? [];
  const phase = wk?.ph ? capitalize(wk.ph) : '';
  const raceName = s.onboarding?.name ? `${s.onboarding.name}'s ${tri.distance === 'ironman' ? 'Ironman' : '70.3'}` : `Your ${tri.distance === 'ironman' ? 'Ironman' : '70.3'}`;
  const raceDate = s.onboarding?.customRaceDate;
  const raceDays = raceDate ? daysUntil(raceDate) : 0;
  const raceCountdownDisplay = raceDays > 14 ? `${Math.floor(raceDays / 7)}` : `${raceDays}`;
  const raceCountdownUnit = raceDays > 14 ? 'weeks' : 'days';

  // Weekly totals
  const totalMin = workouts.reduce((acc, w) => acc + estimateMinutes(w), 0);
  const totalTss = workouts.reduce((acc, w) => acc + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);

  // Per-discipline minute totals
  const minByDisc = { swim: 0, bike: 0, run: 0 };
  for (const w of workouts) {
    const d = w.discipline ?? 'run';
    if (d === 'swim' || d === 'bike' || d === 'run') minByDisc[d] += estimateMinutes(w);
  }

  // Group by day
  const byDay: Record<number, typeof workouts> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const w of workouts) {
    const d = w.dayOfWeek ?? 4;
    byDay[d] = byDay[d] ?? [];
    byDay[d].push(w);
  }

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      @keyframes floatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hf { opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>
    <div class="mosaic-page" style="background:#FAF9F6;position:relative;min-height:100vh">
      <!-- Full-page sky gradient — identical to running plan/home -->
      <div style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:0">
        <div style="position:absolute;inset:0;background:linear-gradient(180deg, #C5DFF8 0%, #E3F0FA 15%, #F0F7FC 35%, #F5F8FB 55%, #FAF9F6 80%)"></div>
        <svg style="position:absolute;top:0;left:0;width:100%;height:600px" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="tpBlur"><feGaussianBlur stdDeviation="20"/></filter>
            <filter id="tpSoft"><feGaussianBlur stdDeviation="6"/></filter>
          </defs>
          <ellipse cx="200" cy="100" rx="100" ry="70" fill="rgba(255,255,255,0.5)" filter="url(#tpSoft)" opacity="0.6"/>
          <ellipse cx="80" cy="180" rx="60" ry="25" fill="white" filter="url(#tpBlur)" opacity="0.35"/>
          <ellipse cx="340" cy="160" rx="50" ry="20" fill="white" filter="url(#tpBlur)" opacity="0.25"/>
          <path d="M-40,280 Q60,240 150,265 T320,245 T440,270 L440,600 L-40,600 Z" fill="rgba(255,255,255,0.25)" filter="url(#tpSoft)"/>
          <path d="M-20,350 Q100,330 220,345 T440,335 L440,600 L-20,600 Z" fill="rgba(255,255,255,0.15)"/>
        </svg>
      </div>

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Header: race countdown + profile -->
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px" class="hf" data-delay="0.02">
          ${raceDays > 0 ? `
            <div style="display:flex;align-items:baseline;gap:3px;padding:4px 12px;border-radius:100px;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.06)">
              <span style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:#0F172A;line-height:1">${raceCountdownDisplay}</span>
              <span style="font-size:11px;font-weight:500;color:#64748B">${raceCountdownUnit}</span>
            </div>
          ` : ''}
          <button id="tri-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <!-- Hero: title + phase + week -->
        <div class="hf" data-delay="0.06" style="text-align:center;padding:20px 20px 10px">
          <div style="font-size:48px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;line-height:1">${escapeHtml(raceName)}</div>
          ${phase ? `<div style="font-size:17px;font-weight:700;color:#0F172A;margin-top:10px;letter-spacing:-0.01em">${phase}</div>` : ''}
          ${s.w && s.tw ? `<div style="font-size:14px;font-weight:500;color:#64748B;margin-top:4px">Week ${s.w} of ${s.tw}</div>` : ''}

          <div style="display:flex;justify-content:center;gap:8px;margin-top:18px">
            <button id="tri-coach-btn" class="m-btn-glass">Coach</button>
            <button id="tri-checkin-btn" class="m-btn-glass">Check-in</button>
          </div>
        </div>

        <!-- Weekly summary strip -->
        <div class="hf" data-delay="0.10" style="padding:16px 20px 8px">
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
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Week load</div>
              <div style="font-size:20px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${Math.round(totalTss)}<span style="font-size:11px;color:var(--c-faint);font-weight:500;margin-left:2px">TSS</span></div>
            </div>
          </div>
          <!-- Discipline mini-bars -->
          <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            ${renderDisciplineMini('swim', minByDisc.swim, totalMin)}
            ${renderDisciplineMini('bike', minByDisc.bike, totalMin)}
            ${renderDisciplineMini('run', minByDisc.run, totalMin)}
          </div>
          <div style="text-align:center;font-size:11px;color:var(--c-faint);margin-top:6px">Hours per discipline this week</div>
        </div>

        <!-- Week navigation strip -->
        <div class="hf" data-delay="0.14" style="padding:8px 20px 8px">
          <div style="display:flex;gap:5px;overflow-x:auto;padding:2px 0;-webkit-overflow-scrolling:touch">
            ${Array.from({ length: s.tw }, (_, i) => {
              const wkNum = i + 1;
              const active = wkNum === viewWeek;
              return `
                <div style="flex-shrink:0;min-width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:${active ? 600 : 500};font-variant-numeric:tabular-nums;border-radius:8px;background:${active ? '#0F172A' : 'rgba(255,255,255,0.75)'};color:${active ? '#fff' : 'var(--c-muted)'};box-shadow:${active ? '0 2px 6px rgba(0,0,0,0.15)' : '0 1px 2px rgba(0,0,0,0.04)'}">${wkNum}</div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Refine your benchmarks (sticks until done or dismissed) -->
        ${renderBenchmarkTestsCard(s)}

        <!-- Day-by-day -->
        <div class="hf" data-delay="0.18" style="padding:12px 20px">
          ${Array.from({ length: 7 }, (_, d) => renderDay(d, byDay[d] ?? [])).join('')}
        </div>

      </div>

      ${renderTabBar('plan')}
    </div>
  `;

  // Tab bar wiring
  wireTabBarHandlers(navigateTab);

  // Benchmark test cards — re-render on save/dismiss to update visibility.
  wireBenchmarkTestsCard(() => renderTriathlonPlanView());

  // Header buttons
  document.getElementById('tri-account-btn')?.addEventListener('click', () => navigateTab('account'));
  document.getElementById('tri-coach-btn')?.addEventListener('click', () => {
    import('../coach-view').then(({ renderCoachView }) => renderCoachView(() => renderTriathlonPlanView()));
  });
  document.getElementById('tri-checkin-btn')?.addEventListener('click', () => {
    import('../checkin-overlay').then(({ openCheckinOverlay }) => openCheckinOverlay());
  });

  // Workout card → full breakdown modal
  document.querySelectorAll<HTMLElement>('[data-tri-workout-id]').forEach((el) => {
    el.addEventListener('click', () => {
      if (_dragSuppressClick) { _dragSuppressClick = false; return; }
      const id = el.getAttribute('data-tri-workout-id');
      if (!id) return;
      const st = getState();
      const wkRow = st.wks?.[st.w - 1];
      const found = (wkRow?.triWorkouts ?? []).find((x: any) => (x.id || x.n) === id);
      if (found) openTriWorkoutDetail(found);
    });
  });

  wireTriWorkoutDnd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag-and-drop reorder within week (mirrors marathon plan-view DnD)
// ─────────────────────────────────────────────────────────────────────────────

let _dragId = '';
let _dragDay = -1;
let _dragSuppressClick = false;

function wireTriWorkoutDnd(): void {
  document.querySelectorAll<HTMLElement>('.tri-workout-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      _dragId = card.getAttribute('data-tri-workout-id') || '';
      _dragDay = parseInt(card.getAttribute('data-tri-day-of-week') || '-1', 10);
      (e as DragEvent).dataTransfer?.setData('text/plain', _dragId);
      card.style.opacity = '0.4';
    });
    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      card.style.outline = '';
      _dragSuppressClick = true;
      // Reset on next tick so a real subsequent click still works
      setTimeout(() => { _dragSuppressClick = false; }, 0);
    });
    card.addEventListener('dragover', (e) => {
      if (!_dragId || card.getAttribute('data-tri-workout-id') === _dragId) return;
      e.preventDefault();
      card.style.outline = '2px solid #0F172A';
      card.style.outlineOffset = '-2px';
    });
    card.addEventListener('dragleave', () => {
      card.style.outline = '';
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.style.outline = '';
      const srcId = _dragId || (e as DragEvent).dataTransfer?.getData('text/plain') || '';
      const targetId = card.getAttribute('data-tri-workout-id') || '';
      if (!srcId || !targetId || targetId === srcId) return;
      const targetDay = parseInt(card.getAttribute('data-tri-day-of-week') || '-1', 10);
      const srcDay = _dragDay;
      if (srcDay < 0 || targetDay < 0 || srcDay === targetDay) return;
      swapWorkoutDays(srcId, targetId, srcDay, targetDay);
      _dragId = '';
      _dragDay = -1;
      renderTriathlonPlanView();
    });
  });

  // Empty-day rest rows: drop anywhere on the row moves the workout there.
  // For non-empty rows the day-header inside takes over (so drops on the
  // header stack onto that day, and drops on cards still swap).
  document.querySelectorAll<HTMLElement>('.tri-day-row').forEach((row) => {
    row.addEventListener('dragover', (e) => {
      if (!_dragId) return;
      const targetDay = parseInt(row.getAttribute('data-tri-day-drop') || '-1', 10);
      if (targetDay < 0 || targetDay === _dragDay) return;
      e.preventDefault();
      row.style.background = 'rgba(15,23,42,0.04)';
      const restLabel = row.querySelector('.tri-day-rest-label') as HTMLElement | null;
      if (restLabel) restLabel.textContent = 'Drop here';
    });
    row.addEventListener('dragleave', () => {
      row.style.background = '';
      const restLabel = row.querySelector('.tri-day-rest-label') as HTMLElement | null;
      if (restLabel) restLabel.textContent = 'Rest';
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.style.background = '';
      const restLabel = row.querySelector('.tri-day-rest-label') as HTMLElement | null;
      if (restLabel) restLabel.textContent = 'Rest';
      const srcId = _dragId || (e as DragEvent).dataTransfer?.getData('text/plain') || '';
      const targetDay = parseInt(row.getAttribute('data-tri-day-drop') || '-1', 10);
      if (!srcId || targetDay < 0 || targetDay === _dragDay) return;
      // Drops on cards (swap) or headers (stack) have their own handlers.
      const dropTarget = e.target as HTMLElement | null;
      if (dropTarget?.closest('.tri-workout-card') || dropTarget?.closest('.tri-day-header')) return;
      moveWorkoutToDay(srcId, targetDay);
      _dragId = '';
      _dragDay = -1;
      renderTriathlonPlanView();
    });
  });

  // Day-header strip: drop here to stack onto that day (without swapping).
  document.querySelectorAll<HTMLElement>('.tri-day-header').forEach((header) => {
    header.addEventListener('dragover', (e) => {
      if (!_dragId) return;
      const targetDay = parseInt(header.getAttribute('data-tri-day-stack') || '-1', 10);
      if (targetDay < 0 || targetDay === _dragDay) return;
      e.preventDefault();
      header.style.background = 'rgba(15,23,42,0.06)';
      const stackLabel = header.querySelector('.tri-day-stack-label') as HTMLElement | null;
      const restLabel = header.querySelector('.tri-day-rest-label') as HTMLElement | null;
      if (stackLabel) stackLabel.textContent = 'Add here';
      if (restLabel) restLabel.textContent = 'Drop here';
    });
    header.addEventListener('dragleave', () => {
      header.style.background = '';
      const targetDay = parseInt(header.getAttribute('data-tri-day-stack') || '-1', 10);
      const stackLabel = header.querySelector('.tri-day-stack-label') as HTMLElement | null;
      const restLabel = header.querySelector('.tri-day-rest-label') as HTMLElement | null;
      if (stackLabel) {
        const ms = getState();
        const wk = ms.wks?.[ms.w - 1];
        const count = (wk?.triWorkouts ?? []).filter((w: any) => (w.dayOfWeek ?? -1) === targetDay).length;
        stackLabel.textContent = count > 1 ? `${count} sessions` : '';
      }
      if (restLabel) restLabel.textContent = 'Rest';
    });
    header.addEventListener('drop', (e) => {
      e.preventDefault();
      header.style.background = '';
      const srcId = _dragId || (e as DragEvent).dataTransfer?.getData('text/plain') || '';
      const targetDay = parseInt(header.getAttribute('data-tri-day-stack') || '-1', 10);
      if (!srcId || targetDay < 0 || targetDay === _dragDay) return;
      moveWorkoutToDay(srcId, targetDay);
      _dragId = '';
      _dragDay = -1;
      renderTriathlonPlanView();
    });
  });
}

function swapWorkoutDays(srcId: string, targetId: string, srcDay: number, targetDay: number): void {
  const ms = getMutableState();
  const wk = ms.wks?.[ms.w - 1];
  if (!wk?.triWorkouts) return;
  const srcIdx = wk.triWorkouts.findIndex((w: Workout) => (w.id ?? w.n) === srcId);
  const targetIdx = wk.triWorkouts.findIndex((w: Workout) => (w.id ?? w.n) === targetId);
  if (srcIdx < 0 || targetIdx < 0) return;
  wk.triWorkouts[srcIdx] = { ...wk.triWorkouts[srcIdx], dayOfWeek: targetDay, dayName: DAY_NAMES[targetDay] };
  wk.triWorkouts[targetIdx] = { ...wk.triWorkouts[targetIdx], dayOfWeek: srcDay, dayName: DAY_NAMES[srcDay] };
  saveState();
}

function moveWorkoutToDay(srcId: string, targetDay: number): void {
  const ms = getMutableState();
  const wk = ms.wks?.[ms.w - 1];
  if (!wk?.triWorkouts) return;
  const idx = wk.triWorkouts.findIndex((w: Workout) => (w.id ?? w.n) === srcId);
  if (idx < 0) return;
  wk.triWorkouts[idx] = { ...wk.triWorkouts[idx], dayOfWeek: targetDay, dayName: DAY_NAMES[targetDay] };
  saveState();
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderDay(d: number, list: Array<any>): string {
  const dayLabel = DAY_NAMES[d];
  if (list.length === 0) {
    return `
      <div class="tri-day-row" data-tri-day-drop="${d}" style="margin-bottom:14px;padding:6px 8px;border-radius:10px;transition:background 0.15s">
        <div class="tri-day-header" data-tri-day-stack="${d}" style="display:flex;align-items:center;gap:12px;border-radius:6px;transition:background 0.15s">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-muted);min-width:40px">${dayLabel.slice(0, 3)}</span>
          <span style="flex:1;height:1px;background:rgba(0,0,0,0.06)"></span>
          <span class="tri-day-rest-label" style="font-size:11px;color:var(--c-faint);font-weight:500">Rest</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="tri-day-row" data-tri-day-drop="${d}" style="margin-bottom:16px;padding:6px 8px;border-radius:10px;transition:background 0.15s">
      <div class="tri-day-header" data-tri-day-stack="${d}" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;border-radius:6px;transition:background 0.15s">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#0F172A;min-width:40px">${dayLabel.slice(0, 3)}</span>
        <span style="flex:1;height:1px;background:rgba(0,0,0,0.06)"></span>
        <span class="tri-day-stack-label" style="font-size:11px;color:var(--c-faint);font-weight:500">${list.length > 1 ? `${list.length} sessions` : ''}</span>
      </div>
      ${list.map((w) => renderTriWorkoutCard(w)).join('')}
    </div>
  `;
}

function renderDisciplineMini(d: 'swim' | 'bike' | 'run', mins: number, totalMin: number): string {
  const colour = d === 'swim' ? '#5b8a8a' : d === 'bike' ? '#c08460' : '#7a845c';
  const label = d === 'swim' ? 'Swim' : d === 'bike' ? 'Bike' : 'Run';
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
  // Round to nearest 5 min for anything >= 30 min (§4 feedback)
  const rounded = mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function estimateMinutes(w: any): number {
  if (typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0) {
    return w.estimatedDurationMin;
  }
  if (w.brickSegments) {
    return (w.brickSegments[0]?.durationMin ?? 0) + (w.brickSegments[1]?.durationMin ?? 0);
  }
  const hm = String(w.d || '').match(/(\d+)\s*h\s*(\d+)\s*min/i);
  if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  const matches = Array.from(String(w.d || '').matchAll(/(\d+)\s*min/g)) as RegExpMatchArray[];
  if (!matches.length) return 60;
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

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
