/**
 * Coach view — AI-powered coaching surface (BYOK) + rules-based fallback.
 *
 * AI mode (key set): streams a coaching brief, shows Apply cards for plan
 * changes, supports chat follow-ups. Session persists across navigation within
 * the same plan week.
 *
 * Classic mode (no key): rules-based brief + prominent inline setup card so
 * users can connect without navigating to Settings.
 *
 * Security: all user-controlled strings sanitized before prompt inclusion.
 * Tool calls validated against actual plan state before Apply card is shown.
 */

import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { computeDailyCoach, type CoachState, type CoachSignals, type CoachBlocker } from '@/calculations/daily-coach';
import { fmtSleepDebt } from '@/calculations/sleep-insights';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { renderFeelingPromptHTML, wireFeelingPromptHandlers } from './feeling-prompt';
import { buildScrollAtmosphereBackground, buildSunGlint } from './page-flair';

// ─── Design tokens ────────────────────────────────────────────────────────────

const CREAM  = '#FAF9F6';
const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const TEXT_L = '#94A3B8';
const BORDER = '#F1F5F9';
const WARN   = '#DC2626';
const CAUTION = '#B45309';
const GREEN_D = '#16A34A';

const CARD_SHADOW = '0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)';

// ─── Session persistence ──────────────────────────────────────────────────────

const SESSION_KEY = 'mosaic_coach_session_v1';
const SESSION_WEEK_LIMIT = 7 * 24 * 60 * 60 * 1000; // 7 days

type ChatMsg = { role: 'user' | 'assistant'; content: string };

interface CoachSession {
  messages: ChatMsg[];
  weekIdx: number;
  savedAt: string;
}

function saveSession(weekIdx: number): void {
  try {
    const session: CoachSession = { messages: chatMessages, weekIdx, savedAt: new Date().toISOString() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* ignore quota errors */ }
}

function loadSession(weekIdx: number): boolean {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const session: CoachSession = JSON.parse(raw);
    if (session.weekIdx !== weekIdx) return false;
    const age = Date.now() - new Date(session.savedAt).getTime();
    if (age > SESSION_WEEK_LIMIT) return false;
    if (!Array.isArray(session.messages) || session.messages.length < 2) return false;
    chatMessages = session.messages;
    return true;
  } catch { return false; }
}

function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

// ─── In-memory state ──────────────────────────────────────────────────────────

let chatMessages: ChatMsg[] = [];
let pendingChanges: import('@/coach/coach-tools').PendingChange[] = [];
let isStreaming = false;
let coachOnBack: (() => void) | null = null;

function resetSession(): void {
  chatMessages = [];
  pendingChanges = [];
  isStreaming = false;
  clearSession();
}

