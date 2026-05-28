/**
 * coach-workout-modal.ts
 * ======================
 * Premium "Generate with Coach" surface for On-Demand mode. Calls the
 * `coach-generate-workout` edge function and renders a brain-personalised
 * session proposal alongside a short "why this session today" narrative.
 *
 * Flow:
 *   1. Entitlement check. If no active AI Coach subscription, render a
 *      teaser pane with a Subscribe CTA that routes into `coach-paywall`.
 *   2. Intent input. Free-text, duration, optional injury note.
 *   3. POST to edge function. Show loading.
 *   4. Render the proposal: workout summary + narrative + Accept / Regenerate.
 *   5. Accept pushes the workout into `wk.adhocWorkouts` (same path as the
 *      free `openSessionGenerator()`) and re-renders the main view.
 *
 * V1 scope: running sessions only. The schema for strength sessions is
 * owned by a parallel workstream; when that lands, extend the edge function
 * tool definition and surface here.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { Workout } from '@/types';
import { hasActiveCoachSubscription } from '@/coach/entitlement';
import { computeReadinessACWR, computeLiveSameSignalTSB } from '@/calculations/fitness-model';
import { computeReadiness } from '@/calculations/readiness';
import { SUPABASE_URL, supabase } from '@/data/supabaseClient';

const MODAL_ID = 'coach-workout-modal';
const EDGE_FN_URL = `${SUPABASE_URL}/functions/v1/coach-generate-workout`;

// Slot label + how to render the workout description string.
const SLOT_LABEL: Record<string, string> = {
  easy: 'Easy Run',
  long: 'Long Run',
  threshold: 'Threshold',
  vo2: 'VO2 Intervals',
  marathon_pace: 'Marathon Pace',
  progressive: 'Progressive Run',
  vibes: 'Run by Feel',
};

interface CoachProposal {
  slot: string;
  totalMinutes: number;
  workMinutes: number;
  reps?: number;
  repMinutes?: number;
  recoveryMinutes?: number;
  targetEffort: 'easy' | 'steady' | 'hard';
  narrative: string;
}

interface RecentSessionPayload {
  daysAgo: number;
  type: string;
  distanceKm: number | null;
  durationMin: number | null;
  perceivedEffort: number | null;
}

// ─── Public entry ────────────────────────────────────────────────────────────

export async function openCoachWorkoutModal(): Promise<void> {
  document.getElementById(MODAL_ID)?.remove();

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  // Loading shell while we check entitlement.
  modal.innerHTML = shellOpen() + `<div style="padding:36px 8px;text-align:center;color:var(--c-muted);font-size:13px">Checking subscription…</div>` + shellClose();

  const entitled = await hasActiveCoachSubscription();
  if (!entitled) {
    renderTeaserPane(modal);
    return;
  }

  renderIntentForm(modal);
}

// ─── Shell ───────────────────────────────────────────────────────────────────

function shellOpen(maxHeight = '85dvh'): string {
  return `<div class="w-full max-w-sm rounded-2xl" style="background:#ffffff;position:relative;overflow:hidden;border:1px solid var(--c-border);box-shadow:0 4px 16px rgba(0,0,0,0.06), 0 16px 48px rgba(0,0,0,0.08);max-height:${maxHeight};display:flex;flex-direction:column">
    <div aria-hidden="true" style="position:absolute;top:-30px;left:-30px;width:380px;height:380px;pointer-events:none;
      background:radial-gradient(ellipse 55% 55% at 22% 22%, rgba(255,248,229,0.5) 0%, rgba(255,248,229,0.18) 30%, transparent 70%)"></div>
    <div style="position:relative;padding:22px;overflow-y:auto;overscroll-behavior:contain">`;
}
function shellClose(): string { return `</div></div>`; }

function closeModal() {
  document.getElementById(MODAL_ID)?.remove();
}

// ─── Teaser (non-entitled) ───────────────────────────────────────────────────

function renderTeaserPane(modal: HTMLElement): void {
  modal.innerHTML = shellOpen('auto') + `
    <div style="display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:600;color:#0F172A;background:rgba(15,23,42,0.06);padding:4px 9px;border-radius:100px;margin-bottom:12px">AI Coach</div>
    <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:6px">Generate workouts with Coach</div>
    <div style="font-size:13px;color:var(--c-muted);line-height:1.55;margin-bottom:18px">Coach reads your recent training, recovery state, and what you want to do today. It then builds a session that fits, with a short note explaining why.</div>

    <ul style="list-style:none;padding:0;margin:0 0 20px;display:flex;flex-direction:column;gap:10px">
      <li style="display:flex;gap:10px;align-items:flex-start;font-size:13px;color:#0F172A;line-height:1.5">
        <span style="color:#0F172A;flex-shrink:0;margin-top:1px">·</span>
        <span>Tell Coach what you have time for. It builds the right session.</span>
      </li>
      <li style="display:flex;gap:10px;align-items:flex-start;font-size:13px;color:#0F172A;line-height:1.5">
        <span style="color:#0F172A;flex-shrink:0;margin-top:1px">·</span>
        <span>Reads CTL, freshness, recent RPE. Adjusts intensity if you're loaded or fresh.</span>
      </li>
      <li style="display:flex;gap:10px;align-items:flex-start;font-size:13px;color:#0F172A;line-height:1.5">
        <span style="color:#0F172A;flex-shrink:0;margin-top:1px">·</span>
        <span>Free "Generate" button stays. Use Coach when you want context-aware sessions.</span>
      </li>
    </ul>

    <button id="cw-subscribe" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">See subscription options</button>
    <button id="cw-cancel" class="m-btn-glass m-btn-glass--inset" style="width:100%">Cancel</button>
  ` + shellClose();

  document.getElementById('cw-cancel')?.addEventListener('click', closeModal);
  document.getElementById('cw-subscribe')?.addEventListener('click', async () => {
    closeModal();
    const { renderCoachPaywall } = await import('./coach-paywall');
    await renderCoachPaywall();
  });
}

// ─── Intent form ─────────────────────────────────────────────────────────────

interface IntentFormState {
  intent: string;
  preferredDurationMin: number;
  injuryNote: string;
  showInjury: boolean;
}

const DURATION_OPTIONS = [20, 30, 45, 60, 75, 90];

function renderIntentForm(modal: HTMLElement, prefill?: Partial<IntentFormState>): void {
  const formState: IntentFormState = {
    intent: prefill?.intent ?? '',
    preferredDurationMin: prefill?.preferredDurationMin ?? 45,
    injuryNote: prefill?.injuryNote ?? '',
    showInjury: prefill?.showInjury ?? !!prefill?.injuryNote,
  };

  function paint() {
    modal.innerHTML = shellOpen() + `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:600;color:#0F172A;background:rgba(15,23,42,0.06);padding:4px 9px;border-radius:100px">AI Coach</div>
        <button id="cw-close" aria-label="Close" style="width:28px;height:28px;border-radius:50%;border:none;cursor:pointer;background:rgba(15,23,42,0.06);color:#0F172A;display:flex;align-items:center;justify-content:center;font-size:16px;font-family:var(--f)">×</button>
      </div>

      <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Generate with Coach</div>
      <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">Tell Coach what you want to do. It reads your recent training and builds the right session.</div>

      <label style="display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:6px">What's the intent?</label>
      <textarea id="cw-intent" rows="2" maxlength="160" placeholder="e.g. 50 min on hills · feeling tired · easy with strides" style="width:100%;padding:11px 12px;border:1px solid var(--c-border);border-radius:10px;background:#fff;color:var(--c-black);font-size:14px;font-family:var(--f);line-height:1.4;resize:none;outline:none;margin-bottom:16px">${escapeHtml(formState.intent)}</textarea>

      <label style="display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:8px">Time budget</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px">
        ${DURATION_OPTIONS.map(d => {
          const sel = d === formState.preferredDurationMin;
          return `<button class="cw-dur" data-d="${d}" style="padding:8px 12px;border-radius:8px;border:1px solid ${sel ? 'rgba(15,23,42,0.9)' : 'var(--c-border)'};background:${sel ? '#0A0A0A' : '#fff'};color:${sel ? '#FDFCF7' : 'var(--c-black)'};font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f)">${d}m</button>`;
        }).join('')}
      </div>

      ${formState.showInjury ? `
        <label style="display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:6px">Injury or soreness note</label>
        <input id="cw-injury" type="text" maxlength="60" placeholder="e.g. calf tight, knee sore" value="${escapeHtml(formState.injuryNote)}" style="width:100%;padding:10px 12px;border:1px solid var(--c-border);border-radius:10px;background:#fff;color:var(--c-black);font-size:13px;font-family:var(--f);outline:none;margin-bottom:18px">
      ` : `
        <button id="cw-add-injury" style="font-size:12px;color:#64748B;background:none;border:none;cursor:pointer;padding:0 0 18px;text-decoration:underline;font-family:var(--f)">+ Add injury or soreness note</button>
      `}

      <button id="cw-generate" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Generate workout</button>
      <button id="cw-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">Cancel</button>
    ` + shellClose();

    document.getElementById('cw-close')?.addEventListener('click', closeModal);
    document.getElementById('cw-back')?.addEventListener('click', closeModal);

    document.getElementById('cw-intent')?.addEventListener('input', e => {
      formState.intent = (e.target as HTMLTextAreaElement).value;
    });

    modal.querySelectorAll<HTMLElement>('.cw-dur').forEach(btn => {
      btn.addEventListener('click', () => {
        formState.preferredDurationMin = Number(btn.dataset.d);
        paint();
      });
    });

    document.getElementById('cw-add-injury')?.addEventListener('click', () => {
      formState.showInjury = true;
      paint();
    });
    document.getElementById('cw-injury')?.addEventListener('input', e => {
      formState.injuryNote = (e.target as HTMLInputElement).value;
    });

    document.getElementById('cw-generate')?.addEventListener('click', () => {
      void submitGenerate(modal, formState);
    });
  }

  paint();
}

// ─── Submit + loading ────────────────────────────────────────────────────────

async function submitGenerate(modal: HTMLElement, formState: IntentFormState): Promise<void> {
  modal.innerHTML = shellOpen('auto') + `
    <div style="padding:48px 8px;text-align:center">
      <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px">Coach is reading your training context…</div>
      <div style="display:inline-block;width:24px;height:24px;border:2px solid rgba(15,23,42,0.12);border-top-color:#0F172A;border-radius:50%;animation:cw-spin 0.8s linear infinite"></div>
    </div>
    <style>@keyframes cw-spin { to { transform: rotate(360deg); } }</style>
  ` + shellClose();

  const payload = buildContextPayload(formState);

  let session: Awaited<ReturnType<typeof supabase.auth.getSession>>;
  try {
    session = await supabase.auth.getSession();
  } catch {
    renderError(modal, formState, 'Not signed in. Please reconnect your account.');
    return;
  }
  const accessToken = session.data.session?.access_token;
  if (!accessToken) {
    renderError(modal, formState, 'Not signed in. Please reconnect your account.');
    return;
  }

  let resp: Response;
  try {
    resp = await fetch(EDGE_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    renderError(modal, formState, 'Network error. Try again in a moment.');
    return;
  }

  if (resp.status === 402) {
    // Subscription must have lapsed between entitlement check and submit.
    renderTeaserPane(modal);
    return;
  }
  if (resp.status === 429) {
    const body = await resp.json().catch(() => ({}));
    renderError(modal, formState, body.message ?? 'Daily limit reached. Try again tomorrow.');
    return;
  }
  if (!resp.ok) {
    renderError(modal, formState, 'Coach is unavailable right now. Try the free Generate button instead.');
    return;
  }

  const body = await resp.json();
  const proposal: CoachProposal | undefined = body.proposal;
  if (!proposal || !proposal.slot) {
    renderError(modal, formState, 'Coach returned an empty proposal. Try again.');
    return;
  }
  renderProposal(modal, proposal, formState);
}

// ─── Proposal display ────────────────────────────────────────────────────────

function renderProposal(modal: HTMLElement, proposal: CoachProposal, formState: IntentFormState): void {
  const summary = describeProposal(proposal);
  modal.innerHTML = shellOpen() + `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:#0F172A;background:rgba(15,23,42,0.06);padding:4px 9px;border-radius:100px">Coach proposal</div>
      <button id="cw-close" aria-label="Close" style="width:28px;height:28px;border-radius:50%;border:none;cursor:pointer;background:rgba(15,23,42,0.06);color:#0F172A;display:flex;align-items:center;justify-content:center;font-size:16px;font-family:var(--f)">×</button>
    </div>

    <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${escapeHtml(SLOT_LABEL[proposal.slot] ?? proposal.slot)}</div>
    <div style="font-size:14px;color:#475569;margin-bottom:16px;line-height:1.5">${escapeHtml(summary)}</div>

    <div style="padding:14px 14px;background:rgba(15,23,42,0.04);border-radius:12px;margin-bottom:18px">
      <div style="font-size:12px;font-weight:600;color:#64748B;margin-bottom:6px">Why this session today</div>
      <div style="font-size:13px;color:#0F172A;line-height:1.55">${escapeHtml(proposal.narrative)}</div>
    </div>

    <button id="cw-accept" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Accept and add to today</button>
    <button id="cw-regenerate" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Tweak intent and regenerate</button>
    <button id="cw-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">Cancel</button>
  ` + shellClose();

  document.getElementById('cw-close')?.addEventListener('click', closeModal);
  document.getElementById('cw-back')?.addEventListener('click', closeModal);
  document.getElementById('cw-regenerate')?.addEventListener('click', () => {
    renderIntentForm(modal, formState);
  });
  document.getElementById('cw-accept')?.addEventListener('click', () => {
    acceptProposal(proposal);
  });
}

function renderError(modal: HTMLElement, formState: IntentFormState, message: string): void {
  modal.innerHTML = shellOpen('auto') + `
    <div style="font-size:14px;color:var(--c-black);line-height:1.5;margin-bottom:18px">${escapeHtml(message)}</div>
    <button id="cw-retry" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Try again</button>
    <button id="cw-cancel" class="m-btn-glass m-btn-glass--inset" style="width:100%">Cancel</button>
  ` + shellClose();
  document.getElementById('cw-retry')?.addEventListener('click', () => renderIntentForm(modal, formState));
  document.getElementById('cw-cancel')?.addEventListener('click', closeModal);
}

// ─── Accept (write to adhocWorkouts) ─────────────────────────────────────────

function acceptProposal(proposal: CoachProposal): void {
  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  const workout: Workout = {
    id: `adhoc-${Date.now()}`,
    t: proposal.slot,
    n: `${SLOT_LABEL[proposal.slot] ?? proposal.slot} (Coach)`,
    d: describeProposal(proposal),
    r: rpeForEffort(proposal.targetEffort),
    rpe: rpeForEffort(proposal.targetEffort),
    dayOfWeek: ourDay,
    estimatedDurationMin: proposal.totalMinutes,
  };

  const ms = getMutableState();
  const wk = ms.wks?.[ms.w - 1];
  if (!wk) {
    closeModal();
    return;
  }
  if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
  wk.adhocWorkouts.push(workout);
  saveState();

  closeModal();
  import('./main-view').then(({ renderMainView }) => renderMainView());
}

function rpeForEffort(eff: CoachProposal['targetEffort']): number {
  return eff === 'hard' ? 7 : eff === 'steady' ? 5 : 3;
}

function describeProposal(p: CoachProposal): string {
  if (p.slot === 'threshold' || p.slot === 'vo2') {
    if (p.reps && p.repMinutes && p.recoveryMinutes) {
      return `${p.totalMinutes} min total: ${p.reps} × ${p.repMinutes} min ${p.slot === 'vo2' ? 'VO2' : 'threshold'} effort, ${p.recoveryMinutes} min recovery between.`;
    }
  }
  if (p.slot === 'progressive') return `${p.totalMinutes} min, easy to marathon-pace build.`;
  if (p.slot === 'marathon_pace') return `${p.totalMinutes} min total. ${p.workMinutes} min at marathon pace.`;
  if (p.slot === 'vibes') return `${p.totalMinutes} min by feel. No targets.`;
  if (p.slot === 'long') return `${p.totalMinutes} min easy.`;
  return `${p.totalMinutes} min easy aerobic.`;
}

// ─── Context payload builder ─────────────────────────────────────────────────

function buildContextPayload(formState: IntentFormState): Record<string, unknown> {
  const s = getState();
  const wks = s.wks ?? [];
  const wk = wks[s.w - 1];

  // Readiness composite score (mirrors the home daily-target card).
  const hrvAll = (s.physiologyHistory ?? []).map(p => p.hrvRmssd).filter((v): v is number => v != null);
  const hrvAvg = hrvAll.length >= 3 ? Math.round(hrvAll.reduce((a, b) => a + b, 0) / hrvAll.length) : null;
  const lastPhys = (s.physiologyHistory ?? []).slice(-1)[0] ?? null;
  const lastHrv = (s.physiologyHistory ?? []).slice().reverse().find(p => p.hrvRmssd != null)?.hrvRmssd ?? null;

  const tsbResult = computeLiveSameSignalTSB(
    wks,
    s.w,
    s.signalBBaseline ?? undefined,
    s.ctlBaseline ?? undefined,
    s.planStartDate,
    s.previousPlanWks as Parameters<typeof computeLiveSameSignalTSB>[5],
  );
  const acwrResult = computeReadinessACWR(s);

  const readinessResult = computeReadiness({
    tsb: tsbResult.tsb,
    acwr: acwrResult.ratio,
    ctlNow: s.ctlBaseline ?? 0,
    sleepScore: lastPhys?.sleepScore ?? null,
    sleepHistory: s.physiologyHistory ?? [],
    hrvRmssd: lastHrv,
    hrvPersonalAvg: hrvAvg,
    sleepBankSec: null,
    weeksOfHistory: Math.min(wks.length, 4),
  });
  const readinessScore = readinessResult?.score ?? null;

  // Walk current + prior week for recent sessions.
  const recent: RecentSessionPayload[] = [];
  const today = new Date();
  const lookWeeks = [wk, wks[s.w - 2]].filter((w): w is NonNullable<typeof wk> => !!w);
  for (const week of lookWeeks) {
    const rated = (week as { rated?: Record<string, number | 'skip'> }).rated ?? {};
    for (const [key, actual] of Object.entries(week.garminActuals ?? {})) {
      if (!actual.startTime) continue;
      const d = new Date(actual.startTime);
      const daysAgo = Math.max(0, Math.round((today.getTime() - d.getTime()) / 86_400_000));
      if (daysAgo > 14) continue;
      const rpeVal = typeof rated[key] === 'number' ? rated[key] as number : null;
      recent.push({
        daysAgo,
        type: actual.activityType ?? 'run',
        distanceKm: typeof actual.distanceKm === 'number' ? Number(actual.distanceKm.toFixed(1)) : null,
        durationMin: typeof actual.durationSec === 'number' ? Math.round(actual.durationSec / 60) : null,
        perceivedEffort: rpeVal,
      });
    }
  }
  recent.sort((a, b) => a.daysAgo - b.daysAgo);
  const recentTrimmed = recent.slice(0, 10);

  // Week TSS context. Use this week's typical/actual from historicWeeklyKm if available.
  const weekTssActual = wk
    ? Math.round(Object.values(wk.garminActuals ?? {}).reduce((sum, a) => sum + (a.iTrimp ? a.iTrimp / 150 : (a.durationSec ?? 0) / 60 * 0.92), 0))
    : null;
  const ctlWeekly = s.ctlBaseline ?? null;
  const weekTssTypical = ctlWeekly ?? null;

  return {
    intent: formState.intent.trim() || null,
    preferredDurationMin: formState.preferredDurationMin,
    injuryNote: formState.injuryNote.trim() || null,
    vdot: s.v ?? null,
    phase: (s as unknown as { phase?: string }).phase ?? null,
    ctlWeekly,
    tsbDaily: tsbResult.tsb,
    acwr: acwrResult.ratio,
    readinessScore,
    weekTssActual,
    weekTssTypical,
    recentSessions: recentTrimmed,
  };
}

// ─── HTML escape ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
