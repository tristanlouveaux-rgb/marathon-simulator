/**
 * Coach view — AI-powered coaching surface (Mosaic-paid) + rules-based fallback.
 *
 * AI mode (allowlisted user): streams a coaching brief, shows Apply cards for
 * plan changes, supports chat follow-ups. Session persists across navigation
 * within the same plan week.
 *
 * Classic mode (not allowlisted): rules-based brief, recovery readout, today's
 * workout, feeling prompt, and an export-snapshot affordance. No placeholder
 * copy — fully functional standalone surface.
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
/** Module-level guard so the consent modal can't double-mount within a single
 *  page-load (race between the async gate chain re-entering before the modal
 *  has DOM-mounted). Persisted flag (`coachConsentGiven`) is the long-term
 *  guard; this is the short-term per-page-load belt-and-braces. */
let consentShownThisSession = false;

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

/** Strip the most common markdown markers Haiku occasionally emits despite the
 *  prompt forbidding them. Defensive belt-and-braces — the prompt is the primary
 *  defence, this is the safety net so the UI never renders raw `**` or `*`. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/^\s*#+\s*/gm, '')                          // headings
    .replace(/\*\*(.+?)\*\*/g, '$1')                      // bold
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '$1')   // italic
    .replace(/`([^`\n]+?)`/g, '$1')                        // inline code
    .replace(/^\s*[-*]\s+/gm, '')                          // bullet markers
    .replace(/, /g, ', ')                                    // em dashes (banned by copy rules)
    .replace(/–/g, '-');                                    // en dashes → hyphen
}

/** Extract the <choices>...</choices> block from an assistant turn. Returns
 *  the parsed choices array and the cleaned text (with the block removed). */
export function extractChoices(text: string): { choices: string[]; clean: string } {
  const match = text.match(/<choices>([\s\S]*?)<\/choices>/i);
  if (!match) return { choices: [], clean: text };
  const choices = match[1]
    .split('\n')
    .map(s => s.replace(/^[\s•·\-*]+/, '').trim())
    .filter(s => s.length > 0 && s.length <= 80)
    .slice(0, 4);
  const clean = text.replace(/<choices>[\s\S]*?<\/choices>/gi, '').trim();
  return { choices, clean };
}

/** Extract the <confidence>level</confidence> block. Returns the level (high
 *  | medium | low | null) and the cleaned text with the tag removed. */
export function extractConfidence(text: string): { confidence: 'high' | 'medium' | 'low' | null; clean: string } {
  const match = text.match(/<confidence>\s*(high|medium|low)\s*<\/confidence>/i);
  const clean = text.replace(/<confidence>[\s\S]*?<\/confidence>/gi, '').trim();
  if (!match) return { confidence: null, clean };
  return { confidence: match[1].toLowerCase() as 'high' | 'medium' | 'low', clean };
}

/** Render a small confidence pill below an assistant message. */
function renderConfidencePill(level: 'high' | 'medium' | 'low', anchorId: string): void {
  document.querySelectorAll(`[data-confidence-for="${anchorId}"]`).forEach(el => el.remove());

  const label = level === 'high' ? 'High confidence' : level === 'medium' ? 'Estimate' : 'Uncertain';
  const dotColour = level === 'high' ? '#16A34A' : level === 'medium' ? '#94A3B8' : '#B45309';

  const pill = document.createElement('div');
  pill.setAttribute('data-confidence-for', anchorId);
  pill.style.cssText = `padding:0 16px 8px;display:flex;justify-content:flex-start`;
  pill.innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:${TEXT_L};font-weight:500;padding:3px 10px;border-radius:100px;background:rgba(15,23,42,0.04)">
      <span style="width:6px;height:6px;border-radius:50%;background:${dotColour}"></span>
      ${label}
    </span>
  `;

  const anchor = document.getElementById(anchorId);
  if (anchor) anchor.insertAdjacentElement('afterend', pill);
}

/** Render tappable chip pills below the current message. Tapping a chip sends
 *  its text as the next user message. */
