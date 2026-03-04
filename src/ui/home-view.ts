/**
 * Home tab — the app landing screen.
 * Shows this-week progress, injury risk, today's workout, race countdown, recent activity.
 */

import { getState } from '@/state';
import type { SimulatorState } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';
import { computeWeekTSS, computeWeekRawTSS, computeACWR, getWeeklyExcess } from '@/calculations/fitness-model';
import { generateWeekWorkouts } from '@/workouts';
import { isInjuryActive } from './injury/modal';

// ─── Navigation ────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'plan') {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'record') {
    import('./record-view').then(({ renderRecordView }) => renderRecordView());
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderStatsView }) => renderStatsView());
  } else if (tab === 'account') {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

// ─── Data helpers ───────────────────────────────────────────────────────────

/** JS getDay() → Mon-0 … Sun-6 */
function jsToOurDay(jsDay: number): number {
  return jsDay === 0 ? 6 : jsDay - 1;
}

/** Days remaining until an ISO date string */
function daysUntil(isoDate: string): number {
  const race = new Date(isoDate);
  const now = new Date();
  race.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((race.getTime() - now.getTime()) / 86400000));
}

/** Day-of-week short label: Mon, Tue … */
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function todayLabel(): string {
  const ourDay = jsToOurDay(new Date().getDay());
  return DAY_LABELS[ourDay];
}

/** Format ISO date as "Mon 17 Feb" */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const NON_RUN_KW = ['cross', 'gym', 'strength', 'rest', 'yoga', 'swim', 'bike', 'cycl',
  'tennis', 'hiit', 'pilates', 'row', 'hik', 'elliptic', 'walk'];
const isRunKey = (k: string) => !NON_RUN_KW.some(kw => k.toLowerCase().includes(kw));

// ─── Section builders ───────────────────────────────────────────────────────

