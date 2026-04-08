/**
 * Load & Taper detail page.
 * Accessible from the Week Load (TSS) row in both the plan header and home view.
 */

import { getState } from '@/state';
import { computeWeekRawTSS, computePlannedSignalB, computeDecayedCarry } from '@/calculations/fitness-model';
import { showLoadBreakdownSheet } from './home-view';

// ─── Phase config ────────────────────────────────────────────────────────────

const PHASE_COLORS: Record<string, { bg: string; text: string }> = {
  base:  { bg: 'rgba(59,130,246,0.1)',  text: '#2563EB' },
  build: { bg: 'rgba(249,115,22,0.1)',  text: '#EA580C' },
  peak:  { bg: 'rgba(239,68,68,0.1)',   text: '#DC2626' },
  taper: { bg: 'rgba(34,197,94,0.1)',   text: '#16A34A' },
};

function phaseBadge(ph: string): string {
  const label = ph.charAt(0).toUpperCase() + ph.slice(1);
  const c = PHASE_COLORS[ph] ?? { bg: 'rgba(0,0,0,0.06)', text: 'var(--c-muted)' };
  return `<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:10px;background:${c.bg};color:${c.text};letter-spacing:0.02em">${label}</span>`;
}

function weekRangeFmt(planStartDate: string | undefined, weekNum: number): string {
  if (!planStartDate) return '';
  const start = new Date(planStartDate);
  start.setDate(start.getDate() + (weekNum - 1) * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${start.toLocaleDateString('en-GB', opts)} – ${end.toLocaleDateString('en-GB', opts)}`;
}

// ─── Phase content ───────────────────────────────────────────────────────────

interface PhaseInfo {
  label: string;
  body: string;
}

const PHASE_INFO: Record<string, PhaseInfo> = {
  base: {
    label: 'Base',
    body: 'Aerobic development at easy effort. High proportion of Zone 2 running. Load is moderate and consistent — the aim is to raise your aerobic ceiling before intensity is introduced.',
  },
  build: {
    label: 'Build',
    body: 'Quality sessions are introduced: tempo runs, cruise intervals, marathon-pace work. Weekly TSS rises 5–10%. A recovery week is scheduled every third or fourth week to allow adaptation.',
  },
  peak: {
    label: 'Peak',
    body: 'The highest-load weeks of the plan. Longest long run, most volume, most stress. Two to three weeks here before load drops into taper.',
  },
  taper: {
    label: 'Taper',
    body: 'Volume drops 30–50% while intensity is maintained. The goal is to clear accumulated fatigue before race day. Fitness does not decline over a 2–3 week taper — it consolidates.',
  },
};

// ─── TSS explainer ────────────────────────────────────────────────────────────

function buildTssExplainer(): string {
  const ranges = [
    { range: 'Under 150', desc: 'Recovery or base maintenance', color: 'var(--c-muted)' },
    { range: '150 – 350', desc: 'Productive training for most runners', color: 'var(--c-ok)' },
    { range: '350 – 500', desc: 'High load — recovery needs careful management', color: 'var(--c-caution)' },
    { range: '500+',      desc: 'Elite volume — injury risk rises if sustained', color: 'var(--c-warn)' },
  ];

  const rows = ranges.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--c-border)">
      <span style="font-size:13px;font-weight:600;color:var(--c-black);min-width:90px">${r.range}</span>
      <span style="font-size:12px;color:var(--c-muted);text-align:right">${r.desc}</span>
    </div>`).join('');

  return `
    <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px">
      <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:4px">Training Stress Score</div>
      <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0 0 14px">
        TSS combines duration and intensity into a single weekly number.
        A 45-min easy run scores around 40. A 90-min long run at marathon pace is closer to 120.
      </p>
      <div style="border-top:1px solid var(--c-border)">${rows}</div>
    </div>`;
}

// ─── Carry-through section ───────────────────────────────────────────────────

