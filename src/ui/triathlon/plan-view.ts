/**
 * Triathlon plan view. Mirrors the running plan visual language.
 *
 * Same page shell as `plan-view.ts` (sky gradient, centred hero, Coach +
 * Check-in buttons, real tab bar), with the workout list replaced by a
 * tri-aware day-grouped layout. Running users never hit this. They see
 * the full `renderPlanView()`.
 */

import { getState, getMutableState } from '@/state/store';
import { getTriDistanceLabel } from '@/constants/triathlon-constants';
import { saveState } from '@/state/persistence';
import { AI_COACH_ENABLED } from '@/constants/feature-flags';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { renderTriWorkoutCard } from './workout-card';
import { gymLegLoadNudgeForWorkout } from '@/calculations/strength-leg-load';
import { deriveWorkoutStatus, renderWorkoutStatusChip, computeWeekStatusContext, type WeekStatusContext } from '../workout-status';
import { openTriWorkoutDetail } from './workout-detail-modal';
import { DISCIPLINE_COLOURS, DISCIPLINE_ICON, DISCIPLINE_LABEL, type BadgeKind } from './colours';
import { collectWeekActivities } from '@/calculations/week-activity-log';
import { resolveTriWeekWorkouts, estimateTriWorkoutMin as estimateMinutes } from './week-resolve.triathlon';
import { formatKm } from '@/utils/format';
import { isTouchPrimary } from '@/utils/platform';
import { renderBenchmarkTestsCard, wireBenchmarkTestsCard } from './benchmark-tests-card';
import { openVibesScienceModal } from '../session-generator';
import { getCyclingEventLabel, isCyclingOnlyMode } from '@/calculations/cycling-mode';
import { getTriathlonById } from '@/data/triathlons';
import { DAY_NAMES } from '@/workouts/scheduler.triathlon';
import type { Workout } from '@/types/state';
import { buildRingBackground, atmosphereGradient, buildSunGlint, shouldPlayEntrance } from '../page-flair';
import { openInjuryModal, isInjuryActive, markAsRecovered, getInjuryStateForDisplay } from '../injury/modal';
import { recordMorningPain, injuryAppliesToWeek, getDisciplineCapacity } from '@/injury/engine';
import { INJURY_PROTOCOLS } from '@/constants/injury-protocols';
import type { InjuryState } from '@/types/injury';
import { normalizeiTrimp } from '@/calculations/fitness-model';

// ─── Module-level navigation state ───────────────────────────────────────────
// null = show the live current week (s.w). Non-null = preview another week
// without changing s.w. Same pattern as running plan-view.
let _viewWeek: number | null = null;

/** Open the plan view focused on a specific week without mutating s.w. Used by
 * surfaces that list past weeks (e.g. recent-weeks-detail) so a tap opens that
 * week. Passing `wkNum === liveW` resets to the live view. */
export function renderTriathlonPlanViewAtWeek(wkNum: number, liveW: number): void {
  _viewWeek = wkNum === liveW ? null : wkNum;
  renderTriathlonPlanView();
}

/** Summarize a week's actuals into minutes, session count, and TSS-equivalent.
 * Mirrors `forEachActual` from progress-detail-view but flattens across
 * disciplines for stats-row displays. */
export function summarizeWeekActuals(
  actuals: Record<string, { garminId?: string; durationSec?: number | null; iTrimp?: number | null }>,
): { min: number; count: number; tss: number } {
  let min = 0;
  let count = 0;
  let tss = 0;
  const seen = new Set<string>();
  for (const a of Object.values(actuals ?? {})) {
    if (a.garminId && seen.has(a.garminId)) continue;
    if (a.garminId) seen.add(a.garminId);
    min += (a.durationSec ?? 0) / 60;
    count += 1;
    if (a.iTrimp != null && a.iTrimp > 0) tss += normalizeiTrimp(a.iTrimp);
  }
  return { min, count, tss };
}