function renderChips(choices: string[], anchorId: string): void {
  if (choices.length === 0) return;
  // Clear any existing chip strip first
  document.getElementById('coach-chip-strip')?.remove();
  const anchor = document.getElementById(anchorId);
  if (!anchor) return;

  const strip = document.createElement('div');
  strip.id = 'coach-chip-strip';
  strip.style.cssText = `display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px;justify-content:flex-start`;
  strip.innerHTML = choices.map(c => `
    <button class="coach-chip" data-chip-text="${escHtml(c).replace(/"/g, '&quot;')}"
      style="background:rgba(255,255,255,0.85);backdrop-filter:blur(8px);border:1px solid ${BORDER};color:${TEXT_M};font-size:13px;font-weight:500;padding:8px 14px;border-radius:100px;cursor:pointer;font-family:inherit;line-height:1.3;transition:transform 0.1s ease,box-shadow 0.1s ease">
      ${escHtml(c)}
    </button>
  `).join('');

  anchor.insertAdjacentElement('afterend', strip);

  strip.querySelectorAll('.coach-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = (btn as HTMLElement).getAttribute('data-chip-text') ?? '';
      if (!text) return;
      strip.remove();
      sendChatMessage(text);
    });
  });
}

/** Convert plain-text LLM response to paragraphs for display. */
function formatAsHTML(text: string): string {
  return stripMarkdown(text)
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
  // Sentence-case, no text-transform/letter-spacing per UX_PATTERNS Visual Constraints.
  return `<div style="font-size:13px;color:${TEXT_M};margin-bottom:10px;font-weight:600">${label}</div>`;
}

