/**
 * feeling-prompt.ts
 * =================
 * Shared renderer + handler wiring for the "How do you feel today?" one-tap
 * daily feeling prompt. Used from both home-view and coach-view so the prompt
 * UI stays consistent across surfaces.
 *
 * Visual rules (CLAUDE.md Visual Constraints):
 *   - No tint, no emoji, no accent colour on the pills
 *   - Border-only buttons with muted/black text
 *   - 4 single-word labels: Struggling / Ok / Good / Great
 *
 * The stored value expires at end of day — see getTodayFeeling() in
 * calculations/daily-coach.ts.
 */

import { getMutableState, saveState, getState } from '@/state';

export type FeelingValue = 'struggling' | 'ok' | 'good' | 'great';

const OPTIONS: Array<{ key: FeelingValue; label: string }> = [
  { key: 'struggling', label: 'Struggling' },
  { key: 'ok',         label: 'Ok' },
  { key: 'good',       label: 'Good' },
  { key: 'great',      label: 'Great' },
];

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Build the HTML for the feeling prompt. Caller is responsible for placing it
 * inside an appropriate section container and calling wireFeelingPromptHandlers
 * after innerHTML is applied.
 *
 * @param variant 'home' uses home-view's inline styling (CSS vars),
 *                'brain' uses the Brain sub-page palette (hard-coded colours,
 *                already matching TEXT_M etc. — kept as neutral greys here).
 */
export function renderFeelingPromptHTML(variant: 'home' | 'brain' = 'home'): string {
  const s = getState();
  const tf = s.todayFeeling;
  const hasToday = !!tf && tf.date === todayISO();

  if (variant === 'brain') {
    const BORDER  = 'rgba(15,23,42,0.08)';
    const TEXT_M  = '#0F172A';
    const TEXT_S  = '#64748B';

    if (hasToday && tf) {
      const chosen = OPTIONS.find(o => o.key === tf.value)?.label ?? tf.value;
      return `
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
          <div style="font-size:14px;font-weight:600;color:${TEXT_M}">Today: ${chosen}</div>
          <button class="feeling-prompt-change" style="
            background:none;border:none;cursor:pointer;
            font-size:12px;color:${TEXT_S};font-family:var(--f);padding:4px 0;
          ">Change</button>
        </div>
      `;
    }

    const buttons = OPTIONS.map(o => `
      <button class="feeling-prompt-btn" data-feeling="${o.key}" style="
        flex:1;padding:10px 8px;border-radius:12px;
        border:1px solid ${BORDER};background:transparent;cursor:pointer;
        font-size:13px;font-weight:500;color:${TEXT_M};font-family:var(--f);
        transition:background 0.15s;
      ">${o.label}</button>
    `).join('');
    return `<div style="display:flex;gap:8px;margin-top:8px">${buttons}</div>`;
  }

  // home variant — uses CSS vars so it matches the existing home-view check-in row.
  if (hasToday && tf) {
    const chosen = OPTIONS.find(o => o.key === tf.value)?.label ?? tf.value;
    return `
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:10px">
        <div style="font-size:13px;font-weight:600;color:var(--c-black)">Today: ${chosen}</div>
        <button class="feeling-prompt-change" style="
          background:none;border:none;cursor:pointer;
          font-size:12px;color:var(--c-muted);font-family:var(--f);padding:4px 0;
        ">Change</button>
      </div>
    `;
  }

  const buttons = OPTIONS.map(o => `
    <button class="feeling-prompt-btn" data-feeling="${o.key}" style="
      flex:1;padding:8px 10px;border-radius:100px;
      border:1px solid var(--c-border);background:rgba(255,255,255,0.7);
      backdrop-filter:blur(8px);cursor:pointer;
      font-size:12px;font-weight:500;color:var(--c-black);font-family:var(--f);
    ">${o.label}</button>
  `).join('');
  return `
    <div style="margin-top:10px">
      <div style="text-align:center;font-size:12px;color:var(--c-muted);margin-bottom:8px">How do you feel today?</div>
      <div style="display:flex;gap:6px;justify-content:center">${buttons}</div>
    </div>
  `;
}

/**
 * Wire click handlers on all .feeling-prompt-btn / .feeling-prompt-change
 * elements inside `root`. After a click, `onChange` is called so the caller
 * can re-render its view. The caller should scope `root` to its own subtree
 * to avoid double-binding when multiple prompts coexist on a page.
 */
export function wireFeelingPromptHandlers(root: HTMLElement | Document, onChange: () => void): void {
  root.querySelectorAll<HTMLElement>('.feeling-prompt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.feeling as FeelingValue | undefined;
      if (!value) return;
      const ms = getMutableState();
      ms.todayFeeling = { value, date: todayISO() };
      saveState();
      onChange();
    });
  });

  root.querySelectorAll<HTMLElement>('.feeling-prompt-change').forEach(btn => {
    btn.addEventListener('click', () => {
      const ms = getMutableState();
      ms.todayFeeling = null;
      saveState();
      onChange();
    });
  });
}