function buildProgressBars(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];

  // Sessions done this week — prefer synced activity count (Strava or Garmin) over rated count
  const syncedSessions = wk
    ? Object.keys(wk.garminActuals || {}).length
      + (wk.adhocWorkouts || []).filter((w: any) =>
          w.id?.startsWith('garmin-') || w.id?.startsWith('strava-')
        ).length
    : 0;
  const ratedSessions = wk
    ? Object.values(wk.rated || {}).filter(v => typeof v === 'number' && v > 0).length
    : 0;
  const sessionsDone = Math.max(syncedSessions, ratedSessions);
  // Count all planned non-rest sessions (runs + gym + cross-training + adhoc)
  const plannedWorkouts = wk
    ? generateWeekWorkouts(
        wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
        null, s.recurringActivities,
        s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
      )
    : [];
  const adhocExtra = wk
    ? (wk.adhocWorkouts || []).filter((w: any) => !(w.id || '').startsWith('garmin-') && !(w.id || '').startsWith('strava-')).length
    : 0;
  const sessionsPlan = plannedWorkouts.filter((w: any) => w.t !== 'rest').length + adhocExtra || s.rw || 5;

  // Distance this week (running only from garmin, or completedKm)
  const kmDone = wk
    ? Object.entries(wk.garminActuals || {})
        .filter(([k]) => isRunKey(k))
        .reduce((sum, [, a]) => sum + ((a as any).distanceKm || 0), 0)
    : 0;
  const kmPlan = (s.rw || 5) * ((s.wks?.[s.w - 1] as any)?.targetKmPerRun || 10);

  // TSS this week vs plan — Signal B (raw physiological): honest total load, gym + cross-training at full weight
  const tssActual = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  const tssPlan = (wk as any)?.plannedTSS || (kmPlan * 4.5); // ~4.5 TSS/km fallback

  function bar(actual: number, plan: number, fmt: (v: number) => string, planFmt: (v: number) => string): string {
    if (plan <= 0) return '';
    const ratio = actual / plan;
    const overRatio = Math.max(0, ratio - 1);

    // Bar fill: cap the visual at 88% of container width
    // Within 88%: green portion = min(ratio, 1) × 88, amber = overshoot portion
    const greenWidth = Math.min(ratio, 1) * 88;
    const amberWidth = Math.min(overRatio, 0.3) * 88; // cap amber at 30% over
    const totalWidth = greenWidth + amberWidth;

    // Overflow label (+X%)
    const overPct = Math.round(overRatio * 100);
    const overLabel = overPct >= 5
      ? `<span class="absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-bold" style="color:${overPct >= 30 ? 'var(--c-warn)' : 'var(--c-caution)'}">${overPct >= 30 ? '+' + overPct + '%' : '+' + overPct + '%'}</span>`
      : '';

    // Colour: grey until 70%, then green, cap segments for over-target
    let fillStyle: string;
    if (ratio < 0.7) {
      fillStyle = `background:var(--c-muted);width:${totalWidth}%`;
    } else if (ratio <= 1.05) {
      fillStyle = `background:var(--c-ok);width:${totalWidth}%`;
    } else {
      // green to target, amber cap
      const targetPx = Math.min(1, 1) * 88; // target position within 88%
      fillStyle = `background:linear-gradient(to right, var(--c-ok) ${(88 / totalWidth * 100).toFixed(1)}%, var(--c-caution) ${(88 / totalWidth * 100).toFixed(1)}%);width:${totalWidth}%`;
    }

    return `<div class="m-prog-fill" style="${fillStyle}"></div>`;
  }

  // Simplified colour logic
  function fillBar(actual: number, plan: number): string {
    if (plan <= 0) return '';
    const ratio = actual / plan;
    const capWidth = 88; // max bar % width
    const targetPct = Math.min(ratio, 1) * capWidth;
    const overPct = Math.min(Math.max(0, ratio - 1), 0.42) * capWidth;
    const totalWidth = targetPct + overPct;

    if (ratio < 0.7) {
      return `<div class="m-prog-fill" style="width:${totalWidth}%;background:var(--c-muted)"></div>`;
    }
    if (ratio <= 1.05) {
      return `<div class="m-prog-fill" style="width:${totalWidth}%;background:var(--c-ok)"></div>`;
    }
    // overshoot: green body + amber cap via gradient
    const greenPct = (targetPct / totalWidth * 100).toFixed(1);
    return `<div class="m-prog-fill" style="width:${totalWidth}%;background:linear-gradient(to right,var(--c-ok) ${greenPct}%,var(--c-caution) ${greenPct}%)"></div>`;
  }

  function overLabel(actual: number, plan: number): string {
    if (plan <= 0) return '';
    const overPct = Math.round(((actual / plan) - 1) * 100);
    if (overPct < 5) return '';
    const col = overPct >= 30 ? 'var(--c-warn)' : 'var(--c-caution)';
    return `<span class="absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-bold" style="color:${col}">+${overPct}%</span>`;
  }

  // Status pill
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate);
  let pillHtml: string;
  let pillCaption: string;
  if (acwr.ratio <= 0 || (s.w < 3)) {
    pillHtml = `<span class="m-pill m-pill-neutral"><span class="m-pill-dot"></span>Building Consistency</span>`;
    pillCaption = 'Keep logging sessions — your baseline builds over the first 4 weeks.';
  } else if (acwr.status === 'high') {
    pillHtml = `<span class="m-pill m-pill-caution"><span class="m-pill-dot"></span>Consider slowing down</span>`;
    pillCaption = 'Load is spiking. Protect recovery before next week.';
  } else if (acwr.status === 'caution') {
    pillHtml = `<span class="m-pill m-pill-caution"><span class="m-pill-dot"></span>Training Hard!</span>`;
    pillCaption = 'Load is rising fast. Keep today\'s session easy if possible.';
  } else {
    pillHtml = `<span class="m-pill m-pill-ok"><span class="m-pill-dot"></span>On Track!</span>`;
    pillCaption = sessionsDone >= sessionsPlan
      ? 'Great week — you hit all your sessions.'
      : `${sessionsPlan - sessionsDone} session${sessionsPlan - sessionsDone > 1 ? 's' : ''} left this week.`;
  }

  return `
    <div class="section px-[18px] mb-[14px]">
      <div class="m-sec-label">This Week</div>
      <div class="m-card p-4 flex flex-col gap-[13px]">

        <div class="flex flex-col gap-[7px]">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Sessions</span>
            <span class="text-[12px] font-medium" style="letter-spacing:-0.01em">${sessionsDone} / ${sessionsPlan}</span>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(sessionsDone, sessionsPlan)}</div>
            ${overLabel(sessionsDone, sessionsPlan)}
          </div>
        </div>

        <div class="flex flex-col gap-[7px]">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Distance</span>
            <span class="text-[12px] font-medium" style="letter-spacing:-0.01em">${kmDone.toFixed(1)} / ${kmPlan.toFixed(0)} km</span>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(kmDone, kmPlan)}</div>
            ${overLabel(kmDone, kmPlan)}
          </div>
        </div>

        <div id="home-tss-row" class="flex flex-col gap-[7px]" style="cursor:pointer">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Training Load (TSS)</span>
            <div class="flex items-center gap-[6px]">
              <span class="text-[12px] font-medium" style="letter-spacing:-0.01em">${tssActual} / ${Math.round(tssPlan)} TSS</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.25"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </div>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(tssActual, tssPlan)}</div>
            ${overLabel(tssActual, tssPlan)}
          </div>
        </div>

        <div class="flex items-center gap-2 pt-[2px]">
          ${pillHtml}
          <span class="text-[12px]" style="color:var(--c-muted)">${pillCaption}</span>
        </div>
      </div>
    </div>
  `;
}

