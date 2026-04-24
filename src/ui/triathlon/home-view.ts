/**
 * Triathlon home view — mirrors the running home-view chrome.
 *
 * Same sky background, hero header with race countdown + profile button,
 * Coach + Check-in buttons. The main body surfaces today's workouts +
 * per-discipline fitness summary + coming-up preview. Race forecast does
 * NOT appear here (§6 — lives on Stats). Readiness ring is rendered for
 * now via the existing buildReadinessRing helper when applicable.
 */

import { getState } from '@/state/store';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { renderTriWorkoutCard } from './workout-card';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL } from './colours';
import { readTriFitness } from '@/calculations/fitness-model.triathlon';

function navigateTab(tab: TabId): void {
  if (tab === 'plan') {
    import('../plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'record') {
    import('../record-view').then(({ renderRecordView }) => renderRecordView());
  } else if (tab === 'stats') {
    import('../stats-view').then(({ renderStatsView }) => renderStatsView());
  } else if (tab === 'account') {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

export function renderTriathlonHomeView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const tri = s.triConfig;
  if (!tri) return;

  const wk = s.wks?.[s.w - 1];
  const workouts = wk?.triWorkouts ?? [];

  const jsDay = new Date().getDay();
  const today = (jsDay + 6) % 7;
  const todayList = workouts.filter((w) => w.dayOfWeek === today);
  const nextList = workouts
    .filter((w) => (w.dayOfWeek ?? -1) > today)
    .slice(0, 3);

  const fitness = readTriFitness(s);

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  const userName = s.onboarding?.name || null;
  const planTitle = userName ? `${userName}'s ${tri.distance === 'ironman' ? 'Ironman' : '70.3'}` : `Your ${tri.distance === 'ironman' ? 'Ironman' : '70.3'}`;

  const raceDate = s.onboarding?.customRaceDate;
  const raceDays = raceDate ? daysUntil(raceDate) : 0;
  const raceCountdownDisplay = raceDays > 14 ? `${Math.floor(raceDays / 7)}` : `${raceDays}`;
  const raceCountdownUnit = raceDays > 14 ? 'weeks' : 'days';

  const phase = wk?.ph ? wk.ph.charAt(0).toUpperCase() + wk.ph.slice(1) : '';

  container.innerHTML = `
    <style>
      @keyframes floatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hf { opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>
    <div class="mosaic-page" style="background:#FAF9F6;position:relative;min-height:100vh">
      <!-- Sky gradient — identical to running home -->
      <div style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:0">
        <div style="position:absolute;inset:0;background:linear-gradient(180deg, #C5DFF8 0%, #E3F0FA 15%, #F0F7FC 35%, #F5F8FB 55%, #FAF9F6 80%)"></div>
        <svg style="position:absolute;top:0;left:0;width:100%;height:600px" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="thBlur"><feGaussianBlur stdDeviation="20"/></filter>
            <filter id="thSoft"><feGaussianBlur stdDeviation="6"/></filter>
          </defs>
          <ellipse cx="200" cy="100" rx="100" ry="70" fill="rgba(255,255,255,0.5)" filter="url(#thSoft)" opacity="0.6"/>
          <ellipse cx="80" cy="180" rx="60" ry="25" fill="white" filter="url(#thBlur)" opacity="0.35"/>
          <ellipse cx="340" cy="160" rx="50" ry="20" fill="white" filter="url(#thBlur)" opacity="0.25"/>
          <path d="M-40,280 Q60,240 150,265 T320,245 T440,270 L440,600 L-40,600 Z" fill="rgba(255,255,255,0.25)" filter="url(#thSoft)"/>
          <path d="M-20,350 Q100,330 220,345 T440,335 L440,600 L-20,600 Z" fill="rgba(255,255,255,0.15)"/>
        </svg>
      </div>

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Header -->
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px" class="hf" data-delay="0.02">
          ${raceDays > 0 ? `
            <div style="display:flex;align-items:baseline;gap:3px;padding:4px 12px;border-radius:100px;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.06)">
              <span style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:#0F172A;line-height:1">${raceCountdownDisplay}</span>
              <span style="font-size:11px;font-weight:500;color:#64748B">${raceCountdownUnit}</span>
            </div>
          ` : ''}
          <button id="tri-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <!-- Hero -->
        <div class="hf" data-delay="0.06" style="text-align:center;padding:20px 20px 10px">
          <div style="font-size:48px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;line-height:1">${escapeHtml(planTitle)}</div>
          ${phase ? `<div style="font-size:17px;font-weight:700;color:#0F172A;margin-top:10px;letter-spacing:-0.01em">${phase}</div>` : ''}
          ${s.w && s.tw ? `<div style="font-size:14px;font-weight:500;color:#64748B;margin-top:4px">Week ${s.w} of ${s.tw}</div>` : ''}

          <div style="display:flex;justify-content:center;gap:8px;margin-top:18px">
            <button id="tri-coach-btn" class="m-btn-glass">Coach</button>
            <button id="tri-checkin-btn" class="m-btn-glass">Check-in</button>
          </div>
        </div>

        <!-- Today -->
        <div class="hf" data-delay="0.12" style="padding:16px 20px 8px">
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
            <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#0F172A">Today</span>
            <span style="font-size:11px;color:var(--c-muted);font-weight:500">${formatDayHeader()}</span>
          </div>
          ${todayList.length === 0
            ? `<div style="background:#fff;border-radius:14px;padding:22px;text-align:center;box-shadow:0 2px 4px rgba(0,0,0,0.04),0 8px 24px rgba(0,0,0,0.05)">
                <div style="font-size:15px;font-weight:600;color:#0F172A;margin-bottom:4px">Rest day</div>
                <div style="font-size:13px;color:var(--c-muted);line-height:1.5">Recovery is where adaptation happens. Light stretching or a walk is fine.</div>
              </div>`
            : todayList.map((w) => renderTriWorkoutCard(w)).join('')}
        </div>

        <!-- Per-discipline fitness -->
        <div class="hf" data-delay="0.16" style="padding:8px 20px 8px">
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
            <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#0F172A">Fitness</span>
            <span style="font-size:11px;color:var(--c-muted);font-variant-numeric:tabular-nums">Combined CTL ${fitness.combinedCtl.toFixed(1)}</span>
          </div>
          <div style="background:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 2px 4px rgba(0,0,0,0.04),0 8px 24px rgba(0,0,0,0.05)">
            ${(['swim', 'bike', 'run'] as const).map((d) => {
              const f = fitness[d];
              const c = DISCIPLINE_COLOURS[d];
              const maxCtl = Math.max(fitness.swim.ctl, fitness.bike.ctl, fitness.run.ctl, 10);
              const pct = Math.min(100, (f.ctl / maxCtl) * 100);
              return `
                <div style="margin-bottom:10px">
                  <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:4px">
                    <span style="color:#0F172A;font-weight:500">${DISCIPLINE_LABEL[d]}</span>
                    <span style="font-variant-numeric:tabular-nums;color:var(--c-muted)">CTL ${f.ctl.toFixed(1)} · ATL ${f.atl.toFixed(1)}</span>
                  </div>
                  <div style="height:4px;background:rgba(0,0,0,0.05);border-radius:2px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${c.accent};transition:width 0.3s"></div>
                  </div>
                </div>
              `;
            }).join('')}
            <div style="margin-top:6px;padding-top:10px;border-top:1px dashed rgba(0,0,0,0.06);font-size:11px;color:var(--c-faint)">
              CTL fills in as activities sync. See Stats for details.
            </div>
          </div>
        </div>

        ${nextList.length > 0 ? `
        <div class="hf" data-delay="0.20" style="padding:8px 20px">
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
            <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#0F172A">Coming up</span>
          </div>
          ${nextList.map((w) => renderTriWorkoutCard(w, { showDay: true })).join('')}
        </div>
        ` : ''}

      </div>

      ${renderTabBar('home')}
    </div>
  `;

  wireTabBarHandlers(navigateTab);

  document.getElementById('tri-account-btn')?.addEventListener('click', () => navigateTab('account'));
  document.getElementById('tri-coach-btn')?.addEventListener('click', () => {
    import('../coach-view').then(({ renderCoachView }) => renderCoachView(() => renderTriathlonHomeView()));
  });
  document.getElementById('tri-checkin-btn')?.addEventListener('click', () => {
    import('../checkin-overlay').then(({ openCheckinOverlay }) => openCheckinOverlay());
  });
}

function daysUntil(isoDate: string): number {
  const target = new Date(isoDate).getTime();
  const now = new Date().setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((target - now) / 86400000));
}

function formatDayHeader(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