function navigateTab(tab: TabId): void {
  _viewWeek = null; // leaving the plan tab resets to live week on return
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'forecast') {
    import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
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

  const viewWeek = _viewWeek ?? s.w;
  const isFutureWeek = viewWeek > s.w;
  const isPastWeek = viewWeek < s.w;
  const wk = s.wks?.[viewWeek - 1];
  // Include adhoc sessions (e.g. injury-safe strength accepted from the
  // capability nudge) so suggested sessions render on the plan, not just
  // `triWorkouts`. Mirrors the HYROX plan-view fix.
  // clone:false — click/drag handlers re-read wk.triWorkouts directly and rely
  // on render mods being visible on those shared objects (historical behaviour).
  const workouts = resolveTriWeekWorkouts(s, viewWeek, { clone: false });
  const phase = wk?.ph ? capitalize(wk.ph) : '';
  const cyclingLabel = getCyclingEventLabel(s);
  const baseEventLabel = cyclingLabel ?? getTriDistanceLabel(tri.distance);
  const raceCity = cyclingLabel ? null : (getTriathlonById(s.onboarding?.selectedTriathlonId ?? '')?.city ?? null);
  const eventLabel = raceCity ? `${raceCity} ${baseEventLabel}` : baseEventLabel;
  const raceName = s.onboarding?.name ? `${s.onboarding.name}'s ${eventLabel}` : `Your ${eventLabel}`;
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

  // Completed totals (current + past weeks only. Future weeks have no actuals yet)
  const actualsForWk: Record<string, any> = (wk as any)?.garminActuals ?? {};
  const completedWorkouts = workouts.filter((w: any) => w.status === 'completed');
  const completedMinFor = (w: any): number => {
    const a = w.matchedActivityId ? actualsForWk[w.matchedActivityId] : null;
    if (a?.durationSec && a.durationSec > 0) return Math.round(a.durationSec / 60);
    return estimateMinutes(w);
  };
  const doneMin = completedWorkouts.reduce((acc: number, w: any) => acc + completedMinFor(w), 0);
  const doneTss = completedWorkouts.reduce((acc: number, w: any) => acc + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);
  const doneByDisc = { swim: 0, bike: 0, run: 0 };
  for (const w of completedWorkouts) {
    const d = (w.discipline ?? 'run') as string;
    if (d === 'swim' || d === 'bike' || d === 'run') doneByDisc[d] += completedMinFor(w);
  }
  const showProgress = !isFutureWeek;

  // (Day grouping / injury discipline status / dismissed-test set are computed
  // inside buildTriDayList so the localized drag re-render can rebuild the list
  // without a full render.)

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  // Injury only looks forward. A current injury must not paint "Injury management"
  // onto already-trained past weeks (it reads as history being rewritten). Uses the
  // shared injuryAppliesToWeek() rule, the same one the running generator and the
  // tri/HYROX plan engines enforce, so the gate can't drift out of sync.
  // (injStatus is computed inside buildTriDayList; injState is still needed
  // here for the injury banner / morning-pain check below.)
  const injuryActive = isInjuryActive();
  const injState = (injuryActive && injuryAppliesToWeek(viewWeek, s.w)) ? getInjuryStateForDisplay() : null;

  // Entrance plays on the first Plan visit per session only; revisits render settled.
  const animate = shouldPlayEntrance('tri-plan');

  container.innerHTML = `
    <style>
      @keyframes floatUp {
        from { opacity:0; }
        to   { opacity:1; }
      }
      .hf { ${animate ? 'opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards;' : 'opacity:1;'} }
    </style>
    <div class="mosaic-page" style="background:${atmosphereGradient('sky')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('tp', { variant: 'asymmetric', side: 'right', palette: 'sky', pulse: animate, entrance: animate ? 'small' : 'none' })}
      </div>
      ${buildSunGlint('low')}

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
          ${s.w && s.tw ? `<div style="font-size:14px;font-weight:500;color:#64748B;margin-top:4px">${s.w > s.tw ? 'Plan complete' : `Week ${s.w} of ${s.tw}`}</div>` : ''}

          <div style="display:flex;justify-content:center;gap:8px;margin-top:18px;flex-wrap:wrap">
            ${AI_COACH_ENABLED ? `<button id="tri-coach-btn" class="m-btn-glass">Coach</button>` : ''}
            ${injuryActive
              ? `<button id="tri-injury-header-btn" style="padding:8px 18px;border-radius:100px;border:none;background:rgba(234,88,12,0.12);backdrop-filter:blur(8px);cursor:pointer;font-size:13px;font-weight:600;color:#92400E;font-family:var(--f);box-shadow:0 1px 4px rgba(0,0,0,0.06)">In Recovery</button>`
              : `<button id="tri-checkin-btn" class="m-btn-glass">Check-in</button>`}
            ${!isFutureWeek ? `<button id="tri-plan-generate-session" class="m-btn-glass">+ Add session</button><button id="tri-plan-log-activity" class="m-btn-glass">+ Log activity</button>` : ''}
          </div>
        </div>

        <!-- Weekly summary strip -->
        <div class="hf" data-delay="0.10" style="padding:16px 20px 8px">
          <div style="background:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);display:flex;gap:16px;justify-content:space-between">
            <div style="flex:1;text-align:center">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Weekly hours</div>
              <div style="font-size:20px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${fmtHours(totalMin)}</div>
              ${showProgress ? `<div style="font-size:10px;color:var(--c-faint);font-variant-numeric:tabular-nums;margin-top:2px">${fmtHoursZero(doneMin)} done</div>` : ''}
            </div>
            <div style="flex:1;text-align:center;border-left:1px solid rgba(0,0,0,0.06);border-right:1px solid rgba(0,0,0,0.06)">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Sessions</div>
              <div style="font-size:20px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${workouts.length}</div>
              ${showProgress ? `<div style="font-size:10px;color:var(--c-faint);font-variant-numeric:tabular-nums;margin-top:2px">${completedWorkouts.length} done</div>` : ''}
            </div>
            <div style="flex:1;text-align:center">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Week load</div>
              <div style="font-size:20px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${Math.round(totalTss)}<span style="font-size:11px;color:var(--c-faint);font-weight:500;margin-left:2px">TSS</span></div>
              ${showProgress ? `<div style="font-size:10px;color:var(--c-faint);font-variant-numeric:tabular-nums;margin-top:2px">${Math.round(doneTss)} done</div>` : ''}
            </div>
          </div>
          <!-- Discipline mini-bars -->
          <div style="margin-top:10px;display:grid;grid-template-columns:${isCyclingOnlyMode(s) ? '1fr' : '1fr 1fr 1fr'};gap:8px">
            ${isCyclingOnlyMode(s)
              ? renderDisciplineMini('bike', doneByDisc.bike, minByDisc.bike, showProgress)
              : `${renderDisciplineMini('swim', doneByDisc.swim, minByDisc.swim, showProgress)}
                 ${renderDisciplineMini('bike', doneByDisc.bike, minByDisc.bike, showProgress)}
                 ${renderDisciplineMini('run', doneByDisc.run, minByDisc.run, showProgress)}`}
          </div>
          <div style="text-align:center;font-size:11px;color:var(--c-faint);margin-top:6px">${showProgress ? 'Completed vs planned this week' : `Hours${isCyclingOnlyMode(s) ? '' : ' per discipline'} this week`}</div>
        </div>

        <!-- Week navigation strip -->
        <div class="hf" data-delay="0.14" style="padding:8px 20px 8px">
          <div style="display:flex;gap:5px;overflow-x:auto;padding:2px 0;-webkit-overflow-scrolling:touch">
            ${Array.from({ length: s.tw }, (_, i) => {
              const wkNum = i + 1;
              const active = wkNum === viewWeek;
              return `
                <button data-tri-week-nav="${wkNum}" style="flex-shrink:0;min-width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:${active ? 600 : 500};font-variant-numeric:tabular-nums;border-radius:8px;border:none;background:${active ? '#0F172A' : 'rgba(255,255,255,0.75)'};color:${active ? '#fff' : 'var(--c-muted)'};box-shadow:${active ? '0 2px 6px rgba(0,0,0,0.15)' : '0 1px 2px rgba(0,0,0,0.04)'};cursor:pointer">${wkNum}</button>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Future-week draft banner (mirrors running plan-view) -->
        ${isFutureWeek ? `<div style="margin:4px 20px 8px;padding:12px 15px;background:rgba(255,255,255,0.7);border:1px solid rgba(0,0,0,0.06);border-radius:12px;font-size:13px;font-weight:500;color:#64748B;line-height:1.5">Estimated from last week\'s load. Sessions and distances adjust as you train.</div>` : ''}

        <!-- Injury banner + morning check (current week only) -->
        ${!isFutureWeek && injuryActive && injState ? `
          <div style="padding:0 20px">
            ${buildTriMorningPainCheck(injState)}
            ${buildTriInjuryBanner(injState)}
          </div>
        ` : ''}

        <!-- Refine your benchmarks (sticks until done or dismissed, current week only) -->
        ${!isFutureWeek ? renderBenchmarkTestsCard(s) : ''}

        <!-- Vibes Run nudge (build phase only, current week only, once per plan) -->
        ${!isFutureWeek && wk?.ph === 'build' && !s.vibesRunNudgeDismissed ? `
          <div style="padding:0 20px;margin-bottom:8px">
            <div id="tri-vibes-nudge-card" style="padding:14px 16px;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);border:1px solid rgba(0,0,0,0.06);border-radius:14px;position:relative;overflow:hidden">
              <div aria-hidden="true" style="position:absolute;top:0;left:0;width:240px;height:240px;pointer-events:none;
                background:radial-gradient(ellipse 70% 70% at 18% 18%, rgba(255,248,229,0.5) 0%, rgba(255,248,229,0.18) 30%, transparent 70%)"></div>
              <div style="position:relative">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px">
                  <div style="flex:1;min-width:0">
                    <div style="font-size:13px;font-weight:600;color:#0F172A;margin-bottom:4px">Run by Feel</div>
                    <div style="font-size:12px;color:#64748B;line-height:1.55;margin-bottom:8px">Extra session. Sometimes plans are too prescriptive. Listening to your body lets you push yourself. 5km easy, then keep going if it's still fun.</div>
                    <div style="font-size:12px;color:#0F172A;line-height:1.55;margin-bottom:8px;font-style:italic">Tristan (our founder) got his half marathon PB on one of these.</div>
                    <button id="tri-vibes-nudge-science" style="background:none;border:none;padding:0;font-size:11px;color:#64748B;cursor:pointer;text-align:left;font-family:inherit;line-height:1.5">The science: fartlek, central governor, flow states, Born to Run</button>
                  </div>
                  <button id="tri-vibes-nudge-dismiss" style="flex-shrink:0;background:none;border:none;cursor:pointer;padding:0;color:#64748B;font-size:18px;line-height:1;opacity:0.5" aria-label="Dismiss">×</button>
                </div>
                <button id="tri-vibes-nudge-try" class="m-btn-secondary" style="margin-top:6px;padding:9px 14px;font-size:12px">Try one</button>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Completed efforts (past weeks only) -->
        ${isPastWeek ? buildCompletedEfforts(wk, s) : ''}

        <!-- Reorder hint: tiny, muted, above Monday. Current week only. -->
        ${viewWeek === s.w ? `
          <div class="hf" data-delay="0.16" style="padding:6px 28px 0 20px;text-align:right">
            <span style="font-size:10px;color:var(--c-faint);font-weight:500">Hold and drag to reorder</span>
          </div>
        ` : ''}

        <!-- Day-by-day. Stable id so a drag-and-drop reorder re-renders just
             this subtree (buildTriDayList) instead of the whole page, which
             would replay the .hf entrance animation and read as a refresh. -->
        <div id="tri-plan-day-list" class="hf" data-delay="0.18" style="padding:12px 20px">
          ${buildTriDayList(s, viewWeek)}
        </div>

      </div>

      ${renderTabBar('plan')}
    </div>
  `;

  // Tab bar wiring
  wireTabBarHandlers(navigateTab);

  // Benchmark test cards. Re-render on save/dismiss to update visibility.
  wireBenchmarkTestsCard(() => renderTriathlonPlanView());

  // Header buttons
  document.getElementById('tri-account-btn')?.addEventListener('click', () => navigateTab('account'));
  document.getElementById('tri-coach-btn')?.addEventListener('click', () => {
    import('../coach-view').then(({ renderCoachView }) => renderCoachView(() => renderTriathlonPlanView()));
  });
  document.getElementById('tri-checkin-btn')?.addEventListener('click', () => {
    import('../checkin-overlay').then(({ openCheckinOverlay }) => openCheckinOverlay());
  });

  // Injury header button (replaces check-in when injured)
  document.getElementById('tri-injury-header-btn')?.addEventListener('click', () => openInjuryModal());

  // Injury banner buttons
  document.getElementById('tri-injury-update')?.addEventListener('click', () => openInjuryModal());
  document.getElementById('tri-injury-recovered')?.addEventListener('click', () => markAsRecovered());

  // Add session button → opens the session generator picker. In tri mode the
  // picker is filtered to Vibes Run only for V1; full discipline-aware picker
  // (swim/bike/run × types each) is a follow-up.
  document.getElementById('tri-plan-log-activity')?.addEventListener('click', () => {
    import('../log-activity-overlay').then(({ openLogActivityOverlay }) => openLogActivityOverlay());
  });
  document.getElementById('tri-plan-generate-session')?.addEventListener('click', () => {
    import('../session-generator').then(({ openSessionGenerator }) => openSessionGenerator());
  });

  // Vibes Run nudge handlers
  document.getElementById('tri-vibes-nudge-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const ms = getMutableState();
    ms.vibesRunNudgeDismissed = true;
    saveState();
    // In-place: drop the additive nudge card, no full Plan re-render.
    document.getElementById('tri-vibes-nudge-card')?.remove();
  });
  document.getElementById('tri-vibes-nudge-science')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openVibesScienceModal();
  });
  document.getElementById('tri-vibes-nudge-try')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const ms = getMutableState();
    const wkLive = ms.wks?.[ms.w - 1];
    if (!wkLive) return;
    if (!wkLive.triWorkouts) wkLive.triWorkouts = [];
    const jsDay = new Date().getDay();
    const ourDay = jsDay === 0 ? 6 : jsDay - 1;
    wkLive.triWorkouts.push({
      id: `adhoc-${Date.now()}`,
      t: 'vibes',
      n: 'Run by Feel',
      d: '5km easy, then keep going if it\'s still fun',
      r: 4,
      rpe: 4,
      dayOfWeek: ourDay,
      dayName: DAY_NAMES[ourDay],
      discipline: 'run',
    });
    ms.vibesRunNudgeDismissed = true;
    saveState();
    renderTriathlonPlanView();
  });

  // Morning pain check buttons
  document.querySelectorAll<HTMLElement>('.tri-morning-pain-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const response = btn.getAttribute('data-response') as 'worse' | 'same' | 'better' | null;
      if (response) handleTriMorningPainResponse(response);
    });
  });

  // Week navigation pills
  document.querySelectorAll<HTMLElement>('[data-tri-week-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wkNum = parseInt(btn.getAttribute('data-tri-week-nav') || '0', 10);
      if (!wkNum) return;
      _viewWeek = wkNum === getState().w ? null : wkNum;
      renderTriathlonPlanView();
    });
  });

  // Day-list card clicks + drag-and-drop. Factored so a localized re-render
  // after a drop (rerenderTriDayListLocal) can rebind the fresh card nodes.
  wireTriDayList();

  // Completed effort rows → detail pop-up (live outside the day-list subtree,
  // past weeks only, so a day-list re-render never touches them)
  document.querySelectorAll<HTMLElement>('.tri-completed-row').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-completed-id');
      if (!id) return;
      openCompletedEffortDetail(id, wk, s);
    });
  });

  // Prompt for chronic high-RPE bike pattern (fires after view mounts)
  maybePromptHighRpeBike();
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag-and-drop reorder within week (mirrors marathon plan-view DnD)
// ─────────────────────────────────────────────────────────────────────────────