function buildSignalBars(s: SimulatorState): string {
  const tier = s.athleteTierOverride ?? s.athleteTier;
  // ATL seed: inflate baseline for gym-heavy athletes — same formula as buildAdvancedSection in stats-view so
  // Home and Stats always compute ACWR identically (fixes ISSUE-55)
  const atlSeedMultiplier = 1 + Math.min(0.1 * (s.gs ?? 0), 0.3);
  const atlSeed = (s.ctlBaseline ?? 0) * atlSeedMultiplier;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);

  // Injury risk: map ACWR ratio to 0–100% position on gradient bar
  let riskPct = 0;
  let riskLabel = '—';
  let riskLabelColor = 'var(--c-faint)';
  let riskCaption = 'Keep training consistently to build your baseline.';
  let thumbBorder = 'var(--c-border-strong)';

  if (acwr.ratio > 0) {
    // Map 0.6→0% to 1.8→100%
    riskPct = Math.min(100, Math.max(0, Math.round(((acwr.ratio - 0.6) / 1.2) * 100)));
    if (acwr.status === 'high') {
      riskLabel = 'High'; riskLabelColor = 'var(--c-warn)'; thumbBorder = 'var(--c-warn)';
      riskCaption = 'Load is significantly above your baseline. Reduce one session this week.';
    } else if (acwr.status === 'caution') {
      riskLabel = 'Elevated'; riskLabelColor = 'var(--c-caution)'; thumbBorder = 'var(--c-caution)';
      riskCaption = 'You\'ve trained hard this week. Prioritise sleep and keep tomorrow easy.';
    } else {
      riskLabel = 'Low'; riskLabelColor = 'var(--c-ok)';
      riskCaption = 'Load is within a safe range. Keep this week\'s plan as-is.';
    }
  }

  // Recovery: prefer manual check-in for today, fall back to latest Garmin physiology
  const today = new Date().toISOString().split('T')[0];
  const manualToday = s.lastRecoveryPromptDate === today
    ? (s.recoveryHistory ?? []).slice().reverse().find((e: any) => e.date === today && e.source === 'manual')
    : undefined;
  const latestPhysio = s.physiologyHistory?.slice(-1)[0];

  // HRV dot derived from latest physiology RMSSD
  const rmssd = latestPhysio?.hrvRmssd;
  let hrvDotColor = '';
  if (rmssd != null) {
    hrvDotColor = rmssd >= 50 ? 'var(--c-ok)' : rmssd >= 35 ? 'var(--c-caution)' : 'var(--c-warn)';
  }
  const hrvDot = hrvDotColor
    ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${hrvDotColor};margin-right:5px;vertical-align:middle"></span>`
    : '';

  // Resting HR sub-caption (compare vs 7-day average)
  let rhrCaption = '';
  if (latestPhysio?.restingHR != null) {
    const rhrValues = (s.physiologyHistory ?? []).map((p: any) => p.restingHR).filter((v: any) => v != null) as number[];
    const rhrAvg = rhrValues.length > 1 ? Math.round(rhrValues.slice(0, -1).reduce((a, b) => a + b, 0) / (rhrValues.length - 1)) : null;
    const rhrDiff = rhrAvg != null ? latestPhysio.restingHR - rhrAvg : 0;
    const rhrArrow = rhrDiff > 2 ? ' ↑' : rhrDiff < -2 ? ' ↓' : '';
    rhrCaption = ` · RHR: ${latestPhysio.restingHR}bpm${rhrArrow}`;
  }

  const sleepScore = manualToday ? manualToday.sleepScore : latestPhysio?.sleepScore;
  const isManualEntry = !!manualToday;
  let recoveryPct = sleepScore ? Math.round(sleepScore) : 0;
  let recoveryLabel = sleepScore ? (sleepScore >= 75 ? 'Good' : sleepScore >= 55 ? 'Fair' : 'Poor') : '—';
  let recoveryColor = sleepScore
    ? (sleepScore >= 75 ? 'var(--c-ok)' : sleepScore >= 55 ? 'var(--c-caution)' : 'var(--c-warn)')
    : 'var(--c-faint)';
  let recoveryCaption = sleepScore
    ? (isManualEntry
        ? `Self-reported${rhrCaption} — ${sleepScore >= 75 ? 'you\'re well rested.' : sleepScore >= 55 ? 'reasonable recovery.' : 'prioritise sleep tonight.'}`
        : `Sleep score ${Math.round(sleepScore)}/100${rhrCaption} — ${sleepScore >= 75 ? 'you\'re well rested.' : sleepScore >= 55 ? 'reasonable recovery.' : 'prioritise sleep tonight.'}`)
    : 'Sleep data · connect watch to unlock';
  const recoveryFill = sleepScore
    ? `background:linear-gradient(to right,var(--c-ok) 0%,var(--c-caution) 60%,var(--c-warn) 100%);width:${100 - recoveryPct}%`
    : 'width:0%';

  const injured = isInjuryActive();

  // Show "Adjust week" button when there is unresolved excess load but ACWR is not elevated.
  // Tier 1 (Auto: mod) silently absorbed the excess — button hides until user undoes.
  // Tier 2 range: excess 15–40 TSS above baseline. Falls back to showing for any items if no baseline.
  const wkForExcess = s.wks?.[s.w - 1];
  const _hasAutoMod = (wkForExcess?.workoutMods ?? []).some(m => m.modReason?.startsWith('Auto:'));
  const _baseline = s.signalBBaseline ?? 0;
  const _excess = wkForExcess ? getWeeklyExcess(wkForExcess, _baseline, s.planStartDate) : 0;
  const _inTier2Range = _baseline > 0 ? (_excess >= 15 && _excess <= 40) : true;
  const hasPendingExcess = !injured &&
    acwr.status !== 'caution' && acwr.status !== 'high' &&
    (wkForExcess?.unspentLoadItems?.length ?? 0) > 0 &&
    !_hasAutoMod &&
    _inTier2Range;

  // Injury risk row: show recovery pill when injured, ACWR bar otherwise
  const injuryRowContent = injured
    ? `
      <div class="flex justify-between items-center mb-[9px]">
        <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">Injury</span>
        <span class="m-pill m-pill-caution" style="pointer-events:none"><span class="m-pill-dot"></span>In Recovery</span>
      </div>
      <p class="m-text-caption">Tap to view your recovery plan and update your pain level.</p>`
    : `
      <div class="flex justify-between items-center mb-[9px]">
        <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">Injury Risk</span>
        <span class="text-[12px] font-semibold" style="color:${riskLabelColor}">${riskLabel}</span>
      </div>
      <div class="m-signal-track">
        <div class="m-signal-fill" style="width:${riskPct}%;background:${riskLabelColor}"></div>
        ${acwr.ratio > 0 ? `<div class="m-signal-thumb" style="left:${riskPct}%;border-color:${thumbBorder}"></div>` : ''}
      </div>
      <p class="m-text-caption mt-[7px]">${hasPendingExcess ? 'You have unresolved cross-training load this week.' : riskCaption}</p>`;

  return `
    <div class="section px-[18px] mb-[14px]">
      <div class="m-card overflow-hidden">

        <div id="home-injury-risk-row" class="px-4 py-3" style="cursor:pointer">
          ${injuryRowContent}
        </div>

        <div id="home-recovery-row" class="px-4 py-3" style="border-top:1px solid var(--c-border);cursor:pointer">
          <div class="flex justify-between items-center mb-[9px]">
            <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">Recovery</span>
            <span class="text-[12px] font-semibold" style="color:${recoveryColor}">${hrvDot}${recoveryLabel}</span>
          </div>
          <div class="m-signal-track" style="${!sleepScore ? 'background:rgba(0,0,0,0.04)' : ''}">
            ${sleepScore ? `<div class="m-signal-fill" style="${recoveryFill}"></div>
            <div class="m-signal-thumb" style="left:${100 - recoveryPct}%"></div>` : ''}
          </div>
          <p class="m-text-caption mt-[7px]" style="${!sleepScore ? 'opacity:0.45' : ''}">${recoveryCaption}</p>
        </div>

      </div>
    </div>
  `;
}