function applyCardHTML(change: import('@/coach/coach-tools').PendingChange): string {
  // Memory tools surface the fact text prominently and use softer button labels
  // so it reads as "save this note" rather than "modify your plan".
  const isMemoryTool = change.tool === 'remember' || change.tool === 'forget';
  const factText = isMemoryTool ? String((change as any)._params?.fact ?? '') : '';

  const icon = isMemoryTool
    ? `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" style="flex-shrink:0;margin-top:2px"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/></svg>`
    : '';

  const body = change.tool === 'remember' && factText
    ? `<div style="font-size:13px;color:${TEXT_M};line-height:1.5;margin-bottom:6px;font-style:italic">"${escHtml(factText)}"</div>
       <div style="font-size:12px;color:${TEXT_L};line-height:1.45;margin-bottom:12px">${escHtml(change.reason)}</div>`
    : `<div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-bottom:12px">${escHtml(change.reason)}</div>`;

  const primaryLabel = isMemoryTool ? (change.tool === 'remember' ? 'Save' : 'Forget') : 'Apply';
  const secondaryLabel = isMemoryTool ? 'Discard' : 'Skip';

  return `
    <div id="apply-card-${change.id}" style="
      margin:0 16px 10px;padding:14px 16px;background:white;border-radius:14px;
      box-shadow:${CARD_SHADOW};border-left:3px solid ${TEXT_M};
    ">
      <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px">
        ${icon}
        <div style="font-size:14px;font-weight:600;color:${TEXT_M};line-height:1.35;flex:1">${escHtml(change.headline)}</div>
      </div>
      ${body}
      <div style="display:flex;gap:8px">
        <button data-apply-id="${change.id}"
          style="flex:1;padding:8px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;background:${TEXT_M};color:#fff;border:none">
          ${primaryLabel}
        </button>
        <button data-skip-id="${change.id}"
          style="flex:1;padding:8px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;background:transparent;color:${TEXT_M};border:1px solid ${BORDER}">
          ${secondaryLabel}
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
      <span style="display:inline-flex;padding:5px 12px;border-radius:100px;border:1px solid rgba(15,23,42,0.1);background:rgba(255,255,255,0.75);backdrop-filter:blur(8px);font-size:12px;font-weight:600;color:${stanceColor}">${stanceLabel}</span>
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

// ─── Intro overlay ────────────────────────────────────────────────────────────

/** One-time "what the coach can do" overlay. Shown on first Coach open
 *  (gated by state.coachIntroSeen) and re-accessible via the header ? button. */
function showCoachIntro(opts?: { onDismiss?: () => void; markSeen?: boolean }): void {
  // Hard guard against double-mount
  if (document.getElementById('coach-intro-overlay')) return;

  const markSeen = opts?.markSeen ?? true;

  const sections: Array<{ title: string; body: string }> = [
    {
      title: 'What I do',
      body: 'Read your full plan and recent training. Explain why this week is built the way it is. Propose specific tweaks to workouts you can apply with one tap.',
    },
    {
      title: 'What to ask me',
      body: '"Why is this week threshold-heavy?" · "Cut Tuesday\'s swim by 30%" · "Swap Thursday\'s bike for an easy run" · "How am I tracking against my goal?"',
    },
    {
      title: 'What I won\'t do',
      body: 'No medical, nutrition, technique, or equipment advice. For those, see a qualified professional. I stick to training load, intensity, and session timing.',
    },
  ];

  const overlay = document.createElement('div');
  overlay.id = 'coach-intro-overlay';
  overlay.style.cssText = `position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);padding:24px`;
  overlay.innerHTML = `
    <div style="position:relative;background:white;border-radius:20px;padding:28px 24px 24px;max-width:380px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,0.18);max-height:80vh;overflow-y:auto">
      <button id="coach-intro-close" aria-label="Close"
        style="position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;border:none;cursor:pointer;background:transparent;color:${TEXT_L};display:flex;align-items:center;justify-content:center">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div style="font-size:18px;font-weight:700;color:${TEXT_M};margin-bottom:6px">Meet your Coach</div>
      <div style="font-size:13px;color:${TEXT_S};line-height:1.5;margin-bottom:20px">A quick guide so you know what to expect.</div>
      ${sections.map(s => `
        <div style="margin-bottom:18px">
          <div style="font-size:14px;font-weight:700;color:${TEXT_M};margin-bottom:4px">${s.title}</div>
          <div style="font-size:13px;color:${TEXT_S};line-height:1.55">${s.body}</div>
        </div>
      `).join('')}
      <button id="coach-intro-cta"
        style="width:100%;padding:13px;border-radius:12px;border:none;cursor:pointer;background:${TEXT_M};color:#fff;font-size:15px;font-weight:600;margin-top:4px">
        Got it
      </button>
    </div>
  `;
  document.body.appendChild(overlay);

  const dismiss = () => {
    overlay.remove();
    if (markSeen && !getState().coachIntroSeen) {
      getMutableState().coachIntroSeen = true;
      saveState();
    }
    opts?.onDismiss?.();
  };

  document.getElementById('coach-intro-cta')?.addEventListener('click', dismiss);
  document.getElementById('coach-intro-close')?.addEventListener('click', dismiss);
}

// ─── Priorities modal (Sprint D) ─────────────────────────────────────────────

type CoachPriority = 'time' | 'finish' | 'healthy' | 'fun';
type CoachConstraint = 'time' | 'energy' | 'injury' | 'none';

const PRIORITY_OPTIONS: Array<{ id: CoachPriority; label: string; sub: string }> = [
  { id: 'time',    label: 'Hit the time',  sub: 'Race-day goal time is what matters.' },
  { id: 'finish',  label: 'Just finish',   sub: 'Crossing the line in good shape is the win.' },
  { id: 'healthy', label: 'Stay healthy',  sub: 'Injury-free matters more than a faster time.' },
  { id: 'fun',     label: 'Have fun',      sub: 'Enjoy the build. Not chasing PBs right now.' },
];

const CONSTRAINT_OPTIONS: Array<{ id: CoachConstraint; label: string; sub: string }> = [
  { id: 'time',    label: 'Time available',    sub: 'Work, family, or schedule is the bottleneck.' },
  { id: 'energy',  label: 'Energy / recovery', sub: 'Tired more often than I\'d like.' },
  { id: 'injury', label: 'Injury history',    sub: 'A niggle could become a setback.' },
  { id: 'none',    label: 'Nothing right now', sub: 'No major limiter today.' },
];

/** Public entry point so other surfaces (Account view) can re-open the picker. */
export function openCoachPrioritiesModal(onDismiss?: () => void): void {
  showPrioritiesModal({ onDismiss, markSeen: false });
}

/** One-time priorities flow. Two questions, chip-style picks, persists to state.
 *  Re-opened from the help icon or Account view for edits. */
function showPrioritiesModal(opts?: { onDismiss?: () => void; markSeen?: boolean }): void {
  if (document.getElementById('coach-priorities-overlay')) return;
  const markSeen = opts?.markSeen ?? true;
  const existing = getState().coachPriorities;

  const overlay = document.createElement('div');
  overlay.id = 'coach-priorities-overlay';
  overlay.style.cssText = `position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);padding:24px`;

  let pickedPriority: CoachPriority | null = existing?.priority ?? null;
  let pickedConstraint: CoachConstraint | null = existing?.constraint ?? null;

  const renderPicker = (opts: Array<{ id: string; label: string; sub: string }>, name: string, current: string | null) => {
    return opts.map(o => `
      <button class="prio-pick" data-${name}-id="${o.id}" style="
        width:100%;text-align:left;padding:12px 14px;border-radius:12px;cursor:pointer;
        border:1px solid ${current === o.id ? TEXT_M : BORDER};
        background:${current === o.id ? 'rgba(15,23,42,0.04)' : 'white'};
        margin-bottom:8px;font-family:inherit;display:block">
        <div style="font-size:14px;font-weight:600;color:${TEXT_M};margin-bottom:2px">${escHtml(o.label)}</div>
        <div style="font-size:12px;color:${TEXT_S};line-height:1.4">${escHtml(o.sub)}</div>
      </button>
    `).join('');
  };

  overlay.innerHTML = `
    <div style="position:relative;background:white;border-radius:20px;padding:24px;max-width:380px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,0.18);max-height:88vh;overflow-y:auto">
      <button id="prio-close" aria-label="Close"
        style="position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;border:none;cursor:pointer;background:transparent;color:${TEXT_L};display:flex;align-items:center;justify-content:center">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div style="font-size:17px;font-weight:700;color:${TEXT_M};margin-bottom:4px">What matters most this block?</div>
      <div style="font-size:12px;color:${TEXT_S};margin-bottom:14px">Helps the coach weight its recommendations.</div>
      <div id="prio-priority-list">${renderPicker(PRIORITY_OPTIONS, 'priority', pickedPriority)}</div>

      <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin:20px 0 4px">What's most limiting you?</div>
      <div style="font-size:12px;color:${TEXT_S};margin-bottom:14px">Pick the closest fit. You can change this later.</div>
      <div id="prio-constraint-list">${renderPicker(CONSTRAINT_OPTIONS, 'constraint', pickedConstraint)}</div>

      <button id="prio-save"
        style="width:100%;margin-top:14px;padding:13px;border-radius:12px;border:none;cursor:pointer;background:${TEXT_M};color:#fff;font-size:15px;font-weight:600;opacity:${pickedPriority && pickedConstraint ? '1' : '0.5'}">
        Save
      </button>
    </div>
  `;
  document.body.appendChild(overlay);

  // Wire chip picks
  overlay.querySelectorAll<HTMLButtonElement>('[data-priority-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      pickedPriority = btn.getAttribute('data-priority-id') as CoachPriority;
      const list = document.getElementById('prio-priority-list');
      if (list) list.innerHTML = renderPicker(PRIORITY_OPTIONS, 'priority', pickedPriority);
      // Re-wire after re-render
      overlay.querySelectorAll<HTMLButtonElement>('[data-priority-id]').forEach(b => b.addEventListener('click', () => {
        pickedPriority = b.getAttribute('data-priority-id') as CoachPriority;
        const l = document.getElementById('prio-priority-list');
        if (l) l.innerHTML = renderPicker(PRIORITY_OPTIONS, 'priority', pickedPriority);
        wireRePicks();
        updateSaveState();
      }));
      updateSaveState();
    });
  });
  overlay.querySelectorAll<HTMLButtonElement>('[data-constraint-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      pickedConstraint = btn.getAttribute('data-constraint-id') as CoachConstraint;
      const list = document.getElementById('prio-constraint-list');
      if (list) list.innerHTML = renderPicker(CONSTRAINT_OPTIONS, 'constraint', pickedConstraint);
      wireRePicks();
      updateSaveState();
    });
  });

  function wireRePicks() {
    overlay.querySelectorAll<HTMLButtonElement>('[data-priority-id]').forEach(b => b.addEventListener('click', () => {
      pickedPriority = b.getAttribute('data-priority-id') as CoachPriority;
      const l = document.getElementById('prio-priority-list');
      if (l) l.innerHTML = renderPicker(PRIORITY_OPTIONS, 'priority', pickedPriority);
      wireRePicks();
      updateSaveState();
    }));
    overlay.querySelectorAll<HTMLButtonElement>('[data-constraint-id]').forEach(b => b.addEventListener('click', () => {
      pickedConstraint = b.getAttribute('data-constraint-id') as CoachConstraint;
      const l = document.getElementById('prio-constraint-list');
      if (l) l.innerHTML = renderPicker(CONSTRAINT_OPTIONS, 'constraint', pickedConstraint);
      wireRePicks();
      updateSaveState();
    }));
  }

  function updateSaveState() {
    const btn = document.getElementById('prio-save') as HTMLButtonElement | null;
    if (!btn) return;
    btn.style.opacity = pickedPriority && pickedConstraint ? '1' : '0.5';
  }

  const dismiss = () => {
    overlay.remove();
    if (markSeen && !getState().coachPrioritiesSeen) {
      getMutableState().coachPrioritiesSeen = true;
      saveState();
    }
    opts?.onDismiss?.();
  };

  document.getElementById('prio-close')?.addEventListener('click', dismiss);
  document.getElementById('prio-save')?.addEventListener('click', () => {
    if (!pickedPriority || !pickedConstraint) return;
    const ms = getMutableState();
    ms.coachPriorities = {
      priority: pickedPriority,
      constraint: pickedConstraint,
      setISO: new Date().toISOString(),
    };
    ms.coachPrioritiesSeen = true;
    saveState();
    overlay.remove();
    opts?.onDismiss?.();
  });
}

// ─── Consent modal ────────────────────────────────────────────────────────────

function showConsentModal(): void {
  // Hard double-mount guards: DOM id + module-level boolean. Both flip BEFORE
  // any await/network round-trip so a re-entry while the modal is materialising
  // can't produce a second copy. Mirrors the showCoachIntro pattern.
  if (document.getElementById('coach-consent-overlay')) return;
  if (consentShownThisSession) return;
  consentShownThisSession = true;

  const overlay = document.createElement('div');
  overlay.id = 'coach-consent-overlay';
  overlay.style.cssText = `position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);padding:24px`;
  overlay.innerHTML = `
    <div style="background:white;border-radius:20px;padding:28px 24px;max-width:360px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,0.18)">
      <div style="font-size:17px;font-weight:700;color:${TEXT_M};margin-bottom:12px">Before we start</div>
      <div style="font-size:14px;color:${TEXT_S};line-height:1.6;margin-bottom:10px">Your recent training data (pacing, heart rate, readiness, this week's plan) is sent to <strong>Anthropic Claude (Haiku model)</strong> each session to generate coaching responses.</div>
      <div style="font-size:14px;color:${TEXT_S};line-height:1.6;margin-bottom:10px">No name, email, GPS routes, or credentials are sent. Under our commercial agreement, Anthropic does not train on this data and does not retain it beyond the response.</div>
      <div style="font-size:12px;color:${TEXT_S};line-height:1.55;margin-bottom:20px;opacity:0.8">Full details in the <a href="https://mosaicrunning.run/privacy.html" target="_blank" rel="noopener" style="color:${TEXT_M};text-decoration:underline">privacy policy</a>.</div>
      <button id="coach-consent-btn" style="width:100%;padding:13px;border-radius:12px;border:none;cursor:pointer;background:${TEXT_M};color:#fff;font-size:15px;font-weight:600">Got it, start coaching</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('coach-consent-btn')?.addEventListener('click', () => {
    overlay.remove();
    getMutableState().coachConsentGiven = true;
    saveState();
    startBriefStream();
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

async function startBriefStream(primer?: string): Promise<void> {
  const state = getState();
  const { buildCoachContext } = await import('@/coach/coach-context-builder');
  const { streamCoachChat } = await import('@/coach/coach-chat-client');
  const { validateAndBuildPendingChange } = await import('@/coach/coach-tools');

  const context = buildCoachContext(state);
  // primer = a proactive insight primer fed from Home view. When set, treat it
  // as the user's first message instead of the default "start" → brief flow.
  chatMessages = [{ role: 'user', content: primer && primer.trim() ? primer.trim() : 'start' }];
  isStreaming = true;

  const loadingEl = document.getElementById('coach-loading');
  const briefEl = document.getElementById('coach-brief-text');
  const inputArea = document.getElementById('coach-input-area');
  if (!briefEl) return;

  let accumulated = '';

  try {
    for await (const chunk of streamCoachChat(chatMessages, context)) {
      if (chunk.type === 'text') {
        accumulated += chunk.delta;
        // Truncate live display at the first internal tag (<choices> or <confidence>)
        // so the user never sees raw tag markup while streaming.
        const live = accumulated.split(/<(?:choices|confidence)/i)[0];
        briefEl.textContent = live;
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
      briefEl.textContent = 'Could not connect to coach. Try again in a moment.';
      briefEl.style.display = '';
      briefEl.style.color = WARN;
    }
  }

  if (accumulated) {
    // Strip both internal tags (<choices>, <confidence>) before format/persist.
    const c1 = extractChoices(accumulated);
    const c2 = extractConfidence(c1.clean);
    briefEl.innerHTML = formatAsHTML(c2.clean);
    chatMessages.push({ role: 'assistant', content: c2.clean });
    saveSession(state.w);

    const briefContainer = briefEl.parentElement;
    if (briefContainer && !briefContainer.id) briefContainer.id = 'coach-brief-container';

    if (c2.confidence) {
      renderConfidencePill(c2.confidence, briefEl.id || 'coach-brief-text');
    }
    if (c1.choices.length > 0) {
      renderChips(c1.choices, briefContainer?.id ?? '');
    }
  }

  isStreaming = false;
  if (inputArea) inputArea.style.display = '';
}

async function sendChatMessage(text: string): Promise<void> {
  if (isStreaming || !text.trim()) return;

  // Clear any chip strip from the previous turn so a fresh question gets fresh chips.
  document.getElementById('coach-chip-strip')?.remove();

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
  let validToolFired = false;
  let invalidToolFired = false;
  let errorMessage: string | null = null;
  let lastDropReason: string | null = null;

  try {
    for await (const chunk of streamCoachChat(chatMessages, context)) {
      if (chunk.type === 'text') {
        accumulated += chunk.delta;
        const replyEl = document.getElementById(assistantId)?.querySelector('div');
        const live = accumulated.split(/<(?:choices|confidence)/i)[0];
        if (replyEl) replyEl.textContent = live; // plain during stream, internal tags hidden
        // Keep the latest text in view as the bubble grows
        const thread = document.getElementById('coach-thread');
        if (thread) thread.scrollTop = thread.scrollHeight;
      } else if (chunk.type === 'tool_use') {
        // Race-safe: drop reason returned inline so back-to-back tool blocks
        // in a single stream can't clobber each other's diagnostics.
        const { validateToolCall } = await import('@/coach/coach-tools');
        const result = validateToolCall(chunk.name, chunk.input);
        if ('change' in result) {
          validToolFired = true;
          pendingChanges.push(result.change);
          renderApplyCard(result.change, 'thread');
        } else {
          invalidToolFired = true;
          lastDropReason = result.dropReason;
        }
      } else if (chunk.type === 'done' || chunk.type === 'error') {
        if (chunk.type === 'error') errorMessage = chunk.message;
        break;
      }
    }
  } catch { /* falls through to fallback handling below */ }

  const replyEl = document.getElementById(assistantId)?.querySelector('div');
  const bubbleEl = document.getElementById(assistantId);

  if (errorMessage) {
    if (replyEl) { replyEl.textContent = errorMessage; (replyEl as HTMLElement).style.color = WARN; }
  } else if (accumulated) {
    // Stream completed with text — strip internal tags, format, persist.
    const c1 = extractChoices(accumulated);
    const c2 = extractConfidence(c1.clean);
    if (replyEl) replyEl.innerHTML = formatAsHTML(c2.clean);
    chatMessages.push({ role: 'assistant', content: c2.clean });
    saveSession(state.w);
    if (c2.confidence && bubbleEl) {
      renderConfidencePill(c2.confidence, assistantId);
    }
    if (c1.choices.length > 0 && bubbleEl) {
      renderChips(c1.choices, assistantId);
    }
  } else if (validToolFired) {
    // Coach used a tool with no preamble — the Apply card IS the response.
    // Remove the empty bubble; persist a marker so re-renders don't recreate it.
    if (bubbleEl) bubbleEl.remove();
    chatMessages.push({ role: 'assistant', content: '[proposed a change above]' });
    saveSession(state.w);
  } else if (invalidToolFired) {
    if (replyEl) {
      const detail = lastDropReason ? ` (${lastDropReason})` : '';
      replyEl.textContent = `I tried to propose a change but couldn't apply it${detail}. Tell me which session you mean and I'll try again.`;
      (replyEl as HTMLElement).style.color = TEXT_M;
    }
  } else {
    // No text, no tool, no error — likely a model hiccup. Recoverable.
    if (replyEl) {
      replyEl.textContent = 'I didn\'t catch that. Try rephrasing what you\'d like to change.';
      (replyEl as HTMLElement).style.color = TEXT_S;
    }
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
    showAppliedToast(change);
  });

  document.querySelector(`[data-skip-id="${id}"]`)?.addEventListener('click', () => {
    document.getElementById(`apply-card-${id}`)?.remove();
    pendingChanges = pendingChanges.filter(c => c.id !== id);
  });
}

/** Brief confirmation toast with an Undo link. Auto-dismisses after 5s. */
function showAppliedToast(change: import('@/coach/coach-tools').PendingChange): void {
  document.getElementById('coach-applied-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'coach-applied-toast';
  toast.style.cssText = `position:fixed;left:50%;bottom:calc(110px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);z-index:300;background:${TEXT_M};color:#fff;padding:12px 16px;border-radius:14px;font-size:14px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,0.2);display:flex;align-items:center;gap:12px;max-width:88vw`;

  // Memory tools get distinct toast copy + skip the Undo button (use the
  // `forget` tool conversationally to remove a saved fact instead).
  const isMemoryTool = change.tool === 'remember' || change.tool === 'forget';
  const verb = change.tool === 'remember' ? 'Saved to memory' : change.tool === 'forget' ? 'Removed from memory' : `Applied: ${change.headline}`;
  const showUndo = !isMemoryTool;

  toast.innerHTML = `
    <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    <span style="flex:1">${escHtml(verb)}.</span>
    ${showUndo ? '<button id="coach-applied-undo" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.4);padding:5px 12px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Undo</button>' : ''}
  `;
  document.body.appendChild(toast);

  document.getElementById('coach-applied-undo')?.addEventListener('click', async () => {
    const { undoPendingChange } = await import('@/coach/coach-tools');
    const ok = undoPendingChange(change);
    toast.remove();
    if (ok) {
      const undoneToast = document.createElement('div');
      undoneToast.style.cssText = `position:fixed;left:50%;bottom:calc(110px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);z-index:300;background:${TEXT_M};color:#fff;padding:12px 18px;border-radius:14px;font-size:14px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,0.2)`;
      undoneToast.textContent = 'Change undone';
      document.body.appendChild(undoneToast);
      setTimeout(() => undoneToast.remove(), 2000);
    }
  });

  setTimeout(() => toast.remove(), 5000);
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
      @keyframes coachPulse { 0%,100%{opacity:0.3} 50%{opacity:1} }
      .coach-pulse { animation:coachPulse 1.4s ease-in-out infinite; }
      #coach-brief-text p:last-child { margin-bottom:0; }
      .coach-typing-dots { display:inline-flex; gap:5px; padding:4px 0; }
      .coach-typing-dots span { width:7px; height:7px; border-radius:50%; background:${TEXT_L}; animation:coachDot 1.2s ease-in-out infinite; }
      .coach-typing-dots span:nth-child(2) { animation-delay:0.15s; }
      .coach-typing-dots span:nth-child(3) { animation-delay:0.3s; }
      @keyframes coachDot { 0%,80%,100%{opacity:0.25;transform:scale(0.85)} 40%{opacity:1;transform:scale(1.1)} }
      .coach-chip:hover { box-shadow:0 2px 8px rgba(0,0,0,0.08); transform:translateY(-1px); }
    </style>

    <div id="coach-view" style="position:relative;min-height:100vh;background:${CREAM};font-family:var(--f);overflow-x:hidden;display:flex;flex-direction:column;padding-bottom:calc(88px + env(safe-area-inset-bottom, 0px))">

      ${buildScrollAtmosphereBackground('cv', 'rose', { haloCenter: { cx: 200, cy: 550 } })}${buildSunGlint('low')}

      <!-- Header -->
      <div style="position:relative;z-index:10;padding:56px 20px 12px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <button id="coach-back-btn" style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.08);display:flex;align-items:center;justify-content:center;color:${TEXT_M}">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style="font-size:20px;font-weight:700;color:${TEXT_M}">Coach</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="coach-help-btn" title="What can the coach do?"
            style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:transparent;display:flex;align-items:center;justify-content:center;color:${TEXT_L}">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </button>
          <button id="coach-newsession-btn" title="Start a new coaching session"
            style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:transparent;display:flex;align-items:center;justify-content:center;color:${TEXT_L}">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
          </button>
          <button id="coach-export-btn" title="Export training snapshot"
            style="width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:transparent;display:flex;align-items:center;justify-content:center;color:${TEXT_L}">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        </div>
      </div>

      <!-- Brief area -->
      <div style="position:relative;z-index:10;flex-shrink:0;padding:0 16px 8px">
        <div id="coach-loading" style="padding:14px 0;display:flex;align-items:center;gap:10px">
          <div class="coach-typing-dots"><span></span><span></span><span></span></div>
          <span style="font-size:13px;color:${TEXT_L};font-weight:500">Reading your training…</span>
        </div>
        <div id="coach-brief-text" style="display:none;font-size:16px;line-height:1.65;color:${TEXT_M};padding:4px 0 12px"></div>
      </div>

      <!-- Apply cards from brief -->
      <div id="coach-apply-cards" style="position:relative;z-index:10;flex-shrink:0"></div>

      <!-- Chat thread. Scrollable -->
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
    // Intentionally do NOT reset — the session persists within the same plan
    // week so re-opening Coach picks up the existing thread.
    if (coachOnBack) { coachOnBack(); return; }
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  document.getElementById('coach-export-btn')?.addEventListener('click', () => downloadSnapshot());

  // ? icon — re-open the "what the coach can do" overlay anytime
  document.getElementById('coach-help-btn')?.addEventListener('click', () => {
    showCoachIntro({ markSeen: false });
  });

  // ↻ icon — discard the current thread and stream a fresh brief
  document.getElementById('coach-newsession-btn')?.addEventListener('click', () => {
    resetSession();
    renderCoachView(coachOnBack ?? undefined);
  });

  if (!aiMode) {
    wireFeelingPromptHandlers(document, () => renderCoachView(coachOnBack ?? undefined));
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

// ─── Public entry point ───────────────────────────────────────────────────────

export interface RenderCoachOpts {
  onBack?: () => void;
  /** Proactive primer (from Home insight tap). When set, becomes the first user
   *  message instead of the default brief, and skips the session-restore path
   *  so the primer always lands a fresh stream. */
  primer?: string;
}

/** Open Coach with a proactive primer — convenience wrapper for Home view. */
export async function openCoachWith(primer: string): Promise<void> {
  await renderCoachView({ primer });
}

export async function renderCoachView(opts?: RenderCoachOpts | (() => void)): Promise<void> {
  // Back-compat: legacy callers pass a function as the first arg.
  const opt = typeof opts === 'function' ? { onBack: opts } : (opts ?? {});

  const container = document.getElementById('app-root');
  if (!container) return;
  coachOnBack = opt.onBack ?? coachOnBack;

  const state = getState();
  const { hasActiveCoachSubscription } = await import('@/coach/entitlement');
  const allowed = await hasActiveCoachSubscription();

  if (allowed) {
    container.innerHTML = getAICoachHTML();
    wireCoachHandlers(true);

    // When opened with a primer, ALWAYS start fresh — the primer is meant to
    // initiate a focused, single-topic conversation, not piggy-back on a
    // previous thread the user wasn't expecting.
    if (opt.primer) {
      resetSession();
    } else if (loadSession(state.w)) {
      // Normal entry: restore prior session if one exists for this week.
      restoreSessionUI();
      return;
    } else {
      // Normal entry, no restorable session — fresh start.
      resetSession();
    }

    const loadingEl = document.getElementById('coach-loading');

    /** Chained pre-stream gating: intro → priorities → consent → brief.
     *  Each step calls `next()` (which re-enters renderCoachView so the next
     *  gate evaluates fresh state). Preserves the primer through the chain. */
    const next = () => { renderCoachView({ ...opt }); };

    // First-ever open: capabilities overview.
    if (!state.coachIntroSeen) {
      if (loadingEl) loadingEl.style.display = 'none';
      showCoachIntro({ onDismiss: next });
      return;
    }

    // First Coach open OR priorities stale (>12 weeks) OR inconsistent state
    // (seen flag set but no priorities object — happens if state got partially
    // wiped or migrated): goal-setting flow.
    const STALE_MS = 12 * 7 * 24 * 60 * 60 * 1000;
    const priorityStale = state.coachPriorities
      ? (Date.now() - new Date(state.coachPriorities.setISO).getTime()) > STALE_MS
      : false;
    const prioritiesInconsistent = state.coachPrioritiesSeen && !state.coachPriorities;
    if (!state.coachPrioritiesSeen || priorityStale || prioritiesInconsistent) {
      if (loadingEl) loadingEl.style.display = 'none';
      showPrioritiesModal({ onDismiss: next });
      return;
    }

    // One-time AI-data consent.
    if (!state.coachConsentGiven) {
      if (loadingEl) loadingEl.style.display = 'none';
      showConsentModal();
      return;
    }

    startBriefStream(opt.primer);
  } else {
    // Non-subscriber path. On iOS we must route to the IAP paywall (Apple
    // requires Subscribe to be the only AI Coach unlock path on device); web
    // and Android still see the rules-based classic coach with BYOK affordance.
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios') {
      const { renderCoachPaywall } = await import('./coach-paywall');
      await renderCoachPaywall({ onBack: opt.onBack });
      return;
    }
    const coach = computeDailyCoach(state);
    container.innerHTML = getClassicCoachHTML(coach);
    wireCoachHandlers(false);
  }
}