let _dragId = '';
let _dragDay = -1;
let _dragSuppressClick = false;

// Touch DnD state (iOS. HTML5 drag events don't fire in WKWebView)
// Long-press to reorder: the finger must rest TOUCH_DRAG_HOLD_MS before a drag
// arms. Until then any real movement is treated as a scroll and the card is
// never picked up, so scrolling the plan no longer reorders days by accident.
// (Tristan, 2026-06-01: 350ms. Mirrored in running + HYROX plan-views.)
const TOUCH_DRAG_HOLD_MS = 350;
let _touchDragId = '';
let _touchDragDay = -1;
let _touchStartX = 0;
let _touchStartY = 0;
let _touchDragging = false;
let _touchClone: HTMLElement | null = null;
let _touchSourceCard: HTMLElement | null = null;
let _touchLastHighlight: HTMLElement | null = null;
let _touchHoldTimer: number | null = null;
let _touchHoldMet = false;

/**
 * Build the 7-day plan list HTML for a given week. Self-contained (recomputes
 * workouts/byDay/injury/status from state) so both the full render and the
 * localized drag-and-drop re-render can call it.
 */
function buildTriDayList(s: any, viewWeek: number): string {
  const tri = s.triConfig;
  const wk = s.wks?.[viewWeek - 1];
  // clone:false — see renderTriathlonPlanView; handlers depend on shared refs.
  const workouts = resolveTriWeekWorkouts(s, viewWeek, { clone: false });
  const dismissedTests = new Set<string>((tri as any)?.dismissedTests as string[] ?? []);

  const byDay: Record<number, typeof workouts> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const w of workouts) {
    // Synced cross-training adhocs may carry no dayOfWeek. Derive it from the
    // activity timestamp (Mon=0..Sun=6) rather than dumping it on Friday.
    const ts = (w as any).garminTimestamp ?? (w as any).startTime;
    const d = w.dayOfWeek ?? (ts ? (new Date(ts).getDay() + 6) % 7 : 4);
    byDay[d] = byDay[d] ?? [];
    byDay[d].push(w);
  }

  const injuryActive = isInjuryActive();
  const injState = (injuryActive && injuryAppliesToWeek(viewWeek, s.w)) ? getInjuryStateForDisplay() : null;
  const injStatus = injState ? injuryDisciplineStatus(injState) : null;

  const statusCtx = { wk, ctx: computeWeekStatusContext(s.planStartDate, viewWeek, s.w, s.planCreatedAt) };
  return Array.from({ length: 7 }, (_, d) =>
    renderDay(d, byDay[d] ?? [], { cssSecPer100m: tri?.swim?.cssSecPer100m ?? null, ftp: tri?.bike?.ftp ?? null, dismissedTests }, injStatus, statusCtx),
  ).join('');
}