function buildSparkline(s: SimulatorState): string {
  const histTSS = s.historicWeeklyTSS ?? [];
  const ctl = s.ctlBaseline ?? null;

  const wk = s.wks?.[s.w - 1];
  const currentTSS = wk ? computeWeekTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;

  if (histTSS.length === 0 && currentTSS === 0) {
    return `
      <div class="px-[18px] mb-[14px]">
        <div class="m-card px-4 py-3 flex items-center justify-between" id="home-sparkline" style="cursor:pointer">
          <div style="height:36px;flex:1;display:flex;align-items:center">
            <span style="font-size:11px;color:var(--c-faint)">Baseline builds in week 4</span>
          </div>
          <span style="font-size:10px;color:var(--c-faint);flex-shrink:0">Last 8 weeks →</span>
        </div>
      </div>`;
  }

  const past7 = histTSS.slice(-7);
  const allValues = [...past7, currentTSS];
  const maxVal = Math.max(...allValues, ctl ?? 0, 1);
  const chartH = 36;

  const BAR_W = 100 / (allValues.length * 1.6 + 0.4);
  const GAP   = (100 - BAR_W * allValues.length) / (allValues.length + 1);

  const baselinePct = ctl ? (ctl / maxVal * chartH) : null;

  const bars = allValues.map((val, i) => {
    const isCurrentWeek = i === allValues.length - 1;
    const barH = Math.max(2, Math.round((val / maxVal) * chartH));
    const x = GAP + i * (BAR_W + GAP);

    let color: string;
    if (isCurrentWeek) {
      color = 'var(--c-accent)';
    } else if (ctl) {
      const ratio = val / ctl;
      color = ratio > 1.2 ? 'var(--c-caution)' : ratio >= 0.7 ? 'var(--c-ok)' : 'var(--c-muted)';
    } else {
      color = 'var(--c-muted)';
    }

    return `<rect x="${x.toFixed(1)}%" y="${chartH - barH}" width="${BAR_W.toFixed(1)}%" height="${barH}" fill="${color}" rx="1.5"/>`;
  }).join('');

  const baselineLine = baselinePct
    ? `<line x1="0" y1="${chartH - baselinePct}" x2="100%" y2="${chartH - baselinePct}" stroke="var(--c-muted)" stroke-width="0.8" stroke-dasharray="3 2" opacity="0.5"/>`
    : '';

  return `
    <div class="px-[18px] mb-[14px]">
      <div class="m-card px-4 py-3 flex items-center gap-3" id="home-sparkline" style="cursor:pointer">
        <div style="flex:1;height:${chartH}px">
          <svg width="100%" height="${chartH}" style="overflow:visible;display:block">
            ${baselineLine}
            ${bars}
          </svg>
        </div>
        <span style="font-size:10px;color:var(--c-faint);flex-shrink:0;white-space:nowrap">Last 8 weeks →</span>
      </div>
    </div>`;
}