// ─── Text formatting ──────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convert plain-text LLM response to paragraphs for display. */
function formatAsHTML(text: string): string {
  return text
    .split(/\n\n+/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(p => p.length > 0)
    .map(p => `<p style="margin:0 0 12px;last-child{margin-bottom:0}">${escHtml(p)}</p>`)
    .join('');
}

// ─── UI components ────────────────────────────────────────────────────────────

function card(inner: string, style = ''): string {
  return `<div style="margin:0 16px 12px;padding:16px 18px;background:white;border-radius:16px;box-shadow:${CARD_SHADOW};${style}">${inner}</div>`;
}

function cardTitle(label: string): string {
  return `<div style="font-size:11px;color:${TEXT_L};margin-bottom:10px;letter-spacing:0.02em;text-transform:uppercase;font-weight:600">${label}</div>`;
}

function applyCardHTML(change: import('@/coach/coach-tools').PendingChange): string {
  return `
    <div id="apply-card-${change.id}" style="
      margin:0 16px 10px;padding:14px 16px;background:white;border-radius:14px;
      box-shadow:${CARD_SHADOW};border-left:3px solid ${TEXT_M};
    ">
      <div style="font-size:14px;font-weight:600;color:${TEXT_M};margin-bottom:4px">${change.headline}</div>
      <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-bottom:12px">${change.reason}</div>
      <div style="display:flex;gap:8px">
        <button data-apply-id="${change.id}"
          style="flex:1;padding:8px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;background:${TEXT_M};color:#fff;border:none">
          Apply
        </button>
        <button data-skip-id="${change.id}"
          style="flex:1;padding:8px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;background:transparent;color:${TEXT_M};border:1px solid ${BORDER}">
          Skip
        </button>
      </div>
    </div>
  `;
}

function userBubble(text: string): string {
  return `<div style="display:flex;justify-content:flex-end;margin:0 16px 10px">
    <div style="max-width:80%;padding:10px 14px;background:${TEXT_M};color:#fff;border-radius:16px 16px 4px 16px;font-size:14px;line-height:1.5">${escHtml(text)}</div>
  </div>`;
}

function coachBubble(contentHTML: string, id?: string): string {
  return `<div style="display:flex;justify-content:flex-start;margin:0 16px 10px" ${id ? `id="${id}"` : ''}>
    <div style="max-width:88%;padding:12px 14px;background:white;border:1px solid ${BORDER};border-radius:16px 16px 16px 4px;font-size:14px;line-height:1.6;color:${TEXT_M};box-shadow:${CARD_SHADOW}">${contentHTML}</div>
  </div>`;
}

// ─── Classic mode components ──────────────────────────────────────────────────

function classicHero(coach: CoachState): string {
  const sig = coach.signals;
  const stanceColor = coach.stance === 'push' ? GREEN_D
    : coach.stance === 'reduce' ? CAUTION
    : coach.stance === 'rest' ? WARN : TEXT_M;
  const stanceLabel = { push: 'Ready to Push', normal: 'On Track', reduce: 'Manage Load', rest: 'Ease Back' }[coach.stance];

  return `
    <div style="padding:20px 20px 8px;text-align:center">
      <span style="display:inline-flex;padding:5px 12px;border-radius:100px;border:1px solid rgba(15,23,42,0.1);background:rgba(255,255,255,0.75);backdrop-filter:blur(8px);font-size:11px;font-weight:600;letter-spacing:0.04em;color:${stanceColor};text-transform:uppercase">${stanceLabel}</span>
    </div>
    <div style="padding:4px 24px 20px;text-align:center">
      <div style="font-size:22px;font-weight:700;color:${TEXT_M};line-height:1.3;margin-bottom:8px">${coach.primaryMessage}</div>
      ${sig.readinessScore != null ? `<div style="font-size:13px;color:${TEXT_S}">Readiness ${sig.readinessScore}/100</div>` : ''}
    </div>
  `;
}

function classicWhySection(coach: CoachState): string {
  const bullets: string[] = [];
  const sig = coach.signals;
  const b = new Set<CoachBlocker>(coach.blockers);

  if (b.has('injury')) bullets.push(`Injury active${sig.injuryLocation ? ` (${sig.injuryLocation})` : ''}.`);
  if (b.has('illness')) bullets.push(`Illness ${sig.illnessSeverity ?? 'active'}.`);
  if (b.has('overload')) bullets.push(`ACWR ${sig.acwr.toFixed(2)}: acute load spike.`);
  if (b.has('sleep')) {
    const debtStr = sig.sleepDebtSec != null ? fmtSleepDebt(sig.sleepDebtSec) : null;
    bullets.push(debtStr ? `Sleep debt ${debtStr}.` : 'Sleep deficit flagged.');
  }

  if (bullets.length === 0) {
    if (sig.hrv != null && sig.hrvBaseline != null) {
      const pct = Math.round(((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline) * 100);
      if (pct < -15) bullets.push(`HRV ${pct}% below baseline.`);
      else if (pct > 10) bullets.push(`HRV ${pct}% above baseline.`);
    }
    if (!bullets.length && sig.acwrStatus !== 'safe') {
      bullets.push(`Load ratio ${sig.acwr.toFixed(2)}: ${sig.acwrStatus}.`);
    }
    if (!bullets.length) bullets.push('No red flags. Proceed as planned.');
  }

  return card(`
    ${cardTitle('Why this call')}
    ${bullets.map(bul => `<div style="font-size:13px;color:${TEXT_S};line-height:1.5;margin-bottom:4px">· ${bul}</div>`).join('')}
  `);
}

function classicRecoverySection(sig: CoachSignals): string {
  const rows: string[] = [];

  if (sig.sleepLastNight != null) {
    rows.push(`
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid ${BORDER}">
        <span style="font-size:13px;color:${TEXT_S}">Sleep last night</span>
        <div style="text-align:right">
          <div style="font-size:14px;font-weight:600;color:${TEXT_M}">${sig.sleepLastNight}</div>
          ${sig.sleepAvg7d != null ? `<div style="font-size:11px;color:${TEXT_L}">7-day avg ${sig.sleepAvg7d}</div>` : ''}
        </div>
      </div>`);
  }

  if (sig.hrv != null) {
    const pct = (sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0)
      ? Math.round(((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline) * 100) : null;
    const col = pct != null && pct < -15 ? WARN : pct != null && pct < -8 ? CAUTION : TEXT_M;
    rows.push(`
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid ${BORDER}">
        <span style="font-size:13px;color:${TEXT_S}">HRV</span>
        <div style="text-align:right">
          <div style="font-size:14px;font-weight:600;color:${col}">${sig.hrv} ms</div>
          ${pct != null ? `<div style="font-size:11px;color:${TEXT_L}">${pct > 0 ? '+' : ''}${pct} ms vs baseline</div>` : ''}
        </div>
      </div>`);
  }

  if (sig.sleepDebtSec != null && sig.sleepDebtSec < 0) {
    rows.push(`
      <div style="display:flex;justify-content:space-between;padding:10px 0">
        <span style="font-size:13px;color:${TEXT_S}">Sleep debt</span>
        <div style="font-size:14px;font-weight:600;color:${WARN}">${fmtSleepDebt(sig.sleepDebtSec)}</div>
      </div>`);
  }

  if (!rows.length) return '';
  return card(`${cardTitle('Recovery')}${rows.join('')}`);
}

/** Prominent glass setup card shown in classic mode to connect an API key inline. */
function aiSetupCard(): string {
  return `
    <div style="margin:0 16px 16px;padding:20px;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);border-radius:18px;border:1px solid rgba(0,0,0,0.07);box-shadow:${CARD_SHADOW}">
      <div style="font-size:16px;font-weight:700;color:${TEXT_M};margin-bottom:6px">AI Coach</div>
      <div style="font-size:13px;color:${TEXT_S};line-height:1.55;margin-bottom:16px">Reads your full training history (pacing, HR, readiness) and adapts your plan. Uses your own Anthropic API key. Typically under $1 a month at daily use.</div>

      <div style="margin-bottom:14px">
        <div style="font-size:12px;color:${TEXT_L};font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">How to get a key</div>
        ${['Go to console.anthropic.com (separate from claude.ai)', 'Create an account. New accounts include $5 free credit.', 'Add a payment method', 'Navigate to API Keys and create a new key', 'Paste it below'].map((step, i) => `
          <div style="display:flex;gap:10px;margin-bottom:6px;align-items:flex-start">
            <div style="width:18px;height:18px;border-radius:50%;background:${BORDER};color:${TEXT_S};font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">${i + 1}</div>
            <div style="font-size:13px;color:${TEXT_S};line-height:1.4">${step}</div>
          </div>`).join('')}
      </div>

      <input id="coach-setup-key-input" type="password" placeholder="sk-ant-api03-…"
        style="width:100%;padding:10px 12px;border:1px solid ${BORDER};border-radius:10px;font-size:13px;font-family:var(--f);color:${TEXT_M};background:white;margin-bottom:8px;box-sizing:border-box" />
      <div id="coach-setup-error" style="font-size:12px;color:${WARN};margin-bottom:8px;display:none"></div>
      <button id="coach-setup-connect"
        style="width:100%;padding:11px;border-radius:10px;border:none;cursor:pointer;background:${TEXT_M};color:#fff;font-size:14px;font-weight:600">
        Connect
      </button>
    </div>
  `;
}

// ─── Consent modal ────────────────────────────────────────────────────────────

function showConsentModal(apiKey: string): void {
  const overlay = document.createElement('div');
  overlay.id = 'coach-consent-overlay';
  overlay.style.cssText = `position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);padding:24px`;
  overlay.innerHTML = `
    <div style="background:white;border-radius:20px;padding:28px 24px;max-width:340px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,0.18)">
      <div style="font-size:17px;font-weight:700;color:${TEXT_M};margin-bottom:12px">Before we start</div>
      <div style="font-size:14px;color:${TEXT_S};line-height:1.6;margin-bottom:8px">Your recent training data (pacing, heart rate, readiness) will be sent to Anthropic each session to generate coaching.</div>
      <div style="font-size:14px;color:${TEXT_S};line-height:1.6;margin-bottom:24px">No name, email, or location is included. Anthropic does not train on API data.</div>
      <button id="coach-consent-btn" style="width:100%;padding:13px;border-radius:12px;border:none;cursor:pointer;background:${TEXT_M};color:#fff;font-size:15px;font-weight:600">Got it, start coaching</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('coach-consent-btn')?.addEventListener('click', () => {
    overlay.remove();
    getMutableState().coachConsentGiven = true;
    saveState();
    startBriefStream(apiKey);
  });
}

// ─── Snapshot export ──────────────────────────────────────────────────────────

async function downloadSnapshot(): Promise<void> {
  const state = getState();
  const { buildCoachContext } = await import('@/coach/coach-context-builder');
  const { buildSystemPrompt } = await import('@/coach/coach-chat-client');

  const context = buildCoachContext(state);
  const systemPrompt = buildSystemPrompt(context);
  const contextJson = JSON.stringify(context, null, 2);

  const lines = [
    'MOSAIC TRAINING SNAPSHOT',
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Paste this into Claude.ai, ChatGPT, or any AI assistant.',
    'The system prompt below tells the AI how to behave as your coach.',
    '',
    '─── SYSTEM PROMPT ───────────────────────────────────────────────',
    '',
    systemPrompt,
    '',
    '─── TRAINING DATA ───────────────────────────────────────────────',
    '',
    contextJson,
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mosaic-training-snapshot-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── AI mode streaming ────────────────────────────────────────────────────────

async function startBriefStream(apiKey: string): Promise<void> {
  const state = getState();
  const { buildCoachContext } = await import('@/coach/coach-context-builder');
  const { streamCoachChat } = await import('@/coach/coach-chat-client');
  const { validateAndBuildPendingChange } = await import('@/coach/coach-tools');

  const context = buildCoachContext(state);
  chatMessages = [{ role: 'user', content: 'start' }];
  isStreaming = true;

  const loadingEl = document.getElementById('coach-loading');
  const briefEl = document.getElementById('coach-brief-text');
  const inputArea = document.getElementById('coach-input-area');
  if (!briefEl) return;

  let accumulated = '';

  try {
    for await (const chunk of streamCoachChat(chatMessages, context, apiKey)) {
      if (chunk.type === 'text') {
        accumulated += chunk.delta;
        briefEl.textContent = accumulated; // plain during stream
        if (loadingEl) loadingEl.style.display = 'none';
        briefEl.style.display = '';
      } else if (chunk.type === 'tool_use') {
        const change = validateAndBuildPendingChange(chunk.name, chunk.input);
        if (change) {
          pendingChanges.push(change);
          renderApplyCard(change);
        }
      } else if (chunk.type === 'done') {
        break;
      } else if (chunk.type === 'error') {
        if (loadingEl) loadingEl.style.display = 'none';
        briefEl.style.display = '';
        briefEl.textContent = chunk.message;
        briefEl.style.color = WARN;
        break;
      }
    }
  } catch {
    if (briefEl) {
      briefEl.textContent = 'Could not connect to coach. Check your API key in Settings.';
      briefEl.style.display = '';
      briefEl.style.color = WARN;
    }
  }

  if (accumulated) {
    // Format paragraphs once stream is complete
    briefEl.innerHTML = formatAsHTML(accumulated);
    chatMessages.push({ role: 'assistant', content: accumulated });
    saveSession(state.w);
  }

  isStreaming = false;
  if (inputArea) inputArea.style.display = '';
}

async function sendChatMessage(text: string): Promise<void> {
  if (isStreaming || !text.trim()) return;

  const apiKey = await (await import('@/coach/api-key-store')).getApiKey();
  if (!apiKey) return;

  const state = getState();
  const { buildCoachContext } = await import('@/coach/coach-context-builder');
  const { streamCoachChat } = await import('@/coach/coach-chat-client');
  const { validateAndBuildPendingChange } = await import('@/coach/coach-tools');

  const MAX_MESSAGES = 20;
  if (chatMessages.length >= MAX_MESSAGES) {
    appendToThread(coachBubble('Start a new coaching session to continue. Tap the back button and re-open Coach.'));
    return;
  }

  chatMessages.push({ role: 'user', content: text });
  appendToThread(userBubble(text));

  const assistantId = `coach-reply-${Date.now()}`;
  appendToThread(coachBubble('', assistantId));

  isStreaming = true;
  const sendBtn = document.getElementById('coach-send-btn') as HTMLButtonElement | null;
  const input = document.getElementById('coach-input') as HTMLTextAreaElement | null;
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;

  const context = buildCoachContext(state);
  let accumulated = '';

  try {
    for await (const chunk of streamCoachChat(chatMessages, context, apiKey)) {
      if (chunk.type === 'text') {
        accumulated += chunk.delta;
        const replyEl = document.getElementById(assistantId)?.querySelector('div');
        if (replyEl) replyEl.textContent = accumulated; // plain during stream
      } else if (chunk.type === 'tool_use') {
        const change = validateAndBuildPendingChange(chunk.name, chunk.input);
        if (change) {
          pendingChanges.push(change);
          renderApplyCard(change, 'thread');
        }
      } else if (chunk.type === 'done' || chunk.type === 'error') {
        if (chunk.type === 'error') {
          const replyEl = document.getElementById(assistantId)?.querySelector('div');
          if (replyEl) { replyEl.textContent = chunk.message; (replyEl as HTMLElement).style.color = WARN; }
        }
        break;
      }
    }
  } catch { /* error shown inline */ }

  if (accumulated) {
    // Format paragraphs once stream is complete
    const replyEl = document.getElementById(assistantId)?.querySelector('div');
    if (replyEl) replyEl.innerHTML = formatAsHTML(accumulated);
    chatMessages.push({ role: 'assistant', content: accumulated });
    saveSession(state.w);
  }

  isStreaming = false;
  if (sendBtn) sendBtn.disabled = false;
  if (input) { input.disabled = false; input.value = ''; input.focus(); }
}

function appendToThread(html: string): void {
  const thread = document.getElementById('coach-thread');
  if (!thread) return;
  const div = document.createElement('div');
  div.innerHTML = html;
  thread.appendChild(div.firstElementChild ?? div);
  thread.scrollTop = thread.scrollHeight;
}

function renderApplyCard(
  change: import('@/coach/coach-tools').PendingChange,
  target: 'brief' | 'thread' = 'brief',
): void {
  const containerId = target === 'thread' ? 'coach-thread' : 'coach-apply-cards';
  const container = document.getElementById(containerId);
  if (!container) return;
  const div = document.createElement('div');
  div.innerHTML = applyCardHTML(change);
  container.appendChild(div.firstElementChild ?? div);
  wireApplyCard(change.id);
}

function wireApplyCard(id: string): void {
  document.querySelector(`[data-apply-id="${id}"]`)?.addEventListener('click', async () => {
    const change = pendingChanges.find(c => c.id === id);
    if (!change) return;
    const { applyPendingChange } = await import('@/coach/coach-tools');
    applyPendingChange(change);
    document.getElementById(`apply-card-${id}`)?.remove();
    pendingChanges = pendingChanges.filter(c => c.id !== id);
  });

  document.querySelector(`[data-skip-id="${id}"]`)?.addEventListener('click', () => {
    document.getElementById(`apply-card-${id}`)?.remove();
    pendingChanges = pendingChanges.filter(c => c.id !== id);
  });
}

/** Restore a saved session into the UI without re-streaming. */
function restoreSessionUI(): void {
  const loadingEl = document.getElementById('coach-loading');
  const briefEl = document.getElementById('coach-brief-text');
  const inputArea = document.getElementById('coach-input-area');

  // chatMessages[0] = 'start', chatMessages[1] = brief
  const brief = chatMessages[1]?.content ?? '';
  if (brief && briefEl) {
    if (loadingEl) loadingEl.style.display = 'none';
    briefEl.innerHTML = formatAsHTML(brief);
    briefEl.style.display = '';
  }

  // Restore thread (skip index 0 and 1)
  for (let i = 2; i < chatMessages.length; i++) {
    const msg = chatMessages[i];
    if (msg.role === 'user') appendToThread(userBubble(msg.content));
    else appendToThread(coachBubble(formatAsHTML(msg.content)));
  }

  if (inputArea) inputArea.style.display = '';
}

// ─── HTML shells ──────────────────────────────────────────────────────────────

function getAICoachHTML(): string {
  return `
    <style>
      #coach-view { box-sizing:border-box; }
      #coach-view *, #coach-view *::before, #coach-view *::after { box-sizing:inherit; }
      @keyframes coachPulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
      .coach-pulse { animation:coachPulse 1.6s ease-in-out infinite; }
      #coach-brief-text p:last-child { margin-bottom:0; }
    </style>

    <div id="coach-view" style="position:relative;min-height:100vh;background:${CREAM};font-family:var(--f);overflow-x:hidden;display:flex;flex-direction:column">

      ${buildScrollAtmosphereBackground('cv', 'rose', { haloCenter: { cx: 200, cy: 550 } })}${buildSunGlint('low')}

      <!-- Header -->
      <div style="position:relative;z-index:10;padding:56px 20px 12px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <button id="coach-back-btn" style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.08);display:flex;align-items:center;justify-content:center;color:${TEXT_M}">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style="font-size:20px;font-weight:700;color:${TEXT_M}">Coach</div>
        <button id="coach-export-btn" title="Export training snapshot"
          style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:transparent;display:flex;align-items:center;justify-content:center;color:${TEXT_L}">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
      </div>

      <!-- Brief area -->
      <div style="position:relative;z-index:10;flex-shrink:0;padding:0 16px 8px">
        <div id="coach-loading" class="coach-pulse" style="font-size:15px;color:${TEXT_S};padding:12px 0">Reviewing your week…</div>
        <div id="coach-brief-text" style="display:none;font-size:16px;line-height:1.65;color:${TEXT_M};padding:4px 0 12px"></div>
      </div>

      <!-- Apply cards from brief -->
      <div id="coach-apply-cards" style="position:relative;z-index:10;flex-shrink:0"></div>

      <!-- Chat thread — scrollable -->
      <div id="coach-thread" style="position:relative;z-index:10;flex:1;overflow-y:auto;padding:8px 0 16px;min-height:80px"></div>

      <!-- Input -->
      <div id="coach-input-area" style="display:none;position:relative;z-index:10;padding:10px 16px;padding-bottom:calc(10px + env(safe-area-inset-bottom, 0px));background:rgba(255,255,255,0.9);backdrop-filter:blur(16px);border-top:1px solid ${BORDER};flex-shrink:0">
        <div style="display:flex;gap:8px;align-items:flex-end">
          <textarea id="coach-input" rows="1" placeholder="Ask your coach…"
            style="flex:1;padding:10px 12px;border:1px solid ${BORDER};border-radius:12px;font-size:14px;resize:none;background:transparent;font-family:var(--f);color:${TEXT_M};max-height:120px;overflow-y:auto"></textarea>
          <button id="coach-send-btn" style="width:38px;height:38px;border-radius:50%;border:none;cursor:pointer;background:${TEXT_M};color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>

    </div>

    ${renderTabBar('home')}
  `;
}

function getClassicCoachHTML(coach: CoachState): string {
  const sig = coach.signals;

  return `
    <style>
      #coach-view { box-sizing:border-box; }
      #coach-view *, #coach-view *::before, #coach-view *::after { box-sizing:inherit; }
      @keyframes coachFloatUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:none} }
      .cv-fade { opacity:0;animation:coachFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="coach-view" style="position:relative;min-height:100vh;background:${CREAM};font-family:var(--f);overflow-x:hidden">

      ${buildScrollAtmosphereBackground('cv', 'rose', { haloCenter: { cx: 200, cy: 550 } })}${buildSunGlint('low')}

      <div style="position:relative;z-index:10;padding-bottom:96px">

        <!-- Header -->
        <div style="padding:56px 20px 12px;display:flex;align-items:center;justify-content:space-between">
          <button id="coach-back-btn" style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.08);display:flex;align-items:center;justify-content:center;color:${TEXT_M}">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="font-size:20px;font-weight:700;color:${TEXT_M}">Coach</div>
          <div style="width:36px"></div>
        </div>

        ${classicHero(coach)}

        <!-- AI Coach setup card — prominent, inline, no navigation required -->
        ${aiSetupCard()}

        ${classicWhySection(coach)}
        ${classicRecoverySection(sig)}

        <!-- Today's workout -->
        ${sig.todayWorkoutName ? card(`
          ${cardTitle('Today')}
          <div style="font-size:15px;font-weight:600;color:${TEXT_M};margin-bottom:4px">${sig.todayWorkoutName}</div>
          ${sig.todayWorkoutDescription ? `<div style="font-size:13px;color:${TEXT_S};line-height:1.5">${sig.todayWorkoutDescription}</div>` : ''}
        `) : ''}

        <!-- Feeling prompt -->
        ${card(`${cardTitle('How do you feel today?')}${renderFeelingPromptHTML('brain')}`)}

        <!-- Export snapshot -->
        <div style="margin:8px 16px 0;text-align:center">
          <button id="coach-export-btn" style="font-size:13px;color:${TEXT_L};background:none;border:none;cursor:pointer;padding:4px">
            Export training snapshot
          </button>
        </div>

      </div>
    </div>

    ${renderTabBar('home')}
  `;
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'forecast') import('./triathlon/forecast-view').then(m => m.renderTriathlonForecastView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
}

// ─── Wire handlers ────────────────────────────────────────────────────────────

function wireCoachHandlers(aiMode: boolean): void {
  wireTabBarHandlers(navigateTab);

  document.getElementById('coach-back-btn')?.addEventListener('click', () => {
    resetSession();
    if (coachOnBack) { coachOnBack(); return; }
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  document.getElementById('coach-export-btn')?.addEventListener('click', () => downloadSnapshot());

  if (!aiMode) {
    wireFeelingPromptHandlers(document, () => renderCoachView(coachOnBack ?? undefined));
    wireSetupCard();
    return;
  }

  // AI mode: chat input
  const input = document.getElementById('coach-input') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('coach-send-btn') as HTMLButtonElement | null;

  const send = () => {
    const text = input?.value.trim() ?? '';
    if (text) sendChatMessage(text);
  };

  sendBtn?.addEventListener('click', send);

  input?.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      ke.preventDefault();
      send();
    }
  });

  input?.addEventListener('input', () => {
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    }
  });
}

/** Wire the inline API key setup card in classic mode. */
function wireSetupCard(): void {
  document.getElementById('coach-setup-connect')?.addEventListener('click', async () => {
    const keyInput = document.getElementById('coach-setup-key-input') as HTMLInputElement | null;
    const errorEl = document.getElementById('coach-setup-error') as HTMLElement | null;
    const connectBtn = document.getElementById('coach-setup-connect') as HTMLButtonElement | null;
    const key = keyInput?.value.trim() ?? '';

    if (errorEl) errorEl.style.display = 'none';

    if (!key.startsWith('sk-ant-')) {
      if (errorEl) { errorEl.textContent = 'Key must start with sk-ant-'; errorEl.style.display = ''; }
      return;
    }

    if (connectBtn) { connectBtn.textContent = 'Testing connection…'; connectBtn.disabled = true; }

    const { testApiKey } = await import('@/coach/coach-chat-client');
    const result = await testApiKey(key);

    if (!result.ok) {
      if (errorEl) { errorEl.textContent = result.error ?? 'Connection failed. Check the key and try again.'; errorEl.style.display = ''; }
      if (connectBtn) { connectBtn.textContent = 'Connect'; connectBtn.disabled = false; }
      return;
    }

    const { storeApiKey } = await import('@/coach/api-key-store');
    await storeApiKey(key);
    getMutableState().anthropicApiKeyStored = true;
    saveState();
    renderCoachView(coachOnBack ?? undefined);
  });
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function renderCoachView(onBack?: () => void): Promise<void> {
  const container = document.getElementById('app-root');
  if (!container) return;
  coachOnBack = onBack ?? coachOnBack;

  const state = getState();
  const hasKey = state.anthropicApiKeyStored ?? false;

  if (hasKey) {
    resetSession();
    container.innerHTML = getAICoachHTML();
    wireCoachHandlers(true);

    const { getApiKey } = await import('@/coach/api-key-store');
    const apiKey = await getApiKey();

    if (!apiKey) {
      // Stale flag — reset and show classic
      getMutableState().anthropicApiKeyStored = false;
      saveState();
      const coach = computeDailyCoach(state);
      container.innerHTML = getClassicCoachHTML(coach);
      wireCoachHandlers(false);
      return;
    }

    // Restore previous session if it exists for this week
    if (loadSession(state.w)) {
      restoreSessionUI();
      return;
    }

    // Check one-time consent
    if (!state.coachConsentGiven) {
      const loadingEl = document.getElementById('coach-loading');
      if (loadingEl) loadingEl.style.display = 'none';
      showConsentModal(apiKey);
      return;
    }

    startBriefStream(apiKey);
  } else {
    const coach = computeDailyCoach(state);
    container.innerHTML = getClassicCoachHTML(coach);
    wireCoachHandlers(false);
  }
}