/** Wire day-list card clicks + drag-and-drop. Safe to call again after a localized re-render. */
function wireTriDayList(): void {
  const s = getState();
  const isFutureWeek = (_viewWeek ?? s.w) > s.w;
  // Workout card → full breakdown modal (suppressed for future-week previews and injury-stopped cards)
  document.querySelectorAll<HTMLElement>('[data-tri-workout-id]').forEach((el) => {
    el.addEventListener('click', () => {
      if (isFutureWeek) return;
      if (_dragSuppressClick) { _dragSuppressClick = false; return; }
      if (el.getAttribute('draggable') === 'false') return; // injury-stopped card
      const id = el.getAttribute('data-tri-workout-id');
      if (!id) return;
      const st = getState();
      const wkRow = st.wks?.[st.w - 1];
      const found = [...(wkRow?.triWorkouts ?? []), ...(wkRow?.adhocWorkouts ?? [])]
        .find((x: any) => (x.id || x.n) === id);
      if (found) openTriWorkoutDetail(found, st.w - 1);
    });
  });
  wireTriWorkoutDnd();
  wireTriWorkoutTouchDnd();
}

/**
 * Re-render only the day-list subtree after a drag-and-drop move. Mirrors
 * running's rerenderWeekListLocal: swapping a workout's day doesn't change
 * weekly totals, so the summary strip and the rest of the page are untouched,
 * and the .hf entrance animation does not replay (no "page refresh" flash).
 */
function rerenderTriDayListLocal(): void {
  const listEl = document.getElementById('tri-plan-day-list');
  if (!listEl) { renderTriathlonPlanView(); return; }
  const s = getState();
  listEl.innerHTML = buildTriDayList(s, _viewWeek ?? s.w);
  wireTriDayList();
}

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
      rerenderTriDayListLocal();
      maybeOpenSuggestionsAfterDrop(targetDay);
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
      rerenderTriDayListLocal();
      maybeOpenSuggestionsAfterDrop(targetDay);
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
      rerenderTriDayListLocal();
      maybeOpenSuggestionsAfterDrop(targetDay);
    });
  });
}

/**
 * Touch-based DnD for iOS WKWebView. HTML5 drag events don't fire there.
 * Uses touchstart/touchmove/touchend + document.elementFromPoint to replicate
 * the mouse drag behaviour. Only calls e.preventDefault() after the finger
 * moves ≥8px so vertical scroll still works for short taps.
 */