function buildTodayWorkout(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  if (!wk) {
    return buildNoWorkoutHero('No plan this week', 'Complete onboarding to generate your training plan.', false);
  }

  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
  );

  // Apply mods
  if (wk.workoutMods) {
    for (const mod of wk.workoutMods) {
      const w = workouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
      if (w) { (w as any).d = mod.newDistance; (w as any).status = mod.status; }
    }
  }

  // Apply day moves (drag-and-drop reorder from plan tab)
  if ((wk as any).workoutMoves) {
    for (const [workoutId, newDay] of Object.entries((wk as any).workoutMoves as Record<string, number>)) {
      const w = workouts.find((wo: any) => (wo.id || wo.n) === workoutId);
      if (w) (w as any).dayOfWeek = newDay;
    }
  }

  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  // Find today's workout — run or cross-training
  const active = workouts.filter((w: any) =>
    w.status !== 'skip' && w.status !== 'replaced',
  );
  let todayW = active.find((w: any) => w.dayOfWeek === ourDay);
  if (!todayW) {
    const unrated = active.filter((w: any) => !wk.rated[w.id || w.n]);
    todayW = unrated[0] || null;
  }

  if (!todayW) {
    // Check if it's a rest day
    return buildNoWorkoutHero('Rest Day', 'No structured training today. Walk, stretch, sleep.', true, s);
  }

  const isRest = (todayW as any).t === 'rest' || (todayW as any).n?.toLowerCase().includes('rest');
  if (isRest) {
    return buildNoWorkoutHero('Rest Day', 'No structured training today. Walk, stretch, sleep.', true, s);
  }

  const name = (todayW as any).n || 'Workout';
  const desc = (todayW as any).d || '';
  const distKm = (todayW as any).km || (todayW as any).distanceKm || null;
  const durationMin = (todayW as any).dur || null;
  const rpe = (todayW as any).rpe || null;
  const workoutId = (todayW as any).id || (todayW as any).n;
  const alreadyRated = wk.rated[workoutId] && wk.rated[workoutId] !== 'skip';

  const metaItems = [
    durationMin ? { val: `~${Math.round(durationMin)} min`, lbl: 'Duration' } : null,
    distKm ? { val: `${distKm.toFixed ? distKm.toFixed(1) : distKm} km`, lbl: 'Distance' } : null,
    rpe ? { val: `RPE ${rpe}`, lbl: 'Effort' } : null,
  ].filter(Boolean);

  const metaHtml = metaItems.map((item, i) => `
    <div class="flex flex-col gap-[2px] flex-1 ${i > 0 ? 'border-l pl-[14px]' : ''}" style="${i > 0 ? 'border-color:rgba(0,0,0,0.09)' : ''}">
      <span style="font-size:16px;font-weight:400;letter-spacing:-0.02em">${item!.val}</span>
      <span class="text-[10px] font-semibold uppercase tracking-[0.08em]" style="color:var(--c-faint)">${item!.lbl}</span>
    </div>
  `).join('');

  const startBtn = !alreadyRated
    ? `<button id="home-start-btn" data-workout-id="${workoutId}" class="m-btn-primary">
        <span style="width:12px;height:12px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
        Start
      </button>`
    : `<span class="m-pill m-pill-ok" style="pointer-events:none"><span class="m-pill-dot"></span>Done</span>`;

  return `
    <div class="workout-hero-bg mb-[14px]">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:0.9" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(78,159,229,0.18)" stroke-width="1"/>
        <circle cx="100" cy="100" r="55" stroke="rgba(78,159,229,0.14)" stroke-width="1"/>
        <circle cx="100" cy="100" r="82" stroke="rgba(78,159,229,0.10)" stroke-width="1"/>
        <circle cx="100" cy="100" r="112" stroke="rgba(78,159,229,0.07)" stroke-width="1"/>
        <circle cx="100" cy="100" r="145" stroke="rgba(78,159,229,0.04)" stroke-width="1"/>
        <line x1="100" y1="0" x2="100" y2="200" stroke="rgba(78,159,229,0.08)" stroke-width="0.8"/>
        <line x1="0" y1="100" x2="200" y2="100" stroke="rgba(78,159,229,0.08)" stroke-width="0.8"/>
      </svg>
      <div class="relative z-10 px-[22px] py-[20px]">
        <div class="flex justify-between items-start mb-[14px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
          ${startBtn}
        </div>
        <div style="font-size:28px;font-weight:300;letter-spacing:-0.04em;line-height:1.05;margin-bottom:5px">${name}</div>
        <div class="m-text-caption mb-[16px]">${desc}</div>
        <div class="flex gap-0 items-center pt-[14px]" style="border-top:1px solid rgba(0,0,0,0.09)">
          ${metaHtml}
          <button id="home-view-plan-btn" class="m-btn-link ml-auto pl-[14px]" style="border-left:1px solid rgba(0,0,0,0.09);white-space:nowrap">
            View
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildNoWorkoutHero(title: string, subtitle: string, isRest: boolean, s?: SimulatorState): string {
  const ourDay = jsToOurDay(new Date().getDay());
  // Find next upcoming workout
  let nextLabel = '';
  if (isRest && s) {
    const wk = s.wks?.[s.w - 1];
    if (wk) {
      const workouts = generateWeekWorkouts(wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined, null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs);
      // Apply day moves so "Next workout" reflects any plan-tab reorders
      if ((wk as any).workoutMoves) {
        for (const [workoutId, newDay] of Object.entries((wk as any).workoutMoves as Record<string, number>)) {
          const wo = workouts.find((w: any) => (w.id || w.n) === workoutId);
          if (wo) (wo as any).dayOfWeek = newDay;
        }
      }
      const upcoming = workouts.filter((w: any) => w.dayOfWeek > ourDay && w.t !== 'rest');
      if (upcoming.length > 0) {
        const next = upcoming[0] as any;
        nextLabel = `Next: ${DAY_LABELS[next.dayOfWeek]} — ${next.n}${next.km ? ` ${next.km} km` : ''}`;
      }
    }
  }

  return `
    <div class="workout-hero-bg mb-[14px]" style="background:#F7F5F0">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(0,0,0,0.06)" stroke-width="1"/>
        <circle cx="100" cy="100" r="60" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
        <circle cx="100" cy="100" r="95" stroke="rgba(0,0,0,0.04)" stroke-width="1"/>
        <circle cx="100" cy="100" r="135" stroke="rgba(0,0,0,0.03)" stroke-width="1"/>
      </svg>
      <div class="relative z-10 px-[22px] py-[20px]">
        <div class="flex justify-between items-start mb-[14px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
        </div>
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em;opacity:0.45;margin-bottom:5px">${title}</div>
        <div class="m-text-caption mb-[16px]">${subtitle}</div>
        <div class="flex justify-between items-center pt-[14px]" style="border-top:1px solid rgba(0,0,0,0.09)">
          <span class="text-[12px]" style="color:var(--c-muted)">${nextLabel}</span>
          <button id="home-view-plan-btn" class="m-btn-link">
            View plan
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildRaceCountdown(s: SimulatorState): string {
  const raceDate = s.selectedMarathon?.date || s.onboarding?.customRaceDate;
  const raceName = s.selectedMarathon?.name || 'Your Race';
  if (!raceDate || s.continuousMode) return '';

  const days = daysUntil(raceDate);
  if (days <= 0) return '';

  const weeks = Math.floor(days / 7);
  const display = days <= 14 ? `${days}` : `${weeks}`;
  const unit = days <= 14 ? 'days' : 'weeks';

  return `
    <div class="px-[18px] mb-[14px]">
      <div class="m-card px-[18px] py-[14px] flex items-center justify-between">
        <div class="flex flex-col gap-[3px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">Race Day</span>
          <span style="font-size:15px;font-weight:400;letter-spacing:-0.02em">${raceName}</span>
        </div>
        <div class="flex items-baseline gap-[5px]">
          <span style="font-size:44px;font-weight:300;letter-spacing:-0.05em;line-height:1">${display}</span>
          <span style="font-size:13px;color:var(--c-muted)">${unit}</span>
        </div>
      </div>
    </div>
  `;
}