function buildCarryThroughSection(currentCarry: number): string {
  const carryNote = currentCarry > 0
    ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--c-border);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--c-caution)">Carried into this week</span>
        <span style="font-size:13px;font-weight:600;color:var(--c-caution)">${currentCarry} TSS</span>
      </div>`
    : '';
  return `
    <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:10px">
      <div style="font-size:13px;font-weight:600;color:var(--c-black)">Carry-through</div>
      <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">
        Training load does not reset at week boundaries. Excess from one week creates residual fatigue that decays into the next.
      </p>
      <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">
        The decay follows a 7-day time constant and updates daily. On Monday after a heavy week, roughly 61% of the excess remains. By Thursday, 40%. By the following Sunday, 22%. The carried load decreases through the week as the body recovers. This week's own activities are unaffected.
      </p>
      <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">
        If last week exceeded its target by 100 TSS, Monday's effective load includes approximately 61 TSS of residual fatigue. By Friday that drops to around 35 TSS. This is when plan adjustments matter most: early in the week, when residual fatigue is highest.
      </p>
      ${carryNote}
    </div>`;
}

// ─── Phase cards ─────────────────────────────────────────────────────────────

function buildPhaseCards(currentPh: string): string {
  const phases = ['base', 'build', 'peak', 'taper'];
  return `
    <div style="background:var(--c-surface);border-radius:14px;overflow:hidden">
      ${phases.map((ph, i) => {
        const info = PHASE_INFO[ph];
        const c = PHASE_COLORS[ph] ?? { bg: 'rgba(0,0,0,0.06)', text: 'var(--c-muted)' };
        const isCurrent = ph === currentPh;
        const border = i < phases.length - 1 ? 'border-bottom:1px solid var(--c-border);' : '';
        return `
          <div style="padding:14px 16px 14px 18px;${border}${isCurrent ? `border-left:3px solid ${c.text};` : 'border-left:3px solid transparent;'}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
              <span style="font-size:12px;font-weight:700;color:${c.text}">${info.label}</span>
              ${isCurrent ? `<span style="font-size:10px;color:${c.text};opacity:0.7">current</span>` : ''}
            </div>
            <p style="font-size:12px;color:var(--c-muted);line-height:1.6;margin:0">${info.body}</p>
          </div>`;
      }).join('')}
    </div>`;
}

// ─── Taper section ────────────────────────────────────────────────────────────

function buildTaperSection(): string {
  return `
    <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:10px">
      <div style="font-size:13px;font-weight:600;color:var(--c-black)">Why taper works</div>
      <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">
        Training creates fatigue that sits on top of fitness. During taper, fatigue clears while fitness remains elevated.
        Glycogen stores top up, soft tissue repairs, and the nervous system recovers.
      </p>
      <p style="font-size:13px;color:var(--c-muted);line-height:1.6;margin:0">
        Most recreational runners perform 2–3% faster after a proper 2–3 week taper versus maintaining full load into race week.
        The restlessness you feel during taper is normal — resist adding sessions.
      </p>
    </div>`;
}

// ─── Main render ─────────────────────────────────────────────────────────────

export function renderLoadTaperView(viewWeek?: number, returnTo: 'plan' | 'home' = 'plan'): void {
  const container = document.getElementById('app-root');
  if (!container) return;

  const s = getState();
  const weekNum = viewWeek ?? s.w;
  const wk = s.wks?.[weekNum - 1];
  const ph = wk?.ph ?? 'base';

  const _tssRawLtp = wk ? Math.round(computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate)) : 0;
  const tssPlan = Math.round(computePlannedSignalB(
    s.historicWeeklyTSS,
    s.ctlBaseline,
    ph,
    s.athleteTierOverride ?? s.athleteTier,
    s.rw,
    undefined,
    undefined,
    s.sportBaselineByType,
  ));

  const _tssCarryLtp = computeDecayedCarry(s.wks ?? [], weekNum, tssPlan, s.planStartDate);
  const tssActual = _tssRawLtp + _tssCarryLtp;

  const barPct = tssPlan > 0 ? Math.min(100, Math.round((tssActual / tssPlan) * 100)) : 0;
  const barColor = barPct >= 100 ? 'var(--c-ok)' : barPct >= 70 ? 'var(--c-ok)' : 'var(--c-accent)';
  const dateRange = weekRangeFmt(s.planStartDate, weekNum);
  const weeksToRace = s.tw - weekNum;

  container.innerHTML = `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Header -->
      <div style="padding:14px 18px 12px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;gap:10px">
        <button id="ltp-back" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div style="flex:1">
          <div style="font-size:16px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">Load &amp; Taper</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            ${phaseBadge(ph)}
            ${dateRange ? `<span style="font-size:11px;color:var(--c-faint);font-weight:500">Week ${weekNum} of ${s.tw} · ${dateRange}</span>` : `<span style="font-size:11px;color:var(--c-faint)">Week ${weekNum} of ${s.tw}</span>`}
          </div>
        </div>
      </div>

      <!-- Content -->
      <div style="overflow-y:auto;padding:16px 16px 32px;display:flex;flex-direction:column;gap:12px">

        <!-- This week's load -->
        <div style="background:var(--c-surface);border-radius:14px;padding:16px 18px">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:10px">This Week</div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:12px">
            <span style="font-size:32px;font-weight:700;letter-spacing:-0.03em;color:var(--c-black)">${tssActual}</span>
            <span style="font-size:14px;color:var(--c-muted)">/ ${tssPlan} TSS</span>
          </div>
          <div style="background:rgba(0,0,0,0.07);border-radius:5px;height:6px;overflow:hidden;margin-bottom:12px">
            <div style="height:100%;border-radius:5px;background:${barColor};width:${barPct}%;transition:width 0.3s"></div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;color:var(--c-muted)">${barPct}% of weekly target${weeksToRace > 0 ? ` · ${weeksToRace}w to race` : ''}</span>
            <button id="ltp-breakdown-btn" style="font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0">Breakdown →</button>
          </div>
        </div>

        ${buildTssExplainer()}

        ${buildCarryThroughSection(_tssCarryLtp)}

        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);padding:4px 2px 0">Plan structure</div>

        ${buildPhaseCards(ph)}

        ${buildTaperSection()}

      </div>
    </div>`;

  document.getElementById('ltp-back')?.addEventListener('click', () => {
    if (returnTo === 'plan') {
      import('./plan-view').then(({ renderPlanView }) => renderPlanView());
    } else {
      import('./home-view').then(({ renderHomeView }) => renderHomeView());
    }
  });

  document.getElementById('ltp-breakdown-btn')?.addEventListener('click', () => {
    showLoadBreakdownSheet(s, weekNum);
  });
}