function wireTriWorkoutTouchDnd(): void {
  const touchPrimary = isTouchPrimary();
  document.querySelectorAll<HTMLElement>('.tri-workout-card').forEach((card) => {
    // On touch devices the native HTML5 `draggable` makes WKWebView lift its own
    // drag preview, doubling up with the custom clone below. Disable it so only
    // the touch DnD runs; desktop keeps it for mouse drag.
    if (touchPrimary) card.draggable = false;
    card.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      _touchDragId = card.getAttribute('data-tri-workout-id') || '';
      _touchDragDay = parseInt(card.getAttribute('data-tri-day-of-week') || '-1', 10);
      _touchStartX = touch.clientX;
      _touchStartY = touch.clientY;
      _touchDragging = false;
      _touchSourceCard = card;
      _touchHoldMet = false;
      if (_touchHoldTimer !== null) clearTimeout(_touchHoldTimer);
      _touchHoldTimer = window.setTimeout(() => { _touchHoldMet = true; }, TOUCH_DRAG_HOLD_MS);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!_touchDragId) return;
      const touch = e.touches[0];
      const dx = touch.clientX - _touchStartX;
      const dy = touch.clientY - _touchStartY;

      if (!_touchDragging) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Long-press gate. Before the hold elapses, real movement means the
        // user is scrolling: abandon the drag candidate and let the page
        // scroll (no preventDefault). After the hold, a small intentional
        // move arms the drag.
        if (!_touchHoldMet) {
          if (dist >= 8) {
            if (_touchHoldTimer !== null) { clearTimeout(_touchHoldTimer); _touchHoldTimer = null; }
            _touchDragId = '';
          }
          return;
        }
        if (dist < 8) return;
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

      if (_touchClone) _touchClone.style.visibility = 'hidden';
      const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
      if (_touchClone) _touchClone.style.visibility = '';

      if (_touchLastHighlight) {
        _touchLastHighlight.style.outline = '';
        _touchLastHighlight.style.background = '';
        const rl = _touchLastHighlight.querySelector('.tri-day-rest-label') as HTMLElement | null;
        if (rl) rl.textContent = 'Rest';
        _touchLastHighlight = null;
      }

      const targetCard = el?.closest<HTMLElement>('.tri-workout-card');
      if (targetCard && targetCard !== card) {
        targetCard.style.outline = '2px solid #0F172A';
        targetCard.style.outlineOffset = '-2px';
        _touchLastHighlight = targetCard;
        return;
      }
      const targetHeader = el?.closest<HTMLElement>('.tri-day-header');
      if (targetHeader) {
        const tDay = parseInt(targetHeader.getAttribute('data-tri-day-stack') || '-1', 10);
        if (tDay >= 0 && tDay !== _touchDragDay) {
          targetHeader.style.background = 'rgba(15,23,42,0.06)';
          _touchLastHighlight = targetHeader;
        }
        return;
      }
      const targetRow = el?.closest<HTMLElement>('.tri-day-row');
      if (targetRow && !el?.closest('.tri-workout-card')) {
        const tDay = parseInt(targetRow.getAttribute('data-tri-day-drop') || '-1', 10);
        if (tDay >= 0 && tDay !== _touchDragDay) {
          targetRow.style.background = 'rgba(15,23,42,0.04)';
          const rl = targetRow.querySelector('.tri-day-rest-label') as HTMLElement | null;
          if (rl) rl.textContent = 'Drop here';
          _touchLastHighlight = targetRow;
        }
      }
    }, { passive: false });

    card.addEventListener('touchend', (e) => {
      if (_touchHoldTimer !== null) { clearTimeout(_touchHoldTimer); _touchHoldTimer = null; }
      _touchHoldMet = false;
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
        const rl = _touchLastHighlight.querySelector('.tri-day-rest-label') as HTMLElement | null;
        if (rl) rl.textContent = 'Rest';
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

      const targetCard = el?.closest<HTMLElement>('.tri-workout-card');
      if (targetCard && targetCard !== card) {
        const targetId = targetCard.getAttribute('data-tri-workout-id') || '';
        const targetDay = parseInt(targetCard.getAttribute('data-tri-day-of-week') || '-1', 10);
        if (targetId && targetDay >= 0 && targetDay !== srcDay) {
          swapWorkoutDays(srcId, targetId, srcDay, targetDay);
          rerenderTriDayListLocal();
          maybeOpenSuggestionsAfterDrop(targetDay);
          return;
        }
      }
      const targetHeader = el?.closest<HTMLElement>('.tri-day-header');
      if (targetHeader) {
        const targetDay = parseInt(targetHeader.getAttribute('data-tri-day-stack') || '-1', 10);
        if (targetDay >= 0 && targetDay !== srcDay) {
          moveWorkoutToDay(srcId, targetDay);
          rerenderTriDayListLocal();
          maybeOpenSuggestionsAfterDrop(targetDay);
          return;
        }
      }
      const targetRow = el?.closest<HTMLElement>('.tri-day-row');
      if (targetRow && !el?.closest('.tri-workout-card') && !el?.closest('.tri-day-header')) {
        const targetDay = parseInt(targetRow.getAttribute('data-tri-day-drop') || '-1', 10);
        if (targetDay >= 0 && targetDay !== srcDay) {
          moveWorkoutToDay(srcId, targetDay);
          rerenderTriDayListLocal();
          maybeOpenSuggestionsAfterDrop(targetDay);
        }
      }
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

/**
 * After a drop that lands a workout on today, surface the tri suggestion
 * modal if the drop has produced a mod targeting today specifically. We
 * deliberately filter out mods that aren't about today's load. The user
 * just made a change to today, the response should be about today, not
 * about next week's volume ramp or a cross-training overload elsewhere
 * in the week. Call after the plan re-render so the user sees the new
 * layout under the modal.
 *
 * Today-relevant filter:
 * - source `readiness` and `rpe_blown` are today-centric by construction
 *   (the aggregator picks today's quality workout when emitting them).
 * - any mod whose `targetWorkoutId` resolves to a workout currently on
 *   today is also today-relevant. Covers `cross_training_overload` when
 *   the recommended discipline's first mod happens to land on today.
 * - everything else (`volume_ramp` for next week, cross-training overload
 *   targeting another day) is dropped here. Those mods still surface via
 *   the home readiness CTA, which is the "everything actionable" entry
 *   point. They just don't pop a modal mid-drag.
 */
function maybeOpenSuggestionsAfterDrop(targetDay: number): void {
  const todayDow = (new Date().getDay() + 6) % 7;
  if (targetDay !== todayDow) return;
  import('@/calculations/tri-suggestion-aggregator').then(({ collectTriSuggestions }) => {
    const state = getState();
    const bundle = collectTriSuggestions(state);
    if (bundle.mods.length === 0) return;

    const todayWorkoutIds = new Set(
      (state.wks?.[state.w - 1]?.triWorkouts ?? [])
        .filter((w: Workout) => w.dayOfWeek === todayDow)
        .map((w: Workout) => w.id ?? w.n)
        .filter((id): id is string => !!id),
    );
    const todayMods = bundle.mods.filter((m) =>
      m.source === 'readiness' || m.source === 'rpe_blown' ||
      (m.targetWorkoutId && todayWorkoutIds.has(m.targetWorkoutId)),
    );
    if (todayMods.length === 0) return;

    const todayBundle = { ...bundle, mods: todayMods };
    import('./tri-suggestion-modal').then(({ showTriSuggestionModal }) => {
      showTriSuggestionModal(todayBundle).then(() => renderTriathlonPlanView());
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Injury system. Triathlon discipline-aware adaptation
// ─────────────────────────────────────────────────────────────────────────────

type DisciplineStatus = 'ok' | 'easy' | 'stop';

/**
 * Per-discipline training status derived from the user's own capacity sliders
 * (`runCapacity`/`bikeCapacity`/`swimCapacity`), NOT from the injury location.
 * The location-based guess was wrong for upper-body injuries: a shoulder injury
 * mapped to "swim normal, run easy" when the athlete had actually told us they
 * cannot swim. Mirrors the modal's caption bands exactly (modal.ts:142):
 * 0 → Paused, 1–99 → Low intensity only, 100 → Continue normally.
 */
function disciplineStatusFromCapacity(cap: number): DisciplineStatus {
  if (cap <= 0) return 'stop';
  if (cap >= 100) return 'ok';
  return 'easy';
}

/** Per-discipline status for swim/bike/run, read from the athlete's capacity sliders. */
function injuryDisciplineStatus(inj: InjuryState): Record<'swim' | 'bike' | 'run', DisciplineStatus> {
  return {
    swim: disciplineStatusFromCapacity(getDisciplineCapacity(inj, 'swim')),
    bike: disciplineStatusFromCapacity(getDisciplineCapacity(inj, 'bike')),
    run:  disciplineStatusFromCapacity(getDisciplineCapacity(inj, 'run')),
  };
}

function buildTriInjuryBanner(inj: InjuryState): string {
  const status = injuryDisciplineStatus(inj);
  const protocol = INJURY_PROTOCOLS[inj.type];
  const displayName = protocol?.displayName || inj.type;

  const phaseLabels: Record<string, string> = {
    acute: 'Acute, Rest',
    rehab: 'Rehabilitation',
    test_capacity: 'Capacity Testing',
    return_to_run: 'Return to Run',
    graduated_return: 'Graduated Return',
    resolved: 'Resolved',
  };
  const phaseLabelText = phaseLabels[inj.injuryPhase] || 'Rehabilitation';

  const discRow = (disc: 'swim' | 'bike' | 'run', label: string): string => {
    const st = status[disc];
    const text = st === 'ok' ? 'Continue normally' : st === 'easy' ? 'Low intensity only' : 'Paused';
    const colour = st === 'ok' ? '#5a8050' : st === 'easy' ? '#92400E' : '#94A3B8';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
      <span style="font-size:12px;font-weight:600;color:#0F172A">${label}</span>
      <span style="font-size:11px;font-weight:500;color:${colour}">${text}</span>
    </div>`;
  };

  return `
    <div style="margin-bottom:12px;padding:16px;background:#fff;border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div>
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">Recovery mode</div>
          <div style="font-size:16px;font-weight:600;color:#0F172A;letter-spacing:-0.01em">${displayName}</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:3px">${phaseLabelText}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Pain</div>
          <div style="font-size:28px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:#0F172A">${inj.currentPain}<span style="font-size:12px;color:var(--c-faint);font-weight:400">/10</span></div>
        </div>
      </div>
      <div style="margin-bottom:12px">
        ${discRow('swim', 'Swim')}
        ${discRow('bike', 'Bike')}
        ${discRow('run', 'Run')}
      </div>
      <div style="display:flex;gap:8px">
        <button id="tri-injury-update" class="m-btn-secondary" style="flex:1;font-size:13px;padding:10px 0;text-align:center">Update injury</button>
        <button id="tri-injury-recovered" class="m-btn-primary" style="flex:1;font-size:13px;padding:10px 0;justify-content:center">I'm recovered</button>
      </div>
    </div>
  `;
}

function buildTriMorningPainCheck(inj: InjuryState): string {
  const s = getState();
  const today = new Date().toISOString().split('T')[0];
  if ((s as any).lastMorningPainDate === today) return '';

  const protocol = INJURY_PROTOCOLS[inj.type];
  const injName = protocol?.displayName || inj.type;
  const pain = inj.currentPain || 0;
  const btnBase = 'padding:12px 0;font-size:13px;text-align:center';

  return `
    <div id="tri-morning-pain-check" style="margin-bottom:12px;padding:16px;background:#fff;border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05)">
      <div style="margin-bottom:13px">
        <div style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--c-black);margin-bottom:3px">Morning check-in</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">How does your ${injName.toLowerCase()} feel vs yesterday? <span style="color:var(--c-faint);font-weight:500">Pain ${pain}/10</span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px">
        <button class="tri-morning-pain-btn m-btn-secondary" data-response="worse" style="${btnBase}">Worse</button>
        <button class="tri-morning-pain-btn m-btn-secondary" data-response="same" style="${btnBase}">Same</button>
        <button class="tri-morning-pain-btn m-btn-secondary" data-response="better" style="${btnBase}">Better</button>
      </div>
    </div>
  `;
}

function handleTriMorningPainResponse(response: 'worse' | 'same' | 'better'): void {
  const s = getMutableState() as any;
  const today = new Date().toISOString().split('T')[0];
  s.lastMorningPainDate = today;
  const injuryState = s.injuryState;
  if (!injuryState) return;
  const entry = {
    date: today,
    response,
    painLevel: injuryState.currentPain || 0,
  };
  if (!injuryState.morningPainResponses) injuryState.morningPainResponses = [];
  injuryState.morningPainResponses.push(entry);
  const newPain = response === 'better'
    ? Math.max(0, (injuryState.currentPain || 1) - 1)
    : response === 'worse'
    ? Math.min(10, (injuryState.currentPain || 1) + 1)
    : injuryState.currentPain;
  s.injuryState = recordMorningPain(injuryState, newPain);
  saveState();
  const card = document.getElementById('tri-morning-pain-check');
  if (card) {
    card.innerHTML = `<div style="font-size:13px;color:var(--c-muted);padding:4px 0;font-weight:500">Noted. ${response === 'better' ? 'good to hear.' : response === 'worse' ? 'take it easy today.' : 'maintaining the plan.'}</div>`;
  }
}

/** Render a greyed-out rest placeholder for a discipline-stopped workout. */
function renderInjuryRestCard(w: Workout, disc: string): string {
  const discLabel = disc === 'swim' ? 'Swim' : disc === 'bike' ? 'Bike' : 'Run';
  return `
    <div class="tri-workout-card" data-tri-workout-id="${escapeHtml(w.id ?? w.n)}" data-tri-day-of-week="${w.dayOfWeek ?? ''}" draggable="false" style="
      background:#f8fafc;border-radius:14px;padding:14px 16px;margin-bottom:8px;
      box-shadow:0 1px 2px rgba(0,0,0,0.04);opacity:0.55;cursor:default;
    ">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="display:inline-flex;align-items:center;padding:3px 8px;border-radius:100px;background:rgba(0,0,0,0.06);color:#94A3B8;font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase">${discLabel}. Paused</span>
      </div>
      <div style="font-size:15px;font-weight:600;color:#94A3B8;margin-bottom:4px;letter-spacing:-0.01em">${escapeHtml(w.n)}</div>
      <div style="font-size:12px;color:#94A3B8;line-height:1.5">${discLabel} training paused during injury recovery.</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Completed efforts. Past-week section + detail pop-up
// ─────────────────────────────────────────────────────────────────────────────

function fmtDurSec(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

interface EffortSignal { label: string; color: string; }
function effortSignal(actual: any, discipline: string): EffortSignal | null {
  let score: number | null = null;
  const isSwim = discipline === 'swim';
  if (discipline === 'bike') score = actual?.powerAdherence ?? actual?.hrEffortScore ?? null;
  else if (isSwim) score = actual?.paceAdherence ?? null;
  else score = actual?.hrEffortScore ?? null;
  if (score == null) return null;
  // Swim: score > 1.0 = slower than target. Bike/run: score > 1.0 = harder than planned.
  if (score > 1.12) return { label: isSwim ? 'Off pace'      : 'Hard effort',    color: '#EF4444' };
  if (score > 1.07) return { label: isSwim ? 'Slightly slow' : 'Above target',   color: '#F59E0B' };
  if (score >= 0.93) return { label: 'On target',                                 color: '#22C55E' };
  if (score >= 0.87) return { label: isSwim ? 'Ahead of pace' : 'Below target',  color: '#94A3B8' };
  return              { label: isSwim ? 'Well ahead'    : 'Well below target',   color: '#94A3B8' };
}

function buildCompletedEfforts(wk: any, s: any): string {
  const completed = (wk?.triWorkouts ?? []).filter((w: any) => w.status === 'completed');
  const actuals = wk?.garminActuals ?? {};
  const rated   = wk?.rated ?? {};

  const rows = completed.map((w: any) => {
    const actual  = w.matchedActivityId ? actuals[w.matchedActivityId] : null;
    const disc    = (w.discipline ?? 'run') as BadgeKind;
    const c       = DISCIPLINE_COLOURS[disc] ?? DISCIPLINE_COLOURS.run;
    const icon    = DISCIPLINE_ICON[disc]    ?? '';
    const label   = DISCIPLINE_LABEL[disc]   ?? disc;
    const rpe     = typeof rated[w.id ?? w.n] === 'number' ? (rated[w.id ?? w.n] as number) : null;
    const signal  = actual ? effortSignal(actual, disc) : null;
    const actualDur = actual?.durationSec ? fmtDurSec(actual.durationSec) : null;
    const meta    = [w.dayName, actualDur].filter(Boolean).join(' · ');

    const right = signal
      ? `<span style="font-size:11px;font-weight:600;color:${signal.color}">${signal.label}</span>`
      : rpe != null
      ? `<span style="font-size:11px;color:var(--c-muted)">RPE ${rpe}</span>`
      : '';

    return `
      <div class="tri-completed-row" data-completed-id="${escapeHtml(w.id ?? w.n)}"
        style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05);cursor:pointer">
        <span style="display:inline-flex;align-items:center;gap:4px;background:${c.badge};color:${c.badgeText};font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:3px 7px;border-radius:100px;flex-shrink:0">
          ${icon} ${label}
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(w.n)}</div>
          ${meta ? `<div style="font-size:11px;color:var(--c-muted)">${meta}</div>` : ''}
        </div>
        <div style="flex-shrink:0">${right}</div>
        <svg style="flex-shrink:0;color:var(--c-faint)" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </div>`;
  }).join('');

  // Extra activities the user logged that did NOT map to a completed planned
  // session: unmatched/extra sessions, orphaned matches, or pending review.
  // These already showed on Home and on the running Activity Log; they were
  // invisible here because this list only walked completed planned workouts.
  // Same shared source (collectWeekActivities) so the three surfaces agree.
  const renderedKeys = new Set<string>();
  const renderedGarminIds = new Set<string>();
  for (const w of completed) {
    if (w.matchedActivityId) renderedKeys.add(w.matchedActivityId);
    const a = w.matchedActivityId ? actuals[w.matchedActivityId] : null;
    if (a?.garminId) renderedGarminIds.add(a.garminId);
  }
  const STATUS_LABEL: Record<string, string> = { matched: 'Logged', logged: 'Logged', excess: 'Excess', pending: 'Pending' };
  const extra = collectWeekActivities(wk).filter(e =>
    !renderedKeys.has(e.key) && !(e.garminId && renderedGarminIds.has(e.garminId)));

  const extraRows = extra.map((e) => {
    const known = e.discipline != null;
    const disc  = (e.discipline ?? 'strength') as BadgeKind;
    const c     = DISCIPLINE_COLOURS[disc] ?? DISCIPLINE_COLOURS.run;
    const icon  = known ? (DISCIPLINE_ICON[disc] ?? '') : '';
    const label = known ? (DISCIPLINE_LABEL[disc] ?? disc) : 'Other';
    const dur   = e.durationMin > 0 ? `${e.durationMin} min` : null;
    const dateStr = e.sortTime ? new Date(e.sortTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    const meta  = [dateStr, dur].filter(Boolean).join(' · ');

    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
        <span style="display:inline-flex;align-items:center;gap:4px;background:${c.badge};color:${c.badgeText};font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:3px 7px;border-radius:100px;flex-shrink:0">
          ${icon} ${label}
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.name)}</div>
          ${meta ? `<div style="font-size:11px;color:var(--c-muted)">${meta}</div>` : ''}
        </div>
        <div style="flex-shrink:0"><span style="font-size:11px;color:var(--c-muted)">${STATUS_LABEL[e.badge]}</span></div>
      </div>`;
  }).join('');

  if (!rows && !extraRows) return '';

  return `
    <div style="margin:0 20px 12px;background:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
      <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:4px">Activity log</div>
      ${rows}
      ${extraRows}
    </div>`;
}

function openCompletedEffortDetail(workoutId: string, wk: any, s: any): void {
  document.getElementById('tri-completed-detail-overlay')?.remove();
  const w = (wk?.triWorkouts ?? []).find((x: any) => (x.id ?? x.n) === workoutId);
  if (!w) return;

  const actual    = w.matchedActivityId ? (wk?.garminActuals ?? {})[w.matchedActivityId] : null;
  const rated     = wk?.rated ?? {};
  const rpe       = typeof rated[w.id ?? w.n] === 'number' ? (rated[w.id ?? w.n] as number) : null;
  const disc      = (w.discipline ?? 'run') as BadgeKind;
  const c         = DISCIPLINE_COLOURS[disc] ?? DISCIPLINE_COLOURS.run;
  const icon      = DISCIPLINE_ICON[disc]    ?? '';
  const label     = DISCIPLINE_LABEL[disc]   ?? disc;
  const plannedMin = estimateMinutes(w);
  const actualDur = actual?.durationSec ? fmtDurSec(actual.durationSec) : null;
  const actualDist = actual?.distanceKm  ? formatKm(actual.distanceKm, s.unitPref ?? 'km') : null;
  const avgHR     = actual?.avgHR        ? `${Math.round(actual.avgHR)} bpm` : null;
  const signal    = actual ? effortSignal(actual, disc) : null;

  // Signal plain-language detail
  let signalDetail = '';
  if (actual) {
    if (disc === 'bike' && actual.powerAdherence != null) {
      const pct = Math.round(actual.powerAdherence * 100);
      signalDetail = `Power output was ${pct}% of target.`;
    } else if (disc === 'swim' && actual.paceAdherence != null) {
      const pct = Math.round(actual.paceAdherence * 100);
      signalDetail = pct <= 100
        ? `Swam ${100 - pct}% faster than target pace.`
        : `Swam ${pct - 100}% slower than target pace.`;
    } else if (actual.hrEffortScore != null) {
      const pct = Math.round(actual.hrEffortScore * 100);
      signalDetail = pct <= 100
        ? `Heart rate was ${100 - pct}% below the expected zone.`
        : `Heart rate was ${pct - 100}% above the expected zone.`;
    }
  }

  const row = (label: string, value: string) =>
    `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.04)">
      <span style="font-size:13px;color:var(--c-muted)">${label}</span>
      <span style="font-size:13px;font-weight:600;color:#0F172A">${value}</span>
    </div>`;

  const statsRows = [
    plannedMin > 0 ? row('Planned', `${plannedMin} min`) : '',
    actualDur       ? row('Actual duration', actualDur) : '',
    actualDist      ? row('Distance', actualDist) : '',
    avgHR           ? row('Avg HR', avgHR) : '',
    rpe != null     ? row('RPE rated', `${rpe} / 10`) : '',
  ].join('');

  const overlay = document.createElement('div');
  overlay.id = 'tri-completed-detail-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';

  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:420px;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3);overflow:hidden">
      <div style="background:linear-gradient(180deg,${c.bg},rgba(255,255,255,0));padding:20px 22px 16px;border-bottom:1px solid rgba(0,0,0,0.05)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="display:inline-flex;align-items:center;gap:5px;background:${c.badge};color:${c.badgeText};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:3px 9px;border-radius:100px">${icon} ${label}</span>
          <button id="tri-completed-close" style="width:30px;height:30px;background:rgba(0,0,0,0.05);border:none;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted)" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style="font-size:22px;font-weight:700;color:#0F172A;letter-spacing:-0.02em">${escapeHtml(w.n)}</div>
        ${w.dayName ? `<div style="font-size:12px;color:var(--c-muted);margin-top:3px">${w.dayName}</div>` : ''}
      </div>
      <div style="padding:16px 22px 20px">
        ${statsRows}
        ${signal ? `
          <div style="margin-top:14px;padding:12px 14px;background:rgba(0,0,0,0.03);border-radius:10px">
            <div style="font-size:12px;font-weight:600;color:${signal.color};margin-bottom:3px">${signal.label}</div>
            ${signalDetail ? `<div style="font-size:12px;color:var(--c-muted);line-height:1.5">${signalDetail}</div>` : ''}
          </div>` : ''}
        <button id="tri-completed-done" class="m-btn-primary" style="margin-top:16px;width:100%;padding:13px;font-size:14px">Done</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#tri-completed-close')?.addEventListener('click', close);
  overlay.querySelector('#tri-completed-done')?.addEventListener('click', close);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderDay(d: number, list: Array<any>, benchmarkCtx: { cssSecPer100m: number | null; ftp: number | null; dismissedTests?: Set<string> }, injStatus: Record<'swim' | 'bike' | 'run', DisciplineStatus> | null = null, statusCtx: { wk: any; ctx: WeekStatusContext } | null = null): string {
  const dayLabel = DAY_NAMES[d];
  // Done / Logged / Missed / Today flag, mirroring the running plan-view card.
  const chipFor = (w: any): string =>
    statusCtx ? renderWorkoutStatusChip(deriveWorkoutStatus(w, statusCtx.wk, statusCtx.ctx)) : '';
  // "Completed · 56 min · Wed 3 Jun" footnote on a completed card — what was
  // actually done, so a logged session reads unambiguously as finished.
  const completedSummaryFor = (w: any): string | undefined => {
    if (!statusCtx) return undefined;
    const actuals = statusCtx.wk?.garminActuals ?? {};
    const a = (w.matchedActivityId && actuals[w.matchedActivityId]) || actuals[w.id ?? w.n];
    if (!a?.garminId) return undefined;
    const parts: string[] = ['Completed'];
    if (a.durationSec) parts.push(`${Math.round(a.durationSec / 60)} min`);
    if (a.distanceKm && a.distanceKm > 0.1) parts.push(formatKm(a.distanceKm, getState().unitPref ?? 'km'));
    if (a.startTime) {
      const t = new Date(a.startTime);
      if (!isNaN(t.getTime())) parts.push(t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
    }
    return parts.join(' · ');
  };
  if (list.length === 0) {
    // Empty rest day: the row itself is the drop zone (mirrors running's
    // single `.plan-drop-zone`). No inner `.tri-day-header`, so the row's
    // drop handler isn't suppressed by the header-exclusion guard at the top
    // of the `.tri-day-row` drop listener, and a generous top/bottom pad makes
    // the thin strip an easy target. Fixes "card picks up but won't drop on
    // the last/empty day" (e.g. dragging Saturday's session onto rest-day Sunday).
    return `
      <div class="tri-day-row" data-tri-day-drop="${d}" style="display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:16px 8px 10px;border-radius:10px;transition:background 0.15s">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-muted);min-width:40px">${dayLabel.slice(0, 3)}</span>
        <span style="flex:1;height:1px;background:rgba(0,0,0,0.06)"></span>
        <span class="tri-day-rest-label" style="font-size:11px;color:var(--c-faint);font-weight:500">Rest</span>
      </div>
    `;
  }

  const renderedCards = list.map((w) => {
    const rawDisc = w.discipline as 'swim' | 'bike' | 'run' | undefined;
    // Non-tri-discipline workouts (strength, gym) are never injury-restricted
    if (!injStatus || !rawDisc || (rawDisc !== 'swim' && rawDisc !== 'bike' && rawDisc !== 'run')) {
      // Leg-load nudge on a leg-day gym card when the legs are already loaded
      // (shared helper — matches the running plan-view card). Suggest-only.
      const isStrength = w.t === 'gym' || w.t === 'strength' || /strength|gym/i.test(w.n);
      const isActiveCard = w.status !== 'completed' && w.status !== 'skipped' && w.status !== 'replaced';
      const legLoadNudge = isStrength && isActiveCard
        ? (gymLegLoadNudgeForWorkout(w, getState().recentLegLoads ?? [], w.rpe ?? w.r ?? 7, Date.now()) ?? undefined)
        : undefined;
      return renderTriWorkoutCard(w, { ...benchmarkCtx, dismissedTests: benchmarkCtx.dismissedTests, statusChip: chipFor(w), legLoadNudge, completedSummary: completedSummaryFor(w) });
    }
    // For bricks: use the more restrictive of bike/run status
    let disc: 'swim' | 'bike' | 'run' = rawDisc;
    if (w.t === 'brick') {
      const rank: Record<DisciplineStatus, number> = { ok: 0, easy: 1, stop: 2 };
      disc = rank[injStatus.bike] >= rank[injStatus.run] ? 'bike' : 'run';
    }
    const status = injStatus[disc];
    if (status === 'stop') return renderInjuryRestCard(w, rawDisc);
    return renderTriWorkoutCard(w, { ...benchmarkCtx, dismissedTests: benchmarkCtx.dismissedTests, injuryEasy: status === 'easy', statusChip: chipFor(w), completedSummary: completedSummaryFor(w) });
  }).join('');

  return `
    <div class="tri-day-row" data-tri-day-drop="${d}" style="margin-bottom:16px;padding:6px 8px;border-radius:10px;transition:background 0.15s">
      <div class="tri-day-header" data-tri-day-stack="${d}" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;border-radius:6px;transition:background 0.15s">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#0F172A;min-width:40px">${dayLabel.slice(0, 3)}</span>
        <span style="flex:1;height:1px;background:rgba(0,0,0,0.06)"></span>
        <span class="tri-day-stack-label" style="font-size:11px;color:var(--c-faint);font-weight:500">${list.length > 1 ? `${list.length} sessions` : ''}</span>
      </div>
      ${renderedCards}
    </div>
  `;
}

function renderDisciplineMini(
  d: 'swim' | 'bike' | 'run',
  doneMin: number,
  plannedMin: number,
  showProgress: boolean,
): string {
  const colour = d === 'swim' ? '#5b8a8a' : d === 'bike' ? '#c08460' : '#7a845c';
  const label = d === 'swim' ? 'Swim' : d === 'bike' ? 'Bike' : 'Run';
  const pct = showProgress && plannedMin > 0
    ? Math.min(100, Math.round((doneMin / plannedMin) * 100))
    : 0;
  const rightLabel = showProgress
    ? `${fmtHoursZero(doneMin)} / ${fmtHours(plannedMin)}`
    : fmtHours(plannedMin);
  return `
    <div style="background:#fff;border-radius:10px;padding:8px 10px;box-shadow:0 1px 2px rgba(0,0,0,0.04)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:10px;font-weight:600;color:${colour};letter-spacing:0.04em;text-transform:uppercase">${label}</span>
        <span style="font-size:11px;color:var(--c-muted);font-variant-numeric:tabular-nums">${rightLabel}</span>
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

/** Like fmtHours but renders "0h" instead of an em-dash so the "done" caption
 *  shows a real number early in the week. */
function fmtHoursZero(mins: number): string {
  if (mins <= 0) return '0h';
  return fmtHours(mins);
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

// ─── Chronic high-RPE bike prompt ─────────────────────────────────────────────

/**
 * Detects 3+ consecutive completed weeks where all rated bike workouts had
 * RPE ≥ 8. Returns the count, or 0 if the pattern isn't present.
 * Only counts weeks where at least one bike workout was rated.
 */
function detectConsecutiveHighRpeBike(state: ReturnType<typeof getState>): number {
  const wks = state.wks ?? [];
  const completedWeeks = Math.max(0, (state.w ?? 1) - 1);
  let consecutiveCount = 0;
  for (let i = completedWeeks - 1; i >= 0; i--) {
    const wk = wks[i];
    if (!wk?.triWorkouts || !wk.rated) break;
    const bikeWorkouts = wk.triWorkouts.filter(w => (w.discipline ?? 'run') === 'bike' && w.id);
    const ratedBike = bikeWorkouts.filter(w => typeof wk.rated![w.id!] === 'number');
    if (ratedBike.length === 0) break; // week had no rated bike workouts. Stop
    const allHigh = ratedBike.every(w => (wk.rated![w.id!] as number) >= 8);
    if (!allHigh) break;
    consecutiveCount++;
  }
  return consecutiveCount;
}

/**
 * Prompts the user once when 3+ consecutive bike weeks have all been rated RPE 8+.
 * No auto-correction. User confirms they've seen it; stored in notifiedMarkers
 * so it doesn't fire every render.
 */
function maybePromptHighRpeBike(): void {
  const s = getState();
  const tri = s.triConfig;
  if (!tri) return;
  const count = detectConsecutiveHighRpeBike(s);
  if (count < 3) return;
  // Already notified for this week or later
  if ((tri.notifiedMarkers?.highRpeBikeWeek ?? 0) >= (s.w ?? 1)) return;

  // Delay so the plan view mounts first
  setTimeout(() => {
    if (document.getElementById('high-rpe-bike-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'high-rpe-bike-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:24px';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:20px;padding:24px;max-width:360px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.18)">
        <div style="font-size:15px;font-weight:700;color:#0F172A;margin-bottom:8px">Bike sessions consistently at high effort</div>
        <div style="font-size:13px;color:#475569;line-height:1.55;margin-bottom:18px">
          Bike workouts have been rated 8 to 10 RPE for ${count} weeks. Targets may be set too high relative to your current FTP. Sustained overreaching limits adaptation and raises injury risk.
          <br><br>
          Consider retesting your FTP or reducing watt targets. Nothing in your plan changes automatically.
        </div>
        <div style="display:flex;gap:10px">
          <button id="high-rpe-review-ftp" class="m-btn-secondary" style="flex:1;padding:12px;font-size:13px">Review FTP</button>
          <button id="high-rpe-dismiss" class="m-btn-primary" style="flex:1;padding:12px;font-size:13px">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const dismiss = () => {
      overlay.remove();
      const ms = getMutableState();
      if (ms.triConfig) {
        if (!ms.triConfig.notifiedMarkers) ms.triConfig.notifiedMarkers = {};
        ms.triConfig.notifiedMarkers.highRpeBikeWeek = ms.w ?? 1;
        saveState();
      }
    };

    document.getElementById('high-rpe-dismiss')?.addEventListener('click', dismiss);
    document.getElementById('high-rpe-review-ftp')?.addEventListener('click', () => {
      dismiss();
      import('../benchmark-overlay').then(({ openBenchmarkOverlay }) => openBenchmarkOverlay());
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  }, 500);
}