function buildRecentActivity(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  const prevWk = s.wks?.[s.w - 2];

  // Collect recent completed activities (garminActuals + adhoc from current + prev week)
  type ActivityRow = { name: string; sub: string; value: string; icon: 'run' | 'gym' | 'swim' | 'bike'; id: string; workoutKey?: string; weekNum?: number };
  const rows: ActivityRow[] = [];

  function addFromWk(week: typeof wk, weekNum: number) {
    if (!week) return;
    const isCurrentWeek = weekNum === s.w;
    // Garmin synced actuals
    Object.entries(week.garminActuals || {}).forEach(([key, act]: [string, any]) => {
      if (rows.length >= 5) return;
      const isRun = isRunKey(key);
      const dateStr = act.date ? fmtDate(act.date) : (isCurrentWeek ? 'This week' : 'Last week');
      const val = isRun && act.distanceKm ? `${act.distanceKm.toFixed(1)} km` : act.durationMin ? `${Math.round(act.durationMin)} min` : '';
      const actName = act.workoutName || act.displayName
        || key.replace(/^[Ww]\d+[-_]?/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      rows.push({ name: actName, sub: dateStr, value: val, icon: isRun ? 'run' : 'gym', id: `garmin-${key}-${act.date || ''}`, workoutKey: key, weekNum });
    });
    // Adhoc workouts
    (week.adhocWorkouts || []).forEach((w: any) => {
      if (rows.length >= 5) return;
      const dateStr = isCurrentWeek ? 'This week' : 'Last week';
      const val = w.distanceKm ? `${w.distanceKm.toFixed(1)} km` : w.durationMin ? `${Math.round(w.durationMin)} min` : '';
      rows.push({ name: w.workoutName || w.displayName || w.name || w.n || 'Workout', sub: dateStr, value: val, icon: 'run', id: w.id || w.name });
    });
  }

  addFromWk(wk, s.w);
  addFromWk(prevWk, s.w - 1);

  if (rows.length === 0) return '';

  function iconSvg(type: ActivityRow['icon']): string {
    if (type === 'run') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4a1 1 0 100-2 1 1 0 000 2z" fill="var(--c-accent)" stroke="none"/><path d="M6.5 20l3-5.5 2.5 2 3.5-7 2.5 4.5"/></svg>`;
    if (type === 'gym') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-muted)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>`;
    if (type === 'swim') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c1.5 0 3-1 4.5-1s3 1 4.5 1 3-1 4.5-1 3 1 4.5 1M3 12c1.5 0 3-1 4.5-1s3 1 4.5 1 3-1 4.5-1 3 1 4.5 1"/></svg>`;
    return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>`;
  }

  const rowsHtml = rows.map(r => `
    <div class="m-list-item${r.workoutKey ? ' home-act-row' : ''}"
      data-activity-id="${r.id}"
      ${r.workoutKey ? `data-workout-key="${r.workoutKey}" data-week-num="${r.weekNum}"` : ''}
      style="cursor:${r.workoutKey ? 'pointer' : 'default'}">
      <div style="width:34px;height:34px;border-radius:50%;background:${r.icon === 'run' ? 'rgba(78,159,229,0.08)' : 'rgba(0,0,0,0.05)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${iconSvg(r.icon)}
      </div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:400;letter-spacing:-0.01em;margin-bottom:1px">${r.name}</div>
        <div style="font-size:11px;color:var(--c-muted)">${r.sub}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:-0.01em">${r.value}</span>
        ${r.workoutKey ? `<span style="opacity:0.25"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>` : ''}
      </div>
    </div>
  `).join('');

  return `
    <div class="px-[18px] mb-[14px]">
      <div class="m-sec-label">Recent</div>
      <div class="m-card overflow-hidden">${rowsHtml}</div>
    </div>
  `;
}

function buildSyncActions(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  const hasPending = (s as any).pendingActivities?.length > 0;
  const allRated = wk
    ? Object.values(wk.rated || {}).filter(v => typeof v === 'number' && v > 0).length >= (s.rw || 5)
    : false;

  const buttons: string[] = [];
  if (hasPending) {
    buttons.push(`<button id="home-sync-btn" class="m-btn-secondary flex-1">↻ Sync Activities</button>`);
  }
  if (allRated && !(wk as any)?.weekCompleted) {
    buttons.push(`<button id="home-complete-week-btn" class="m-btn-secondary flex-1">✓ Complete Week</button>`);
  }
  if (buttons.length === 0) return '';

  return `
    <div class="px-[18px] mb-[14px] flex gap-[10px]">
      ${buttons.join('')}
    </div>
  `;
}

// ─── Main render ────────────────────────────────────────────────────────────

function getHomeHTML(s: SimulatorState): string {
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Header -->
      <div style="padding:14px 18px 10px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:24px;font-weight:600;letter-spacing:-0.03em;color:var(--c-black);line-height:1.1">Mosaic</div>
          ${s.w && s.tw ? `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-top:2px">Week ${s.w} of ${s.tw}${s.wks?.[s.w-1]?.ph ? ` · ${s.wks[s.w-1].ph.charAt(0).toUpperCase() + s.wks[s.w-1].ph.slice(1)}` : ''}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button id="home-injured-btn" style="height:32px;padding:0 10px;border-radius:16px;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;cursor:pointer;color:var(--c-black);font-family:var(--f)">🩹 Report Injury</button>
          <button id="home-account-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:0.02em;cursor:pointer;color:var(--c-black);font-family:var(--f)">${initials || 'Me'}</button>
        </div>
      </div>

      ${buildProgressBars(s)}
      ${buildSignalBars(s)}
      ${buildSparkline(s)}
      ${buildTodayWorkout(s)}
      ${buildRaceCountdown(s)}
      ${buildSyncActions(s)}
      ${buildRecentActivity(s)}

    </div>
    ${renderTabBar('home', isSimulatorMode())}
  `;
}

function wireHomeHandlers(): void {
  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Account button
  document.getElementById('home-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Injured button
  document.getElementById('home-injured-btn')?.addEventListener('click', () => {
    import('./injury/modal').then(({ openInjuryModal }) => openInjuryModal());
  });

  // Start workout button
  document.getElementById('home-start-btn')?.addEventListener('click', (e) => {
    const workoutId = (e.currentTarget as HTMLElement).getAttribute('data-workout-id');
    import('./record-view').then(({ renderRecordView }) => renderRecordView());
  });

  // View plan button (from workout hero)
  document.getElementById('home-view-plan-btn')?.addEventListener('click', () => {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });

  // Sync button → go to plan (which has sync)
  document.getElementById('home-sync-btn')?.addEventListener('click', () => {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });

  // Complete week button → go to plan (which has complete week)
  document.getElementById('home-complete-week-btn')?.addEventListener('click', () => {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });

  // Injury risk row → injury modal (if injured), reduce/replace modal (if ACWR elevated),
  // or Stats page (if load is safe — excess-load-card in plan view handles pending adjustments).
  document.getElementById('home-injury-risk-row')?.addEventListener('click', () => {
    if (isInjuryActive()) {
      import('./injury/modal').then(({ openInjuryModal }) => openInjuryModal());
    } else {
      const s = getState();
      const tier = s.athleteTierOverride ?? s.athleteTier;
      const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate);
      if (acwr.status === 'caution' || acwr.status === 'high') {
        import('./main-view').then(({ triggerACWRReduction }) => triggerACWRReduction());
      } else {
        // ACWR is safe — navigate to Stats so user can see their load in context.
        // Any pending plan adjustments are shown in the Plan tab via excess-load-card.
        import('./stats-view').then(({ renderStatsView }) => renderStatsView());
      }
    }
  });

  // Recovery row → sleep log modal
  document.getElementById('home-recovery-row')?.addEventListener('click', () => {
    import('./plan-view').then(({ showRecoveryLogModal }) => showRecoveryLogModal());
  });

  // Sparkline → Stats tab
  document.getElementById('home-sparkline')?.addEventListener('click', () => {
    import('./stats-view').then(({ renderStatsView }) => renderStatsView());
  });

  // TSS row → Stats tab (see activity breakdown)
  document.getElementById('home-tss-row')?.addEventListener('click', () => {
    import('./stats-view').then(({ renderStatsView }) => renderStatsView());
  });

  // Recent activity click-through → activity detail page
  document.querySelectorAll<HTMLElement>('.home-act-row').forEach(el => {
    el.addEventListener('click', async () => {
      const workoutKey = el.dataset.workoutKey || '';
      const weekNum = parseInt(el.dataset.weekNum || '0', 10);
      if (!workoutKey || !weekNum) return;
      const s2 = getState();
      const actual = s2.wks?.[weekNum - 1]?.garminActuals?.[workoutKey];
      if (!actual) return;
      const { renderActivityDetail } = await import('./activity-detail');
      renderActivityDetail(actual, actual.workoutName || actual.displayName || workoutKey, 'home');
    });
  });
}

export function renderHomeView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  container.innerHTML = getHomeHTML(s);
  wireHomeHandlers();
}
