/**
 * coach-modal.ts
 * ==============
 * Full-screen Coach overlay. Shows:
 *   - Readiness ring (score + label)
 *   - Signal rows (sleep, HRV, load, freshness)
 *   - LLM narrative card (fetched from coach-narrative edge function)
 *
 * Rate limit: 3 LLM calls per day, cached in localStorage for 4 hours.
 * If limit reached, shows last cached narrative.
 */

import { getState } from '@/state';
import { computeDailyCoach, type CoachState } from '@/calculations/daily-coach';
import { readinessColor } from '@/calculations/readiness';
import { callEdgeFunction } from '@/data/supabaseClient';

// ─── Rate limit helpers ───────────────────────────────────────────────────────

const CACHE_KEY = 'mosaic_coach_narrative_cache';
const MAX_CALLS_PER_DAY = 3;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface NarrativeCache {
  date: string;
  calls: number;
  narrative: string;
  expiresAt: number;
}

function loadCache(): NarrativeCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as NarrativeCache;
  } catch {
    return null;
  }
}

function saveCache(cache: NarrativeCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

/** Returns cached narrative if still valid (within TTL). */
function getCachedNarrative(): string | null {
  const cache = loadCache();
  if (!cache || cache.date !== todayStr()) return null;
  if (Date.now() > cache.expiresAt) return null;
  return cache.narrative;
}

/** Returns remaining calls allowed today. */
function remainingCalls(): number {
  const cache = loadCache();
  if (!cache || cache.date !== todayStr()) return MAX_CALLS_PER_DAY;
  return Math.max(0, MAX_CALLS_PER_DAY - cache.calls);
}

async function fetchNarrative(coach: CoachState): Promise<string> {
  const cache = loadCache();
  const today = todayStr();

  // Unexpired cache — return without a new call
  const cached = getCachedNarrative();
  if (cached) return cached;

  // Daily limit reached — return last narrative or fallback
  const calls = cache?.date === today ? cache.calls : 0;
  if (calls >= MAX_CALLS_PER_DAY) {
    return cache?.narrative ?? buildFallbackNarrative(coach);
  }

  try {
    const result = await callEdgeFunction<{ narrative: string }>('coach-narrative', coach.signals as unknown as Record<string, unknown>);
    const narrative = result.narrative?.trim() || buildFallbackNarrative(coach);

    saveCache({
      date: today,
      calls: calls + 1,
      narrative,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return narrative;
  } catch {
    return buildFallbackNarrative(coach);
  }
}

/** Rules-based fallback if LLM call fails or returns empty. */
function buildFallbackNarrative(coach: CoachState): string {
  return coach.primaryMessage;
}

// ─── SVG arc helpers ──────────────────────────────────────────────────────────

function polarToCart(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const s = polarToCart(cx, cy, r, startDeg);
  const e = polarToCart(cx, cy, r, endDeg);
  const large = (endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

// ─── Build ring SVG ───────────────────────────────────────────────────────────

function buildRing(score: number, color: string): string {
  const CX = 80, CY = 80, R = 60, SW = 10;
  const START = 135;
  const SWEEP = 270;
  const fillEnd = START + (score / 100) * SWEEP;
  const trackPath = arcPath(CX, CY, R, START, START + SWEEP);
  const fillPathStr = score > 0 ? arcPath(CX, CY, R, START, Math.min(fillEnd, START + SWEEP - 0.01)) : '';

  return `
    <svg width="160" height="160" viewBox="0 0 160 160" style="display:block">
      <path d="${trackPath}" fill="none" stroke="var(--c-border)" stroke-width="${SW}" stroke-linecap="round"/>
      ${fillPathStr ? `<path d="${fillPathStr}" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="round"/>` : ''}
    </svg>
  `;
}

// ─── Signal row helpers ───────────────────────────────────────────────────────

function sigRow(label: string, value: string, sub: string, color = 'var(--c-text)'): string {
  return `
    <div style="display:flex;align-items:center;padding:10px 0;border-bottom:1px solid var(--c-border)">
      <div style="flex:1;font-size:13px;color:var(--c-muted)">${label}</div>
      <div style="text-align:right">
        <div style="font-size:13px;font-weight:600;color:${color}">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--c-faint);margin-top:1px">${sub}</div>` : ''}
      </div>
    </div>
  `;
}

// ─── Build modal HTML ─────────────────────────────────────────────────────────

function buildCoachModalHtml(coach: CoachState): string {
  const { signals, readiness, blockers } = coach;
  const color = readinessColor(readiness.label);

  // Ring
  const ring = buildRing(readiness.score, color);

  // Stance label
  const stanceMap: Record<string, string> = {
    push: 'Primed',
    normal: 'On Track',
    reduce: 'Manage Load',
    rest: 'Rest',
  };
  const stanceLabel = stanceMap[coach.stance] ?? 'On Track';

  // Signal rows
  const tsbColor = signals.tsb > 0
    ? 'var(--c-ok)'
    : signals.tsb >= -3 ? 'var(--c-text)'
    : signals.tsb >= -8 ? 'var(--c-caution)'
    : 'var(--c-danger)';
  const tsbVal = (signals.tsb > 0 ? '+' : '') + signals.tsb;

  const acwrColor = signals.acwrStatus === 'high'
    ? 'var(--c-danger)'
    : signals.acwrStatus === 'caution' ? 'var(--c-caution)'
    : 'var(--c-ok)';
  const acwrLabel = signals.acwrStatus === 'high' ? 'High risk'
    : signals.acwrStatus === 'caution' ? 'Elevated' : 'Safe';

  const sleepColor = signals.sleepLastNight == null ? 'var(--c-faint)'
    : signals.sleepLastNight >= 80 ? 'var(--c-ok)'
    : signals.sleepLastNight >= 65 ? 'var(--c-ok-muted)'
    : signals.sleepLastNight >= 50 ? 'var(--c-caution)'
    : 'var(--c-warn)';
  const sleepVal = signals.sleepLastNight != null ? String(signals.sleepLastNight) : '—';
  const sleepSub = signals.sleepAvg7d != null ? `7-day avg: ${signals.sleepAvg7d}` : '';

  let hrvVal = '—';
  let hrvColor = 'var(--c-faint)';
  let hrvSub = '';
  if (signals.hrv != null) {
    hrvVal = `${signals.hrv} ms`;
    if (signals.hrvBaseline != null) {
      const pct = Math.round(((signals.hrv - signals.hrvBaseline) / signals.hrvBaseline) * 100);
      hrvColor = pct >= 5 ? 'var(--c-ok)' : pct <= -10 ? 'var(--c-danger)' : 'var(--c-caution)';
      const arrow = pct >= 5 ? '▲' : pct <= -5 ? '▼' : '→';
      hrvSub = `${arrow} ${Math.abs(pct)}% vs baseline`;
    }
  }

  const loadVal = signals.weekTSS != null && signals.plannedTSS != null
    ? `${signals.weekTSS} TSS`
    : signals.weekTSS != null ? `${signals.weekTSS} TSS` : '—';
  const loadSub = signals.weekTSS != null && signals.plannedTSS != null
    ? `${Math.round((signals.weekTSS / signals.plannedTSS) * 100)}% of plan (${signals.plannedTSS})`
    : '';
  const loadColor = signals.weekTSS != null && signals.plannedTSS != null
    ? (signals.weekTSS > signals.plannedTSS * 1.1 ? 'var(--c-caution)'
      : signals.weekTSS < signals.plannedTSS * 0.6 ? 'var(--c-caution)'
      : 'var(--c-text)')
    : 'var(--c-faint)';

  // Blocker banner
  const blockerHtml = blockers.length > 0 ? `
    <div style="padding:9px 12px;border-radius:10px;border:1px solid var(--c-danger);margin-bottom:14px">
      <div style="font-size:12px;font-weight:600;color:var(--c-danger)">
        ${blockers.includes('injury') ? 'Injury active' :
          blockers.includes('illness') ? 'Illness active' :
          blockers.includes('overload') ? 'Load safety risk' : 'Sleep deficit'}
      </div>
    </div>
  ` : '';

  const callsLeft = remainingCalls();
  const usageHint = callsLeft === 0
    ? `<div style="font-size:10px;color:var(--c-faint);margin-top:6px;text-align:right">Showing cached — daily limit reached</div>`
    : '';

  return `
    <div id="coach-modal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      style="background:rgba(0,0,0,0.45)">
      <div class="w-full max-w-sm rounded-2xl"
        style="background:var(--c-surface);max-height:90vh;display:flex;flex-direction:column;overflow:hidden">

        <!-- Header -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px">
          <div style="font-size:16px;font-weight:600;color:var(--c-black)">Coach</div>
          <button id="coach-modal-close"
            style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;
                   border:none;background:transparent;cursor:pointer;color:var(--c-muted);font-size:18px;padding:0">
            ×
          </button>
        </div>

        <!-- Scrollable body -->
        <div style="overflow-y:auto;padding:0 18px 18px">

          ${blockerHtml}

          <!-- Ring -->
          <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:16px;position:relative">
            ${ring}
            <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none">
              <div style="font-size:28px;font-weight:300;color:var(--c-black);line-height:1">${readiness.score}</div>
              <div style="font-size:11px;color:var(--c-muted);margin-top:2px">${stanceLabel}</div>
            </div>
          </div>

          <!-- Signal rows -->
          <div style="margin-bottom:14px">
            ${sigRow('Freshness', tsbVal, signals.tsbZone, tsbColor)}
            ${sigRow('Load safety', `${signals.acwr}`, acwrLabel, acwrColor)}
            ${sigRow('Sleep last night', sleepVal, sleepSub, sleepColor)}
            ${signals.hrv != null ? sigRow('HRV', hrvVal, hrvSub, hrvColor) : ''}
            ${sigRow('Week load', loadVal, loadSub, loadColor)}
          </div>

          <!-- LLM narrative card -->
          <div id="coach-narrative-card"
            style="border-radius:12px;border:1px solid var(--c-border);padding:12px 14px">
            <div id="coach-narrative-loading"
              style="font-size:13px;color:var(--c-faint);line-height:1.5">
              Loading coaching note...
            </div>
            <div id="coach-narrative-text" style="display:none">
              <div id="coach-narrative-headline"
                style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:4px"></div>
              <div id="coach-narrative-body"
                style="font-size:13px;color:var(--c-muted);line-height:1.5"></div>
            </div>
          </div>
          ${usageHint}

        </div>
      </div>
    </div>
  `;
}

// ─── Render narrative into modal ──────────────────────────────────────────────

function renderNarrative(narrative: string): void {
  const loading = document.getElementById('coach-narrative-loading');
  const textEl = document.getElementById('coach-narrative-text');
  const headlineEl = document.getElementById('coach-narrative-headline');
  const bodyEl = document.getElementById('coach-narrative-body');

  if (!loading || !textEl || !headlineEl || !bodyEl) return;

  // Split first sentence as headline, rest as body
  const firstPeriod = narrative.indexOf('. ');
  let headline = narrative;
  let body = '';
  if (firstPeriod > 0 && firstPeriod < narrative.length - 2) {
    headline = narrative.slice(0, firstPeriod + 1);
    body = narrative.slice(firstPeriod + 2);
  }

  // Render **bold** markdown
  const bold = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  headlineEl.innerHTML = bold(headline);
  bodyEl.innerHTML = body ? bold(body) : '';
  if (!body) bodyEl.style.display = 'none';

  loading.style.display = 'none';
  textEl.style.display = 'block';
}

function renderNarrativeError(): void {
  const loading = document.getElementById('coach-narrative-loading');
  if (loading) loading.textContent = 'Could not load coaching note.';
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function openCoachModal(): void {
  const existing = document.getElementById('coach-modal');
  if (existing) existing.remove();

  const s = getState();
  const coach = computeDailyCoach(s);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = buildCoachModalHtml(coach);
  const modal = wrapper.firstElementChild as HTMLElement;
  document.body.appendChild(modal);

  // Dismiss on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  // Close button
  document.getElementById('coach-modal-close')?.addEventListener('click', () => modal.remove());

  // Fetch LLM narrative async
  fetchNarrative(coach)
    .then(renderNarrative)
    .catch(() => renderNarrativeError());
}
